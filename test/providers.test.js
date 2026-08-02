const test = require('node:test');
const assert = require('node:assert/strict');

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

  const fireForce = {
    title: { english: 'Fire Force', romaji: 'Enen no Shouboutai', native: '炎炎ノ消防隊' }
  };

  // A romaji filename search term must still score an exact match against Fire
  // Force, even though English is the resolved/preferred title.
  assert.equal(createMatchScore(fireForce, 'Enen no Shouboutai'), 100);
  assert.equal(createMatchScore(fireForce, 'Fire Force'), 100);
  // An unrelated show shouldn't get an exact-match bonus just because it shares
  // no titles with the search term.
  const unrelated = { title: { english: 'Some Other Show', romaji: null, native: null } };
  assert.equal(createMatchScore(unrelated, 'Enen no Shouboutai'), 60);
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
    assert.deepEqual(await tmdb.searchTv('Rick and Morty'), {
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
      return { ok: true, json: async () => ({ id: 1668, name: 'Rick and Morty' }) };
    }, async () => {
      const show = await tmdb.getTvById(1668);
      assert.equal(show.title.english, 'Rick and Morty');
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
          name: 'Rick and Morty',
          overview: 'A sociopathic scientist and his grandson.',
          first_air_date: '2013-12-02',
          vote_average: 8.7,
          poster_path: '/poster.jpg',
          backdrop_path: '/backdrop.jpg',
          genres: [{ name: 'Animation' }]
        }]
      })
    }), async () => {
      const result = await tmdb.searchTv('Rick and Morty');
      assert.equal(result.media.length, 1);
      const [show] = result.media;
      assert.equal(show.title.english, 'Rick and Morty');
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

test('AniList media lookups are cached, so a repeat call for the same id does not hit the network again', async () => {
  const { getMediaById } = freshModule('../src/providers/anilist');

  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ data: { Media: { id: 15125, title: { english: 'Fire Force' } } } })
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
    await withMockFetch(async () => {
      calls += 1;
      return { ok: true, json: async () => ({ id: 88046, name: 'Fire Force' }) };
    }, async () => {
      const first = await getTvById(88046);
      const second = await getTvById(88046);

      assert.equal(calls, 1);
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
