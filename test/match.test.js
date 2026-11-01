const test = require('node:test');
const assert = require('node:assert/strict');

// No spacing between AniList calls in tests - the queue itself is still exercised.
process.env.ANILIST_MIN_INTERVAL_MS = '0';
const { createApp } = require('../src/server');
const { parseAnimeFilename } = require('../src/utils/filenameParser');
const { createMatchScore } = require('../src/providers/anilist');
const { toTmdbLanguage } = require('../src/utils/language');

// The real fetch, for calling the test server while global.fetch is mocked.
const httpFetch = global.fetch;

function media(id, overrides = {}) {
  return {
    id,
    title: { english: `Show ${id}`, romaji: `Show ${id}`, native: null },
    synonyms: [],
    description: `Summary ${id}`,
    episodes: 12,
    duration: 24,
    genres: ['Action'],
    format: 'TV',
    averageScore: 80,
    isAdult: false,
    bannerImage: null,
    coverImage: { large: `https://img/${id}.jpg`, extraLarge: `https://img/${id}.jpg` },
    startDate: { year: 2020, month: 1, day: 1 },
    studios: { nodes: [] },
    characters: { edges: [] },
    relations: { edges: [] },
    streamingEpisodes: [],
    ...overrides
  };
}

function edge(relationType, node) {
  return { relationType, node };
}

// The crosswalk keeps its dataset for a day once loaded, so every test in this file
// shares the same one.
const FRIBB = [
  { anilist_id: 20958, anidb_id: 10944, tvdb_id: 267440, season: { tvdb: 2 } },
  { anilist_id: 16498, anidb_id: 9541, tvdb_id: 267440, season: { tvdb: 1 } },
  // A franchise whose sequel is the better title match (Mushoku Tensei II).
  { anilist_id: 50001, tvdb_id: 900001, season: { tvdb: 1 } },
  { anilist_id: 50002, tvdb_id: 900001, season: { tvdb: 2 } },
  // Naruto -> Shippuden -> Boruto: three TVDB series with no season mapping, plus a
  // one-shot Fribb knows but TVDB doesn't list (One Piece's "MONSTERS").
  { anilist_id: 60001, tvdb_id: 900010 },
  { anilist_id: 60002, tvdb_id: 900011 },
  { anilist_id: 60003, tvdb_id: 900012 },
  { anilist_id: 60009, tvdb_id: null, imdb_id: ['tt0000001'] },
  { anilist_id: 60010, tvdb_id: 900020 }
];

// A fake AniList + Fribb backend: `catalog` maps id -> Media, `search` maps a search
// term -> list of ids.
function installBackend({ catalog, search = {} }) {
  const fribb = FRIBB;
  const originalFetch = global.fetch;
  const calls = { search: [] };
  global.fetch = async (url, options = {}) => {
    const href = url.toString();
    if (href.includes('anime-lists')) {
      return { ok: true, json: async () => fribb };
    }
    if (!href.includes('graphql.anilist.co')) {
      throw new Error(`Unexpected fetch: ${href}`);
    }

    const payload = JSON.parse(options.body || '{}');
    let data;
    if (payload.query.includes('query SearchMedia')) {
      calls.search.push(payload.variables);
      const ids = search[payload.variables.search] || [];
      data = { Page: { pageInfo: { hasNextPage: false }, media: ids.map((id) => catalog[id]) } };
    } else if (payload.query.includes('query EpisodeSchedule')) {
      data = { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [] } };
    } else {
      data = { Media: catalog[payload.variables.id] || null };
    }
    return { ok: true, headers: new Headers(), json: async () => ({ data }) };
  };
  return { calls, restore: () => { global.fetch = originalFetch; } };
}

async function withServer(run) {
  const server = await new Promise((resolve) => {
    const instance = createApp().listen(0, () => resolve(instance));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function postMatch(baseUrl, body) {
  return httpFetch(`${baseUrl}/library/metadata/matches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

test('filename parser handles real-world fansub and scene release names', () => {
  const cases = [
    ['[SubsPlease] Jujutsu Kaisen - 01 (1080p) [ABCD1234].mkv', 'Jujutsu Kaisen', null, 1, 'absolute'],
    ['Example.Anime.S01E03.1080p.WEB.x264-GROUP.mkv', 'Example Anime', 1, 3, 'season-episode'],
    // Numbers that belong to the title must not be read as the episode.
    ['Mob Psycho 100 - 05.mkv', 'Mob Psycho 100', null, 5, 'absolute'],
    ['86 - 01.mkv', '86', null, 1, 'absolute'],
    ['One Piece - 1071.mkv', 'One Piece', null, 1071, 'absolute'],
    ['Frieren - 05v2.mkv', 'Frieren', null, 5, 'absolute'],
    ['Show S2 - 05.mkv', 'Show', 2, 5, 'season-absolute'],
    ['Show 2nd Season - 05.mkv', 'Show', 2, 5, 'season-absolute'],
    ['Show EP05.mkv', 'Show', null, 5, 'absolute'],
    ['Show 1x05.mkv', 'Show', 1, 5, 'season-episode'],
    ['Show - S01E05 - Episode Title.mkv', 'Show', 1, 5, 'season-episode'],
    // No title in the file name: the show folder (not "Season 01") supplies it.
    ['/Kaguya-sama (2019)/Season 01/S01E02.mkv', 'Kaguya-sama', 1, 2, 'season-episode']
  ];

  for (const [filename, title, seasonNumber, episodeNumber, pattern] of cases) {
    const parsed = parseAnimeFilename(filename);
    assert.deepEqual(
      { title: parsed.title, seasonNumber: parsed.seasonNumber, episodeNumber: parsed.episodeNumber, pattern: parsed.pattern },
      { title, seasonNumber, episodeNumber, pattern },
      filename
    );
  }
});

test('match score ignores punctuation/case, counts synonyms, and weighs year and format', () => {
  const reZero = media(1, {
    title: { english: 'Re:ZERO -Starting Life in Another World-', romaji: 'Re:Zero kara Hajimeru Isekai Seikatsu', native: null },
    synonyms: ['ReZero'],
    startDate: { year: 2016 }
  });
  assert.equal(createMatchScore(reZero, 're zero kara hajimeru isekai seikatsu'), 100);
  assert.equal(createMatchScore(reZero, 'ReZero'), 100);
  assert.equal(createMatchScore(reZero, 'Re:Zero kara Hajimeru Isekai Seikatsu', {}, { year: 2016 }), 100);
  assert.equal(createMatchScore(reZero, 'Re:Zero kara Hajimeru Isekai Seikatsu', {}, { year: 2001 }), 90);

  const movie = media(2, { title: { english: 'Re:Zero kara Hajimeru Isekai Seikatsu', romaji: null, native: null }, format: 'MOVIE' });
  assert.ok(createMatchScore(movie, 'Re:Zero kara Hajimeru Isekai Seikatsu') < createMatchScore(reZero, 'Re:Zero kara Hajimeru Isekai Seikatsu'));

  // A short synonym must not match inside an unrelated word.
  const aot = media(3, { title: { english: 'Attack on Titan', romaji: null, native: null }, synonyms: ['AoT'] });
  assert.equal(createMatchScore(aot, 'Chaotic Days'), 60);
});

test('X-Plex-Language style tags map to valid TMDB languages', () => {
  assert.equal(toTmdbLanguage('it'), 'it-IT');
  assert.equal(toTmdbLanguage('en'), 'en-US');
  assert.equal(toTmdbLanguage('ja'), 'ja-JP');
  assert.equal(toTmdbLanguage('pt-BR'), 'pt-BR');
  assert.equal(toTmdbLanguage('it-IT,it;q=0.9,en;q=0.8'), 'it-IT');
  assert.equal(toTmdbLanguage(''), 'en-US');
});

test('/matches answers each Plex type with the right kind of item', async () => {
  const season1 = media(500, {
    title: { english: 'Franchise', romaji: 'Franchise', native: null },
    episodes: 12,
    relations: { edges: [edge('SEQUEL', { id: 501, format: 'TV' })] }
  });
  const season2 = media(501, {
    title: { english: 'Franchise Season 2', romaji: 'Franchise 2', native: null },
    episodes: 10,
    startDate: { year: 2021, month: 1, day: 1 },
    relations: { edges: [edge('PREQUEL', { id: 500, format: 'TV' })] }
  });
  const backend = installBackend({
    catalog: { 500: season1, 501: season2 },
    search: { Franchise: [500, 501] }
  });

  try {
    await withServer(async (baseUrl) => {
      // Show: only the best match unless manual, and Plex's 0/1 flags are integers.
      const show = await postMatch(baseUrl, { type: 2, title: 'Franchise', manual: 0, includeChildren: 1 });
      assert.equal(show.status, 200);
      assert.equal(show.body.MediaContainer.size, 1);
      assert.equal(show.body.MediaContainer.Metadata[0].ratingKey, 'anilist-500');
      assert.equal(show.body.MediaContainer.Metadata[0].originallyAvailableAt, '2020-01-01');
      assert.equal(show.body.MediaContainer.Metadata[0].Children.size, 2);
      assert.equal(show.body.MediaContainer.Metadata[0].index, undefined);

      const manual = await postMatch(baseUrl, { type: 2, title: 'Franchise', manual: 1 });
      assert.equal(manual.body.MediaContainer.size, 2);

      // Season: the series title is in parentTitle, the season number in index.
      const season = await postMatch(baseUrl, { type: 3, parentTitle: 'Franchise', index: 2, includeChildren: 1 });
      assert.equal(season.body.MediaContainer.Metadata[0].type, 'season');
      assert.equal(season.body.MediaContainer.Metadata[0].ratingKey, 'anilist-500-s2-a501');
      assert.equal(season.body.MediaContainer.Metadata[0].Children.size, 10);

      // Episode: grandparentTitle + parentIndex/index.
      const episode = await postMatch(baseUrl, {
        type: 4, grandparentTitle: 'Franchise', title: 'Some Episode Name', parentIndex: 2, index: 3
      });
      assert.equal(episode.body.MediaContainer.Metadata[0].type, 'episode');
      assert.equal(episode.body.MediaContainer.Metadata[0].ratingKey, 'anilist-500-e03-a501');
      assert.equal(episode.body.MediaContainer.Metadata[0].parentIndex, 2);

      // Absolute numbering across the franchise: episode 15 of "season 1" is S02E03.
      const absolute = await postMatch(baseUrl, { type: 4, grandparentTitle: 'Franchise', parentIndex: 1, index: 15 });
      assert.equal(absolute.body.MediaContainer.Metadata[0].ratingKey, 'anilist-500-e03-a501');

      // Absolute numbers kept in a later season folder: S02E15 is still episode 15.
      const absoluteInSeason = await postMatch(baseUrl, { type: 4, grandparentTitle: 'Franchise', parentIndex: 2, index: 15 });
      assert.equal(absoluteInSeason.body.MediaContainer.Metadata[0].ratingKey, 'anilist-500-e03-a501');

      // A season-relative number never reaches past season 1, so it isn't recounted.
      const unknownSeason = await postMatch(baseUrl, { type: 4, grandparentTitle: 'Franchise', parentIndex: 3, index: 5 });
      assert.equal(unknownSeason.body.MediaContainer.size, 0);

      const missingSeason = await postMatch(baseUrl, { type: 3, parentTitle: 'Franchise', index: 9 });
      assert.equal(missingSeason.body.MediaContainer.size, 0);

      const unsupported = await postMatch(baseUrl, { type: 1, title: 'Franchise' });
      assert.equal(unsupported.status, 400);
    });
  } finally {
    backend.restore();
  }
});

test('/matches refuses weak automatic matches but still lists them for a manual Fix Match', async () => {
  const unrelated = media(600, { title: { english: 'Totally Different', romaji: null, native: null } });
  const backend = installBackend({ catalog: { 600: unrelated }, search: { 'Some Folder Name': [600] } });

  try {
    await withServer(async (baseUrl) => {
      const automatic = await postMatch(baseUrl, { type: 2, title: 'Some Folder Name' });
      assert.equal(automatic.body.MediaContainer.size, 0);

      const manual = await postMatch(baseUrl, { type: 2, title: 'Some Folder Name', manual: 1 });
      assert.equal(manual.body.MediaContainer.Metadata[0].ratingKey, 'anilist-600');
    });
  } finally {
    backend.restore();
  }
});

test('/matches resolves guid hints and folder id tags without a title search', async () => {
  const aotSeason1 = media(16498, { title: { english: 'Attack on Titan', romaji: 'Shingeki no Kyojin', native: null } });
  const aotSeason2 = media(20958, { title: { english: 'Attack on Titan Season 2', romaji: null, native: null } });
  const backend = installBackend({
    catalog: { 16498: aotSeason1, 20958: aotSeason2 }
  });

  try {
    await withServer(async (baseUrl) => {
      // A TVDB id names the whole series: the season-1 AniList entry is the show.
      const byTvdb = await postMatch(baseUrl, { type: 2, title: 'whatever', guid: 'tvdb://267440' });
      assert.equal(byTvdb.body.MediaContainer.Metadata[0].ratingKey, 'anilist-16498');

      // Our own guid, as Plex sends it back on a refresh.
      const byOwnGuid = await postMatch(baseUrl, {
        type: 2, title: 'whatever', guid: 'tv.plex.agents.custom.animoku://show/anilist-20958'
      });
      assert.equal(byOwnGuid.body.MediaContainer.Metadata[0].ratingKey, 'anilist-20958');

      // A HAMA-style folder tag on the first scan, when Plex sends no guid yet.
      const byTag = await postMatch(baseUrl, { type: 2, title: 'Shingeki no Kyojin [anidb-9541]' });
      assert.equal(byTag.body.MediaContainer.Metadata[0].ratingKey, 'anilist-16498');
      const byPathTag = await postMatch(baseUrl, { type: 2, title: 'Attack on Titan', filename: '/Attack on Titan {anilist-20958}/S01E01.mkv' });
      assert.equal(byPathTag.body.MediaContainer.Metadata[0].ratingKey, 'anilist-20958');
    });
    assert.equal(backend.calls.search.length, 0);
  } finally {
    backend.restore();
  }
});

test('automatic AniList searches hide adult entries unless Plex passes includeAdult', async () => {
  const backend = installBackend({ catalog: {}, search: {} });
  try {
    await withServer(async (baseUrl) => {
      await postMatch(baseUrl, { type: 2, title: 'Anything' });
      await postMatch(baseUrl, { type: 2, title: 'Anything Else', includeAdult: 1 });
    });
    assert.equal(backend.calls.search[0].isAdult, false);
    assert.ok(!('isAdult' in backend.calls.search[1]), 'isAdult must be omitted: AniList returns nothing for null');
  } finally {
    backend.restore();
  }
});

test('the season chain follows a franchise through a movie between two TV seasons', async () => {
  // Demon Slayer: season 1 -> Mugen Train (MOVIE) -> Mugen Train Arc (TV).
  const season1 = media(101922, { relations: { edges: [edge('SEQUEL', { id: 112151, format: 'MOVIE' })] } });
  const movie = media(112151, {
    format: 'MOVIE',
    startDate: { year: 2020, month: 10, day: 16 },
    relations: { edges: [edge('PREQUEL', { id: 101922, format: 'TV' }), edge('SEQUEL', { id: 129874, format: 'TV' })] }
  });
  const arc = media(129874, {
    episodes: 7,
    startDate: { year: 2021, month: 10, day: 10 },
    relations: { edges: [edge('PREQUEL', { id: 112151, format: 'MOVIE' })] }
  });
  const backend = installBackend({ catalog: { 101922: season1, 112151: movie, 129874: arc } });

  try {
    await withServer(async (baseUrl) => {
      const children = await httpFetch(`${baseUrl}/library/metadata/anilist-101922/children`).then((response) => response.json());
      assert.deepEqual(children.MediaContainer.Metadata.map((season) => season.ratingKey), ['anilist-101922-s1', 'anilist-101922-s2-a129874']);
    });
  } finally {
    backend.restore();
  }
});

test('a show matched through a sequel title is keyed on the franchise first season', async () => {
  const season1 = media(50001, {
    title: { english: 'Jobless Reincarnation', romaji: 'Mushoku Tensei', native: null },
    relations: { edges: [edge('SEQUEL', { id: 50002, format: 'TV' })] }
  });
  const season2 = media(50002, {
    title: { english: 'Jobless Reincarnation Season 2', romaji: 'Mushoku Tensei II', native: null },
    startDate: { year: 2023, month: 7, day: 1 },
    relations: { edges: [edge('PREQUEL', { id: 50001, format: 'TV' })] }
  });
  const backend = installBackend({
    catalog: { 50001: season1, 50002: season2 },
    search: { 'Mushoku Tensei II': [50002, 50001] }
  });

  try {
    await withServer(async (baseUrl) => {
      const auto = await postMatch(baseUrl, { type: 2, title: 'Mushoku Tensei II' });
      assert.equal(auto.body.MediaContainer.Metadata[0].ratingKey, 'anilist-50001');
      assert.equal(auto.body.MediaContainer.Metadata[0].title, 'Jobless Reincarnation');

      // Both seasons collapse onto the same show in a manual Fix Match list.
      const manual = await postMatch(baseUrl, { type: 2, title: 'Mushoku Tensei II', manual: 1 });
      assert.deepEqual(manual.body.MediaContainer.Metadata.map((show) => show.ratingKey), ['anilist-50001']);

      // An explicit id tag is never re-keyed.
      const tagged = await postMatch(baseUrl, { type: 2, title: 'Mushoku Tensei II [anilist-50002]' });
      assert.equal(tagged.body.MediaContainer.Metadata[0].ratingKey, 'anilist-50002');
    });
  } finally {
    backend.restore();
  }
});

test('the season layout keeps only the root TVDB series and puts undated seasons last', async () => {
  const naruto = media(60001, {
    startDate: { year: 2002, month: 10, day: 3 },
    relations: { edges: [edge('SEQUEL', { id: 60002, format: 'TV' })] }
  });
  const shippuden = media(60002, {
    startDate: { year: 2007, month: 2, day: 15 },
    relations: { edges: [edge('PREQUEL', { id: 60001, format: 'TV' }), edge('SEQUEL', { id: 60003, format: 'TV' })] }
  });
  const boruto = media(60003, {
    startDate: { year: 2017, month: 4, day: 5 },
    relations: { edges: [edge('PREQUEL', { id: 60002, format: 'TV' }), edge('SEQUEL', { id: 60004, format: 'TV' })] }
  });
  // Announced, no start date, not in Fribb yet: it continues Boruto, not Shippuden.
  const borutoPart2 = media(60004, {
    startDate: { year: null },
    relations: { edges: [edge('PREQUEL', { id: 60003, format: 'TV' })] }
  });
  // Neither show is in Fribb: chain position decides, and the undated entry goes last.
  const unmapped = media(70001, { relations: { edges: [edge('SEQUEL', { id: 70002, format: 'TV' })] } });
  const unmappedSequel = media(70002, {
    startDate: { year: null },
    relations: { edges: [edge('PREQUEL', { id: 70001, format: 'TV' })] }
  });
  const backend = installBackend({
    catalog: { 60001: naruto, 60002: shippuden, 60003: boruto, 60004: borutoPart2, 70001: unmapped, 70002: unmappedSequel }
  });

  const seasonKeys = (baseUrl, key) => httpFetch(`${baseUrl}/library/metadata/${key}/children`)
    .then((response) => response.json())
    .then((body) => body.MediaContainer.Metadata.map((season) => season.ratingKey));

  try {
    await withServer(async (baseUrl) => {
      assert.deepEqual(await seasonKeys(baseUrl, 'anilist-60002'), ['anilist-60002-s1']);
      assert.deepEqual(await seasonKeys(baseUrl, 'anilist-60003'), ['anilist-60003-s1', 'anilist-60003-s2-a60004']);
      assert.deepEqual(await seasonKeys(baseUrl, 'anilist-70002'), ['anilist-70002-s1-a70001', 'anilist-70002-s2']);
    });
  } finally {
    backend.restore();
  }
});

test('the season layout drops a chain entry Fribb places outside TVDB', async () => {
  const onePiece = media(60010, {
    episodes: null,
    relations: { edges: [edge('PREQUEL', { id: 60009, format: 'ONA' })] }
  });
  const oneShot = media(60009, {
    format: 'ONA',
    episodes: 1,
    startDate: { year: 2024, month: 1, day: 21 },
    relations: { edges: [edge('SEQUEL', { id: 60010, format: 'TV' })] }
  });
  const backend = installBackend({ catalog: { 60009: oneShot, 60010: onePiece } });

  try {
    await withServer(async (baseUrl) => {
      // Dated after the root, the one-shot would otherwise become "season 2".
      const children = await httpFetch(`${baseUrl}/library/metadata/anilist-60010/children`).then((response) => response.json());
      assert.deepEqual(children.MediaContainer.Metadata.map((season) => season.ratingKey), ['anilist-60010-s1']);
    });
  } finally {
    backend.restore();
  }
});

test('streaming episode titles from another entry are ignored', async () => {
  const show = media(80001, {
    episodes: 2,
    streamingEpisodes: [1, 2, 3].map((number) => ({ title: `Episode ${number} - Borrowed title ${number}`, thumbnail: null }))
  });
  const backend = installBackend({ catalog: { 80001: show } });

  try {
    await withServer(async (baseUrl) => {
      const episodes = await httpFetch(`${baseUrl}/library/metadata/anilist-80001-s1/children`).then((response) => response.json());
      assert.equal(episodes.MediaContainer.size, 2);
      assert.ok(episodes.MediaContainer.Metadata.every((episode) => !episode.title.includes('Borrowed')));
    });
  } finally {
    backend.restore();
  }
});
