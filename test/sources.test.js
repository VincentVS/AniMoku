const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

process.env.ANILIST_MIN_INTERVAL_MS = '0';
const { createApp } = require('../src/server');
const anidb = require('../src/providers/anidb');
const { alignToList, usableTitle } = require('../src/utils/episodeSources');
const { buildRatingKey, parseRatingKey } = require('../src/utils/guid');

const httpFetch = global.fetch;

function media(id, overrides = {}) {
  return {
    id,
    title: { english: `Show ${id}`, romaji: `Show ${id}`, native: null },
    synonyms: [],
    description: `Summary ${id}`,
    episodes: 3,
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

// A franchise of two TVDB seasons (3 + 2 episodes); the side-story OVA isn't part
// of the PREQUEL/SEQUEL chain, so it never becomes a season. TMDB
// splits the same 5 episodes 4 + 1, so season 2's first episode is TMDB S1E4.
const FRIBB = [
  {
    anilist_id: 90001, anidb_id: 5001, tvdb_id: 990001, themoviedb_id: { tv: 777 }, season: { tvdb: 1 }
  },
  {
    anilist_id: 90002, anidb_id: 5002, tvdb_id: 990001, themoviedb_id: { tv: 777 }, season: { tvdb: 2 }
  },
  { anilist_id: 90003, tvdb_id: 990001, season: { tvdb: 0 } },
  // Attack on Titan's shape: TV season, a movie TVDB files as a special, then a
  // "special" TVDB counts as S01E04, then its second half Fribb doesn't know yet.
  { anilist_id: 91001, tvdb_id: 991001, season: { tvdb: 1 } },
  { anilist_id: 91004, tvdb_id: 991001, season: { tvdb: 0 } },
  {
    anilist_id: 91002, anidb_id: 5003, tvdb_id: 991001, season: { tvdb: 1 }, episode_offset: { tvdb: 3 }
  }
];

const CATALOG = {
  90001: media(90001, {
    startDate: { year: 2020, month: 1, day: 5 },
    relations: { edges: [edge('SEQUEL', { id: 90002, format: 'TV' }), edge('SIDE_STORY', { id: 90003, format: 'OVA' })] }
  }),
  90002: media(90002, {
    episodes: 2,
    startDate: { year: 2021, month: 1, day: 5 },
    relations: { edges: [edge('PREQUEL', { id: 90001, format: 'TV' })] }
  }),
  90003: media(90003, { format: 'OVA', episodes: 1, startDate: { year: 2020, month: 6, day: 1 } }),
  91001: media(91001, { relations: { edges: [edge('SEQUEL', { id: 91004, format: 'MOVIE' })] } }),
  91004: media(91004, {
    format: 'MOVIE',
    episodes: 1,
    startDate: { year: 2021, month: 1, day: 1 },
    relations: { edges: [edge('SEQUEL', { id: 91002, format: 'SPECIAL' })] }
  }),
  91002: media(91002, {
    format: 'SPECIAL',
    episodes: 1,
    startDate: { year: 2022, month: 1, day: 1 },
    relations: { edges: [edge('SEQUEL', { id: 91003, format: 'SPECIAL' })] }
  }),
  91003: media(91003, { format: 'SPECIAL', episodes: 1, startDate: { year: 2023, month: 1, day: 1 } })
};

const TMDB_NAMES = {
  'it-IT': ['Primo', 'Episodio 2', 'Terzo', 'Quarto', 'Quinto'],
  'en-US': ['First', 'Second', 'Third', 'Fourth', 'Fifth']
};
const TMDB_SPLIT = { 1: [1, 2, 3, 4], 2: [5] };

function tmdbResponse(url) {
  const language = url.searchParams.get('language');
  if (url.pathname.endsWith('/content_ratings')) {
    return { results: [] };
  }
  const show = {
    id: 777,
    name: 'Show 777',
    seasons: [0, 1, 2].map((season) => ({ season_number: season, episode_count: TMDB_SPLIT[season]?.length || 0 }))
  };
  for (const appended of (url.searchParams.get('append_to_response') || '').split(',')) {
    const season = /^season\/(\d+)$/.exec(appended)?.[1];
    if (season) {
      show[appended] = {
        episodes: (TMDB_SPLIT[season] || []).map((absolute, index) => ({
          episode_number: index + 1,
          name: TMDB_NAMES[language][absolute - 1],
          overview: language === 'it-IT' ? `Trama ${absolute}` : `Plot ${absolute}`,
          air_date: `2020-0${absolute}-0${absolute}`,
          still_path: `/still${absolute}.jpg`
        }))
      };
    }
  }
  return show;
}

function anidbXml(aid) {
  const episodes = {
    5001: `<episode id="1"><epno type="1">2</epno><airdate>2020-01-12</airdate>
             <title xml:lang="en">AniDB Second</title><title xml:lang="x-jat">Dai Ni-wa</title>
             <summary>Luffy meets http://anidb.net/ch123 [Zoro].
Source: crunchyroll</summary></episode>
           <episode id="2"><epno type="2">1</epno><title xml:lang="en">A special</title></episode>`,
    5002: `<episode id="3"><epno type="1">1</epno><title xml:lang="en">Episode 1</title>
             <title xml:lang="x-jat">Fukkatsu &amp; Saikai</title></episode>`,
    // Both halves of the "Final Chapters" in one AniDB anime.
    5003: `<episode id="4"><epno type="1">1</epno><title xml:lang="en">First Half</title></episode>
           <episode id="5"><epno type="1">2</epno><title xml:lang="en">Second Half</title></episode>`
  }[aid];
  return `<?xml version="1.0" encoding="UTF-8"?><anime id="${aid}"><enddate>2020-03-01</enddate>
    <titles><title xml:lang="x-jat" type="main">Show</title></titles><episodes>${episodes}</episodes></anime>`;
}

function installBackend() {
  const originalFetch = global.fetch;
  const calls = { anidb: [] };
  global.fetch = async (url, options = {}) => {
    const href = url.toString();
    if (href.includes('anime-lists')) {
      return { ok: true, json: async () => FRIBB };
    }
    if (href.includes('api.themoviedb.org')) {
      const parsed = new URL(href);
      if (parsed.pathname.includes('/search/')) {
        return { ok: true, json: async () => ({ results: [], page: 1, total_pages: 1 }) };
      }
      return { ok: true, json: async () => tmdbResponse(parsed) };
    }
    if (href.includes('api.anidb.net')) {
      const aid = new URL(href).searchParams.get('aid');
      calls.anidb.push(aid);
      const body = zlib.gzipSync(anidbXml(aid));
      return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
    }
    if (!href.includes('graphql.anilist.co')) {
      throw new Error(`Unexpected fetch: ${href}`);
    }
    const payload = JSON.parse(options.body || '{}');
    let data;
    if (payload.query.includes('query SearchMedia')) {
      data = { Page: { pageInfo: { hasNextPage: false }, media: payload.variables.search.includes('Show') ? [CATALOG[90001]] : [] } };
    } else if (payload.query.includes('query EpisodeSchedule')) {
      data = { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [] } };
    } else {
      data = { Media: CATALOG[payload.variables.id] || null };
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

function getJson(baseUrl, pathname) {
  return httpFetch(`${baseUrl}/library/metadata/${pathname}`, { headers: { 'X-Plex-Language': 'it' } })
    .then((response) => response.json())
    .then((body) => body.MediaContainer.Metadata);
}

function postMatch(baseUrl, body) {
  return httpFetch(`${baseUrl}/library/metadata/matches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then((response) => response.json()).then((json) => json.MediaContainer.Metadata);
}

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test('absolute rating keys round-trip and stay distinct from the TVDB order ones', () => {
  assert.equal(buildRatingKey('show', 21, undefined, undefined, 'anilistabs'), 'anilistabs-21');
  assert.equal(buildRatingKey('season', 21, 1, undefined, 'anilistabs'), 'anilistabs-21-s1');
  assert.equal(buildRatingKey('episode', 21, 4, 22, 'anilistabs'), 'anilistabs-21-e04-a22');
  assert.deepEqual(parseRatingKey('anilistabs-21-e04-a22'), {
    type: 'episode', provider: 'anilistabs', anilistId: 21, rootId: 21, episodeNumber: 4, seasonAnilistId: 22, ratingKey: 'anilistabs-21-e04-a22'
  });
  assert.equal(parseRatingKey('anilist-21-s2').provider, 'anilist');
});

test('generic episode titles are skipped and dated episodes re-anchor on TMDB', () => {
  assert.equal(usableTitle('Episodio 12'), null);
  assert.equal(usableTitle('第3話'), null);
  assert.equal(usableTitle('Romance Dawn'), 'Romance Dawn');

  // TMDB lists a recap as episode 2 that AniList doesn't count.
  const list = ['2020-01-01', '2020-01-05', '2020-01-08', '2020-01-15'].map((airDate) => ({ airDate }));
  const dated = [
    { episodeNumber: 1, airDate: '2020-01-01' },
    { episodeNumber: 2, airDate: '2020-01-08' },
    { episodeNumber: 3, airDate: '2020-01-15' }
  ];
  assert.deepEqual([...alignToList(dated, list, 0).entries()], [[1, 0], [2, 2], [3, 3]]);
  // Undated (estimated) episodes just follow their position.
  const undated = dated.map((episode) => ({ ...episode, airDateEstimated: true }));
  assert.deepEqual([...alignToList(undated, list, 0).entries()], [[1, 0], [2, 1], [3, 2]]);
  // Several dated episodes that never line up: TMDB numbers this entry differently.
  const unrelated = dated.map((episode) => ({ ...episode, airDate: episode.airDate.replace('2020', '2015') }));
  assert.equal(alignToList(unrelated, list, 0).size, 0);
});

test('AniDB responses are parsed, cached on disk and not fetched again while fresh', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anidb-cache-'));
  const backend = installBackend();
  try {
    await withEnv({ ANIDB_CLIENT: 'test', ANIDB_CLIENTVER: '1', CACHE_DIR: cacheDir }, async () => {
      anidb.reset();
      const anime = await anidb.getAnime(5001);
      assert.deepEqual(anime.episodes, [{
        number: 2,
        airDate: '2020-01-12',
        titles: { en: 'AniDB Second', 'x-jat': 'Dai Ni-wa' },
        summary: 'Luffy meets Zoro.'
      }]);
      assert.ok(fs.existsSync(path.join(cacheDir, 'anidb', '5001.json')));

      // A restart (empty memory) reads the disk copy instead of calling AniDB.
      anidb.reset();
      assert.equal((await anidb.getAnime(5001)).episodes.length, 1);
      assert.deepEqual(backend.calls.anidb, ['5001']);
    });
  } finally {
    backend.restore();
    anidb.reset();
  }
});

test('an AniDB ban is persisted and stops further requests', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anidb-cache-'));
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    const body = Buffer.from('<error code="500">Banned</error>');
    return { ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };
  try {
    await withEnv({ ANIDB_CLIENT: 'test', ANIDB_CLIENTVER: '1', CACHE_DIR: cacheDir }, async () => {
      anidb.reset();
      assert.equal(await anidb.getAnime(1), null);
      assert.ok(JSON.parse(fs.readFileSync(path.join(cacheDir, 'anidb', '_ban.json'), 'utf8')).until > Date.now());
      anidb.reset();
      assert.equal(await anidb.getAnime(2), null);
      assert.equal(requests, 1);
    });
  } finally {
    global.fetch = originalFetch;
    anidb.reset();
  }
});

test('episodes take TMDB/AniDB titles by absolute position, in TVDB and absolute order', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anidb-cache-'));
  const backend = installBackend();
  try {
    await withEnv({
      TMDB_API_KEY: 'test', ANIDB_CLIENT: 'test', ANIDB_CLIENTVER: '1', CACHE_DIR: cacheDir
    }, () => withServer(async (baseUrl) => {
      anidb.reset();
      const seasons = await getJson(baseUrl, 'anilist-90001/children');
      assert.deepEqual(seasons.map((season) => season.ratingKey), ['anilist-90001-s1', 'anilist-90001-s2-a90002']);

      const season1 = await getJson(baseUrl, 'anilist-90001-s1/children');
      assert.deepEqual(season1.map((episode) => episode.title), ['Primo', 'Second', 'Terzo']);
      assert.equal(season1[0].summary, 'Trama 1');
      assert.ok(season1[0].images.snapshot.startsWith('https://image.tmdb.org/t/p/original/still1.jpg'));

      // TVDB S2E1 is the 4th episode overall, TMDB S1E4; AniDB 5002 has a romaji title only.
      const season2 = await getJson(baseUrl, 'anilist-90001-s2-a90002/children');
      assert.deepEqual(season2.map((episode) => [episode.index, episode.title]), [[1, 'Quarto'], [2, 'Quinto']]);

      // Absolute order: one regular season, S01E01-E05.
      const absSeasons = await getJson(baseUrl, 'anilistabs-90001/children');
      assert.deepEqual(absSeasons.map((season) => season.ratingKey), ['anilistabs-90001-s1']);
      const absEpisodes = await getJson(baseUrl, 'anilistabs-90001-s1/children');
      assert.deepEqual(
        absEpisodes.map((episode) => [episode.index, episode.ratingKey, episode.title]),
        [
          [1, 'anilistabs-90001-e01', 'Primo'],
          [2, 'anilistabs-90001-e02', 'Second'],
          [3, 'anilistabs-90001-e03', 'Terzo'],
          [4, 'anilistabs-90001-e01-a90002', 'Quarto'],
          [5, 'anilistabs-90001-e02-a90002', 'Quinto']
        ]
      );
      const [single] = await getJson(baseUrl, 'anilistabs-90001-e02-a90002');
      assert.deepEqual([single.parentIndex, single.index, single.parentRatingKey], [1, 5, 'anilistabs-90001-s1']);

      // Each AniDB anime was requested once (show prefetch + seasons share it).
      assert.deepEqual(backend.calls.anidb.slice().sort(), ['5001', '5002']);
    }));
  } finally {
    backend.restore();
    anidb.reset();
  }
});

test('AniDB fills titles TMDB lacks, and the library language falls back to English', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anidb-cache-'));
  const backend = installBackend();
  try {
    // No TMDB: AniDB English, then romaji, then the placeholder.
    await withEnv({ ANIDB_CLIENT: 'test', ANIDB_CLIENTVER: '1', CACHE_DIR: cacheDir }, () => withServer(async (baseUrl) => {
      anidb.reset();
      const season1 = await getJson(baseUrl, 'anilist-90001-s1/children');
      assert.deepEqual(season1.map((episode) => episode.title), ['Episode 01', 'AniDB Second', 'Episode 03']);
      assert.equal(season1[1].summary, 'Luffy meets Zoro.');
      assert.equal(season1[1].originallyAvailableAt, '2020-01-12');
      const season2 = await getJson(baseUrl, 'anilist-90001-s2-a90002/children');
      assert.equal(season2[0].title, 'Fukkatsu & Saikai');
    }));
  } finally {
    backend.restore();
    anidb.reset();
  }
});

test('the episode order is picked by folder tag, EPISODE_ORDER, or kept from our own guid', async () => {
  const backend = installBackend();
  try {
    await withServer(async (baseUrl) => {
      assert.equal((await postMatch(baseUrl, { type: 2, title: 'Show 90001' }))[0].ratingKey, 'anilist-90001');
      assert.equal((await postMatch(baseUrl, { type: 2, title: 'Show 90001 [absolute]' }))[0].ratingKey, 'anilistabs-90001');
      await withEnv({ EPISODE_ORDER: 'absolute' }, async () => {
        assert.equal((await postMatch(baseUrl, { type: 2, title: 'Show 90001' }))[0].ratingKey, 'anilistabs-90001');
        assert.equal((await postMatch(baseUrl, { type: 2, title: 'Show 90001 {tvdb}' }))[0].ratingKey, 'anilist-90001');
        // An existing TVDB-order match isn't silently switched by the new default.
        const kept = await postMatch(baseUrl, { type: 2, guid: 'tv.plex.agents.custom.anime.anilist://show/anilist-90001' });
        assert.equal(kept[0].ratingKey, 'anilist-90001');
      });
      // An absolute S01E05 file resolves to season 2's last episode.
      const [episode] = await postMatch(baseUrl, {
        type: 4, grandparentTitle: 'Show 90001 [absolute]', parentIndex: 1, index: 5
      });
      assert.equal(episode.ratingKey, 'anilistabs-90001-e02-a90002');
      // In the absolute order a TVDB season folder ("S02E05") is ignored.
      const [inSeasonFolder] = await postMatch(baseUrl, {
        type: 4, grandparentTitle: 'Show 90001 [absolute]', parentIndex: 2, index: 5
      });
      assert.equal(inSeasonFolder.ratingKey, 'anilistabs-90001-e02-a90002');
    });
  } finally {
    backend.restore();
  }
});

test('a special TVDB counts as regular episodes joins its season; a movie filed as a special does not', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anidb-cache-'));
  const backend = installBackend();
  try {
    await withEnv({ ANIDB_CLIENT: 'test', ANIDB_CLIENTVER: '1', CACHE_DIR: cacheDir }, () => withServer(async (baseUrl) => {
      anidb.reset();
      const seasons = await getJson(baseUrl, 'anilist-91001/children');
      assert.deepEqual(seasons.map((season) => season.ratingKey), ['anilist-91001-s1']);
      const episodes = await getJson(baseUrl, 'anilist-91001-s1/children');
      assert.deepEqual(
        episodes.map((episode) => [episode.index, episode.ratingKey]),
        [
          [1, 'anilist-91001-e01'],
          [2, 'anilist-91001-e02'],
          [3, 'anilist-91001-e03'],
          [4, 'anilist-91001-e01-a91002'],
          [5, 'anilist-91001-e01-a91003']
        ]
      );
      // The half Fribb doesn't know yet takes the next episode of the AniDB anime.
      assert.deepEqual(episodes.slice(3).map((episode) => episode.title), ['First Half', 'Second Half']);
    }));
  } finally {
    backend.restore();
    anidb.reset();
  }
});
