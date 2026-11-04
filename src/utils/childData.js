const { resolveSeasonChainWithDetours, getEpisodesPage } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
const { getTvdbPlacement, getTmdbPlacement, getExternalIds } = require('../providers/crosswalk');
const { getSeasonPoster } = require('../providers/fanart');
const anidb = require('../providers/anidb');
const { mapSeasonMetadata, mapEpisodeMetadata } = require('./mapping');
const { DEFAULT_LANGUAGE } = require('./language');
const { localizeMedia } = require('./localize');
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
// of them into one season: a third season's first and second cours ("Part 2") are
// both TVDB season 3 (episodes 1-12 and 13-25). Numbering seasons by position in the
// AniList chain would call Part 2 "season 4", so Plex couldn't match S03E13+ files to
// it and the season numbers would differ from Jellyfin's.
//
// When the Fribb crosswalk maps the root entry to a TVDB season, every entry of the
// chain is placed where TVDB puts it (season + episode offset): entries TVDB lists
// under another series are left out (they live in another show folder), and entries
// not mapped yet (a season that just started airing) are appended as new seasons.
// Without a mapping for the root, seasons follow TMDB's "TVDB Order" episode group
// when there is one (see placeByTvdbOrder), else chain position.
// A movie/OVA/special the chain passes through joins the layout only when Fribb puts
// it in a regular season of the same TVDB series (a "Final Chapters"
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

  let parts = rootPlacement ? null : await placeByTvdbOrder(chain, placements, rootMedia);
  const aligned = Boolean(rootPlacement || parts);
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
  } else if (!parts) {
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
        nextFree = part.offset + partSpan(part);
      }
      return {
        seasonNumber,
        parts: seasonParts.map(({
          media, offset, continues, start, length, tmdbBase
        }) => ({
          media,
          offset,
          ...(continues ? { continues } : {}),
          ...(start !== undefined ? { start, length, tmdbBase } : {})
        }))
      };
    });

  await annotateParts(seasons, rootMedia);

  return {
    rootMedia,
    aligned,
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

// Long runners keep hundreds of episodes in one AniList entry that TVDB splits into
// arc seasons (e.g. 366 episodes as TVDB seasons 1-16), and Fribb has no TVDB season
// for them. TMDB's "TVDB Order" episode group says which TMDB episodes make up each
// TVDB season, so every entry is positioned in TMDB's airing order - from Fribb's TMDB
// season/offset, else right after the previous entry, the root at the start - and cut
// where a TVDB season starts. Such a part holds episodes start+1..start+length of its
// entry (length null: up to the last one). Entries Fribb does place in a TVDB season
// (a sequel series filed as season 17) keep that placement; entries with no
// known position are appended as new seasons. Returns null without a usable group.
async function placeByTvdbOrder(chain, placements, rootMedia) {
  const rootIds = await getExternalIds(rootMedia.id);
  const order = rootIds.tmdb ? await tmdb.getTvdbOrder(rootIds.tmdb) : null;
  if (!order) {
    return null;
  }

  const [tmdbPlacements, counts] = await Promise.all([
    Promise.all(chain.map((entry) => getTmdbPlacement(entry.id))),
    Promise.all(chain.map(countEpisodes))
  ]);
  const lastSeason = order.seasons[order.seasons.length - 1];
  const parts = [];
  const unplaced = [];
  let nextStart = 0;
  chain.forEach((media, index) => {
    const tmdbPlacement = tmdbPlacements[index];
    let start = media === rootMedia ? 0 : nextStart;
    if (tmdbPlacement?.tmdbId === rootIds.tmdb && order.seasonStarts.has(tmdbPlacement.season)) {
      start = order.seasonStarts.get(tmdbPlacement.season) + tmdbPlacement.episodeOffset;
    }
    const end = start !== null && counts[index] > 0 ? start + counts[index] : Infinity;
    nextStart = end === Infinity ? null : end;

    const placement = placements[index];
    if (placement) {
      if (placement.tvdbId === rootIds.tvdb) {
        parts.push({ media, order: index, seasonNumber: placement.season, offset: placement.episodeOffset });
      }
      return;
    }
    if (start === null) {
      unplaced.push({ media, order: index });
      return;
    }

    const before = parts.length;
    for (const season of order.seasons) {
      // Episodes past the group's last season (still airing) stay in that season.
      const from = Math.max(season.first, start);
      const to = Math.min(season === lastSeason ? Infinity : season.last + 1, end);
      if (from < to) {
        parts.push({
          media,
          order: index,
          seasonNumber: season.seasonNumber,
          offset: from - season.first,
          start: from - start,
          length: to === Infinity ? null : to - from,
          tmdbBase: start
        });
      }
    }
    if (parts.length === before) {
      unplaced.push({ media, order: index });
    }
  });

  closeSeasonGaps(parts);
  let lastSeasonNumber = Math.max(0, ...parts.map((part) => part.seasonNumber));
  unplaced.forEach(({ media, order: index }) => {
    parts.push({ media, order: index, seasonNumber: (lastSeasonNumber += 1), offset: 0 });
  });
  return parts.length ? parts : null;
}

// The seasons cut by the TVDB-order group come from TVDB itself, while a sequel's
// Fribb season can lag behind a TVDB renumbering (a final act still filed as season 8
// when TVDB lists it as season 7, right after the long runner's six). TVDB seasons
// never skip a number, so Fribb-placed seasons past the cut ones are renumbered to
// follow them with no gap, in their original order.
function closeSeasonGaps(parts) {
  const lastCut = Math.max(0, ...parts.filter((part) => part.start !== undefined).map((part) => part.seasonNumber));
  if (!lastCut) {
    return;
  }
  const later = [...new Set(parts.map((part) => part.seasonNumber).filter((season) => season > lastCut))].sort((a, b) => a - b);
  const renumbered = new Map(later.map((season, index) => [season, lastCut + index + 1]));
  for (const part of parts) {
    part.seasonNumber = renumbered.get(part.seasonNumber) ?? part.seasonNumber;
  }
}

// How many of its entry's episodes a part shows (an estimate for still-airing ones).
function partSpan(part) {
  if (part.length != null) {
    return part.length;
  }
  return Math.max(0, (Number(part.media.episodes) || 0) - (part.start || 0));
}

// Whether a part holds its entry's episode N (one cut by placeByTvdbOrder holds a range).
function partHolds(part, episodeNumber) {
  const start = part.start || 0;
  return episodeNumber > start && (part.length == null || episodeNumber <= start + part.length);
}

// FILE_NUMBERING=absolute: files keep absolute numbers inside TVDB season folders
// (Sonarr's "S02.E21" with {absolute} as the episode).
function fileNumbersAreAbsolute() {
  return String(process.env.FILE_NUMBERING || '').trim().toLowerCase() === 'absolute';
}

// Added to an entry's own episode number to get its index in the season. Plex pairs
// files with a season's episodes by index, so with FILE_NUMBERING=absolute a regular
// season's episodes carry their absolute number (season 2 runs 21-41, not 1-21).
function displayOffset(part) {
  const offset = fileNumbersAreAbsolute() && part.absoluteOffset !== undefined ? part.absoluteOffset : part.offset;
  return offset - (part.start || 0);
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
    Promise.all(allParts.map((part) => (part === lastPart && !part.start ? Number(part.media.episodes) || 0 : countEpisodes(part.media)))),
    getExternalIds(rootMedia.id)
  ]);
  allParts.forEach((part, index) => {
    part.ids = ids[index];
    part.count = part.length ?? Math.max(0, counts[index] - (part.start || 0));
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
          // Offsets are those of the entry's episode 1, also for a part holding a range.
          const known = tmdbId === rootTmdb ? part.tmdbBase : undefined;
          part.tmdb = { id: tmdbId, offset: known ?? (tmdbNext.get(tmdbId) || 0) - (part.start || 0) };
          tmdbNext.set(tmdbId, part.tmdb.offset + (part.start || 0) + part.count);
        }
      }
      const aid = part.ids.anidb || (part.continues && previousPart?.anidb?.aid);
      if (aid) {
        part.anidb = { aid, offset: (anidbNext.get(aid) || 0) - (part.start || 0) };
        anidbNext.set(aid, part.anidb.offset + (part.start || 0) + part.count);
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
// separate shows - a series -> its sequel series -> a successor, or a long runner's one-shot
// "MONSTERS" ONA - and long runners like these have no TVDB season mapping in Fribb
// (TVDB splits them into arcs), so the layout falls back to chain position: a
// sequel series' library would get its parent series as season 1. When the root's TVDB
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

// A long runner's TVDB seasons are all cut from the root entry, so they'd all get its
// AniList cover: those take Fanart.tv's poster for their TVDB season instead, when the
// layout follows TVDB's numbering. A season of its own AniList entry keeps its cover.
async function resolveSeasonPoster(layout, season) {
  const rootId = layout.rootMedia.id;
  const sharing = layout.seasons.filter((entry) => entry.seasonNumber > 0 && entry.parts[0].media.id === rootId);
  if (!layout.aligned || sharing.length < 2 || !sharing.includes(season)) {
    return null;
  }
  return getSeasonPoster((await getExternalIds(rootId)).tvdb, season.seasonNumber);
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
  const [localizedRoot, posters] = await Promise.all([
    localizeMedia(layout.rootMedia, language),
    Promise.all(layout.seasons.map((season) => resolveSeasonPoster(layout, season)))
  ]);
  const seasons = layout.seasons.map((season, index) => mapSeasonMetadata(
    season.parts[0].media.id === layout.rootMedia.id ? localizedRoot : season.parts[0].media,
    season.seasonNumber,
    localizedRoot,
    provider,
    { poster: posters[index] }
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
    const held = page.episodes.filter((episode) => partHolds(part, episode.episodeNumber));
    episodes.push(...enrichEpisodes(part, held, sources[index]).map((episode) => mapEpisodeMetadata(
      page.media,
      { ...episode, parentIndex: season.seasonNumber },
      layout.rootMedia,
      provider,
      { offset: displayOffset(part), seasonMediaId }
    )));
  }

  return media ? { media, rootMedia: layout.rootMedia, episodes } : null;
}

// AniList episode keys (`anilist-<root>-eNN[-a<entryId>]`) carry neither a season
// number nor the TVDB offset - both depend on where the layout above places that
// entry (and, for a long runner split over several seasons, that episode's number).
// Returns { seasonNumber, seasonMediaId, offset }, or null when the entry is no longer
// part of this show (a stale key).
async function resolveEpisodePlacement(rootId, seasonAnilistId, provider = 'anilist', episodeNumber = 1) {
  const layout = await resolveSeasonLayout(rootId, layoutOrder(provider));
  const entryId = Number(seasonAnilistId || rootId);
  for (const season of layout?.seasons || []) {
    const part = season.parts.find((entry) => entry.media.id === entryId && partHolds(entry, Number(episodeNumber)));
    if (part) {
      return { seasonNumber: season.seasonNumber, seasonMediaId: season.parts[0].media.id, offset: displayOffset(part) };
    }
  }
  return null;
}

module.exports = {
  SERIES_FORMATS,
  closeSeasonGaps,
  fileNumbersAreAbsolute,
  layoutOrder,
  resolveSeasonLayout,
  findLayoutSeason,
  resolveSeasonPoster,
  getAllSeasons,
  getAllEpisodes,
  resolveEpisodePlacement
};
