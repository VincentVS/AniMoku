const express = require('express');
const { getMediaById } = require('../providers/anilist');
const { mapSeasonMetadata } = require('../utils/mapping');
const { parseRatingKey } = require('../utils/guid');
const { parsePaging } = require('../utils/paging');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

router.get('/:id/children', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const { start, size } = parsePaging(req.headers);
    const media = await getMediaById(parsed.anilistId);

    if (!media) {
      return res.status(404).json({ error: 'Show not found' });
    }

    const allSeasons = [mapSeasonMetadata(media, 1)];
    const metadata = allSeasons.slice(start, start + size);

    return res.json({
      MediaContainer: {
        offset: start,
        size: metadata.length,
        totalSize: allSeasons.length,
        identifier: providerIdentifier,
        Metadata: metadata
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
