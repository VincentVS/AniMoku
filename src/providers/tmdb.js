const logger = require('../utils/logger');
const { createCache } = require('../utils/cache');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';
const showCache = createCache();
const imagesCache = createCache();

// TMDB is the fallback provider for anything AniList doesn't cover - Western
// cartoons (Rick and Morty, etc.), Western live-action TV, and any other show
// that isn't in AniList's anime-only catalogue. Opt-in via either TMDB_API_KEY
// (v3 "API Key", sent as the api_key query param) or TMDB_ACCESS_TOKEN (v4 "API
// Read Access Token", sent as an Authorization: Bearer header) - TMDB's own docs
// say both give identical access to the v3 endpoints this provider uses, so
// either credential from the developer dashboard works. Same opt-in pattern as
// FANART_API_KEY: neither set means this provider is silently unavailable and
// only AniList results are used.
function isConfigured() {
  return Boolean(process.env.TMDB_ACCESS_TOKEN || process.env.TMDB_API_KEY);
}

async function tmdbFetch(pathname, params = {}, language = 'en-US') {
  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  const apiKey = process.env.TMDB_API_KEY;
  const url = new URL(`${TMDB_BASE_URL}${pathname}`);
  const headers = { Accept: 'application/json' };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    url.searchParams.set('api_key', apiKey);
  }

  url.searchParams.set('language', language);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`TMDB request failed with status ${response.status}`);
  }

  return response.json();
}

function toImageUrl(filePath) {
  return filePath ? `${TMDB_IMAGE_BASE_URL}${filePath}` : null;
}

async function getContentRating(id, language = 'en-US') {
  try {
    const data = await tmdbFetch(`/tv/${id}/content_ratings`, {}, language);
    const ratings = data.results || [];
    // Prefer IT (Italy), then US, else first available
    const preferred = ratings.find((r) => r.iso_3166_1 === 'IT') || ratings.find((r) => r.iso_3166_1 === 'US') || ratings[0];
    return preferred?.rating || null;
  } catch {
    return null;
  }
}

function toDateParts(dateString) {
  if (!dateString) {
    return {};
  }

  return {
    year: Number(dateString.slice(0, 4)),
    month: Number(dateString.slice(5, 7)),
    day: Number(dateString.slice(8, 10))
  };
}

// Normalized into the exact same shape providers/anilist.js produces (title with
// english/romaji/native keys, coverImage.large/extraLarge, bannerImage, genres as a
// flat string array, studios.nodes, characters.edges, startDate{year,month,day}), so
// utils/mapping.js and providers/anilist.js's createMatchScore can operate on a TMDB
// show exactly like an AniList one without knowing which backend it came from.
function toMediaShape(show) {
  return {
    id: show.id,
    title: {
      english: show.name || show.original_name || null,
      romaji: null,
      native: show.original_name && show.original_name !== show.name ? show.original_name : null
    },
    description: show.overview || '',
    episodes: show.number_of_episodes || null,
    duration: (show.episode_run_time || [])[0] || null,
    genres: (show.genres || []).map((genre) => genre.name),
    format: 'TV',
    averageScore: show.vote_average ? Math.round(show.vote_average * 10) : null,
    bannerImage: toImageUrl(show.backdrop_path),
    coverImage: {
      large: toImageUrl(show.poster_path),
      extraLarge: toImageUrl(show.poster_path)
    },
    startDate: toDateParts(show.first_air_date),
    isAdult: Boolean(show.adult),
    studios: { nodes: (show.production_companies || []).map((company) => ({ name: company.name })) },
    characters: { edges: [] },
    seasons: (show.seasons || []).filter((season) => season.season_number > 0)
  };
}

// TMDB seasons are lightweight sub-objects of a show (fetched via /tv/{id}, not their
// own top-level entity like an AniList season Media object), so they inherit most
// fields from the parent show and only override what's season-specific.
function toSeasonMediaShape(rootMedia, season) {
  const poster = toImageUrl(season.poster_path);

  return {
    id: rootMedia.id,
    title: rootMedia.title,
    description: season.overview || rootMedia.description,
    episodes: season.episode_count || null,
    duration: rootMedia.duration,
    genres: rootMedia.genres,
    format: 'TV',
    averageScore: rootMedia.averageScore,
    bannerImage: rootMedia.bannerImage,
    coverImage: {
      large: poster || rootMedia.coverImage.large,
      extraLarge: poster || rootMedia.coverImage.extraLarge
    },
    startDate: season.air_date ? toDateParts(season.air_date) : rootMedia.startDate,
    isAdult: rootMedia.isAdult,
    studios: rootMedia.studios,
    characters: { edges: [] },
    seasonNumber: season.season_number
  };
}

// Cached: getSeasonChain/getEpisodesPage/getShowImages all funnel through this for
// the same show id across metadata/children/grandchildren/images requests.
async function getTvById(id, language = 'en-US') {
  if (!isConfigured()) {
    return null;
  }

  try {
    return await showCache.wrap(`show:${id}:${language}`, async () => {
      const show = await tmdbFetch(`/tv/${id}`, {}, language);
      const media = toMediaShape(show);
      const contentRating = await getContentRating(id, language);
      if (contentRating) {
        media.contentRating = contentRating;
      }
      return media;
    });
  } catch (error) {
    logger.warn({ id, err: error }, 'TMDB show lookup failed');
    return null;
  }
}

async function searchTv(term, page = 1, language = 'en-US') {
  if (!isConfigured()) {
    return { media: [], pageInfo: { total: 0, currentPage: page, perPage: 20, hasNextPage: false } };
  }

  try {
    const data = await tmdbFetch('/search/tv', { query: term, page }, language);
    return {
      media: (data.results || []).map(toMediaShape),
      pageInfo: {
        total: data.total_results || 0,
        currentPage: data.page || page,
        perPage: 20,
        hasNextPage: (data.page || page) < (data.total_pages || 1)
      }
    };
  } catch (error) {
    logger.warn({ term, err: error }, 'TMDB search failed');
    return { media: [], pageInfo: { total: 0, currentPage: page, perPage: 20, hasNextPage: false } };
  }
}

// Equivalent of providers/anilist.js's resolveSeasonChain: the full ordered list of
// seasons for a show, each shaped like a season-level "media" object. TMDB already
// exposes the season list directly on the show resource, so there's no relation
// graph to walk the way AniList's franchise-as-separate-entries model requires.
async function getSeasonChain(rootId, language = 'en-US') {
  const rootMedia = await getTvById(rootId, language);
  if (!rootMedia) {
    return [];
  }

  return rootMedia.seasons
    .slice()
    .sort((a, b) => a.season_number - b.season_number)
    .map((season) => toSeasonMediaShape(rootMedia, season));
}

async function getEpisodesPage(rootId, seasonNumber, start = 0, size = 50) {
  if (!isConfigured()) {
    return { media: null, episodes: [], totalSize: 0 };
  }

  const rootMedia = await getTvById(rootId);
  if (!rootMedia) {
    return { media: null, episodes: [], totalSize: 0 };
  }

  const seasonStub = rootMedia.seasons.find((season) => season.season_number === seasonNumber);
  const media = seasonStub ? toSeasonMediaShape(rootMedia, seasonStub) : rootMedia;

  try {
    const data = await tmdbFetch(`/tv/${rootId}/season/${seasonNumber}`);
    const allEpisodes = (data.episodes || []).map((episode) => ({
      episodeNumber: episode.episode_number,
      airDate: episode.air_date || null,
      title: episode.name || `Episode ${String(episode.episode_number).padStart(2, '0')}`,
      summary: episode.overview || ''
    }));

    return {
      media,
      episodes: allEpisodes.slice(start, start + size),
      totalSize: allEpisodes.length
    };
  } catch (error) {
    logger.warn({ rootId, seasonNumber, err: error }, 'TMDB season episode lookup failed');
    return { media, episodes: [], totalSize: 0 };
  }
}

const SQUARE_ASPECT_TOLERANCE = 0.1;

function pickSquareBackground(backdrops = []) {
  const square = backdrops.find((item) => {
    const width = Number(item.width);
    const height = Number(item.height);
    return width > 0 && height > 0 && Math.abs(width / height - 1) < SQUARE_ASPECT_TOLERANCE;
  });

  return square ? toImageUrl(square.file_path) : null;
}

// TMDB's show-level `/images` endpoint only ever returns the root show's own
// posters/backdrops/logos, never a given season's - season-specific art lives
// under the separate `/tv/{id}/season/{n}/images` endpoint (posters only, no
// backdrops/logos), so a season request needs both calls merged.
async function getSeasonImages(id, seasonNumber) {
  try {
    return await imagesCache.wrap(`season-images:${id}:${seasonNumber}`, async () => {
      const data = await tmdbFetch(`/tv/${id}/season/${seasonNumber}/images`);
      return (data.posters || []).map((item) => toImageUrl(item.file_path)).filter(Boolean);
    });
  } catch (error) {
    logger.warn({ id, seasonNumber, err: error }, 'TMDB season image lookup failed');
    return [];
  }
}

// Unlike AniList (one poster/banner per entry, needing Fanart.tv via a TVDB id
// crosswalk for anything extra - see providers/fanart.js), TMDB already exposes a
// full gallery of posters/backdrops/logos directly by its own id, no crosswalk
// needed at all. `seasonNumber` is only passed when the request is for a season
// entry (not the root show or an episode) - its posters are prepended so they take
// priority over the show-level ones in Plex's picker while still offering both.
async function getShowImages(id, seasonNumber) {
  if (!isConfigured()) {
    return {};
  }

  try {
    const [data, seasonPosters] = await Promise.all([
      imagesCache.wrap(`show-images:${id}`, () => tmdbFetch(`/tv/${id}/images`)),
      seasonNumber ? getSeasonImages(id, seasonNumber) : Promise.resolve([])
    ]);
    const showPosters = (data.posters || []).map((item) => toImageUrl(item.file_path)).filter(Boolean);

    return {
      posters: [...seasonPosters, ...showPosters],
      backgrounds: (data.backdrops || []).map((item) => toImageUrl(item.file_path)).filter(Boolean),
      logos: (data.logos || []).map((item) => toImageUrl(item.file_path)).filter(Boolean),
      squareBackground: pickSquareBackground(data.backdrops)
    };
  } catch (error) {
    logger.warn({ id, err: error }, 'TMDB image gallery lookup failed');
    return {};
  }
}

module.exports = {
  isConfigured,
  getTvById,
  searchTv,
  getSeasonChain,
  getEpisodesPage,
  getShowImages,
  toMediaShape
};
