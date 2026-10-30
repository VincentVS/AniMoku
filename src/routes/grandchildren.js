const express = require('express');
const { getAllSeasons, getAllEpisodes } = require('../utils/childData');
const { parseRatingKey } = require('../utils/guid');
const { parsePaging } = require('../utils/paging');
const { resolveRequestLanguage } = require('../utils/language');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

router.get('/:id/grandchildren', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const { start, size } = parsePaging({ ...req.query, ...req.headers });
    const language = resolveRequestLanguage(req);
    // A show's grandchildren are the episodes of every season, not just the first
    // one - answering with season 1 only makes Plex treat every later episode as gone.
    let episodes;
    if (parsed.type === 'show') {
      const seasonsResult = await getAllSeasons(parsed.provider, parsed.rootId, language);
      if (!seasonsResult) {
        return res.status(404).json({ error: 'Show not found' });
      }
      episodes = [];
      for (const season of seasonsResult.seasons) {
        const seasonKey = parseRatingKey(season.ratingKey);
        const result = await getAllEpisodes(parsed.provider, parsed.rootId, seasonKey.seasonNumber, seasonKey.seasonAnilistId, language);
        episodes.push(...(result?.episodes || []));
      }
    } else {
      const result = await getAllEpisodes(parsed.provider, parsed.rootId, parsed.seasonNumber ?? 1, parsed.seasonAnilistId, language);
      if (!result) {
        return res.status(404).json({ error: 'Season not found' });
      }
      episodes = result.episodes;
    }

    const metadata = episodes.slice(start, start + size);

    return res.json({
      MediaContainer: {
        offset: start,
        size: metadata.length,
        totalSize: episodes.length,
        identifier: providerIdentifier,
        Metadata: metadata
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
