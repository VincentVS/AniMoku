const test = require('node:test');
const assert = require('node:assert/strict');

// No spacing between AniList calls in tests - the queue itself is still exercised.
process.env.ANILIST_MIN_INTERVAL_MS = '0';

function withMockFetch(mockFetch, run) {
  const originalFetch = global.fetch;
  global.fetch = mockFetch;
  return run().finally(() => {
    global.fetch = originalFetch;
  });
}

function freshModule(path) {
  const resolved = require.resolve(path);
  delete require.cache[resolved];
  return require(resolved);
}

test('createMatchScore matches against english, romaji, and native titles, not just the resolved one', () => {
  const { createMatchScore } = freshModule('../src/providers/anilist');

  const flameBrigade = {
    title: { english: 'Flame Brigade', romaji: 'Honoo no Shoubou', native: '炎ノ消防' }
  };

  // A romaji filename search term must still score an exact match against Flame
  // Brigade, even though English is the resolved/preferred title.
  assert.equal(createMatchScore(flameBrigade, 'Honoo no Shoubou'), 100);
  assert.equal(createMatchScore(flameBrigade, 'Flame Brigade'), 100);
  // An unrelated show shouldn't get an exact-match bonus just because it shares
  // no titles with the search term.
  const unrelated = { title: { english: 'Some Other Show', romaji: null, native: null } };
  assert.equal(createMatchScore(unrelated, 'Honoo no Shoubou'), 60);
});

test('AniList 403/429 responses log the response body message, distinguishing rate-limiting from a full API outage', async () => {
  const logger = require('../src/utils/logger');
  const { searchMedia } = freshModule('../src/providers/anilist');

  const warnCalls = [];
  const originalWarn = logger.warn;
  logger.warn = (...args) => warnCalls.push(args);

  try {
    await withMockFetch(async () => ({
      ok: false,
      status: 403,
      headers: new Headers({ 'retry-after': '60' }),
      json: async () => ({
        errors: [{
          message: 'The AniList API has been temporarily disabled due to severe stability issues. Please check the announcements channel in the official AniList Discord for more information.',
          status: 403
        }]
      })
    }), async () => {
      await assert.rejects(() => searchMedia('term'));
    });

    assert.equal(warnCalls.length, 1);
    const [meta, message] = warnCalls[0];
    assert.equal(message, 'AniList request rate-limited or unavailable');
    assert.equal(meta.status, 403);
    assert.match(meta.anilistMessage, /temporarily disabled due to severe stability issues/);
  } finally {
    logger.warn = originalWarn;
  }
});

test('AniList retries on 429/403 with a reasonable retry-after header and succeeds on the next attempt', async () => {
  const logger = require('../src/utils/logger');
  const { searchMedia } = freshModule('../src/providers/anilist');

  let callCount = 0;
  const infoCalls = [];
  const originalInfo = logger.info;
  logger.info = (...args) => infoCalls.push(args);

  try {
    await withMockFetch(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '1' }),
          json: async () => ({ errors: [{ message: 'Rate limited' }] })
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            Page: {
              pageInfo: { total: 1, currentPage: 1, perPage: 5, hasNextPage: false },
              media: [{
                id: 15125,
                title: { english: 'Flame Brigade', romaji: 'Honoo', native: null },
                format: 'TV'
              }]
            }
          }
        })
      };
    }, async () => {
      const result = await searchMedia('Flame Brigade');
      assert.equal(result.pageInfo.total, 1);
      assert.equal(result.media[0].id, 15125);
    });

    assert.equal(callCount, 2);
    assert.equal(infoCalls.length, 1);
    const [meta, message] = infoCalls[0];
    assert.equal(message, 'AniList rate-limited, retrying');
    assert.equal(meta.status, 429);
    assert.equal(meta.retryCount, 1);
  } finally {
    logger.info = originalInfo;
  }
});

test('AniList long retry-after pauses every queued request instead of letting each one retry', async () => {
  const logger = require('../src/utils/logger');
  const { searchMedia } = freshModule('../src/providers/anilist');

  let callCount = 0;
  const originalWarn = logger.warn;
  logger.warn = () => {};

  try {
    await withMockFetch(async () => {
      callCount += 1;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '55' }),
        json: async () => ({ errors: [{ message: 'Too Many Requests.' }] })
      };
    }, async () => {
      // Plex's "Refresh all" fans out requests concurrently.
      const results = await Promise.allSettled([searchMedia('a'), searchMedia('b'), searchMedia('c')]);
      assert.ok(results.every((result) => result.status === 'rejected'));
    });

    // Only the first request reached AniList; the others failed fast during the cooldown.
    assert.equal(callCount, 1);
  } finally {
    logger.warn = originalWarn;
  }
});

test('crosswalk resolves a TVDB id from AniList id via the Fribb/anime-lists dataset', async () => {
  const { getTvdbId } = freshModule('../src/providers/crosswalk');

  await withMockFetch(async () => ({
    ok: true,
    json: async () => ([
      { anilist_id: 20, tvdb_id: 78788 },
      { anilist_id: 16498, tvdb_id: 267440 }
    ])
  }), async () => {
    assert.equal(await getTvdbId(20), 78788);
    assert.equal(await getTvdbId(16498), 267440);
    // Not present in the dataset.
    assert.equal(await getTvdbId(999999), null);
  });
});

test('crosswalk exposes tvdb/tmdb/imdb/anidb ids for an AniList id', async () => {
  const { getExternalIds, getTvdbId } = freshModule('../src/providers/crosswalk');

  await withMockFetch(async () => ({
    ok: true,
    json: async () => ([
      { anilist_id: 20, anidb_id: 239, tvdb_id: 78788, themoviedb_id: 46260, imdb_id: 'tt0409591' },
      { anilist_id: 21, themoviedb_id: 37854, imdb_id: 'unknown' }
    ])
  }), async () => {
    assert.deepEqual(await getExternalIds(20), {
      tvdb: 78788, tmdb: 46260, imdb: 'tt0409591', anidb: 239
    });
    // Entries without a TVDB id are still indexed for their other ids.
    assert.deepEqual(await getExternalIds(21), {
      tvdb: null, tmdb: 37854, imdb: null, anidb: null
    });
    assert.equal(await getTvdbId(21), null);
    assert.deepEqual(await getExternalIds(999999), {});
  });
});

test('crosswalk reads the current Fribb shapes (tmdb object, imdb array) and TVDB season placement', async () => {
  const { getExternalIds, getTvdbPlacement } = freshModule('../src/providers/crosswalk');

  await withMockFetch(async () => ({
    ok: true,
    json: async () => ([
      {
        anilist_id: 179062,
        tvdb_id: 355480,
        themoviedb_id: { tv: 88046 },
        imdb_id: ['tt9307686'],
        season: { tvdb: 3, tmdb: 3 },
        episode_offset: { tvdb: 12, tmdb: 12 }
      },
      { anilist_id: 21, tvdb_id: 81797 }
    ])
  }), async () => {
    assert.deepEqual(await getExternalIds(179062), {
      tvdb: 355480, tmdb: 88046, imdb: 'tt9307686', anidb: null
    });
    assert.deepEqual(await getTvdbPlacement(179062), { tvdbId: 355480, season: 3, episodeOffset: 12 });
    // Mapped to a series but not to a season.
    assert.equal(await getTvdbPlacement(21), null);
  });
});

test('crosswalk fails closed (returns null) instead of throwing when the dataset request fails', async () => {
  const { getTvdbId } = freshModule('../src/providers/crosswalk');

  await withMockFetch(async () => ({ ok: false, status: 500 }), async () => {
    assert.equal(await getTvdbId(20), null);
  });

  await withMockFetch(async () => {
    throw new Error('network down');
  }, async () => {
    assert.equal(await getTvdbId(20), null);
  });
});

test('fanart provider is a no-op without FANART_API_KEY set', async () => {
  const originalKey = process.env.FANART_API_KEY;
  try {
    delete process.env.FANART_API_KEY;
    const { getFanartImages } = freshModule('../src/providers/fanart');
    assert.equal(await getFanartImages(78788), null);
  } finally {
    if (originalKey === undefined) {
      delete process.env.FANART_API_KEY;
    } else {
      process.env.FANART_API_KEY = originalKey;
    }
  }
});

test('fanart provider maps posters/backgrounds/logos and picks a near-square background', async () => {
  const originalKey = process.env.FANART_API_KEY;
  process.env.FANART_API_KEY = 'test-key';

  try {
    const { getFanartImages } = freshModule('../src/providers/fanart');

    await withMockFetch(async () => ({
      ok: true,
      json: async () => ({
        tvposter: [{ url: 'https://fanart/poster1.jpg' }, { url: 'https://fanart/poster2.jpg' }],
        showbackground: [
          { url: 'https://fanart/bg-wide.jpg', width: '1920', height: '1080' },
          { url: 'https://fanart/bg-square.jpg', width: '1000', height: '1020' }
        ],
        hdtvlogo: [{ url: 'https://fanart/logo.png' }]
      })
    }), async () => {
      const images = await getFanartImages(78788);
      assert.deepEqual(images.posters, ['https://fanart/poster1.jpg', 'https://fanart/poster2.jpg']);
      assert.deepEqual(images.backgrounds, ['https://fanart/bg-wide.jpg', 'https://fanart/bg-square.jpg']);
      assert.deepEqual(images.logos, ['https://fanart/logo.png']);
      assert.equal(images.squareBackground, 'https://fanart/bg-square.jpg');
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.FANART_API_KEY;
    } else {
      process.env.FANART_API_KEY = originalKey;
    }
  }
});

test('fanart provider falls back to clearlogo when hdtvlogo is present but empty', async () => {
  const originalKey = process.env.FANART_API_KEY;
  process.env.FANART_API_KEY = 'test-key';

  try {
    const { getFanartImages } = freshModule('../src/providers/fanart');

    await withMockFetch(async () => ({
      ok: true,
      json: async () => ({
        tvposter: [],
        showbackground: [],
        // Empty array is truthy - `hdtvlogo || clearlogo` alone would never fall
        // through to clearlogo here.
        hdtvlogo: [],
        clearlogo: [{ url: 'https://fanart/clearlogo.png' }]
      })
    }), async () => {
      const images = await getFanartImages(78788);
      assert.deepEqual(images.logos, ['https://fanart/clearlogo.png']);
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.FANART_API_KEY;
    } else {
      process.env.FANART_API_KEY = originalKey;
    }
  }
});

test('fanart provider prefers season-specific posters over the show-level ones for a season request', async () => {
  const originalKey = process.env.FANART_API_KEY;
  process.env.FANART_API_KEY = 'test-key';

  try {
    const { getFanartImages } = freshModule('../src/providers/fanart');

    await withMockFetch(async () => ({
      ok: true,
      json: async () => ({
        tvposter: [{ url: 'https://fanart/show-poster.jpg' }],
        seasonposter: [
          { season: '1', url: 'https://fanart/season1-poster.jpg' },
          { season: '2', url: 'https://fanart/season2-poster.jpg' },
          { season: 'all', url: 'https://fanart/all-seasons-poster.jpg' }
        ],
        showbackground: [],
        hdtvlogo: []
      })
    }), async () => {
      const images = await getFanartImages(78788, 2);
      assert.deepEqual(images.posters, [
        'https://fanart/season2-poster.jpg',
        'https://fanart/all-seasons-poster.jpg',
        'https://fanart/show-poster.jpg'
      ]);
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.FANART_API_KEY;
    } else {
      process.env.FANART_API_KEY = originalKey;
    }
  }
});

test('fanart provider falls back to only show-level posters when no seasonNumber is requested', async () => {
  const originalKey = process.env.FANART_API_KEY;
  process.env.FANART_API_KEY = 'test-key';

  try {
    const { getFanartImages } = freshModule('../src/providers/fanart');

    await withMockFetch(async () => ({
      ok: true,
      json: async () => ({
        tvposter: [{ url: 'https://fanart/show-poster.jpg' }],
        seasonposter: [{ season: '1', url: 'https://fanart/season1-poster.jpg' }],
        showbackground: [],
        hdtvlogo: []
      })
    }), async () => {
      const images = await getFanartImages(78788);
      assert.deepEqual(images.posters, ['https://fanart/show-poster.jpg']);
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.FANART_API_KEY;
    } else {
      process.env.FANART_API_KEY = originalKey;
    }
  }
});

test('TMDB provider is a no-op without TMDB_API_KEY set', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  try {
    delete process.env.TMDB_API_KEY;
    const tmdb = freshModule('../src/providers/tmdb');
    assert.equal(tmdb.isConfigured(), false);
    assert.equal(await tmdb.getTvById(1), null);
    assert.deepEqual(await tmdb.searchTv('Space Family'), {
      media: [], pageInfo: { total: 0, currentPage: 1, perPage: 20, hasNextPage: false }
    });
    assert.deepEqual(await tmdb.getShowImages(1), {});
  } finally {
    if (originalKey === undefined) {
      delete process.env.TMDB_API_KEY;
    } else {
      process.env.TMDB_API_KEY = originalKey;
    }
  }
});

test('TMDB provider is configured by either TMDB_API_KEY or TMDB_ACCESS_TOKEN', () => {
  const originalKey = process.env.TMDB_API_KEY;
  const originalToken = process.env.TMDB_ACCESS_TOKEN;
  try {
    delete process.env.TMDB_API_KEY;
    delete process.env.TMDB_ACCESS_TOKEN;
    assert.equal(freshModule('../src/providers/tmdb').isConfigured(), false);

    process.env.TMDB_API_KEY = 'test-key';
    assert.equal(freshModule('../src/providers/tmdb').isConfigured(), true);

    delete process.env.TMDB_API_KEY;
    process.env.TMDB_ACCESS_TOKEN = 'test-token';
    assert.equal(freshModule('../src/providers/tmdb').isConfigured(), true);
  } finally {
    if (originalKey === undefined) { delete process.env.TMDB_API_KEY; } else { process.env.TMDB_API_KEY = originalKey; }
    if (originalToken === undefined) { delete process.env.TMDB_ACCESS_TOKEN; } else { process.env.TMDB_ACCESS_TOKEN = originalToken; }
  }
});

test('TMDB provider sends the v4 Read Access Token as an Authorization Bearer header, taking priority over the v3 api_key', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  const originalToken = process.env.TMDB_ACCESS_TOKEN;
  process.env.TMDB_API_KEY = 'v3-key';
  process.env.TMDB_ACCESS_TOKEN = 'v4-token';

  try {
    const tmdb = freshModule('../src/providers/tmdb');

    await withMockFetch(async (url, options = {}) => {
      assert.equal(options.headers?.Authorization, 'Bearer v4-token');
      // The v3 api_key query param must not be sent once a Bearer token is used.
      assert.equal(new URL(url).searchParams.has('api_key'), false);
      return { ok: true, json: async () => ({ id: 1668, name: 'Space Family' }) };
    }, async () => {
      const show = await tmdb.getTvById(1668);
      assert.equal(show.title.english, 'Space Family');
    });
  } finally {
    if (originalKey === undefined) { delete process.env.TMDB_API_KEY; } else { process.env.TMDB_API_KEY = originalKey; }
    if (originalToken === undefined) { delete process.env.TMDB_ACCESS_TOKEN; } else { process.env.TMDB_ACCESS_TOKEN = originalToken; }
  }
});

test('TMDB provider prepends season-specific posters ahead of the show-level gallery', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'test-key';

  try {
    const tmdb = freshModule('../src/providers/tmdb');

    await withMockFetch(async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.includes('/season/')) {
        return { ok: true, json: async () => ({ posters: [{ file_path: '/season2-poster.jpg' }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          posters: [{ file_path: '/show-poster.jpg' }],
          backdrops: [{ file_path: '/backdrop.jpg', width: '1920', height: '1080' }],
          logos: [{ file_path: '/logo.png' }]
        })
      };
    }, async () => {
      const images = await tmdb.getShowImages(1668, 2);
      assert.deepEqual(images.posters, [
        'https://image.tmdb.org/t/p/original/season2-poster.jpg',
        'https://image.tmdb.org/t/p/original/show-poster.jpg'
      ]);
      assert.equal(images.backgrounds.length, 1);
    });
  } finally {
    if (originalKey === undefined) { delete process.env.TMDB_API_KEY; } else { process.env.TMDB_API_KEY = originalKey; }
  }
});

test('TMDB provider falls back to only the show-level gallery when no seasonNumber is requested', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'test-key';

  try {
    const tmdb = freshModule('../src/providers/tmdb');

    await withMockFetch(async () => ({
      ok: true,
      json: async () => ({ posters: [{ file_path: '/show-poster.jpg' }], backdrops: [], logos: [] })
    }), async () => {
      const images = await tmdb.getShowImages(1668);
      assert.deepEqual(images.posters, ['https://image.tmdb.org/t/p/original/show-poster.jpg']);
    });
  } finally {
    if (originalKey === undefined) { delete process.env.TMDB_API_KEY; } else { process.env.TMDB_API_KEY = originalKey; }
  }
});

test('TMDB provider normalizes a show search result into the shared media shape', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'test-key';

  try {
    const tmdb = freshModule('../src/providers/tmdb');

    await withMockFetch(async () => ({
      ok: true,
      json: async () => ({
        page: 1,
        total_results: 1,
        total_pages: 1,
        results: [{
          id: 1668,
          name: 'Space Family',
          overview: 'A sociopathic scientist and his grandson.',
          first_air_date: '2013-12-02',
          vote_average: 8.7,
          poster_path: '/poster.jpg',
          backdrop_path: '/backdrop.jpg',
          genres: [{ name: 'Animation' }]
        }]
      })
    }), async () => {
      const result = await tmdb.searchTv('Space Family');
      assert.equal(result.media.length, 1);
      const [show] = result.media;
      assert.equal(show.title.english, 'Space Family');
      assert.equal(show.coverImage.large, 'https://image.tmdb.org/t/p/original/poster.jpg');
      assert.equal(show.bannerImage, 'https://image.tmdb.org/t/p/original/backdrop.jpg');
      assert.deepEqual(show.startDate, { year: 2013, month: 12, day: 2 });
      assert.deepEqual(show.genres, ['Animation']);
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.TMDB_API_KEY;
    } else {
      process.env.TMDB_API_KEY = originalKey;
    }
  }
});

test('TMDB provider fails closed (empty results) on a non-ok response or a thrown network error', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'test-key';

  try {
    const tmdb = freshModule('../src/providers/tmdb');

    await withMockFetch(async () => ({ ok: false, status: 500 }), async () => {
      assert.equal(await tmdb.getTvById(1), null);
      assert.deepEqual((await tmdb.searchTv('term')).media, []);
    });

    await withMockFetch(async () => {
      throw new Error('network down');
    }, async () => {
      assert.equal(await tmdb.getTvById(1), null);
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.TMDB_API_KEY;
    } else {
      process.env.TMDB_API_KEY = originalKey;
    }
  }
});

test('fanart provider fails closed on a non-ok response or a thrown network error', async () => {
  const originalKey = process.env.FANART_API_KEY;
  process.env.FANART_API_KEY = 'test-key';

  try {
    const { getFanartImages } = freshModule('../src/providers/fanart');

    await withMockFetch(async () => ({ ok: false, status: 404 }), async () => {
      assert.equal(await getFanartImages(78788), null);
    });

    await withMockFetch(async () => {
      throw new Error('network down');
    }, async () => {
      assert.equal(await getFanartImages(78788), null);
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.FANART_API_KEY;
    } else {
      process.env.FANART_API_KEY = originalKey;
    }
  }
});

function anilistEpisodesMock({ episodes, scheduleFails = false, totalScheduled = 0, streamingEpisodes = [] }) {
  const requestedPages = [];
  const fetchMock = async (url, options = {}) => {
    const payload = JSON.parse(options.body || '{}');
    if (payload.query.includes('query EpisodeSchedule')) {
      if (scheduleFails) {
        return { ok: false, status: 500, headers: new Headers() };
      }
      const { page, perPage } = payload.variables;
      requestedPages.push(page);
      const first = (page - 1) * perPage + 1;
      const last = Math.min(page * perPage, totalScheduled);
      const airingSchedules = [];
      for (let episode = first; episode <= last; episode += 1) {
        airingSchedules.push({ episode, airingAt: 1704067200 });
      }
      return {
        ok: true,
        json: async () => ({ data: { Page: { pageInfo: { hasNextPage: last < totalScheduled }, airingSchedules } } })
      };
    }
    return {
      ok: true,
      json: async () => ({ data: { Media: { id: 21, title: { english: 'Grand Voyage' }, episodes, startDate: { year: 1999 }, streamingEpisodes } } })
    };
  };
  return { fetchMock, requestedPages };
}

test('AniList episode lists walk every airing-schedule page for shows with no fixed episode count', async () => {
  const { getEpisodesPage } = freshModule('../src/providers/anilist');
  const { fetchMock, requestedPages } = anilistEpisodesMock({ episodes: null, totalScheduled: 120 });

  await withMockFetch(fetchMock, async () => {
    const result = await getEpisodesPage(21, 0, Number.MAX_SAFE_INTEGER);
    assert.equal(result.episodes.length, 120);
    assert.deepEqual(requestedPages, [1, 2, 3]);
  });
});

test('AniList streaming episodes are matched by the number in their title, not by position', async () => {
  const { getEpisodesPage } = freshModule('../src/providers/anilist');
  const { fetchMock } = anilistEpisodesMock({
    episodes: 3,
    streamingEpisodes: [
      { title: 'Episode 2 - Second', thumbnail: 'https://img/2.jpg' },
      { title: 'Episode 1 - First', thumbnail: 'https://img/1.jpg' },
      { title: 'Recap special', thumbnail: 'https://img/x.jpg' }
    ]
  });

  await withMockFetch(fetchMock, async () => {
    const { episodes } = await getEpisodesPage(21, 0, 3);
    assert.deepEqual(episodes.map((episode) => [episode.title, episode.thumbnail]), [
      ['First', 'https://img/1.jpg'],
      ['Second', 'https://img/2.jpg'],
      [null, null]
    ]);
  });
});

test('AniList episode lists fail instead of returning a truncated season when the episode count is unknown', async () => {
  const logger = require('../src/utils/logger');
  const originalWarn = logger.warn;
  logger.warn = () => {};

  try {
    const { getEpisodesPage } = freshModule('../src/providers/anilist');
    await withMockFetch(anilistEpisodesMock({ episodes: null, scheduleFails: true }).fetchMock, async () => {
      await assert.rejects(getEpisodesPage(21, 0, Number.MAX_SAFE_INTEGER));
    });

    // With a known episode count only the air dates are lost, so it still answers.
    const fresh = freshModule('../src/providers/anilist');
    await withMockFetch(anilistEpisodesMock({ episodes: 12, scheduleFails: true }).fetchMock, async () => {
      const result = await fresh.getEpisodesPage(21, 0, Number.MAX_SAFE_INTEGER);
      assert.equal(result.episodes.length, 12);
    });
  } finally {
    logger.warn = originalWarn;
  }
});

test('TMDB season episode lookups fail instead of returning an empty season', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'test-key';
  const logger = require('../src/utils/logger');
  const originalWarn = logger.warn;
  logger.warn = () => {};

  try {
    const tmdb = freshModule('../src/providers/tmdb');
    await withMockFetch(async (url) => {
      const href = url.toString();
      if (href.includes('/season/1')) {
        return { ok: false, status: 503 };
      }
      if (href.includes('/content_ratings')) {
        return { ok: true, json: async () => ({ results: [] }) };
      }
      return { ok: true, json: async () => ({ id: 1668, name: 'Space Family', seasons: [{ season_number: 1 }] }) };
    }, async () => {
      await assert.rejects(tmdb.getEpisodesPage(1668, 1, 0, 50));
    });
  } finally {
    logger.warn = originalWarn;
    if (originalKey === undefined) {
      delete process.env.TMDB_API_KEY;
    } else {
      process.env.TMDB_API_KEY = originalKey;
    }
  }
});

test('AniList media lookups are cached, so a repeat call for the same id does not hit the network again', async () => {
  const { getMediaById } = freshModule('../src/providers/anilist');

  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ data: { Media: { id: 15125, title: { english: 'Flame Brigade' } } } })
    };
  }, async () => {
    const first = await getMediaById(15125);
    const second = await getMediaById(15125);

    assert.equal(calls, 1);
    assert.equal(first, second);
  });
});

test('TMDB show lookups are cached, so a repeat call for the same id does not hit the network again', async () => {
  const originalToken = process.env.TMDB_ACCESS_TOKEN;
  process.env.TMDB_ACCESS_TOKEN = 'token';

  try {
    const { getTvById } = freshModule('../src/providers/tmdb');

    let calls = 0;
    await withMockFetch(async (url) => {
      calls += 1;
      if (url.toString().includes('/content_ratings')) {
        return { ok: true, json: async () => ({ results: [] }) };
      }
      return { ok: true, json: async () => ({ id: 88046, name: 'Flame Brigade' }) };
    }, async () => {
      const first = await getTvById(88046);
      const callsAfterFirst = calls;
      const second = await getTvById(88046);

      // First getTvById calls: /tv/{id} and /tv/{id}/content_ratings
      assert.equal(callsAfterFirst, 2);
      // Second getTvById should use cache, no additional calls
      assert.equal(calls, 2);
      assert.equal(first, second);
    });
  } finally {
    if (originalToken === undefined) {
      delete process.env.TMDB_ACCESS_TOKEN;
    } else {
      process.env.TMDB_ACCESS_TOKEN = originalToken;
    }
  }
});

test('Fanart.tv lookups are cached per tvdbId, so a repeat call does not hit the network again', async () => {
  const originalKey = process.env.FANART_API_KEY;
  process.env.FANART_API_KEY = 'key';

  try {
    const { getFanartImages } = freshModule('../src/providers/fanart');

    let calls = 0;
    await withMockFetch(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          tvposter: [{ url: 'https://example.com/poster.jpg' }],
          seasonposter: [],
          showbackground: [],
          hdtvlogo: [],
          clearlogo: []
        })
      };
    }, async () => {
      const first = await getFanartImages(279700);
      const second = await getFanartImages(279700);

      assert.equal(calls, 1);
      assert.deepEqual(first, second);
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.FANART_API_KEY;
    } else {
      process.env.FANART_API_KEY = originalKey;
    }
  }
});
