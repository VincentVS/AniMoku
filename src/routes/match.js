const express = require('express');
const { searchMedia, createMatchScore } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
const logger = require('../utils/logger');
const { buildRatingKey, createGuid } = require('../utils/guid');
const { parseAnimeFilename, normalizeTitle } = require('../utils/filenameParser');
const { resolveTitle, stripHtml } = require('../utils/mapping');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

function toCandidate(media, provider, searchTerm, parsedFilename, body) {
  const ratingKey = buildRatingKey('show', media.id, undefined, undefined, provider);
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
}

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

    const perPage = body.manual ? 10 : 5;
    // Search AniList (anime) and TMDB (everything else - Western cartoons, live
    // action, etc.) in parallel and merge the candidates, so a title AniList has no
    // real match for (e.g. "Rick and Morty") can still resolve via TMDB when
    // TMDB_API_KEY is configured. TMDB is a silent no-op without the key.
    // AniList occasionally 403s under rate limiting - fail that half closed (like
    // TMDB/Fanart.tv already do) instead of 500ing the whole request when TMDB
    // candidates (or a retry a moment later) would otherwise have worked.
    const [anilistResult, tmdbResult] = await Promise.allSettled([
      searchMedia(searchTerm, 1, perPage),
      tmdb.searchTv(searchTerm, 1)
    ]);

    if (anilistResult.status === 'rejected') {
      logger.warn({ searchTerm, err: anilistResult.reason }, 'AniList search failed, continuing with TMDB results only');
    }
    if (tmdbResult.status === 'rejected') {
      logger.warn({ searchTerm, err: tmdbResult.reason }, 'TMDB search failed, continuing with AniList results only');
    }

    const anilistPage = anilistResult.status === 'fulfilled' ? anilistResult.value : { media: [] };
    const tmdbPage = tmdbResult.status === 'fulfilled' ? tmdbResult.value : { media: [] };

    const anilistCandidates = (anilistPage.media || []).map((media) => toCandidate(media, 'anilist', searchTerm, parsedFilename, body));
    const tmdbCandidates = (tmdbPage.media || []).slice(0, perPage).map((media) => toCandidate(media, 'tmdb', searchTerm, parsedFilename, body));
    const metadata = [...anilistCandidates, ...tmdbCandidates].sort((a, b) => b.score - a.score);

    logger.info({
      searchTerm, anilistResults: anilistCandidates.length, tmdbResults: tmdbCandidates.length, topScore: metadata[0]?.score ?? null
    }, 'match search completed');

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
