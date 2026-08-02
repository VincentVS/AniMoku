const SCHEME = 'tv.plex.agents.custom.anime.anilist';

// The rating-key prefix doubles as the provider tag so routes can dispatch to the
// right backend (AniList for anime, TMDB for everything else e.g. Western cartoons)
// without Plex ever needing to know - it only ever sees opaque ratingKey/guid strings.
const PROVIDERS = ['anilist', 'tmdb'];
const DEFAULT_PROVIDER = 'anilist';

function normalizeType(type) {
  if (!type) {
    throw new Error('A Plex metadata type is required');
  }

  const normalized = String(type).toLowerCase();
  if (!['show', 'season', 'episode'].includes(normalized)) {
    throw new Error(`Unsupported Plex metadata type: ${type}`);
  }

  return normalized;
}

function normalizeProvider(provider) {
  const normalized = String(provider || DEFAULT_PROVIDER).toLowerCase();
  if (!PROVIDERS.includes(normalized)) {
    throw new Error(`Unsupported metadata provider: ${provider}`);
  }
  return normalized;
}

function buildRatingKey(type, rootId, index, seasonAnilistId, provider = DEFAULT_PROVIDER) {
  const normalizedType = normalizeType(type);
  const normalizedProvider = normalizeProvider(provider);
  const baseKey = `${normalizedProvider}-${rootId}`;

  if (normalizedType === 'show') {
    return baseKey;
  }

  const hasDistinctSeason = seasonAnilistId && Number(seasonAnilistId) !== Number(rootId);
  const seasonSuffix = hasDistinctSeason ? `-a${seasonAnilistId}` : '';

  if (normalizedType === 'season') {
    return `${baseKey}-s${Number(index || 1)}${seasonSuffix}`;
  }

  return `${baseKey}-e${String(Number(index || 1)).padStart(2, '0')}${seasonSuffix}`;
}

function createGuid(type, ratingKey) {
  return `${SCHEME}://${normalizeType(type)}/${ratingKey}`;
}

function parseRatingKey(value) {
  const raw = String(value || '').trim();
  const providerPattern = PROVIDERS.join('|');

  let match = raw.match(new RegExp(`^(${providerPattern})-(\\d+)-s(\\d+)(?:-a(\\d+))?$`, 'i'));
  if (match) {
    const provider = match[1].toLowerCase();
    const rootId = Number(match[2]);
    const seasonAnilistId = match[4] ? Number(match[4]) : rootId;
    return {
      type: 'season',
      provider,
      anilistId: rootId,
      rootId,
      seasonNumber: Number(match[3]),
      seasonAnilistId,
      ratingKey: raw
    };
  }

  match = raw.match(new RegExp(`^(${providerPattern})-(\\d+)-e(\\d+)(?:-a(\\d+))?$`, 'i'));
  if (match) {
    const provider = match[1].toLowerCase();
    const rootId = Number(match[2]);
    const seasonAnilistId = match[4] ? Number(match[4]) : rootId;
    return {
      type: 'episode',
      provider,
      anilistId: rootId,
      rootId,
      episodeNumber: Number(match[3]),
      seasonAnilistId,
      ratingKey: raw
    };
  }

  match = raw.match(new RegExp(`^(${providerPattern})-(\\d+)$`, 'i'));
  if (match) {
    const provider = match[1].toLowerCase();
    const rootId = Number(match[2]);
    return {
      type: 'show', provider, anilistId: rootId, rootId, ratingKey: raw
    };
  }

  throw new Error(`Unsupported rating key: ${value}`);
}

module.exports = {
  SCHEME,
  PROVIDERS,
  DEFAULT_PROVIDER,
  buildRatingKey,
  createGuid,
  parseRatingKey
};
