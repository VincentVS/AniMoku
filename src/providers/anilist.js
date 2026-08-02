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

async function runQuery(query, variables = {}, retryCount = 0) {
  const response = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    // AniList's Cloudflare-fronted API returns 403 (not just the more standard 429)
    // both for per-IP rate limiting AND for whole-API outages ("temporarily disabled
    // due to severe stability issues"), and there's no separate status page to check -
    // the only way to tell them apart is the error message in the response body, so
    // log it verbatim to make it obvious this isn't something wrong on our end.
    if ((response.status === 403 || response.status === 429) && retryCount < 2) {
      let body = null;
      let retryAfterSeconds = null;
      try {
        body = await response.json();
        const retryAfterHeader = response.headers.get('retry-after');
        if (retryAfterHeader) {
          retryAfterSeconds = Number(retryAfterHeader);
        }
      } catch {
        body = null;
      }

      // Use retry-after if present and reasonable (< 30s), else exponential backoff (1s, 2s)
      let delayMs;
      if (retryAfterSeconds && Number.isFinite(retryAfterSeconds) && retryAfterSeconds < 30) {
        delayMs = retryAfterSeconds * 1000;
      } else {
        delayMs = (1000 * Math.pow(2, retryCount));
      }

      logger.info({
        status: response.status,
        retryCount: retryCount + 1,
        delayMs,
        anilistMessage: body?.errors?.map((error) => error.message).join('; ') || null
      }, 'AniList rate-limited, retrying');

      await sleep(delayMs);
      return runQuery(query, variables, retryCount + 1);
    }

    if (response.status === 403 || response.status === 429) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      logger.warn({
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
        anilistMessage: body?.errors?.map((error) => error.message).join('; ') || null
      }, 'AniList request rate-limited or unavailable');
    }
    throw new Error(`AniList request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }

  return payload.data;
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
  streamingEpisodes(sort: EPISODE) {
    episode
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

async function searchMedia(search, page = 1, perPage = 5) {
  const query = `
    query SearchMedia($search: String!, $page: Int!, $perPage: Int!) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          total
          currentPage
          perPage
          hasNextPage
        }
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          ${SEASON_FIELDS}
        }
      }
    }
  `;

  const data = await runQuery(query, { search, page, perPage });
  return data.Page;
}

function isSeasonCandidate(node) {
  return Boolean(node) && SEASON_FORMATS.has(node.format);
}

async function walkRelations(startMedia, direction, visited) {
  let current = startMedia;

  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    const edges = current.relations?.edges || [];
    const next = edges.find((edge) => edge.relationType === direction
      && isSeasonCandidate(edge.node)
      && !visited.has(edge.node.id));

    if (!next) {
      return;
    }

    const fullNext = await getMediaById(next.node.id);
    if (!fullNext || visited.has(fullNext.id)) {
      return;
    }

    visited.set(fullNext.id, fullNext);
    current = fullNext;
  }
}

// AniList models a franchise's seasons as separate Media entries linked via
// PREQUEL/SEQUEL relations rather than a single entry with season sub-objects,
// so building an accurate season list means walking that relation graph.
async function resolveSeasonChain(rootId) {
  const rootMedia = await getMediaById(Number(rootId));
  if (!rootMedia) {
    return [];
  }

  const visited = new Map([[rootMedia.id, rootMedia]]);
  await walkRelations(rootMedia, 'PREQUEL', visited);
  await walkRelations(rootMedia, 'SEQUEL', visited);

  const chain = Array.from(visited.values());
  chain.sort((a, b) => {
    const aTime = (a.startDate?.year || 0) * 10000 + (a.startDate?.month || 0) * 100 + (a.startDate?.day || 0);
    const bTime = (b.startDate?.year || 0) * 10000 + (b.startDate?.month || 0) * 100 + (b.startDate?.day || 0);
    return aTime - bTime || a.id - b.id;
  });

  return chain;
}

async function getEpisodesPage(id, start = 0, size = 50) {
  const media = await getMediaById(id);
  const totalEpisodes = Number(media?.episodes || 0);
  const page = Math.floor(start / size) + 1;

  const query = `
    query EpisodeSchedule($mediaId: Int!, $page: Int!, $perPage: Int!) {
      Page(page: $page, perPage: $perPage) {
        airingSchedules(mediaId: $mediaId, sort: EPISODE) {
          episode
          airingAt
        }
      }
    }
  `;

  let schedules = [];
  try {
    const data = await runQuery(query, { mediaId: Number(id), page, perPage: size });
    schedules = data.Page?.airingSchedules || [];
  } catch (error) {
    logger.warn({ mediaId: id, err: error }, 'AniList airing schedule lookup failed, falling back to synthesized episode dates');
    schedules = [];
  }

  const maxScheduledEpisode = schedules.reduce((maxEpisode, entry) => (
    Number(entry?.episode) > maxEpisode ? Number(entry.episode) : maxEpisode
  ), 0);
  const inferredTotal = Math.max(maxScheduledEpisode, start + Math.max(schedules.length, 1));
  const safeTotal = totalEpisodes > 0 ? totalEpisodes : inferredTotal;

  function formatAiringDate(airingAt) {
    if (!airingAt) {
      return buildDate(media.startDate);
    }

    return new Date(airingAt * 1000).toISOString().slice(0, 10);
  }

  const episodes = [];
  const limit = Math.min(start + size, safeTotal);
  const streamingEpisodesByNumber = new Map();
  (media.streamingEpisodes || []).forEach((ep) => {
    if (ep?.episode) {
      const episodeNum = Number(ep.episode);
      if (Number.isFinite(episodeNum)) {
        streamingEpisodesByNumber.set(episodeNum, ep);
      }
    }
  });

  for (let number = start + 1; number <= limit; number += 1) {
    const scheduled = schedules.find((entry) => entry.episode === number);
    const streaming = streamingEpisodesByNumber.get(number);

    episodes.push({
      episodeNumber: number,
      airDate: formatAiringDate(scheduled?.airingAt),
      title: streaming?.title || `Episode ${String(number).padStart(2, '0')}`,
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
// (e.g. "Enen no Shouboutai") while the default preferred title is English ("Fire
// Force") - scoring against resolveTitle() alone means the correct entry never gets an
// exact-match bonus in that case, letting an unrelated entry whose *resolved* title
// happens to match the search term outrank it.
function createMatchScore(media, term, parsed = {}) {
  const titleVariants = [media.title?.english, media.title?.romaji, media.title?.native]
    .filter(Boolean)
    .map((title) => title.toLowerCase());
  const normalizedTerm = String(term || '').toLowerCase();

  let score = 60;
  if (normalizedTerm && titleVariants.includes(normalizedTerm)) {
    score = 100;
  } else if (normalizedTerm && titleVariants.some((title) => title.includes(normalizedTerm))) {
    score = 92;
  }

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
  resolveSeasonChain
};
