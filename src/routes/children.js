const express = require('express');
const { getAllSeasons, getAllEpisodes } = require('../utils/childData');
const { parseRatingKey } = require('../utils/guid');
const { parsePaging } = require('../utils/paging');
const { resolveRequestLanguage } = require('../utils/language');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

// A show's children are its seasons, a season's children its episodes: a season's
// `key` points here (see mapSeasonMetadata), so answering a season with the show's
// season list would make Plex nest seasons inside seasons and find no episodes.
async function loadChildren(parsed, language) {
  if (parsed.type === 'show') {
    return (await getAllSeasons(parsed.provider, parsed.rootId, language))?.seasons || null;
  }
  if (parsed.type === 'season') {
    return (await getAllEpisodes(parsed.provider, parsed.rootId, parsed.seasonNumber ?? 1, parsed.seasonAnilistId, language))?.episodes || null;
  }
  return null;
}

router.get('/:id/children', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    // Plex sends paging either as X-Plex-Container-* headers or as query parameters.
    const { start, size } = parsePaging({ ...req.query, ...req.headers });

    const children = await loadChildren(parsed, resolveRequestLanguage(req));
    if (!children) {
      return res.status(404).json({ error: 'Metadata not found' });
    }

    const metadata = children.slice(start, start + size);

    return res.json({
      MediaContainer: {
        offset: start,
        size: metadata.length,
        totalSize: children.length,
        identifier: providerIdentifier,
        Metadata: metadata
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
