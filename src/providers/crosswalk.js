const logger = require('../utils/logger');

const DATASET_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';

let indexPromise = null;

// Fribb/anime-lists is a community-maintained id-mapping dataset (the same one
// Sonarr/HAMA rely on) with both anilist_id and tvdb_id on the same record, which
// AniList itself has no field for and TheTVDB has no way to look up by AniList id.
async function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch(DATASET_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Crosswalk dataset request failed with status ${response.status}`);
        }
        return response.json();
      })
      .then((entries) => {
        const index = new Map();
        for (const entry of entries) {
          if (entry.anilist_id && entry.tvdb_id) {
            index.set(Number(entry.anilist_id), Number(entry.tvdb_id));
          }
        }
        logger.info({ entries: index.size }, 'Fribb anime-lists id crosswalk loaded');
        return index;
      })
      .catch((error) => {
        indexPromise = null;
        logger.warn({ err: error }, 'Fribb anime-lists crosswalk fetch failed, TVDB id resolution unavailable');
        throw error;
      });
  }

  return indexPromise;
}

async function getTvdbId(anilistId) {
  try {
    const index = await loadIndex();
    const tvdbId = index.get(Number(anilistId)) || null;
    if (!tvdbId) {
      logger.info({ anilistId }, 'No TVDB crosswalk entry for this AniList id, Fanart.tv artwork will be unavailable');
    }
    return tvdbId;
  } catch (error) {
    return null;
  }
}

module.exports = { getTvdbId };
