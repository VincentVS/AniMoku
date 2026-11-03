const express = require('express');
const { getMediaById } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
const { mapEpisodeMetadata, mapSeasonMetadata, mapShowMetadata } = require('../utils/mapping');
const { buildRatingKey, parseRatingKey } = require('../utils/guid');
const { getExternalIds } = require('../providers/crosswalk');
const {
  getAllSeasons, getAllEpisodes, resolveEpisodePlacement, resolveSeasonLayout, findLayoutSeason, layoutOrder,
  resolveSeasonPoster
} = require('../utils/childData');
const { resolveRequestLanguage } = require('../utils/language');
const { localizeMedia } = require('../utils/localize');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

// TMDB season/episode rating keys never carry a distinct season id (see
// providers/tmdb.js) - a season is always resolved from its parent show plus a
// season number, unlike AniList where each season is its own fetchable Media id.
async function resolveSeasonMedia(provider, parsed, language = 'en-US') {
  if (provider === 'tmdb') {
    const chain = await tmdb.getSeasonChain(parsed.rootId, language);
    return chain.find((season) => season.seasonNumber === parsed.seasonNumber) || null;
  }

  return getMediaById(parsed.seasonAnilistId);
}

async function resolveRootMedia(provider, seasonMedia, parsed, language = 'en-US') {
  if (parsed.seasonAnilistId === parsed.rootId && provider !== 'tmdb') {
    return seasonMedia;
  }

  const rootMedia = provider === 'tmdb' ? await tmdb.getTvById(parsed.rootId, language) : await getMediaById(parsed.rootId);
  return rootMedia || seasonMedia;
}

router.get('/:id', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const { provider } = parsed;
    // Plex never calls the separate /children or /grandchildren endpoints when
    // browsing an already-matched show - it relies entirely on this flag to get
    // seasons (and, on a season request, episodes) embedded in this one response.
    // See plexinc/tmdb-example-provider's docs/Metadata.md: "it is expected that
    // all the child objects be returned in this array" - no pagination here.
    const includeChildren = Boolean(Number(req.query.includeChildren));
    const language = resolveRequestLanguage(req);

    let metadata;
    if (parsed.type === 'show') {
      const media = provider === 'tmdb'
        ? await tmdb.getTvById(parsed.rootId, language)
        : await localizeMedia(await getMediaById(parsed.rootId), language);
      if (!media) {
        return res.status(404).json({ error: 'Metadata not found' });
      }
      const seasonsResult = await getAllSeasons(provider, parsed.rootId, language);
      const externalIds = provider === 'tmdb' ? media.externalIds : await getExternalIds(parsed.rootId);
      metadata = mapShowMetadata(media, seasonsResult?.seasons.length || 1, provider, externalIds);
      if (includeChildren && seasonsResult) {
        metadata.Children = { size: seasonsResult.seasons.length, Metadata: seasonsResult.seasons };
      }
    } else if (parsed.type === 'season') {
      let poster = null;
      if (provider !== 'tmdb') {
        const layout = await resolveSeasonLayout(parsed.rootId, layoutOrder(provider));
        const layoutSeason = findLayoutSeason(layout, parsed.rootId, parsed.seasonNumber, parsed.seasonAnilistId);
        if (!layoutSeason) {
          return res.status(404).json({ error: 'Metadata not found' });
        }
        poster = await resolveSeasonPoster(layout, layoutSeason);
      }
      const media = await resolveSeasonMedia(provider, parsed, language);
      if (!media) {
        return res.status(404).json({ error: 'Metadata not found' });
      }
      const rootMedia = await resolveRootMedia(provider, media, parsed, language);
      if (provider === 'tmdb') {
        metadata = mapSeasonMetadata(media, parsed.seasonNumber, rootMedia, provider);
      } else {
        // Seasons cut from the root entry (a long runner's TVDB seasons) share its synopsis.
        const localizedRoot = await localizeMedia(rootMedia, language);
        const seasonMedia = media.id === rootMedia.id ? localizedRoot : media;
        metadata = mapSeasonMetadata(seasonMedia, parsed.seasonNumber, localizedRoot, provider, { poster });
      }
      if (includeChildren) {
        const episodesResult = await getAllEpisodes(provider, parsed.rootId, parsed.seasonNumber, parsed.seasonAnilistId, language);
        if (episodesResult) {
          metadata.Children = { size: episodesResult.episodes.length, Metadata: episodesResult.episodes };
        }
      }
    } else {
      // TMDB episode keys carry their season; AniList ones are placed via the layout.
      const placement = provider === 'tmdb'
        ? (parsed.seasonNumber ? { seasonNumber: parsed.seasonNumber, offset: 0 } : null)
        : await resolveEpisodePlacement(parsed.rootId, parsed.seasonAnilistId, provider, parsed.episodeNumber);
      if (!placement) {
        return res.status(404).json({ error: 'Metadata not found' });
      }
      const { seasonNumber } = placement;
      // Served from the same episode list the season's includeChildren embed uses,
      // so refreshing a single episode can't overwrite its real title/summary/date
      // with the bare "Episode NN" placeholder.
      const episodesResult = await getAllEpisodes(provider, parsed.rootId, seasonNumber, placement.seasonMediaId, language);
      const ratingKey = buildRatingKey('episode', parsed.rootId, parsed.episodeNumber, parsed.seasonAnilistId, provider, seasonNumber);
      metadata = episodesResult?.episodes.find((episode) => episode.ratingKey === ratingKey);
      if (!metadata) {
        const seasonParsed = { ...parsed, seasonNumber };
        const media = await resolveSeasonMedia(provider, seasonParsed, language);
        if (!media) {
          return res.status(404).json({ error: 'Metadata not found' });
        }
        const rootMedia = await resolveRootMedia(provider, media, seasonParsed, language);
        metadata = mapEpisodeMetadata(media, { episodeNumber: parsed.episodeNumber, parentIndex: seasonNumber }, rootMedia, provider, placement);
      }
    }

    return res.json({
      MediaContainer: {
        offset: 0,
        totalSize: 1,
        identifier: providerIdentifier,
        size: 1,
        Metadata: [metadata]
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
