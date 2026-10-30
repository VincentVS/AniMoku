const SCHEME = 'tv.plex.agents.custom.anime.anilist';

// The rating-key prefix doubles as the provider tag so routes can dispatch to the
// right backend (AniList for anime, TMDB for everything else e.g. Western cartoons)
// without Plex ever needing to know - it only ever sees opaque ratingKey/guid strings.
//
// `anilistabs` is AniList with the absolute episode order: every regular season of
// the franchise merged into season 1 (S01E103 naming, as HAMA + Absolute Series
// Scanner used to number it). It's a provider of its own so the order lives in every
// rating key and each request knows which layout to serve without extra state.
const ABSOLUTE_PROVIDER = 'anilistabs';
const PROVIDERS = ['anilist', ABSOLUTE_PROVIDER, 'tmdb'];
const DEFAULT_PROVIDER = 'anilist';

function isAbsoluteOrder(provider) {
  return provider === ABSOLUTE_PROVIDER;
}

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

// Providers whose seasons have no id of their own (TMDB seasons are sub-objects of
// the show), so an episode key must carry the season number to stay unique - without
// it every season's episode N collapses onto the same ratingKey/guid in Plex.
const PROVIDERS_WITHOUT_SEASON_IDS = ['tmdb'];

function buildRatingKey(type, rootId, index, seasonAnilistId, provider = DEFAULT_PROVIDER, seasonNumber = 1) {
  const normalizedType = normalizeType(type);
  const normalizedProvider = normalizeProvider(provider);
  const baseKey = `${normalizedProvider}-${rootId}`;

  if (normalizedType === 'show') {
    return baseKey;
  }

  const hasDistinctSeason = seasonAnilistId && Number(seasonAnilistId) !== Number(rootId);
  const seasonSuffix = hasDistinctSeason ? `-a${seasonAnilistId}` : '';

  if (normalizedType === 'season') {
    return `${baseKey}-s${Number(index ?? 1)}${seasonSuffix}`;
  }

  // AniList episode keys deliberately stay in their original `-eNN[-aID]` shape:
  // they are already unique (the -a suffix identifies the season entry) and Plex
  // ties watch state to the guid, so changing them would wipe every user's progress.
  const seasonSegment = PROVIDERS_WITHOUT_SEASON_IDS.includes(normalizedProvider)
    ? `-s${Number(seasonNumber || 1)}`
    : '';

  return `${baseKey}${seasonSegment}-e${String(Number(index || 1)).padStart(2, '0')}${seasonSuffix}`;
}

function createGuid(type, ratingKey) {
  return `${SCHEME}://${normalizeType(type)}/${ratingKey}`;
}

function parseRatingKey(value) {
  const raw = String(value || '').trim();
  // Longest first, so `anilistabs-1` isn't read as provider `anilist` + garbage.
  const providerPattern = PROVIDERS.slice().sort((a, b) => b.length - a.length).join('|');

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

  // The season segment is only present on providers without per-season ids (TMDB).
  // AniList episode keys don't carry it: their season number is positional in the
  // franchise chain and has to be resolved from it (see utils/childData.js).
  match = raw.match(new RegExp(`^(${providerPattern})-(\\d+)(?:-s(\\d+))?-e(\\d+)(?:-a(\\d+))?$`, 'i'));
  if (match) {
    const provider = match[1].toLowerCase();
    const rootId = Number(match[2]);
    const seasonAnilistId = match[5] ? Number(match[5]) : rootId;
    return {
      type: 'episode',
      provider,
      anilistId: rootId,
      rootId,
      ...(match[3] ? { seasonNumber: Number(match[3]) } : {}),
      episodeNumber: Number(match[4]),
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
  ABSOLUTE_PROVIDER,
  isAbsoluteOrder,
  buildRatingKey,
  createGuid,
  parseRatingKey
};
