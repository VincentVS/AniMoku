const logger = require('../utils/logger');
const { createCache } = require('../utils/cache');

const TVDB_BASE_URL = 'https://api4.thetvdb.com/v4';
// TVDB v4 tokens last a month: re-login well before that.
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A series' episodes come in pages of 500: enough for any long runner.
const MAX_EPISODE_PAGES = 20;
const seasonsCache = createCache();

let tokenPromise = null;
let tokenAt = 0;

// TheTVDB is the source of the season split that release filenames, Sonarr and
// Jellyfin follow. It is only asked for that split, and only when neither the Fribb
// crosswalk nor TMDB know it: a single AniList entry that TVDB splits into seasons and
// TMDB keeps as one. Opt-in via TVDB_API_KEY (a v4 project or user key; TVDB_PIN too
// for a user-supported key): unset, this provider is silently unavailable.
function isConfigured() {
  return Boolean(process.env.TVDB_API_KEY);
}

function login() {
  const body = { apikey: process.env.TVDB_API_KEY };
  if (process.env.TVDB_PIN) {
    body.pin = process.env.TVDB_PIN;
  }
  return fetch(`${TVDB_BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`TVDB login failed with status ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      const token = data?.data?.token;
      if (!token) {
        throw new Error('TVDB login returned no token');
      }
      return token;
    });
}

function getToken(renew = false) {
  if (renew || !tokenPromise || Date.now() - tokenAt > TOKEN_MAX_AGE_MS) {
    tokenAt = Date.now();
    tokenPromise = login().catch((error) => {
      tokenPromise = null;
      throw error;
    });
  }
  return tokenPromise;
}

async function tvdbFetch(pathname, retried = false) {
  const token = await getToken();
  const response = await fetch(`${TVDB_BASE_URL}${pathname}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
  if (response.status === 401 && !retried) {
    await getToken(true);
    return tvdbFetch(pathname, true);
  }
  if (!response.ok) {
    throw new Error(`TVDB request failed with status ${response.status}`);
  }
  return response.json();
}

// The series' regular seasons in TVDB's default (aired) order, in the shape of
// tmdb.getTvdbOrder: { seasons: [{ seasonNumber, first, last }], seasonStarts }, where
// first/last index the series' regular episodes in that order. seasonStarts is empty:
// it maps TMDB seasons, which these indexes don't follow. null when the series has no
// regular episodes or TVDB is unavailable (not cached: retried on the next request).
async function getSeasonOrder(tvdbId) {
  if (!isConfigured() || !tvdbId) {
    return null;
  }

  try {
    return await seasonsCache.wrap(`season-order:${tvdbId}`, async () => {
      const episodes = [];
      for (let page = 0; page < MAX_EPISODE_PAGES; page += 1) {
        const data = await tvdbFetch(`/series/${Number(tvdbId)}/episodes/default?page=${page}`);
        episodes.push(...(data?.data?.episodes || []));
        if (!data?.links?.next) {
          break;
        }
      }

      const regular = episodes
        .filter((episode) => Number(episode.seasonNumber) > 0)
        .sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
      const seasons = [];
      regular.forEach((episode, index) => {
        const last = seasons[seasons.length - 1];
        if (last?.seasonNumber === episode.seasonNumber) {
          last.last = index;
        } else {
          seasons.push({ seasonNumber: episode.seasonNumber, first: index, last: index });
        }
      });
      return seasons.length ? { seasons, seasonStarts: new Map(), source: 'tvdb' } : null;
    });
  } catch (error) {
    logger.warn({ tvdbId, err: error }, 'TVDB season lookup failed');
    return null;
  }
}

module.exports = { isConfigured, getSeasonOrder };
