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

function resolveTitle(media) {
  return media.title?.english || media.title?.romaji || media.title?.native || `AniList ${media.id}`;
}

function mapShowMetadata(media) {
  const ratingKey = buildRatingKey('show', media.id);
  return {
    type: 'show',
    ratingKey,
    guid: createGuid('show', ratingKey),
    title: resolveTitle(media),
    summary: stripHtml(media.description || ''),
    originallyAvailableAt: buildDate(media.startDate),
    year: media.startDate?.year || null,
    genres: media.genres || [],
    images: createImageSet(media),
    childCount: 1
  };
}

function mapSeasonMetadata(media, seasonNumber = 1) {
  const ratingKey = buildRatingKey('season', media.id, seasonNumber);
  const parentRatingKey = buildRatingKey('show', media.id);

  return {
    type: 'season',
    ratingKey,
    guid: createGuid('season', ratingKey),
    title: `Season ${seasonNumber}`,
    summary: stripHtml(media.description || ''),
    originallyAvailableAt: buildDate(media.startDate),
    year: media.startDate?.year || null,
    genres: media.genres || [],
    parentRatingKey,
    parentGuid: createGuid('show', parentRatingKey),
    index: seasonNumber,
    images: createImageSet(media)
  };
}

function mapEpisodeMetadata(media, episode = {}) {
  const episodeNumber = Number(episode.episodeNumber || episode.index || 1);
  const ratingKey = buildRatingKey('episode', media.id, episodeNumber);
  const seasonRatingKey = buildRatingKey('season', media.id, 1);
  const showRatingKey = buildRatingKey('show', media.id);

  return {
    type: 'episode',
    ratingKey,
    guid: createGuid('episode', ratingKey),
    title: episode.title || `Episode ${String(episodeNumber).padStart(2, '0')}`,
    summary: episode.summary || stripHtml(media.description || ''),
    originallyAvailableAt: episode.airDate || buildDate(media.startDate),
    year: episode.airDate ? Number(episode.airDate.slice(0, 4)) : media.startDate?.year || null,
    genres: media.genres || [],
    parentRatingKey: seasonRatingKey,
    parentIndex: 1,
    grandparentRatingKey: showRatingKey,
    grandparentTitle: resolveTitle(media),
    index: episodeNumber,
    duration: media.duration || null,
    images: createImageSet(media, episodeNumber)
  };
}

module.exports = {
  buildDate,
  mapShowMetadata,
  mapSeasonMetadata,
  mapEpisodeMetadata,
  resolveTitle,
  stripHtml,
  createImageSet
};
