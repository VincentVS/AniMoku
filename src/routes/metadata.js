const express = require('express');
const { getMediaById } = require('../providers/anilist');
const { mapEpisodeMetadata, mapSeasonMetadata, mapShowMetadata } = require('../utils/mapping');
const { parseRatingKey } = require('../utils/guid');

const router = express.Router();

router.get('/:id', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const media = await getMediaById(parsed.anilistId);

    if (!media) {
      return res.status(404).json({ error: 'Metadata not found' });
    }

    let metadata;
    if (parsed.type === 'show') {
      metadata = mapShowMetadata(media);
    } else if (parsed.type === 'season') {
      metadata = mapSeasonMetadata(media, parsed.seasonNumber);
    } else {
      metadata = mapEpisodeMetadata(media, { episodeNumber: parsed.episodeNumber });
    }

    return res.json({
      MediaContainer: {
        size: 1,
        Metadata: [metadata]
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
