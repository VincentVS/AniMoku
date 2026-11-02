const logger = require('../utils/logger');

const DATASET_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';

// New seasons get mapped in the dataset after they start airing, so a long-running
// container re-downloads it once a day instead of keeping the first copy forever.
const DATASET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let indexPromise = null;
let loadedAt = 0;

// Fribb has published themoviedb_id both as a plain number and as { tv, movie },
// and imdb_id both as a string and as an array - accept either shape.
function parseTmdbId(value) {
  const raw = value && typeof value === 'object' ? value.tv : value;
  return Number(raw) || null;
}

function parseImdbId(value) {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.find((id) => typeof id === 'string' && id.startsWith('tt')) || null;
}

function parseSeason(entry, source) {
  const season = entry.season?.[source];
  if (!Number.isInteger(season) || season < 0) {
    return null;
  }
  const offset = Number(entry.episode_offset?.[source]);
  return { season, episodeOffset: Number.isInteger(offset) && offset > 0 ? offset : 0 };
}

function fetchIndex() {
  return fetch(DATASET_URL)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Crosswalk dataset request failed with status ${response.status}`);
      }
      return response.json();
    })
    .then((entries) => {
      const index = new Map();
      // Reverse lookups (`tvdb:267440` -> [AniList ids]) for Plex's match `guid` hint.
      const byExternalId = new Map();
      for (const entry of entries) {
        if (!entry.anilist_id) {
          continue;
        }
        const anilistId = Number(entry.anilist_id);
        const ids = {
          tvdb: entry.tvdb_id ? Number(entry.tvdb_id) : null,
          tmdb: parseTmdbId(entry.themoviedb_id),
          imdb: parseImdbId(entry.imdb_id),
          anidb: Number(entry.anidb_id) || null
        };
        const tvdbSeason = ids.tvdb ? parseSeason(entry, 'tvdb') : null;
        const tmdbSeason = ids.tmdb ? parseSeason(entry, 'tmdb') : null;
        if (ids.tvdb || ids.tmdb || ids.imdb || ids.anidb) {
          index.set(anilistId, { ids, tvdbSeason, tmdbSeason });
        }
        const external = { ...ids, mal: Number(entry.mal_id) || null };
        for (const [source, id] of Object.entries(external)) {
          if (id) {
            const key = `${source}:${id}`;
            byExternalId.set(key, [...(byExternalId.get(key) || []), { anilistId, tvdbSeason, tmdbSeason }]);
          }
        }
      }
      index.byExternalId = byExternalId;
      logger.info({ entries: index.size }, 'Fribb anime-lists id crosswalk loaded');
      return index;
    });
}

// Fribb/anime-lists is a community-maintained id-mapping dataset (the same one
// Sonarr/HAMA rely on) with both anilist_id and tvdb_id on the same record, which
// AniList itself has no field for and TheTVDB has no way to look up by AniList id.
async function loadIndex() {
  if (indexPromise && loadedAt && Date.now() - loadedAt > DATASET_MAX_AGE_MS) {
    // Refresh in the background and keep serving the copy we have meanwhile.
    loadedAt = Date.now();
    const current = indexPromise;
    fetchIndex()
      .then((index) => {
        if (indexPromise === current) {
          indexPromise = Promise.resolve(index);
        }
      })
      .catch((error) => logger.warn({ err: error }, 'Fribb anime-lists crosswalk refresh failed, keeping the previous copy'));
  }

  if (!indexPromise) {
    indexPromise = fetchIndex()
      .then((index) => {
        loadedAt = Date.now();
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
    const tvdbId = index.get(Number(anilistId))?.ids.tvdb || null;
    if (!tvdbId) {
      logger.info({ anilistId }, 'No TVDB crosswalk entry for this AniList id, Fanart.tv artwork will be unavailable');
    }
    return tvdbId;
  } catch (error) {
    return null;
  }
}

// External ids exposed to Plex as the show's Guid array, which is what lets other
// tools (JellyPlex-Watched, Trakt, Kometa...) match this show against Jellyfin/TVDB
// entries - the custom tv.plex.agents.custom.* guid alone is meaningless to them.
// Fails closed to {} like getTvdbId, so a crosswalk outage never breaks metadata.
async function getExternalIds(anilistId) {
  try {
    const index = await loadIndex();
    return index.get(Number(anilistId))?.ids || {};
  } catch (error) {
    return {};
  }
}

// Where TVDB places an AniList entry: { tvdbId, season, episodeOffset }, e.g. Fire
// Force "San no Shou Part 2" is TVDB season 3 starting after episode 12. Returns
// null when the entry isn't mapped (or the dataset is unavailable).
async function getTvdbPlacement(anilistId) {
  try {
    const index = await loadIndex();
    const entry = index.get(Number(anilistId));
    return entry?.tvdbSeason ? { tvdbId: entry.ids.tvdb, ...entry.tvdbSeason } : null;
  } catch (error) {
    return null;
  }
}

// Same as getTvdbPlacement, for TMDB: { tmdbId, season, episodeOffset }, e.g. a
// sequel's second cour is TMDB season 2 after episode 13.
async function getTmdbPlacement(anilistId) {
  try {
    const index = await loadIndex();
    const entry = index.get(Number(anilistId));
    return entry?.tmdbSeason ? { tmdbId: entry.ids.tmdb, ...entry.tmdbSeason } : null;
  } catch (error) {
    return null;
  }
}

// The AniList entry an external id points at. TVDB and TMDB ids name a whole series
// that Fribb splits over several AniList entries (one per cour), so the series'
// first season (season 1, no episode offset) is preferred: that's the entry the
// season layout is built from. A TMDB id is ranked on Fribb's TMDB seasons, which long
// runners have where TVDB ones are missing (the series is TMDB season 1 with no TVDB
// season, its sequel TVDB season 17 and TMDB season 2). Returns null when nothing is mapped.
async function findAnilistId(source, externalId) {
  try {
    const index = await loadIndex();
    const normalizedId = source === 'imdb' ? String(externalId) : Number(externalId);
    const matches = index.byExternalId?.get(`${source}:${normalizedId}`) || [];
    const rank = (match) => {
      const season = (source === 'tmdb' && match.tmdbSeason) || match.tvdbSeason;
      if (!season) {
        return 1000;
      }
      return (season.season === 0 ? 500 : season.season * 10) + (season.episodeOffset ? 1 : 0);
    };
    const best = matches.slice().sort((a, b) => rank(a) - rank(b) || a.anilistId - b.anilistId)[0];
    return best ? best.anilistId : null;
  } catch (error) {
    return null;
  }
}

// The entry a franchise's show should be keyed on: TVDB season 1 of the series this
// entry belongs to. A folder named after a sequel ("Mushoku Tensei II") or a romaji
// title shared by every season ("Kaguya-sama wa Kokurasetai") otherwise matches a
// later season's entry, and the show takes that season's title, year and poster.
// Returns the entry itself when it already is season 1, null when it isn't mapped.
async function findFranchiseRoot(anilistId) {
  const placement = await getTvdbPlacement(anilistId);
  if (!placement?.tvdbId) {
    return null;
  }
  if (placement.season === 1 && !placement.episodeOffset) {
    return Number(anilistId);
  }

  const rootId = await findAnilistId('tvdb', placement.tvdbId);
  const rootPlacement = rootId ? await getTvdbPlacement(rootId) : null;
  return rootPlacement?.season === 1 ? rootId : Number(anilistId);
}

module.exports = {
  getTvdbId, getExternalIds, getTvdbPlacement, getTmdbPlacement, findAnilistId, findFranchiseRoot
};
