const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRatingKey, createGuid, parseRatingKey } = require('../src/utils/guid');
const { parseAnimeFilename } = require('../src/utils/filenameParser');
const { parsePaging, paginate } = require('../src/utils/paging');
const { mapShowMetadata, mapSeasonMetadata, mapEpisodeMetadata, resolveTitle, resolveTitleLanguageOrder, stripHtml, createImageSet, createImageArray } = require('../src/utils/mapping');

test('guid helpers build and parse Plex identifiers', () => {
  assert.equal(buildRatingKey('show', 15125), 'anilist-15125');
  assert.equal(buildRatingKey('season', 15125, 1), 'anilist-15125-s1');
  assert.equal(buildRatingKey('episode', 15125, 3), 'anilist-15125-e03');
  assert.equal(createGuid('show', 'anilist-15125'), 'tv.plex.agents.custom.anime.anilist://show/anilist-15125');
  assert.deepEqual(parseRatingKey('anilist-15125-e03'), {
    type: 'episode',
    provider: 'anilist',
    anilistId: 15125,
    rootId: 15125,
    seasonAnilistId: 15125,
    episodeNumber: 3,
    ratingKey: 'anilist-15125-e03'
  });
});

test('guid helpers support a distinct AniList id per season for real multi-season franchises', () => {
  assert.equal(buildRatingKey('season', 15125, 2, 98765), 'anilist-15125-s2-a98765');
  assert.equal(buildRatingKey('episode', 15125, 3, 98765), 'anilist-15125-e03-a98765');
  // A season sharing the root's own AniList id keeps the plain, backward-compatible format.
  assert.equal(buildRatingKey('season', 15125, 1, 15125), 'anilist-15125-s1');

  assert.deepEqual(parseRatingKey('anilist-15125-s2-a98765'), {
    type: 'season',
    provider: 'anilist',
    anilistId: 15125,
    rootId: 15125,
    seasonNumber: 2,
    seasonAnilistId: 98765,
    ratingKey: 'anilist-15125-s2-a98765'
  });

  assert.deepEqual(parseRatingKey('anilist-15125-e03-a98765'), {
    type: 'episode',
    provider: 'anilist',
    anilistId: 15125,
    rootId: 15125,
    episodeNumber: 3,
    seasonAnilistId: 98765,
    ratingKey: 'anilist-15125-e03-a98765'
  });
});

test('guid helpers put the season number in TMDB episode keys, which have no per-season id', () => {
  assert.equal(buildRatingKey('episode', 1668, 5, undefined, 'tmdb', 1), 'tmdb-1668-s1-e05');
  assert.equal(buildRatingKey('episode', 1668, 5, undefined, 'tmdb', 3), 'tmdb-1668-s3-e05');
  // AniList episode keys are unchanged (Plex ties watch state to them).
  assert.equal(buildRatingKey('episode', 15125, 5, 98765, 'anilist', 2), 'anilist-15125-e05-a98765');

  assert.deepEqual(parseRatingKey('tmdb-1668-s3-e05'), {
    type: 'episode',
    provider: 'tmdb',
    anilistId: 1668,
    rootId: 1668,
    seasonNumber: 3,
    episodeNumber: 5,
    seasonAnilistId: 1668,
    ratingKey: 'tmdb-1668-s3-e05'
  });
  // Season keys still parse as seasons, not as season-less episodes.
  assert.equal(parseRatingKey('tmdb-1668-s3').type, 'season');
});

test('show mapping exposes external ids as a Plex Guid array', () => {
  const show = mapShowMetadata({ id: 15125, title: { english: 'Example' } }, 1, 'anilist', { tvdb: 1, tmdb: 2, imdb: 'tt3' });
  assert.deepEqual(show.Guid, [{ id: 'imdb://tt3' }, { id: 'tmdb://2' }, { id: 'tvdb://1' }]);
  assert.deepEqual(mapShowMetadata({ id: 15125, title: {} }).Guid, []);
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

test('stripHtml cleans up AniList descriptions without leaving stray characters', () => {
  // A naive <br> regex that doesn't consume the closing '>' leaves orphaned '>' characters behind.
  assert.equal(
    stripHtml('He is joined by other Saints with Cloths of their own to fight for Athena. <br><br>\n(Source: Anime News Network)'),
    'He is joined by other Saints with Cloths of their own to fight for Athena.'
  );
  assert.equal(stripHtml('Line one<br/>Line two<br>Line three'), 'Line one Line two Line three');
  assert.equal(stripHtml('Ends with an attribution.\n<br><br>\n[Written by MAL Rewrite]'), 'Ends with an attribution.');
  // Parentheses that aren't a source/attribution credit must be left alone.
  assert.equal(
    stripHtml('A synopsis (in short) that mentions parentheses mid-sentence (not a source).'),
    'A synopsis (in short) that mentions parentheses mid-sentence (not a source).'
  );
  assert.equal(stripHtml('<b>Summary</b>'), 'Summary');
});

const media = {
  id: 15125,
  title: { english: 'Example Anime', romaji: 'Example Anime Romaji', native: 'サンプル' },
  description: '<b>Summary</b>',
  genres: ['Action'],
  duration: 24,
  episodes: 12,
  startDate: { year: 2024, month: 1, day: 1 },
  coverImage: { extraLarge: 'https://img/poster.jpg' },
  bannerImage: 'https://img/banner.jpg',
  averageScore: 85,
  isAdult: false,
  studios: { nodes: [{ name: 'Example Studio' }] },
  characters: {
    edges: [{
      role: 'MAIN',
      node: { name: { full: 'Example Character' }, image: { large: 'https://img/character.jpg' } },
      voiceActors: [{ name: { full: 'Example VA' }, image: { large: 'https://img/va.jpg' } }]
    }]
  }
};

test('mapping helpers produce Plex-oriented show metadata enriched with rating, studio, genre, and cast', () => {
  const show = mapShowMetadata(media);
  assert.equal(show.guid, 'tv.plex.agents.custom.anime.anilist://show/anilist-15125');
  assert.equal(show.title, 'Example Anime');
  assert.equal(show.summary, 'Summary');
  assert.equal(show.originalTitle, 'Example Anime Romaji');
  assert.equal(show.rating, 8.5);
  assert.deepEqual(show.Rating, [{ image: 'tv.plex.agents.custom.anime.anilist://image.rating', type: 'audience', value: 8.5 }]);
  assert.equal(show.studio, 'Example Studio');
  assert.deepEqual(show.Studio, [{ tag: 'Example Studio' }]);
  assert.deepEqual(show.Genre, [{ tag: 'Action' }]);
  assert.equal(show.contentRating, null);
  assert.deepEqual(show.Role, [{
    tag: 'Example VA', role: 'Example Character', order: 1, thumb: 'https://img/va.jpg'
  }]);
});

test('mapping helpers flag adult content via contentRating', () => {
  const show = mapShowMetadata({ ...media, isAdult: true });
  assert.equal(show.contentRating, 'NC-17');
});

test('TITLE_LANGUAGE_ORDER lets the title priority be reordered without changing the default behavior', () => {
  const originalOrder = process.env.TITLE_LANGUAGE_ORDER;
  try {
    delete process.env.TITLE_LANGUAGE_ORDER;
    assert.deepEqual(resolveTitleLanguageOrder(), ['english', 'romaji', 'native']);
    assert.equal(resolveTitle(media), 'Example Anime');

    process.env.TITLE_LANGUAGE_ORDER = 'romaji,english,native';
    assert.deepEqual(resolveTitleLanguageOrder(), ['romaji', 'english', 'native']);
    assert.equal(resolveTitle(media), 'Example Anime Romaji');

    process.env.TITLE_LANGUAGE_ORDER = 'native , romaji';
    assert.deepEqual(resolveTitleLanguageOrder(), ['native', 'romaji', 'english']);
    assert.equal(resolveTitle(media), 'サンプル');

    // Unknown language keys are ignored rather than breaking the fallback chain.
    process.env.TITLE_LANGUAGE_ORDER = 'italian,romaji';
    assert.deepEqual(resolveTitleLanguageOrder(), ['romaji', 'english', 'native']);
    assert.equal(resolveTitle({ id: 1, title: {} }), 'AniList 1');
  } finally {
    if (originalOrder === undefined) {
      delete process.env.TITLE_LANGUAGE_ORDER;
    } else {
      process.env.TITLE_LANGUAGE_ORDER = originalOrder;
    }
  }
});

test('createImageArray keeps AniList defaults first and merges in an optional gallery without duplicates', () => {
  const imageSet = createImageSet(media);
  assert.deepEqual(createImageArray(imageSet, 'Example Anime'), [
    { type: 'coverPoster', url: 'https://img/poster.jpg', alt: 'Example Anime' },
    { type: 'background', url: 'https://img/banner.jpg', alt: 'Example Anime' }
  ]);

  const gallery = {
    posters: ['https://img/poster.jpg', 'https://fanart/poster2.jpg'],
    backgrounds: ['https://fanart/bg.jpg'],
    logos: ['https://fanart/logo.png'],
    squareBackground: 'https://fanart/square.jpg'
  };

  assert.deepEqual(createImageArray(imageSet, 'Example Anime', gallery), [
    { type: 'coverPoster', url: 'https://img/poster.jpg', alt: 'Example Anime' },
    { type: 'background', url: 'https://img/banner.jpg', alt: 'Example Anime' },
    // The AniList poster URL is repeated in the gallery and must not be duplicated.
    { type: 'coverPoster', url: 'https://fanart/poster2.jpg', alt: 'Example Anime' },
    { type: 'background', url: 'https://fanart/bg.jpg', alt: 'Example Anime' },
    { type: 'clearLogo', url: 'https://fanart/logo.png', alt: 'Example Anime' },
    { type: 'backgroundSquare', url: 'https://fanart/square.jpg', alt: 'Example Anime' }
  ]);
});

test('season mapping uses its own AniList media for artwork while keeping the root show identity', () => {
  const sequelMedia = {
    ...media,
    id: 98765,
    title: { english: 'Example Anime: Second Season', romaji: 'Example Anime 2', native: 'サンプル2' },
    coverImage: { extraLarge: 'https://img/season2-poster.jpg' },
    bannerImage: 'https://img/season2-banner.jpg'
  };

  const season = mapSeasonMetadata(sequelMedia, 2, media);
  assert.equal(season.ratingKey, 'anilist-15125-s2-a98765');
  assert.equal(season.parentRatingKey, 'anilist-15125');
  assert.equal(season.parentTitle, 'Example Anime');
  assert.equal(season.images.coverPoster, 'https://img/season2-poster.jpg');

  const episode = mapEpisodeMetadata(sequelMedia, { episodeNumber: 1, parentIndex: 2 }, media);
  assert.equal(episode.parentRatingKey, 'anilist-15125-s2-a98765');
  assert.equal(episode.grandparentRatingKey, 'anilist-15125');
  assert.equal(episode.grandparentTitle, 'Example Anime');
});

test('mapping helpers produce Plex-oriented episode metadata for the single-season case', () => {
  const episode = mapEpisodeMetadata(media, { episodeNumber: 3, airDate: '2024-01-12' });
  assert.equal(episode.parentRatingKey, 'anilist-15125-s1');
  assert.equal(episode.grandparentRatingKey, 'anilist-15125');
  assert.equal(episode.images.snapshot, 'https://img/poster.jpg#episode-3');
});
