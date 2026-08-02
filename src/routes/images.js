const express = require('express');
const { getMediaById } = require('../providers/anilist');
const { getTvdbId } = require('../providers/crosswalk');
const { getFanartImages } = require('../providers/fanart');
const tmdb = require('../providers/tmdb');
const { createImageArray, createImageSet, resolveTitle } = require('../utils/mapping');
const { parseRatingKey } = require('../utils/guid');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

// Fanart.tv/TheTVDB model artwork per *show*, not per AniList season entry, so the
// crosswalk lookup must always use the root show's AniList id - looking it up by a
// non-root season's own id (as this used to do) almost always misses, since the
// Fribb/anime-lists dataset generally only maps the franchise's root/season-1 id to
// a TVDB id, leaving season 2+ with no extra artwork even when the show has plenty.
async function resolveGallery(provider, rootId, type) {
  if (type === 'episode') {
    return {};
  }

  if (provider === 'tmdb') {
    return tmdb.getShowImages(rootId);
  }

  const tvdbId = await getTvdbId(rootId);
  if (!tvdbId) {
    return {};
  }

  const images = await getFanartImages(tvdbId);
  return images || {};
}

router.get('/:id/images', async (req, res, next) => {
  try {
    const parsed = parseRatingKey(req.params.id);
    const { provider } = parsed;
    const targetId = parsed.type === 'show' ? parsed.rootId : parsed.seasonAnilistId;
    const media = provider === 'tmdb' ? await tmdb.getTvById(targetId) : await getMediaById(targetId);

    if (!media) {
      return res.status(404).json({ error: 'Metadata not found' });
    }

    const imageSet = createImageSet(media, parsed.episodeNumber);
    const gallery = await resolveGallery(provider, parsed.rootId, parsed.type);
    const imageList = createImageArray(imageSet, resolveTitle(media), gallery);

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
