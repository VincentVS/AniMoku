const express = require('express');
const { getMediaById } = require('../providers/anilist');
const { createImageSet } = require('../utils/mapping');
const { parseRatingKey } = require('../utils/guid');

const router = express.Router();

router.get('/:id/images', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const media = await getMediaById(parsed.anilistId);

    if (!media) {
      return res.status(404).json({ error: 'Metadata not found' });
    }

    return res.json({
      MediaContainer: {
        size: 1,
        Metadata: [
          {
            ratingKey: parsed.ratingKey,
            images: createImageSet(media, parsed.episodeNumber)
          }
        ]
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
