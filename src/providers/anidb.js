const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const logger = require('../utils/logger');

// AniDB is what HAMA built its episode lists on: unlike AniList it has a title (in
// several languages), an air date and often a summary for every episode, long
// runners included. Its HTTP API is free but strict - a registered client name,
// at most one request every 2 seconds and no repeated fetches of the same anime
// within a day - and breaking those rules gets the IP banned. So every response
// is kept on disk (surviving restarts and image updates), requests go through a
// single throttled queue, and a ban is persisted and waited out.
//
// Opt-in via ANIDB_CLIENT / ANIDB_CLIENTVER (register a client at
// https://anidb.net/software/add); unset, this provider is silently unavailable.
const API_URL = 'http://api.anidb.net:9001/httpapi';
const DAY_MS = 24 * 60 * 60 * 1000;
const AIRING_TTL_MS = DAY_MS;
const FINISHED_TTL_MS = 7 * DAY_MS;
// A show counts as finished once it ended more than this long ago: late additions
// (titles, summaries) mostly land in the weeks right after the finale.
const FINISHED_AFTER_MS = 30 * DAY_MS;
const BAN_BACKOFF_MS = DAY_MS;
const ERROR_BACKOFF_MS = 60 * 60 * 1000;
const MIN_INTERVAL_FLOOR_MS = 2000;
const DEFAULT_INTERVAL_MS = 4000;
const DEFAULT_WAIT_MS = 10000;
const TIMED_OUT = Symbol('timed out');

const memory = new Map();
const inFlight = new Map();
let queueTail = Promise.resolve();
let lastRequestAt = 0;
let blockedUntil = null;

function isConfigured() {
  return Boolean(process.env.ANIDB_CLIENT && process.env.ANIDB_CLIENTVER);
}

function cacheDir() {
  return path.join(process.env.CACHE_DIR || path.join(process.cwd(), 'data', 'cache'), 'anidb');
}

function readSeconds(name, fallbackMs) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : fallbackMs;
}

function minIntervalMs() {
  return Math.max(MIN_INTERVAL_FLOOR_MS, readSeconds('ANIDB_MIN_INTERVAL_SECONDS', DEFAULT_INTERVAL_MS));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function decodeEntities(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// AniDB summaries link characters/creators inline as `http://anidb.net/ch123 [Name]`
// and often end with a "Source: ..." credit line.
function cleanSummary(value) {
  return decodeEntities(value)
    .replace(/https?:\/\/anidb\.net\/\S+\s*\[([^\]]+)\]/g, '$1')
    .replace(/\n+\s*(?:Source|Note):[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

// Just the parts of the `anime` response the episode lists use. Only regular
// episodes (epno type 1) are kept: specials, credits and trailers are numbered
// S1/C1/T1 in a separate sequence that doesn't line up with any file numbering.
function parseAnime(xml, aid) {
  const endDate = /<enddate>(\d{4}-\d{2}-\d{2})<\/enddate>/.exec(xml)?.[1] || null;
  const episodes = [];
  for (const [, body] of xml.matchAll(/<episode\b[^>]*>([\s\S]*?)<\/episode>/g)) {
    const epno = /<epno\b[^>]*type="(\d+)"[^>]*>([^<]*)<\/epno>/.exec(body);
    const number = Number(epno?.[2]);
    if (!epno || epno[1] !== '1' || !Number.isInteger(number) || number < 1) {
      continue;
    }
    const titles = {};
    for (const [, lang, text] of body.matchAll(/<title\b[^>]*xml:lang="([^"]+)"[^>]*>([\s\S]*?)<\/title>/g)) {
      const title = decodeEntities(text).trim();
      if (title && !titles[lang]) {
        titles[lang] = title;
      }
    }
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1];
    episodes.push({
      number,
      airDate: /<airdate>(\d{4}-\d{2}-\d{2})<\/airdate>/.exec(body)?.[1] || null,
      titles,
      summary: summary ? cleanSummary(summary) : null
    });
  }
  episodes.sort((a, b) => a.number - b.number);
  return { aid: Number(aid), endDate, episodes };
}

function ttlFor(anime) {
  if (anime.missing) {
    return FINISHED_TTL_MS;
  }
  const ended = anime.endDate ? Date.parse(anime.endDate) : NaN;
  return Number.isFinite(ended) && Date.now() - ended > FINISHED_AFTER_MS ? FINISHED_TTL_MS : AIRING_TTL_MS;
}

function cacheFile(aid) {
  return path.join(cacheDir(), `${Number(aid)}.json`);
}

async function writeJson(file, value) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  } catch (error) {
    logger.warn({ file, err: error }, 'AniDB cache write failed, the response is only kept in memory');
  }
}

async function readCached(aid) {
  if (memory.has(aid)) {
    return memory.get(aid);
  }
  try {
    const entry = JSON.parse(await fs.readFile(cacheFile(aid), 'utf8'));
    if (entry?.anime && Number.isFinite(entry.fetchedAt)) {
      memory.set(aid, entry);
      return entry;
    }
  } catch {
    // No cached copy yet (or an unreadable one): fetched below.
  }
  return null;
}

function isFresh(entry) {
  return Boolean(entry) && Date.now() - entry.fetchedAt < ttlFor(entry.anime);
}

// Persisted, so restarting the container while banned doesn't immediately hit the
// API again and extend the ban.
async function loadBlock() {
  if (blockedUntil === null) {
    try {
      blockedUntil = Number(JSON.parse(await fs.readFile(path.join(cacheDir(), '_ban.json'), 'utf8')).until) || 0;
    } catch {
      blockedUntil = 0;
    }
  }
  return blockedUntil;
}

async function block(ms, reason, persist) {
  blockedUntil = Date.now() + ms;
  logger.warn({ until: new Date(blockedUntil).toISOString(), reason }, 'AniDB requests paused');
  if (persist) {
    await writeJson(path.join(cacheDir(), '_ban.json'), { until: blockedUntil, reason });
  }
}

function enqueue(task) {
  const run = queueTail.then(async () => {
    const waitMs = lastRequestAt + minIntervalMs() - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  queueTail = run.catch(() => {});
  return run;
}

async function requestAnime(aid) {
  const url = new URL(API_URL);
  url.searchParams.set('request', 'anime');
  url.searchParams.set('client', process.env.ANIDB_CLIENT);
  url.searchParams.set('clientver', process.env.ANIDB_CLIENTVER);
  url.searchParams.set('protover', '1');
  url.searchParams.set('aid', String(aid));

  const response = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!response.ok) {
    await block(ERROR_BACKOFF_MS, `HTTP ${response.status}`, false);
    return null;
  }

  // Always gzipped; fetch only inflates it when the Content-Encoding header says so.
  let body = Buffer.from(await response.arrayBuffer());
  if (body[0] === 0x1f && body[1] === 0x8b) {
    body = zlib.gunzipSync(body);
  }
  const xml = body.toString('utf8');

  const error = /<error\b[^>]*>([\s\S]*?)<\/error>/i.exec(xml)?.[1]?.trim();
  if (error) {
    if (/banned/i.test(error)) {
      await block(BAN_BACKOFF_MS, error, true);
      return null;
    }
    if (/not found/i.test(error)) {
      return { aid: Number(aid), missing: true, episodes: [] };
    }
    // Client not registered / wrong version: retrying won't help until it's fixed.
    await block(ERROR_BACKOFF_MS, error, false);
    return null;
  }

  return parseAnime(xml, aid);
}

function refresh(aid) {
  if (!inFlight.has(aid)) {
    const pending = enqueue(async () => {
      // Re-checked inside the queue: a ban hit by an earlier request in the queue
      // must stop every request lined up behind it.
      if (await loadBlock() > Date.now()) {
        return null;
      }
      const anime = await requestAnime(aid);
      if (anime) {
        const entry = { fetchedAt: Date.now(), anime };
        memory.set(aid, entry);
        await writeJson(cacheFile(aid), entry);
        logger.info({ aid, episodes: anime.episodes.length }, 'AniDB anime fetched');
      }
      return anime;
    })
      .catch((error) => {
        logger.warn({ aid, err: error }, 'AniDB request failed');
        return null;
      })
      .finally(() => inFlight.delete(aid));
    inFlight.set(aid, pending);
  }
  return inFlight.get(aid);
}

// { aid, endDate, episodes: [{ number, airDate, titles: { en, x-jat, ja, ... }, summary }] }
// or null. Never throws and never makes a Plex request wait more than
// ANIDB_WAIT_SECONDS: a fetch still queued then finishes in the background and is
// used from the next refresh on. A stale cached copy beats nothing.
async function getAnime(aid) {
  const id = Number(aid);
  if (!isConfigured() || !id) {
    return null;
  }

  const cached = await readCached(id);
  if (isFresh(cached)) {
    return cached.anime.missing ? null : cached.anime;
  }
  if (await loadBlock() > Date.now()) {
    return cached && !cached.anime.missing ? cached.anime : null;
  }

  const result = await Promise.race([
    refresh(id),
    sleep(readSeconds('ANIDB_WAIT_SECONDS', DEFAULT_WAIT_MS)).then(() => TIMED_OUT)
  ]);
  const anime = result && result !== TIMED_OUT ? result : cached?.anime;
  if (result === TIMED_OUT) {
    logger.info({ aid: id }, 'AniDB still queued, serving without it this time');
  }
  return anime && !anime.missing ? anime : null;
}

// Queues the anime a show's seasons will ask for next (Plex requests the show,
// then each season), without waiting: by the time the season requests arrive most
// of them are cached, instead of each season waiting for its turn in the queue.
function prefetch(aids) {
  if (!isConfigured()) {
    return;
  }
  (async () => {
    if (await loadBlock() > Date.now()) {
      return;
    }
    for (const aid of new Set(aids.map(Number).filter(Boolean))) {
      if (!isFresh(await readCached(aid))) {
        refresh(aid);
      }
    }
  })().catch((error) => logger.warn({ err: error }, 'AniDB prefetch failed'));
}

// Test hook: forget in-memory state (cache, queue timing, ban).
function reset() {
  memory.clear();
  inFlight.clear();
  queueTail = Promise.resolve();
  lastRequestAt = 0;
  blockedUntil = null;
}

module.exports = {
  isConfigured, getAnime, prefetch, parseAnime, cleanSummary, reset
};
