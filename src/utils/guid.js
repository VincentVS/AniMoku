const SCHEME = 'tv.plex.agents.custom.anime.anilist';

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

function buildRatingKey(type, anilistId, index) {
  const normalizedType = normalizeType(type);
  const baseKey = `anilist-${anilistId}`;

  if (normalizedType === 'show') {
    return baseKey;
  }

  if (normalizedType === 'season') {
    return `${baseKey}-s${Number(index || 1)}`;
  }

  return `${baseKey}-e${String(Number(index || 1)).padStart(2, '0')}`;
}

function createGuid(type, ratingKey) {
  return `${SCHEME}://${normalizeType(type)}/${ratingKey}`;
}

function parseRatingKey(value) {
  const raw = String(value || '').trim();
  let match = raw.match(/^anilist-(\d+)-s(\d+)$/i);
  if (match) {
    return { type: 'season', anilistId: Number(match[1]), seasonNumber: Number(match[2]), ratingKey: raw };
  }

  match = raw.match(/^anilist-(\d+)-e(\d+)$/i);
  if (match) {
    return { type: 'episode', anilistId: Number(match[1]), episodeNumber: Number(match[2]), ratingKey: raw };
  }

  match = raw.match(/^anilist-(\d+)$/i);
  if (match) {
    return { type: 'show', anilistId: Number(match[1]), ratingKey: raw };
  }

  throw new Error(`Unsupported rating key: ${value}`);
}

module.exports = {
  SCHEME,
  buildRatingKey,
  createGuid,
  parseRatingKey
};
