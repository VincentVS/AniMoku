const logger = require('../utils/logger');
const { createCache } = require('../utils/cache');

const FANART_BASE_URL = 'https://webservice.fanart.tv/v3/tv';
const SQUARE_ASPECT_TOLERANCE = 0.1;
// Keyed by tvdbId only (not tvdbId+season) - Fanart.tv's response already contains
// every season's posters/thumbs in one payload, so every season of the same show
// shares this one cached fetch instead of hitting the API once per season.
const fanartCache = createCache();

function pickSquareBackground(backgrounds = []) {
  const square = backgrounds.find((item) => {
    const width = Number(item.width);
    const height = Number(item.height);
    return width > 0 && height > 0 && Math.abs(width / height - 1) < SQUARE_ASPECT_TOLERANCE;
  });

  return square?.url || null;
}

// Fanart.tv tags `seasonposter`/`seasonthumb` entries with a `season` field that is
// either the season number (as a string) or the literal "all" for artwork meant to
// apply to every season - filtering on both keeps season-specific art plus any
// show-wide season art, in preference order (season-specific first).
function pickSeasonImages(items = [], seasonNumber) {
  if (!seasonNumber) {
    return [];
  }
  const target = String(seasonNumber);
  return items
    .filter((item) => item.season === target || item.season === 'all')
    .sort((a, b) => (a.season === target ? -1 : 0) - (b.season === target ? -1 : 0));
}

// Cached per tvdbId (not per-season) since one Fanart.tv response already
// contains every season's posters/thumbs - every season of the same show shares
// this fetch instead of hitting the API once per season. A rejection here (bad
// response, network error, invalid JSON) is never cached, so a transient failure
// doesn't get remembered and returned once Fanart.tv recovers.
async function fetchFanartData(tvdbId, apiKey) {
  return fanartCache.wrap(`fanart:${tvdbId}`, async () => {
    const response = await fetch(`${FANART_BASE_URL}/${tvdbId}?api_key=${encodeURIComponent(apiKey)}`);
    if (!response.ok) {
      throw new Error(`Fanart.tv request failed with status ${response.status}`);
    }
    return response.json();
  });
}

// Opt-in: only queried when FANART_API_KEY is set and a TVDB id was resolved
// (see providers/crosswalk.js), since AniList itself only ever has one poster
// and one banner per entry and Fanart.tv is keyed by TheTVDB id, not AniList id.
// `seasonNumber` is only passed when the request is for a season entry (not the
// root show or an episode) - Fanart.tv only exposes season-specific art via the
// `seasonposter`/`seasonthumb` fields on this same show-level response, there is
// no separate per-season endpoint.
async function getFanartImages(tvdbId, seasonNumber) {
  const apiKey = process.env.FANART_API_KEY;
  if (!apiKey || !tvdbId) {
    return null;
  }

  let data;
  try {
    data = await fetchFanartData(tvdbId, apiKey);
  } catch (error) {
    logger.warn({ tvdbId, err: error }, 'Fanart.tv request failed, falling back to AniList-only artwork');
    return null;
  }

  // `data.hdtvlogo` can be present as an empty array (no HD logos uploaded, but
  // `clearlogo` entries exist) - `[]` is truthy, so `a || b` alone would never fall
  // through to `clearlogo` in that case.
  const logoSource = data.hdtvlogo?.length ? data.hdtvlogo : (data.clearlogo || []);
  const seasonPosters = pickSeasonImages(data.seasonposter, seasonNumber);
  const showPosters = (data.tvposter || []).map((item) => item.url).filter(Boolean);

  const images = {
    posters: [...seasonPosters.map((item) => item.url).filter(Boolean), ...showPosters],
    backgrounds: (data.showbackground || []).map((item) => item.url).filter(Boolean),
    logos: logoSource.map((item) => item.url).filter(Boolean),
    squareBackground: pickSquareBackground(data.showbackground)
  };

  logger.info({
    tvdbId,
    seasonNumber: seasonNumber || null,
    seasonPosters: seasonPosters.length,
    posters: images.posters.length,
    backgrounds: images.backgrounds.length,
    logos: images.logos.length,
    hasSquareBackground: Boolean(images.squareBackground)
  }, 'Fanart.tv artwork resolved');

  return images;
}

// The best poster made for exactly this TVDB season ("all" season art excluded), or
// null: what tells apart seasons that share one AniList entry, and with it one cover.
async function getSeasonPoster(tvdbId, seasonNumber) {
  const apiKey = process.env.FANART_API_KEY;
  if (!apiKey || !tvdbId || !seasonNumber) {
    return null;
  }

  try {
    const data = await fetchFanartData(tvdbId, apiKey);
    const poster = (data.seasonposter || []).find((item) => item.season === String(seasonNumber) && item.url);
    return poster?.url || null;
  } catch (error) {
    logger.warn({ tvdbId, err: error }, 'Fanart.tv request failed, keeping the AniList season cover');
    return null;
  }
}

module.exports = { getFanartImages, getSeasonPoster };
