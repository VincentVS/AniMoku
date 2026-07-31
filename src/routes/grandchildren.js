const express = require('express');
const { getEpisodesPage } = require('../providers/anilist');
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
    const sourceId = parsed.anilistId;
    const { media, episodes, totalSize } = await getEpisodesPage(sourceId, start, size);

    if (!media) {
      return res.status(404).json({ error: 'Season not found' });
    }

    return res.json({
      MediaContainer: {
        offset: start,
        size: episodes.length,
        totalSize,
        identifier: providerIdentifier,
        Metadata: episodes.map((episode) => mapEpisodeMetadata(media, episode))
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
