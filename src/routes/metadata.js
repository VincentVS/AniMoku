const express = require('express');
const { getMediaById } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
const { mapEpisodeMetadata, mapSeasonMetadata, mapShowMetadata } = require('../utils/mapping');
const { parseRatingKey } = require('../utils/guid');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

// TMDB season/episode rating keys never carry a distinct season id (see
// providers/tmdb.js) - a season is always resolved from its parent show plus a
// season number, unlike AniList where each season is its own fetchable Media id.
async function resolveSeasonMedia(provider, parsed) {
  if (provider === 'tmdb') {
    const chain = await tmdb.getSeasonChain(parsed.rootId);
    return chain.find((season) => season.seasonNumber === parsed.seasonNumber) || null;
  }

  return getMediaById(parsed.seasonAnilistId);
}

async function resolveRootMedia(provider, seasonMedia, parsed) {
  if (parsed.seasonAnilistId === parsed.rootId && provider !== 'tmdb') {
    return seasonMedia;
  }

  const rootMedia = provider === 'tmdb' ? await tmdb.getTvById(parsed.rootId) : await getMediaById(parsed.rootId);
  return rootMedia || seasonMedia;
}

router.get('/:id', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const { provider } = parsed;

    let metadata;
    if (parsed.type === 'show') {
      const media = provider === 'tmdb' ? await tmdb.getTvById(parsed.rootId) : await getMediaById(parsed.rootId);
      if (!media) {
        return res.status(404).json({ error: 'Metadata not found' });
      }
      metadata = mapShowMetadata(media, undefined, provider);
    } else if (parsed.type === 'season') {
      const media = await resolveSeasonMedia(provider, parsed);
      if (!media) {
        return res.status(404).json({ error: 'Metadata not found' });
      }
      const rootMedia = await resolveRootMedia(provider, media, parsed);
      metadata = mapSeasonMetadata(media, parsed.seasonNumber, rootMedia, provider);
    } else {
      const media = await resolveSeasonMedia(provider, parsed);
      if (!media) {
        return res.status(404).json({ error: 'Metadata not found' });
      }
      const rootMedia = await resolveRootMedia(provider, media, parsed);
      metadata = mapEpisodeMetadata(media, { episodeNumber: parsed.episodeNumber, parentIndex: parsed.seasonNumber }, rootMedia, provider);
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
