const express = require('express');
const { getMediaById } = require('../providers/anilist');
const { createImageArray, createImageSet, resolveTitle } = require('../utils/mapping');
const { parseRatingKey } = require('../utils/guid');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

router.get('/:id/images', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const media = await getMediaById(parsed.anilistId);

    if (!media) {
      return res.status(404).json({ error: 'Metadata not found' });
    }

    const imageSet = createImageSet(media, parsed.episodeNumber);
    const imageList = createImageArray(imageSet, resolveTitle(media));

    return res.json({
      MediaContainer: {
        offset: 0,
        totalSize: imageList.length,
        identifier: providerIdentifier,
        size: imageList.length,
        Image: imageList
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
