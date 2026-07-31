const { buildRatingKey, createGuid } = require('./guid');

function stripHtml(value = '') {
  return value
    .replace(/<br\s*\/?/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDate(date = {}) {
  if (!date.year) {
    return null;
  }

  const month = String(date.month || 1).padStart(2, '0');
  const day = String(date.day || 1).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

function createImageSet(media, episodeNumber) {
  const snapshot = media.episodes && episodeNumber
    ? `${media.coverImage?.extraLarge || media.coverImage?.large || ''}#episode-${episodeNumber}`
    : null;

  return {
    coverPoster: media.coverImage?.extraLarge || media.coverImage?.large || null,
    background: media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large || null,
    clearLogo: null,
    snapshot
  };
}

function createImageArray(imageSet, alt) {
  return Object.entries(imageSet)
    .filter(([, url]) => Boolean(url))
    .map(([type, url]) => ({
      type,
      url,
      alt
    }));
}

function resolveTitle(media) {
  return media.title?.english || media.title?.romaji || media.title?.native || `AniList ${media.id}`;
}

function mapShowMetadata(media) {
  const ratingKey = buildRatingKey('show', media.id);
  const imageSet = createImageSet(media);
  const title = resolveTitle(media);
  return {
    type: 'show',
    ratingKey,
    key: `/library/metadata/${ratingKey}/children`,
    guid: createGuid('show', ratingKey),
    title,
    summary: stripHtml(media.description || ''),
    originallyAvailableAt: buildDate(media.startDate),
    year: media.startDate?.year || null,
    genres: media.genres || [],
    images: imageSet,
    Image: createImageArray(imageSet, title),
    childCount: 1
  };
}

function mapSeasonMetadata(media, seasonNumber = 1) {
  const ratingKey = buildRatingKey('season', media.id, seasonNumber);
  const parentRatingKey = buildRatingKey('show', media.id);
  const imageSet = createImageSet(media);
  const parentTitle = resolveTitle(media);

  return {
    type: 'season',
    ratingKey,
    key: `/library/metadata/${ratingKey}/children`,
    guid: createGuid('season', ratingKey),
    title: `Season ${seasonNumber}`,
    summary: stripHtml(media.description || ''),
    originallyAvailableAt: buildDate(media.startDate),
    year: media.startDate?.year || null,
    genres: media.genres || [],
    parentRatingKey,
    parentGuid: createGuid('show', parentRatingKey),
    parentKey: `/library/metadata/${parentRatingKey}`,
    parentType: 'show',
    parentTitle,
    index: seasonNumber,
    images: imageSet,
    Image: createImageArray(imageSet, `Season ${seasonNumber}`)
  };
}

function mapEpisodeMetadata(media, episode = {}) {
  const episodeNumber = Number(episode.episodeNumber || episode.index || 1);
  const seasonNumber = Number(episode.parentIndex || 1);
  const ratingKey = buildRatingKey('episode', media.id, episodeNumber);
  const seasonRatingKey = buildRatingKey('season', media.id, seasonNumber);
  const showRatingKey = buildRatingKey('show', media.id);
  const imageSet = createImageSet(media, episodeNumber);
  const showTitle = resolveTitle(media);
  const episodeTitle = episode.title || `Episode ${String(episodeNumber).padStart(2, '0')}`;

  return {
    type: 'episode',
    ratingKey,
    key: `/library/metadata/${ratingKey}`,
    guid: createGuid('episode', ratingKey),
    title: episodeTitle,
    summary: episode.summary || stripHtml(media.description || ''),
    originallyAvailableAt: episode.airDate || buildDate(media.startDate),
    year: episode.airDate ? Number(episode.airDate.slice(0, 4)) : media.startDate?.year || null,
    genres: media.genres || [],
    parentRatingKey: seasonRatingKey,
    parentGuid: createGuid('season', seasonRatingKey),
    parentKey: `/library/metadata/${seasonRatingKey}`,
    parentType: 'season',
    parentTitle: `Season ${seasonNumber}`,
    parentIndex: seasonNumber,
    grandparentRatingKey: showRatingKey,
    grandparentGuid: createGuid('show', showRatingKey),
    grandparentKey: `/library/metadata/${showRatingKey}`,
    grandparentType: 'show',
    grandparentTitle: showTitle,
    index: episodeNumber,
    duration: media.duration ? media.duration * 60 * 1000 : null,
    images: imageSet,
    Image: createImageArray(imageSet, episodeTitle)
  };
}

module.exports = {
  buildDate,
  mapShowMetadata,
  mapSeasonMetadata,
  mapEpisodeMetadata,
  resolveTitle,
  stripHtml,
  createImageSet,
  createImageArray
};
