const ANILIST_URL = 'https://graphql.anilist.co';
const logger = require('../utils/logger');
const { buildDate, stripHtml } = require('../utils/mapping');
const { createCache } = require('../utils/cache');

const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
const MAX_CHAIN_HOPS = 12;
const mediaCache = createCache();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 2;

// AniList allows ~30 requests/minute per IP (90 when it isn't in degraded mode), and a
// Plex "Refresh all metadata" fires dozens of provider requests in parallel - each of
// them retrying on its own just multiplies the 429s. So every AniList call goes
// through one queue: one request at a time, spaced by ANILIST_MIN_INTERVAL_MS, and a
// 429 pauses the whole queue for its Retry-After instead of just the request that hit it.
function readNumberEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

let queue = Promise.resolve();
let nextSlotAt = 0;
let cooldownUntil = 0;

function enqueue(task) {
  const run = queue.then(async () => {
    const waitMs = nextSlotAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    try {
      return await task();
    } finally {
      nextSlotAt = Math.max(nextSlotAt, Date.now() + readNumberEnv('ANILIST_MIN_INTERVAL_MS', 2000));
    }
  });
  queue = run.catch(() => {});
  return run;
}

// Proactively waits out the window when AniList says it's about to run out, rather
// than spending a request on a guaranteed 429.
function respectRateLimitHeaders(response) {
  const remaining = Number(response.headers?.get?.('x-ratelimit-remaining'));
  const resetAt = Number(response.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(remaining) && remaining <= 1 && Number.isFinite(resetAt) && resetAt > 0) {
    nextSlotAt = Math.max(nextSlotAt, resetAt * 1000);
  }
}

async function readErrorMessage(response) {
  try {
    const body = await response.json();
    return body?.errors?.map((error) => error.message).join('; ') || null;
  } catch {
    return null;
  }
}

async function executeQuery(query, variables) {
  for (let retryCount = 0; ; retryCount += 1) {
    // While AniList has told us to back off for longer than we're willing to hold a
    // Plex request open, fail fast: the request errors (Plex keeps its existing
    // metadata) without spending another call that would only extend the ban.
    if (cooldownUntil > Date.now()) {
      throw new Error('AniList request skipped: rate-limit cooldown in progress');
    }

    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, variables })
    });

    if (response.ok) {
      respectRateLimitHeaders(response);
      const payload = await response.json();
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((error) => error.message).join('; '));
      }
      return payload.data;
    }

    // AniList's Cloudflare-fronted API returns 403 (not just the more standard 429)
    // both for per-IP rate limiting AND for whole-API outages ("temporarily disabled
    // due to severe stability issues"), and there's no separate status page to check -
    // the only way to tell them apart is the error message in the response body, so
    // log it verbatim to make it obvious this isn't something wrong on our end.
    if (response.status !== 403 && response.status !== 429) {
      throw new Error(`AniList request failed with status ${response.status}`);
    }

    const anilistMessage = await readErrorMessage(response);
    const retryAfterSeconds = Number(response.headers?.get?.('retry-after'));
    const hasRetryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0;
    const maxWaitSeconds = readNumberEnv('ANILIST_MAX_RETRY_WAIT_SECONDS', 30);

    if (hasRetryAfter && retryAfterSeconds > maxWaitSeconds) {
      cooldownUntil = Date.now() + retryAfterSeconds * 1000;
    }

    if (retryCount >= MAX_RETRIES || cooldownUntil > Date.now()) {
      logger.warn({
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? null,
        rateLimitRemaining: response.headers?.get?.('x-ratelimit-remaining') ?? null,
        anilistMessage
      }, 'AniList request rate-limited or unavailable');
      throw new Error(`AniList request failed with status ${response.status}`);
    }

    // Retry-After when AniList sends one, else exponential backoff (1s, 2s). This
    // runs inside the queue, so every other pending AniList request waits it out too.
    const delayMs = hasRetryAfter ? retryAfterSeconds * 1000 : 1000 * 2 ** retryCount;
    logger.info({
      status: response.status,
      retryCount: retryCount + 1,
      delayMs,
      anilistMessage
    }, 'AniList rate-limited, retrying');
    await sleep(delayMs);
  }
}

function runQuery(query, variables = {}) {
  return enqueue(() => executeQuery(query, variables));
}

const SEASON_FIELDS = `
  id
  title {
    romaji
    english
    native
  }
  description(asHtml: false)
  episodes
  duration
  genres
  format
  averageScore
  bannerImage
  coverImage {
    large
    extraLarge
  }
  startDate {
    year
    month
    day
  }
`;

const MEDIA_DETAIL_FIELDS = `
  ${SEASON_FIELDS}
  isAdult
  studios(isMain: true) {
    nodes {
      name
    }
  }
  characters(sort: [ROLE, RELEVANCE], perPage: 8) {
    edges {
      role
      node {
        name {
          full
        }
        image {
          large
        }
      }
      voiceActors(language: JAPANESE, sort: [RELEVANCE]) {
        name {
          full
        }
        image {
          large
        }
      }
    }
  }
  relations {
    edges {
      relationType(version: 2)
      node {
        ${SEASON_FIELDS}
      }
    }
  }
  streamingEpisodes {
    title
    thumbnail
    url
    site
  }
`;

// Cached: this is called repeatedly for the same id across metadata/children/
// grandchildren/images requests for the same Plex entry, and again for every hop
// of resolveSeasonChain's relation walk - caching it is what actually cuts down
// on AniList calls, since every other function here funnels through it.
async function getMediaById(id) {
  return mediaCache.wrap(`media:${Number(id)}`, async () => {
    const query = `
      query MediaById($id: Int!) {
        Media(id: $id, type: ANIME) {
          ${MEDIA_DETAIL_FIELDS}
        }
      }
    `;

    const data = await runQuery(query, { id: Number(id) });
    return data.Media;
  });
}

// `isAdult: false` hides hentai from automatic matches; Plex passes includeAdult=1
// when the library allows it, and leaving the variable out turns AniList's filter off.
// It must be omitted, not null: AniList reads `isAdult: null` as "isAdult is null"
// and returns no results at all.
async function searchMedia(search, page = 1, perPage = 5, { includeAdult = false } = {}) {
  const query = `
    query SearchMedia($search: String!, $page: Int!, $perPage: Int!, $isAdult: Boolean) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          total
          currentPage
          perPage
          hasNextPage
        }
        media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: $isAdult) {
          ${SEASON_FIELDS}
          synonyms
          isAdult
        }
      }
    }
  `;

  const data = await runQuery(query, {
    search, page, perPage, ...(includeAdult ? {} : { isAdult: false })
  });
  return data.Page;
}

function isSeasonCandidate(node) {
  return Boolean(node) && SEASON_FORMATS.has(node.format);
}

// Formats a franchise's continuity can pass through between two TV seasons. The
// textbook case: season 1's SEQUEL is a *movie*, and only the movie's SEQUEL is the
// TV arc retelling it (TVDB season 2) - stopping at
// the first non-TV node would cut the franchise off after season 1.
const PASS_THROUGH_FORMATS = new Set([...SEASON_FORMATS, 'MOVIE', 'OVA', 'SPECIAL']);

async function walkRelations(startMedia, direction, visited, detours) {
  let current = startMedia;
  const traversed = new Set([startMedia.id]);

  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    const edges = (current.relations?.edges || []).filter((edge) => edge.relationType === direction
      && edge.node
      && !traversed.has(edge.node.id)
      && !visited.has(edge.node.id));
    // A real season always wins over a movie/OVA detour when both are linked.
    const next = edges.find((edge) => isSeasonCandidate(edge.node))
      || edges.find((edge) => PASS_THROUGH_FORMATS.has(edge.node.format));

    if (!next) {
      return;
    }

    traversed.add(next.node.id);
    const fullNext = await getMediaById(next.node.id);
    if (!fullNext) {
      return;
    }

    if (isSeasonCandidate(fullNext)) {
      visited.set(fullNext.id, fullNext);
    } else {
      detours.set(fullNext.id, fullNext);
    }
    current = fullNext;
  }
}

// AniList models a franchise's seasons as separate Media entries linked via
// PREQUEL/SEQUEL relations rather than a single entry with season sub-objects,
// so building an accurate season list means walking that relation graph.
//
// The movies/OVAs/specials the walk passed through are returned as `detours`: not
// seasons by themselves, but TVDB sometimes counts one as regular episodes (Attack
// on Titan's "Final Chapters" special is S04E29-30), which the season layout checks.
async function resolveSeasonChainWithDetours(rootId) {
  const rootMedia = await getMediaById(Number(rootId));
  if (!rootMedia) {
    return { chain: [], detours: [] };
  }

  const visited = new Map([[rootMedia.id, rootMedia]]);
  const detours = new Map();
  await walkRelations(rootMedia, 'PREQUEL', visited, detours);
  await walkRelations(rootMedia, 'SEQUEL', visited, detours);

  // An announced season with no start date yet goes last: sorting it as year 0
  // would put it ahead of the franchise's actual first season.
  const startTime = (media) => (media.startDate?.year
    ? media.startDate.year * 10000 + (media.startDate.month || 12) * 100 + (media.startDate.day || 31)
    : Number.MAX_SAFE_INTEGER);
  const byStart = (a, b) => startTime(a) - startTime(b) || a.id - b.id;

  return {
    chain: Array.from(visited.values()).sort(byStart),
    detours: Array.from(detours.values()).sort(byStart)
  };
}

async function resolveSeasonChain(rootId) {
  return (await resolveSeasonChainWithDetours(rootId)).chain;
}

const AIRING_SCHEDULE_PAGE_SIZE = 50;
const MAX_AIRING_SCHEDULE_PAGES = 100;

// AniList silently caps perPage at 50, so a long-running show with no fixed episode
// count (1000+ episode long runners) has to be walked page by page - a single
// request would cut its season off at episode 50.
async function getAiringSchedules(mediaId) {
  return mediaCache.wrap(`airing:${Number(mediaId)}`, async () => {
    const query = `
      query EpisodeSchedule($mediaId: Int!, $page: Int!, $perPage: Int!) {
        Page(page: $page, perPage: $perPage) {
          pageInfo {
            hasNextPage
          }
          airingSchedules(mediaId: $mediaId, sort: EPISODE) {
            episode
            airingAt
          }
        }
      }
    `;

    const schedules = [];
    for (let page = 1; page <= MAX_AIRING_SCHEDULE_PAGES; page += 1) {
      const data = await runQuery(query, { mediaId: Number(mediaId), page, perPage: AIRING_SCHEDULE_PAGE_SIZE });
      schedules.push(...(data.Page?.airingSchedules || []));
      if (!data.Page?.pageInfo?.hasNextPage) {
        break;
      }
    }
    return schedules;
  });
}

async function getEpisodesPage(id, start = 0, size = 50) {
  const media = await getMediaById(id);
  const totalEpisodes = Number(media?.episodes || 0);

  let schedules = [];
  try {
    schedules = await getAiringSchedules(id);
  } catch (error) {
    // With no fixed episode count the schedule is the only source for how many
    // episodes exist - answering anyway would hand Plex a 1-episode season, and
    // Plex would drop every other episode (and its watch state) on that refresh.
    if (totalEpisodes <= 0) {
      logger.warn({ mediaId: id, err: error }, 'AniList airing schedule lookup failed and the episode count is unknown, failing instead of returning a truncated season');
      throw error;
    }
    logger.warn({ mediaId: id, err: error }, 'AniList airing schedule lookup failed, falling back to synthesized episode dates');
    schedules = [];
  }

  const maxScheduledEpisode = schedules.reduce((maxEpisode, entry) => (
    Number(entry?.episode) > maxEpisode ? Number(entry.episode) : maxEpisode
  ), 0);
  const inferredTotal = Math.max(maxScheduledEpisode, schedules.length, 1);
  const safeTotal = totalEpisodes > 0 ? totalEpisodes : inferredTotal;

  function formatAiringDate(airingAt) {
    if (!airingAt) {
      return buildDate(media.startDate);
    }

    return new Date(airingAt * 1000).toISOString().slice(0, 10);
  }

  const episodes = [];
  const limit = Math.min(start + size, safeTotal);
  // AniList's MediaStreamingEpisode has no episode number (only title/thumbnail/url/
  // site), so it's parsed from the title, e.g. "Episode 3 - The Gathering of Heroes".
  // Entries without a recognisable number are skipped rather than guessed by position.
  const streamingEpisodesByNumber = new Map();
  (media.streamingEpisodes || []).forEach((ep) => {
    const match = /^\s*Episode\s+(\d+)\s*(?:[-–:]\s*(.*))?$/i.exec(ep?.title || '');
    if (match && !streamingEpisodesByNumber.has(Number(match[1]))) {
      streamingEpisodesByNumber.set(Number(match[1]), { ...ep, title: match[2]?.trim() || null });
    }
  });

  // Some entries carry another season's Crunchyroll list (a 13
  // episodes, lists the 49 of a different season): an episode numbered past this
  // entry's own count gives that away, and then none of its titles can be trusted.
  const maxStreamingNumber = Math.max(0, ...streamingEpisodesByNumber.keys());
  if (totalEpisodes > 0 && maxStreamingNumber > totalEpisodes) {
    logger.info({ mediaId: id, totalEpisodes, maxStreamingNumber }, 'AniList streaming episodes belong to another entry, ignoring their titles');
    streamingEpisodesByNumber.clear();
  }

  const schedulesByNumber = new Map(schedules.map((entry) => [Number(entry?.episode), entry]));

  for (let number = start + 1; number <= limit; number += 1) {
    const scheduled = schedulesByNumber.get(number);
    const streaming = streamingEpisodesByNumber.get(number);

    episodes.push({
      episodeNumber: number,
      airDate: formatAiringDate(scheduled?.airingAt),
      // The fallback date is the season's start, not this episode's: it must not be
      // used to line episodes up against TMDB (see utils/episodeSources.js).
      airDateEstimated: !scheduled?.airingAt,
      title: streaming?.title || null,
      summary: streaming?.title ? stripHtml(streaming.title) : stripHtml(media.description || ''),
      thumbnail: streaming?.thumbnail || null
    });
  }

  return {
    media,
    episodes,
    totalSize: safeTotal
  };
}

// Score against every title AniList exposes (english/romaji/native), not just the one
// preferred by TITLE_LANGUAGE_ORDER. Anime release filenames are frequently romaji
// (e.g. "Honoo no Shoubou") while the default preferred title is English ("Flame
// Force") - scoring against resolveTitle() alone means the correct entry never gets an
// exact-match bonus in that case, letting an unrelated entry whose *resolved* title
// happens to match the search term outrank it.
//
// Titles are compared after folding case, accents and punctuation, since folder names
// and release filenames rarely keep them: "Re Start", "Ojou sama Love Duel" and
// "Shio no Kiseki" must still hit "Re:Start", "Ojou-sama: Love Duel" and
// "Shio no Kiseki" exactly. AniList synonyms count as titles too.
function foldTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Whole-word containment, so a short synonym ("aot") can't match inside "chaotic".
function containsWords(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

// Formats that can't be a Plex TV show: a movie or music video winning a show match
// would hand Plex a one-"episode" series.
const NON_SHOW_FORMAT_PENALTY = { MOVIE: 15, MUSIC: 15, SPECIAL: 10, OVA: 5 };

function createMatchScore(media, term, parsed = {}, hints = {}) {
  const titleVariants = [media.title?.english, media.title?.romaji, media.title?.native, ...(media.synonyms || [])]
    .map(foldTitle)
    .filter(Boolean);
  const normalizedTerm = foldTitle(term);

  let score = 60;
  if (normalizedTerm && titleVariants.includes(normalizedTerm)) {
    score = 100;
  } else if (normalizedTerm && titleVariants.some((title) => containsWords(title, normalizedTerm) || containsWords(normalizedTerm, title))) {
    score = 92;
  }

  // Plex sends the year it parsed from the folder ("Show (2019)"); a remake or a
  // same-titled entry from another year must not tie with the right one.
  const year = Number(hints.year);
  const mediaYear = Number(media.startDate?.year);
  if (year && mediaYear) {
    const distance = Math.abs(year - mediaYear);
    if (distance === 1) {
      score -= 3;
    } else if (distance > 1) {
      score -= 10;
    }
  }

  score -= NON_SHOW_FORMAT_PENALTY[media.format] || 0;

  if (parsed.episodeNumber) {
    score -= 2;
  }

  if (parsed.airDate) {
    score -= 3;
  }

  return Math.max(score, 1);
}

module.exports = {
  getMediaById,
  searchMedia,
  getEpisodesPage,
  createMatchScore,
  foldTitle,
  resolveSeasonChain,
  resolveSeasonChainWithDetours
};
