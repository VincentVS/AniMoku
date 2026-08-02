const express = require('express');
const { resolveSeasonChain } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
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
    const { provider } = parsed;

    const chain = provider === 'tmdb'
      ? await tmdb.getSeasonChain(parsed.rootId)
      : await resolveSeasonChain(parsed.rootId);

    if (!chain.length) {
      return res.status(404).json({ error: 'Show not found' });
    }

    // TMDB season entries carry the show's own id (see providers/tmdb.js), so the
    // root show itself must be re-fetched directly rather than found in the chain.
    const rootMedia = provider === 'tmdb'
      ? await tmdb.getTvById(parsed.rootId)
      : (chain.find((entry) => entry.id === parsed.rootId) || chain[0]);
    const allSeasons = chain.map((seasonMedia, index) => mapSeasonMetadata(
      seasonMedia,
      provider === 'tmdb' ? (seasonMedia.seasonNumber || index + 1) : index + 1,
      rootMedia,
      provider
    ));
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
