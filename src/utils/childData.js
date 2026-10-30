const { resolveSeasonChainWithDetours, getEpisodesPage } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
const { getTvdbPlacement, getExternalIds } = require('../providers/crosswalk');
const anidb = require('../providers/anidb');
const { mapSeasonMetadata, mapEpisodeMetadata } = require('./mapping');
const { DEFAULT_LANGUAGE } = require('./language');
const { isAbsoluteOrder } = require('./guid');
const { loadSources, enrichEpisodes } = require('./episodeSources');

// Formats whose Fribb TMDB id is a TV show: a movie's or special's would be a TMDB
// movie id (or another show), useless for looking up the franchise's episodes.
const SERIES_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);

function layoutOrder(provider) {
  return isAbsoluteOrder(provider) ? 'absolute' : 'tvdb';
}

// AniList splits a franchise into one Media entry per cour, while TheTVDB - which is
// what release filenames (S03E13), Sonarr and Jellyfin follow - often groups several
// of them into one season: Fire Force's "San no Shou" and "San no Shou Part 2" are
// both TVDB season 3 (episodes 1-12 and 13-25). Numbering seasons by position in the
// AniList chain would call Part 2 "season 4", so Plex couldn't match S03E13+ files to
// it and the season numbers would differ from Jellyfin's.
//
// When the Fribb crosswalk maps the root entry to a TVDB season, every entry of the
// chain is placed where TVDB puts it (season + episode offset): entries TVDB lists
// under another series are left out (they live in another show folder), and entries
// not mapped yet (a season that just started airing) are appended as new seasons.
// Without a mapping for the root, seasons fall back to chain position.
// A movie/OVA/special the chain passes through joins the layout only when Fribb puts
// it in a regular season of the same TVDB series (Attack on Titan's "Final Chapters"
// is S04E29-30); in season 0 or unmapped it stays out, as a separate Plex item.
//
// order 'absolute' then merges every regular season into season 1, numbered
// straight through (S01E103 naming), keeping specials in season 0.
async function resolveSeasonLayout(rootId, order = 'tvdb') {
  const { chain: fullChain, detours } = await resolveSeasonChainWithDetours(rootId);
  if (!fullChain.length) {
    return null;
  }

  const rootMedia = fullChain.find((entry) => entry.id === Number(rootId)) || fullChain[0];
  const chain = await keepRootSeries(fullChain, rootMedia);
  const placements = await Promise.all(chain.map((entry) => getTvdbPlacement(entry.id)));
  const rootPlacement = placements[chain.indexOf(rootMedia)];

  let parts;
  if (rootPlacement) {
    const sameSeries = chain
      .map((media, order) => ({ media, order, placement: placements[order] }))
      .filter(({ placement }) => !placement || placement.tvdbId === rootPlacement.tvdbId);
    let lastSeason = Math.max(...sameSeries.map(({ placement }) => placement?.season ?? 0));
    parts = sameSeries.map(({ media, order, placement }) => (placement
      ? { media, order, seasonNumber: placement.season, offset: placement.episodeOffset }
      : { media, order, seasonNumber: (lastSeason += 1), offset: 0 }));
    const [detourPlacements, detourIds] = await Promise.all([
      Promise.all(detours.map((entry) => getTvdbPlacement(entry.id))),
      Promise.all(detours.map((entry) => getExternalIds(entry.id)))
    ]);
    let previous = null;
    detours.forEach((media, index) => {
      const placement = detourPlacements[index];
      if (placement?.tvdbId === rootPlacement.tvdbId && placement.season > 0) {
        previous = {
          media, order: chain.length + index, seasonNumber: placement.season, offset: placement.episodeOffset
        };
        parts.push(previous);
      } else if (previous && !Object.keys(detourIds[index]).length) {
        // Not in Fribb yet, right after an included one (the "Final Chapters" second
        // half): it continues the same season, and the same AniDB anime (AniDB keeps
        // both halves in one), numbered after it; the offset is fixed up below.
        previous = {
          media, order: chain.length + index, seasonNumber: previous.seasonNumber, offset: previous.offset + 1, continues: true
        };
        parts.push(previous);
      } else {
        previous = null;
      }
    });
  } else {
    parts = chain.map((media, order) => ({ media, order, seasonNumber: order + 1, offset: 0 }));
  }

  const bySeason = new Map();
  for (const part of parts) {
    bySeason.set(part.seasonNumber, [...(bySeason.get(part.seasonNumber) || []), part]);
  }

  const seasons = Array.from(bySeason.entries())
    .sort(([a], [b]) => a - b)
    .map(([seasonNumber, seasonParts]) => {
      seasonParts.sort((a, b) => a.offset - b.offset || a.order - b.order);
      // Guard against overlapping offsets in the dataset (two parts both at 0):
      // stack them by episode count instead of letting their episodes collide.
      let nextFree = 0;
      for (const part of seasonParts) {
        part.offset = Math.max(part.offset, nextFree);
        nextFree = part.offset + (Number(part.media.episodes) || 0);
      }
      return {
        seasonNumber,
        parts: seasonParts.map(({ media, offset, continues }) => (continues ? { media, offset, continues } : { media, offset }))
      };
    });

  await annotateParts(seasons, rootMedia);

  return {
    rootMedia,
    aligned: Boolean(rootPlacement),
    order,
    seasons: order === 'absolute' ? toAbsoluteSeasons(seasons) : seasons
  };
}

// How many episodes an entry has: AniList's count, else (still airing) the airing
// schedule's. Only needed for entries something else is numbered after.
async function countEpisodes(media) {
  if (Number(media.episodes) > 0) {
    return Number(media.episodes);
  }
  try {
    return (await getEpisodesPage(media.id, 0, 0)).totalSize || 0;
  } catch {
    return 0;
  }
}

// Adds to every part what numbering it across sources needs:
//   absoluteOffset  episodes of the franchise's regular seasons before it
//   tmdb            { id, offset }: TMDB show and position in its regular episodes
//   anidb           { aid, offset }: AniDB anime and position in its episode list
// TMDB and AniDB offsets count the episodes of earlier parts mapped to the same
// show/anime: the franchise-absolute position for TMDB (one show per franchise),
// usually 0 for AniDB (one anime per AniList entry).
async function annotateParts(seasons, rootMedia) {
  const allParts = seasons.flatMap((season) => season.parts);
  const lastPart = allParts[allParts.length - 1];
  const [ids, counts, rootIds] = await Promise.all([
    Promise.all(allParts.map((part) => getExternalIds(part.media.id))),
    Promise.all(allParts.map((part) => (part === lastPart ? Number(part.media.episodes) || 0 : countEpisodes(part.media)))),
    getExternalIds(rootMedia.id)
  ]);
  allParts.forEach((part, index) => {
    part.ids = ids[index];
    part.count = counts[index];
  });

  const rootTmdb = rootIds.tmdb || null;
  const tmdbNext = new Map();
  const anidbNext = new Map();
  let base = 0;
  for (const season of seasons) {
    const regular = season.seasonNumber > 0;
    let length = 0;
    let previousPart = null;
    for (const part of season.parts) {
      if (regular) {
        part.absoluteOffset = base + part.offset;
        length = Math.max(length, part.offset + part.count);
        const tmdbId = (SERIES_FORMATS.has(part.media.format) && part.ids.tmdb) || rootTmdb;
        if (tmdbId) {
          part.tmdb = { id: tmdbId, offset: tmdbNext.get(tmdbId) || 0 };
          tmdbNext.set(tmdbId, part.tmdb.offset + part.count);
        }
      }
      const aid = part.ids.anidb || (part.continues && previousPart?.anidb?.aid);
      if (aid) {
        part.anidb = { aid, offset: anidbNext.get(aid) || 0 };
        anidbNext.set(aid, part.anidb.offset + part.count);
      }
      previousPart = part;
    }
    if (regular) {
      base += length;
    }
  }
}

// Specials stay in season 0; every regular season is chained into season 1.
function toAbsoluteSeasons(seasons) {
  const regular = seasons.filter((season) => season.seasonNumber > 0);
  if (!regular.length) {
    return seasons;
  }
  const merged = {
    seasonNumber: 1,
    parts: regular.flatMap((season) => season.parts.map((part) => ({ ...part, offset: part.absoluteOffset })))
  };
  return [...seasons.filter((season) => season.seasonNumber === 0), merged];
}

// AniList's PREQUEL/SEQUEL chain runs across what Plex libraries (and TVDB) keep as
// separate shows - Naruto -> Naruto Shippuden -> Boruto, or One Piece's one-shot
// "MONSTERS" ONA - and long runners like these have no TVDB season mapping in Fribb
// (TVDB splits them into arcs), so the layout falls back to chain position: a
// "Naruto Shippuden" library would get Naruto as season 1. When the root's TVDB
// series is known, the chain keeps only entries of that series, plus entries Fribb
// doesn't know at all (announced, not mapped yet) that directly follow or precede
// one of them. Entries Fribb places in another series, or in none, are dropped.
async function keepRootSeries(chain, rootMedia) {
  const ids = await Promise.all(chain.map((entry) => getExternalIds(entry.id)));
  const rootSeries = ids[chain.indexOf(rootMedia)].tvdb;
  if (!rootSeries) {
    return chain;
  }

  // 'same' / 'other' for mapped entries, null for entries Fribb has no record of.
  const membership = ids.map((entryIds) => {
    if (!Object.keys(entryIds).length) {
      return null;
    }
    return entryIds.tvdb === rootSeries ? 'same' : 'other';
  });
  const nearestKnown = (index, step) => {
    for (let i = index + step; i >= 0 && i < chain.length; i += step) {
      if (membership[i]) {
        return membership[i];
      }
    }
    return null;
  };

  return chain.filter((entry, index) => entry === rootMedia
    || membership[index] === 'same'
    || (membership[index] === null && (nearestKnown(index, -1) || nearestKnown(index, 1)) === 'same'));
}

// A season key names its first part (`-sN[-a<id>]`); one that no longer matches the
// layout (e.g. `-s4-a179062` from before TVDB alignment) resolves to nothing.
function findLayoutSeason(layout, rootId, seasonNumber, seasonAnilistId) {
  const season = layout?.seasons.find((entry) => entry.seasonNumber === Number(seasonNumber));
  if (!season || season.parts[0].media.id !== Number(seasonAnilistId || rootId)) {
    return null;
  }
  return season;
}

// Shared by routes/children.js (paginated /children endpoint) and routes/metadata.js
// (Plex's includeChildren=1 embed, which requires every season back with no paging -
// see docs/Metadata.md in plexinc/tmdb-example-provider: "it is expected that all the
// child objects be returned in this array").
async function getAllSeasons(provider, rootId, language = DEFAULT_LANGUAGE) {
  if (provider === 'tmdb') {
    const chain = await tmdb.getSeasonChain(rootId, language);
    if (!chain.length) {
      return null;
    }
    // TMDB season entries carry the show's own id (see providers/tmdb.js), so the
    // root show itself must be re-fetched directly rather than found in the chain.
    const rootMedia = await tmdb.getTvById(rootId, language);
    const seasons = chain.map((seasonMedia, index) => mapSeasonMetadata(
      seasonMedia,
      seasonMedia.seasonNumber || index + 1,
      rootMedia,
      provider
    ));
    return { rootMedia, seasons };
  }

  const layout = await resolveSeasonLayout(rootId, layoutOrder(provider));
  if (!layout) {
    return null;
  }

  anidb.prefetch(layout.seasons.flatMap((season) => season.parts.map((part) => part.anidb?.aid)));
  const seasons = layout.seasons.map((season) => mapSeasonMetadata(
    season.parts[0].media,
    season.seasonNumber,
    layout.rootMedia,
    provider
  ));
  return { rootMedia: layout.rootMedia, seasons };
}

// Shared by routes/grandchildren.js (paginated /grandchildren endpoint) and
// routes/metadata.js (Plex's includeChildren=1 embed on a season, which requires
// every episode back with no paging, same as getAllSeasons above).
async function getAllEpisodes(provider, rootId, seasonNumber, seasonAnilistId, language = DEFAULT_LANGUAGE) {
  if (provider === 'tmdb') {
    const { media, episodes } = await tmdb.getEpisodesPage(rootId, seasonNumber, 0, Number.MAX_SAFE_INTEGER, language);
    if (!media) {
      return null;
    }
    const rootMedia = (await tmdb.getTvById(rootId, language)) || media;
    return {
      media,
      rootMedia,
      episodes: episodes.map((episode) => mapEpisodeMetadata(media, { ...episode, parentIndex: seasonNumber }, rootMedia, provider))
    };
  }

  const layout = await resolveSeasonLayout(rootId, layoutOrder(provider));
  const season = findLayoutSeason(layout, rootId, seasonNumber, seasonAnilistId);
  if (!season) {
    return null;
  }

  const seasonMediaId = season.parts[0].media.id;
  const sources = await Promise.all(season.parts.map((part) => loadSources(part, language)));
  const episodes = [];
  let media = null;
  for (const [index, part] of season.parts.entries()) {
    const page = await getEpisodesPage(part.media.id, 0, Number.MAX_SAFE_INTEGER);
    if (!page.media) {
      continue;
    }
    media = media || page.media;
    episodes.push(...enrichEpisodes(part, page.episodes, sources[index]).map((episode) => mapEpisodeMetadata(
      page.media,
      { ...episode, parentIndex: season.seasonNumber },
      layout.rootMedia,
      provider,
      { offset: part.offset, seasonMediaId }
    )));
  }

  return media ? { media, rootMedia: layout.rootMedia, episodes } : null;
}

// AniList episode keys (`anilist-<root>-eNN[-a<entryId>]`) carry neither a season
// number nor the TVDB offset - both depend on where the layout above places that
// entry. Returns { seasonNumber, seasonMediaId, offset }, or null when the entry is
// no longer part of this show (a stale key).
async function resolveEpisodePlacement(rootId, seasonAnilistId, provider = 'anilist') {
  const layout = await resolveSeasonLayout(rootId, layoutOrder(provider));
  const entryId = Number(seasonAnilistId || rootId);
  for (const season of layout?.seasons || []) {
    const part = season.parts.find((entry) => entry.media.id === entryId);
    if (part) {
      return { seasonNumber: season.seasonNumber, seasonMediaId: season.parts[0].media.id, offset: part.offset };
    }
  }
  return null;
}

module.exports = {
  layoutOrder,
  resolveSeasonLayout,
  findLayoutSeason,
  getAllSeasons,
  getAllEpisodes,
  resolveEpisodePlacement
};
