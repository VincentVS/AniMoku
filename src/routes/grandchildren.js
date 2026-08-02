const express = require('express');
const { getAllEpisodes } = require('../utils/childData');
const { parseRatingKey } = require('../utils/guid');
const { parsePaging } = require('../utils/paging');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

router.get('/:id/grandchildren', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const { start, size } = parsePaging(req.headers);
    const seasonNumber = parsed.seasonNumber || 1;

    const result = await getAllEpisodes(parsed.provider, parsed.rootId, seasonNumber, parsed.seasonAnilistId);
    if (!result) {
      return res.status(404).json({ error: 'Season not found' });
    }

    const metadata = result.episodes.slice(start, start + size);

    return res.json({
      MediaContainer: {
        offset: start,
        size: metadata.length,
        totalSize: result.episodes.length,
        identifier: providerIdentifier,
        Metadata: metadata
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
