const express = require('express');
const { getEpisodesPage, getMediaById } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
const { mapEpisodeMetadata } = require('../utils/mapping');
const { parseRatingKey } = require('../utils/guid');
const { parsePaging } = require('../utils/paging');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

router.get('/:id/grandchildren', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const { start, size } = parsePaging(req.headers);
    const { provider } = parsed;
    const seasonNumber = parsed.seasonNumber || 1;

    let media;
    let episodes;
    let totalSize;
    let rootMedia;

    if (provider === 'tmdb') {
      ({ media, episodes, totalSize } = await tmdb.getEpisodesPage(parsed.rootId, seasonNumber, start, size));
      rootMedia = media && (await tmdb.getTvById(parsed.rootId)) || media;
    } else {
      const seasonId = parsed.seasonAnilistId || parsed.rootId;
      ({ media, episodes, totalSize } = await getEpisodesPage(seasonId, start, size));
      rootMedia = seasonId === parsed.rootId ? media : (media && (await getMediaById(parsed.rootId))) || media;
    }

    if (!media) {
      return res.status(404).json({ error: 'Season not found' });
    }

    const contextualEpisodes = episodes.map((episode) => ({ ...episode, parentIndex: seasonNumber }));

    return res.json({
      MediaContainer: {
        offset: start,
        size: episodes.length,
        totalSize,
        identifier: providerIdentifier,
        Metadata: contextualEpisodes.map((episode) => mapEpisodeMetadata(media, episode, rootMedia, provider))
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
