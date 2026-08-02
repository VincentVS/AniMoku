const express = require('express');
const { getAllSeasons } = require('../utils/childData');
const { parseRatingKey } = require('../utils/guid');
const { parsePaging } = require('../utils/paging');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

router.get('/:id/children', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const { start, size } = parsePaging(req.headers);

    const result = await getAllSeasons(parsed.provider, parsed.rootId);
    if (!result) {
      return res.status(404).json({ error: 'Show not found' });
    }

    const metadata = result.seasons.slice(start, start + size);

    return res.json({
      MediaContainer: {
        offset: start,
        size: metadata.length,
        totalSize: result.seasons.length,
        identifier: providerIdentifier,
        Metadata: metadata
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
