const express = require('express');
const { searchMedia, createMatchScore } = require('../providers/anilist');
const { buildRatingKey, createGuid } = require('../utils/guid');
const { parseAnimeFilename, normalizeTitle } = require('../utils/filenameParser');
const { resolveTitle, stripHtml } = require('../utils/mapping');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

router.post('/matches', async (req, res, next) => {
  try {
    const body = req.body || {};
    const parsedFilename = parseAnimeFilename(body.filename);
    const searchTerm = normalizeTitle(
      body.title
        || body.grandparentTitle
        || body.parentTitle
        || parsedFilename.title
    );

    if (!searchTerm) {
      return res.status(400).json({ error: 'A title, parentTitle, grandparentTitle, or filename is required' });
    }

    const matchesPage = await searchMedia(searchTerm, 1, body.manual ? 10 : 5);
    const metadata = (matchesPage.media || []).map((media) => {
      const ratingKey = buildRatingKey('show', media.id);
      return {
        type: 'show',
        ratingKey,
        guid: createGuid('show', ratingKey),
        title: resolveTitle(media),
        summary: stripHtml(media.description || ''),
        year: media.startDate?.year || null,
        score: createMatchScore(media, searchTerm, parsedFilename),
        manual: Boolean(body.manual),
        filename: body.filename || null,
        parsed: parsedFilename,
        index: body.index || parsedFilename.episodeNumber || null,
        parentIndex: body.parentIndex || parsedFilename.seasonNumber || null,
        originallyAvailableAt: body.date || parsedFilename.airDate || null
      };
    });

    return res.json({
      MediaContainer: {
        offset: 0,
        totalSize: metadata.length,
        identifier: providerIdentifier,
        size: metadata.length,
        Metadata: metadata
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
