const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRatingKey, createGuid, parseRatingKey } = require('../src/utils/guid');
const { parseAnimeFilename } = require('../src/utils/filenameParser');
const { parsePaging, paginate } = require('../src/utils/paging');
const { mapShowMetadata, mapEpisodeMetadata } = require('../src/utils/mapping');

test('guid helpers build and parse Plex identifiers', () => {
  assert.equal(buildRatingKey('show', 15125), 'anilist-15125');
  assert.equal(buildRatingKey('season', 15125, 1), 'anilist-15125-s1');
  assert.equal(buildRatingKey('episode', 15125, 3), 'anilist-15125-e03');
  assert.equal(createGuid('show', 'anilist-15125'), 'tv.plex.agents.custom.anime.anilist://show/anilist-15125');
  assert.deepEqual(parseRatingKey('anilist-15125-e03'), {
    type: 'episode',
    anilistId: 15125,
    episodeNumber: 3,
    ratingKey: 'anilist-15125-e03'
  });
});

test('filename parser supports season/episode, absolute, and date formats', () => {
  assert.deepEqual(parseAnimeFilename('Example.Anime.S01E03.1080p.mkv'), {
    title: 'Example Anime',
    seasonNumber: 1,
    episodeNumber: 3,
    airDate: null,
    pattern: 'season-episode'
  });

  assert.deepEqual(parseAnimeFilename('Example Anime - 03.mkv'), {
    title: 'Example Anime',
    seasonNumber: null,
    episodeNumber: 3,
    airDate: null,
    pattern: 'absolute'
  });

  assert.deepEqual(parseAnimeFilename('Example Anime 2024-01-12.mkv'), {
    title: 'Example Anime',
    seasonNumber: null,
    episodeNumber: null,
    airDate: '2024-01-12',
    pattern: 'date'
  });
});

test('paging helpers read Plex headers and slice results', () => {
  assert.deepEqual(parsePaging({ 'x-plex-container-start': '2', 'x-plex-container-size': '3' }), {
    start: 2,
    size: 3
  });

  assert.deepEqual(paginate([1, 2, 3, 4, 5], { start: 1, size: 2 }), {
    metadata: [2, 3],
    start: 1,
    size: 2,
    totalSize: 5,
    end: 3
  });
});

test('mapping helpers produce Plex-oriented show and episode metadata', () => {
  const media = {
    id: 15125,
    title: { english: 'Example Anime', romaji: 'Example Anime', native: 'サンプル' },
    description: '<b>Summary</b>',
    genres: ['Action'],
    duration: 24,
    episodes: 12,
    startDate: { year: 2024, month: 1, day: 1 },
    coverImage: { extraLarge: 'https://img/poster.jpg' },
    bannerImage: 'https://img/banner.jpg'
  };

  const show = mapShowMetadata(media);
  assert.equal(show.guid, 'tv.plex.agents.custom.anime.anilist://show/anilist-15125');
  assert.equal(show.title, 'Example Anime');
  assert.equal(show.summary, 'Summary');

  const episode = mapEpisodeMetadata(media, { episodeNumber: 3, airDate: '2024-01-12' });
  assert.equal(episode.parentRatingKey, 'anilist-15125-s1');
  assert.equal(episode.grandparentRatingKey, 'anilist-15125');
  assert.equal(episode.images.snapshot, 'https://img/poster.jpg#episode-3');
});
