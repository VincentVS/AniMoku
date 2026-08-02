const logger = require('../utils/logger');

const FANART_BASE_URL = 'https://webservice.fanart.tv/v3/tv';
const SQUARE_ASPECT_TOLERANCE = 0.1;

function pickSquareBackground(backgrounds = []) {
  const square = backgrounds.find((item) => {
    const width = Number(item.width);
    const height = Number(item.height);
    return width > 0 && height > 0 && Math.abs(width / height - 1) < SQUARE_ASPECT_TOLERANCE;
  });

  return square?.url || null;
}

// Opt-in: only queried when FANART_API_KEY is set and a TVDB id was resolved
// (see providers/crosswalk.js), since AniList itself only ever has one poster
// and one banner per entry and Fanart.tv is keyed by TheTVDB id, not AniList id.
async function getFanartImages(tvdbId) {
  const apiKey = process.env.FANART_API_KEY;
  if (!apiKey || !tvdbId) {
    return null;
  }

  let response;
  try {
    response = await fetch(`${FANART_BASE_URL}/${tvdbId}?api_key=${encodeURIComponent(apiKey)}`);
  } catch (error) {
    logger.warn({ tvdbId, err: error }, 'Fanart.tv request failed, falling back to AniList-only artwork');
    return null;
  }

  if (!response.ok) {
    logger.warn({ tvdbId, status: response.status }, 'Fanart.tv returned a non-ok response, falling back to AniList-only artwork');
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    logger.warn({ tvdbId, err: error }, 'Fanart.tv response was not valid JSON, falling back to AniList-only artwork');
    return null;
  }

  // `data.hdtvlogo` can be present as an empty array (no HD logos uploaded, but
  // `clearlogo` entries exist) - `[]` is truthy, so `a || b` alone would never fall
  // through to `clearlogo` in that case.
  const logoSource = data.hdtvlogo?.length ? data.hdtvlogo : (data.clearlogo || []);

  const images = {
    posters: (data.tvposter || []).map((item) => item.url).filter(Boolean),
    backgrounds: (data.showbackground || []).map((item) => item.url).filter(Boolean),
    logos: logoSource.map((item) => item.url).filter(Boolean),
    squareBackground: pickSquareBackground(data.showbackground)
  };

  logger.info({
    tvdbId,
    posters: images.posters.length,
    backgrounds: images.backgrounds.length,
    logos: images.logos.length,
    hasSquareBackground: Boolean(images.squareBackground)
  }, 'Fanart.tv artwork resolved');

  return images;
}

module.exports = { getFanartImages };
