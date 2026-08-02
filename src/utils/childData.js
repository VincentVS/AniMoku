const { resolveSeasonChain, getEpisodesPage, getMediaById } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
const { mapSeasonMetadata, mapEpisodeMetadata } = require('./mapping');

// Shared by routes/children.js (paginated /children endpoint) and routes/metadata.js
// (Plex's includeChildren=1 embed, which requires every season back with no paging -
// see docs/Metadata.md in plexinc/tmdb-example-provider: "it is expected that all the
// child objects be returned in this array").
async function getAllSeasons(provider, rootId) {
  const chain = provider === 'tmdb'
    ? await tmdb.getSeasonChain(rootId)
    : await resolveSeasonChain(rootId);

  if (!chain.length) {
    return null;
  }

  // TMDB season entries carry the show's own id (see providers/tmdb.js), so the
  // root show itself must be re-fetched directly rather than found in the chain.
  const rootMedia = provider === 'tmdb'
    ? await tmdb.getTvById(rootId)
    : (chain.find((entry) => entry.id === rootId) || chain[0]);

  const seasons = chain.map((seasonMedia, index) => mapSeasonMetadata(
    seasonMedia,
    provider === 'tmdb' ? (seasonMedia.seasonNumber || index + 1) : index + 1,
    rootMedia,
    provider
  ));

  return { rootMedia, seasons };
}

// Shared by routes/grandchildren.js (paginated /grandchildren endpoint) and
// routes/metadata.js (Plex's includeChildren=1 embed on a season, which requires
// every episode back with no paging, same as getAllSeasons above).
async function getAllEpisodes(provider, rootId, seasonNumber, seasonAnilistId) {
  let media;
  let episodes;
  let rootMedia;

  if (provider === 'tmdb') {
    ({ media, episodes } = await tmdb.getEpisodesPage(rootId, seasonNumber, 0, Number.MAX_SAFE_INTEGER));
    rootMedia = media && (await tmdb.getTvById(rootId)) || media;
  } else {
    const seasonId = seasonAnilistId || rootId;
    ({ media, episodes } = await getEpisodesPage(seasonId, 0, Number.MAX_SAFE_INTEGER));
    rootMedia = seasonId === rootId ? media : (media && (await getMediaById(rootId))) || media;
  }

  if (!media) {
    return null;
  }

  const contextualEpisodes = episodes.map((episode) => ({ ...episode, parentIndex: seasonNumber }));

  return {
    media,
    rootMedia,
    episodes: contextualEpisodes.map((episode) => mapEpisodeMetadata(media, episode, rootMedia, provider))
  };
}

module.exports = { getAllSeasons, getAllEpisodes };
