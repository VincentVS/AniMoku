const logger = require('../utils/logger');
const { createCache } = require('../utils/cache');

const TVDB_BASE_URL = 'https://api4.thetvdb.com/v4';
const TVDB_ARTWORK_BASE_URL = 'https://artworks.thetvdb.com';
// TVDB v4 tokens last a month: re-login well before that.
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A series' episodes come in pages of 500: enough for any long runner.
const MAX_EPISODE_PAGES = 20;
const episodesCache = createCache();

// TVDB names languages by ISO 639-2 code; Plex's X-Plex-Language comes as it-IT.
const TVDB_LANGUAGES = {
  en: 'eng', it: 'ita', ja: 'jpn', fr: 'fra', de: 'deu', es: 'spa', pt: 'por', nl: 'nld', sv: 'swe',
  da: 'dan', fi: 'fin', no: 'nor', pl: 'pol', ru: 'rus', cs: 'ces', hu: 'hun', el: 'ell', tr: 'tur',
  he: 'heb', ko: 'kor', zh: 'zho', uk: 'ukr', ar: 'ara', th: 'tha', id: 'ind', vi: 'vie'
};

function toTvdbLanguage(language) {
  return TVDB_LANGUAGES[String(language || '').slice(0, 2).toLowerCase()] || 'eng';
}

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

// Every episode of the series in TVDB's default (aired) order, with names and
// overviews in `tvdbLanguage` when given (TVDB falls back to another language, or
// null, when it has no translation). Failures are thrown, so they aren't cached.
function getEpisodes(tvdbId, tvdbLanguage = '') {
  return episodesCache.wrap(`episodes:${tvdbId}:${tvdbLanguage}`, async () => {
    const episodes = [];
    const suffix = tvdbLanguage ? `/${tvdbLanguage}` : '';
    for (let page = 0; page < MAX_EPISODE_PAGES; page += 1) {
      const data = await tvdbFetch(`/series/${Number(tvdbId)}/episodes/default${suffix}?page=${page}`);
      episodes.push(...(data?.data?.episodes || []));
      if (!data?.links?.next) {
        break;
      }
    }
    return episodes;
  });
}

// The series' regular seasons in TVDB's default (aired) order, in the shape of
// tmdb.getTvdbOrder: { seasons: [{ seasonNumber, first, last }], seasonStarts }, where
// first/last index the series' regular episodes in that order. seasonStarts is empty:
// it maps TMDB seasons, which these indexes don't follow. Also:
//   absoluteOffsets  season -> what to add to an episode's number for its TVDB absolute
//                    number, the one Sonarr writes in "S02.E28" files. TVDB counts some
//                    specials in it, so it can skip numbers a straight count wouldn't.
//   specials         how many season 0 episodes the series has
// null when the series has no regular episodes or TVDB is unavailable (not cached:
// retried on the next request).
async function getSeasonOrder(tvdbId) {
  if (!isConfigured() || !tvdbId) {
    return null;
  }

  try {
    const episodes = await getEpisodes(tvdbId);
    const regular = episodes
      .filter((episode) => Number(episode.seasonNumber) > 0)
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
    const seasons = [];
    const absoluteOffsets = new Map();
    regular.forEach((episode, index) => {
      const last = seasons[seasons.length - 1];
      if (last?.seasonNumber === episode.seasonNumber) {
        last.last = index;
      } else {
        seasons.push({ seasonNumber: episode.seasonNumber, first: index, last: index });
      }
      if (!absoluteOffsets.has(episode.seasonNumber) && Number(episode.absoluteNumber) > 0) {
        absoluteOffsets.set(episode.seasonNumber, Number(episode.absoluteNumber) - Number(episode.number));
      }
    });
    if (!seasons.length) {
      return null;
    }
    const specials = episodes.filter((episode) => Number(episode.seasonNumber) === 0).length;
    return {
      seasons, seasonStarts: new Map(), source: 'tvdb', absoluteOffsets, specials
    };
  } catch (error) {
    logger.warn({ tvdbId, err: error }, 'TVDB season lookup failed');
    return null;
  }
}

function toArtworkUrl(image) {
  if (!image) {
    return null;
  }
  return /^https?:\/\//.test(image) ? image : `${TVDB_ARTWORK_BASE_URL}${image}`;
}

// The series' specials (TVDB season 0), numbered as TVDB numbers them - the S00E05 of
// Sonarr's files - with title and summary in the library language, else English, and
// the absolute number TVDB gives some of them (0 when none): Sonarr's S00.E{absolute}
// names such a special by it (a movie as S00.E202).
// [] when TVDB is unavailable.
async function getSpecials(tvdbId, language) {
  if (!isConfigured() || !tvdbId) {
    return [];
  }

  try {
    const tvdbLanguage = toTvdbLanguage(language);
    const [localized, english] = await Promise.all([
      getEpisodes(tvdbId, tvdbLanguage),
      tvdbLanguage === 'eng' ? null : getEpisodes(tvdbId, 'eng')
    ]);
    const englishByNumber = new Map((english || [])
      .filter((episode) => Number(episode.seasonNumber) === 0)
      .map((episode) => [episode.number, episode]));
    return localized
      .filter((episode) => Number(episode.seasonNumber) === 0 && Number(episode.number) > 0)
      .sort((a, b) => a.number - b.number)
      .map((episode) => {
        const fallback = englishByNumber.get(episode.number);
        return {
          episodeNumber: Number(episode.number),
          absoluteNumber: Number(episode.absoluteNumber) || 0,
          title: episode.name || fallback?.name || null,
          summary: episode.overview || fallback?.overview || null,
          airDate: episode.aired || null,
          thumbnail: toArtworkUrl(episode.image),
          runtime: Number(episode.runtime) || null
        };
      });
  } catch (error) {
    logger.warn({ tvdbId, err: error }, 'TVDB specials lookup failed');
    return [];
  }
}

module.exports = {
  isConfigured, getSeasonOrder, getSpecials, toTvdbLanguage
};
