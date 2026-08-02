const { buildRatingKey, createGuid, SCHEME } = require('./guid');

function stripHtml(value = '') {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s*[([][^)\]]*\b(?:source|written by)\b[^)\]]*[)\]]\s*$/i, '')
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

// `gallery` (posters/backgrounds/logos/squareBackground) comes from an optional
// secondary source (see providers/fanart.js) and is merged in alongside AniList's
// own single coverImage/bannerImage, since AniList never has more than one of each.
function createImageArray(imageSet, alt, gallery = {}) {
  const seen = new Set();
  const entries = [];

  function addEntry(type, url) {
    const key = `${type}:${url}`;
    if (!url || seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ type, url, alt });
  }

  Object.entries(imageSet).forEach(([type, url]) => addEntry(type, url));
  (gallery.posters || []).forEach((url) => addEntry('coverPoster', url));
  (gallery.backgrounds || []).forEach((url) => addEntry('background', url));
  (gallery.logos || []).forEach((url) => addEntry('clearLogo', url));
  addEntry('backgroundSquare', gallery.squareBackground);

  return entries;
}

const TITLE_LANGUAGE_KEYS = ['english', 'romaji', 'native'];
const DEFAULT_TITLE_LANGUAGE_ORDER = TITLE_LANGUAGE_KEYS;

// AniList only exposes english/romaji/native title fields (no Italian), so this only
// lets TITLE_LANGUAGE_ORDER reorder priority among those three, e.g. "romaji,english,native".
function resolveTitleLanguageOrder() {
  const raw = process.env.TITLE_LANGUAGE_ORDER;
  if (!raw) {
    return DEFAULT_TITLE_LANGUAGE_ORDER;
  }

  const requested = raw
    .split(',')
    .map((key) => key.trim().toLowerCase())
    .filter((key) => TITLE_LANGUAGE_KEYS.includes(key));
  const missing = TITLE_LANGUAGE_KEYS.filter((key) => !requested.includes(key));

  return requested.length ? [...requested, ...missing] : DEFAULT_TITLE_LANGUAGE_ORDER;
}

function resolveTitle(media) {
  const order = resolveTitleLanguageOrder();
  const preferred = order.map((key) => media.title?.[key]).find(Boolean);
  return preferred || `AniList ${media.id}`;
}

function resolveStudioNames(media) {
  return (media.studios?.nodes || []).map((node) => node.name).filter(Boolean);
}

function createGenreArray(media) {
  return (media.genres || []).map((name) => ({ tag: name }));
}

function createStudioArray(studioNames) {
  return studioNames.map((name) => ({ tag: name }));
}

function createRatingArray(media) {
  if (!media.averageScore) {
    return [];
  }

  return [{
    image: `${SCHEME}://image.rating`,
    type: 'audience',
    value: Number((media.averageScore / 10).toFixed(1))
  }];
}

function createRoleArray(media) {
  return (media.characters?.edges || [])
    .map((edge, index) => {
      const voiceActor = edge.voiceActors?.[0];
      const tag = voiceActor?.name?.full || edge.node?.name?.full;

      if (!tag) {
        return null;
      }

      return {
        tag,
        role: edge.node?.name?.full || null,
        order: index + 1,
        thumb: voiceActor?.image?.large || edge.node?.image?.large || null
      };
    })
    .filter(Boolean);
}

function resolveContentRating(media) {
  return media.isAdult ? 'NC-17' : null;
}

function mapShowMetadata(media, childCount = 1, provider = 'anilist') {
  const ratingKey = buildRatingKey('show', media.id, undefined, undefined, provider);
  const imageSet = createImageSet(media);
  const title = resolveTitle(media);
  const studioNames = resolveStudioNames(media);
  const rating = createRatingArray(media);

  return {
    type: 'show',
    ratingKey,
    key: `/library/metadata/${ratingKey}/children`,
    guid: createGuid('show', ratingKey),
    title,
    originalTitle: media.title?.romaji || null,
    summary: stripHtml(media.description || ''),
    originallyAvailableAt: buildDate(media.startDate),
    year: media.startDate?.year || null,
    genres: media.genres || [],
    Genre: createGenreArray(media),
    studio: studioNames[0] || null,
    Studio: createStudioArray(studioNames),
    contentRating: resolveContentRating(media),
    rating: rating[0]?.value ?? null,
    Rating: rating,
    Role: createRoleArray(media),
    images: imageSet,
    Image: createImageArray(imageSet, title),
    childCount
  };
}

function mapSeasonMetadata(media, seasonNumber = 1, rootMedia = media, provider = 'anilist') {
  const seasonAnilistId = media.id !== rootMedia.id ? media.id : undefined;
  const ratingKey = buildRatingKey('season', rootMedia.id, seasonNumber, seasonAnilistId, provider);
  const parentRatingKey = buildRatingKey('show', rootMedia.id, undefined, undefined, provider);
  const imageSet = createImageSet(media);
  const parentTitle = resolveTitle(rootMedia);
  const studioNames = resolveStudioNames(media);
  const rating = createRatingArray(media);

  return {
    type: 'season',
    ratingKey,
    key: `/library/metadata/${ratingKey}/children`,
    guid: createGuid('season', ratingKey),
    title: `Season ${seasonNumber}`,
    originalTitle: media.title?.romaji || null,
    summary: stripHtml(media.description || ''),
    originallyAvailableAt: buildDate(media.startDate),
    year: media.startDate?.year || null,
    genres: media.genres || [],
    Genre: createGenreArray(media),
    studio: studioNames[0] || null,
    Studio: createStudioArray(studioNames),
    contentRating: resolveContentRating(media),
    rating: rating[0]?.value ?? null,
    Rating: rating,
    Role: createRoleArray(media),
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

function mapEpisodeMetadata(media, episode = {}, rootMedia = media, provider = 'anilist') {
  const episodeNumber = Number(episode.episodeNumber || episode.index || 1);
  const seasonNumber = Number(episode.parentIndex || 1);
  const seasonAnilistId = media.id !== rootMedia.id ? media.id : undefined;
  const ratingKey = buildRatingKey('episode', rootMedia.id, episodeNumber, seasonAnilistId, provider);
  const seasonRatingKey = buildRatingKey('season', rootMedia.id, seasonNumber, seasonAnilistId, provider);
  const showRatingKey = buildRatingKey('show', rootMedia.id, undefined, undefined, provider);
  const imageSet = createImageSet(media, episodeNumber);
  const showTitle = resolveTitle(rootMedia);
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
  resolveTitleLanguageOrder,
  stripHtml,
  createImageSet,
  createImageArray,
  createGenreArray,
  createStudioArray,
  createRatingArray,
  createRoleArray,
  resolveStudioNames,
  resolveContentRating
};
