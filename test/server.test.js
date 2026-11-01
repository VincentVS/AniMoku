const test = require('node:test');
const assert = require('node:assert/strict');

// No spacing between AniList calls in tests - the queue itself is still exercised.
process.env.ANILIST_MIN_INTERVAL_MS = '0';
const { createApp } = require('../src/server');

const mockMedia = {
  id: 15125,
  title: { english: 'Example Anime', romaji: 'Example Anime', native: 'サンプル' },
  description: 'AniList summary',
  episodes: 12,
  duration: 24,
  genres: ['Action', 'Fantasy'],
  format: 'TV',
  averageScore: 80,
  isAdult: false,
  bannerImage: 'https://img/banner.jpg',
  coverImage: { large: 'https://img/poster-small.jpg', extraLarge: 'https://img/poster.jpg' },
  startDate: { year: 2024, month: 1, day: 1 },
  studios: { nodes: [{ name: 'Example Studio' }] },
  characters: { edges: [] },
  relations: {
    edges: [{
      relationType: 'SEQUEL',
      node: {
        id: 20000,
        title: { english: 'Example Anime: Second Season', romaji: 'Example Anime 2', native: null },
        format: 'TV',
        episodes: 10,
        coverImage: { large: 'https://img/season2-small.jpg', extraLarge: 'https://img/season2.jpg' },
        bannerImage: 'https://img/season2-banner.jpg',
        startDate: { year: 2025, month: 1, day: 1 }
      }
    }]
  }
};

const mockSequelMedia = {
  id: 20000,
  title: { english: 'Example Anime: Second Season', romaji: 'Example Anime 2', native: null },
  description: 'AniList summary season 2',
  episodes: 10,
  duration: 24,
  genres: ['Action'],
  format: 'TV',
  averageScore: 82,
  isAdult: false,
  bannerImage: 'https://img/season2-banner.jpg',
  coverImage: { large: 'https://img/season2-small.jpg', extraLarge: 'https://img/season2.jpg' },
  startDate: { year: 2025, month: 1, day: 1 },
  studios: { nodes: [{ name: 'Example Studio' }] },
  characters: { edges: [] },
  relations: { edges: [] }
};

test('server exposes Plex provider endpoints with AniList-shaped payloads', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const payload = JSON.parse(options.body || '{}');

    if (payload.query.includes('query SearchMedia')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            Page: {
              pageInfo: { total: 1, currentPage: 1, perPage: 5, hasNextPage: false },
              media: [mockMedia]
            }
          }
        })
      };
    }

    if (payload.query.includes('query EpisodeSchedule')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            Page: {
              airingSchedules: [{ episode: 1, airingAt: 1704067200 }, { episode: 2, airingAt: 1704153600 }]
            }
          }
        })
      };
    }

    if (payload.query.includes('query MediaById')) {
      const requestedId = payload.variables?.id;
      const media = requestedId === mockSequelMedia.id ? mockSequelMedia : mockMedia;
      return { ok: true, json: async () => ({ data: { Media: media } }) };
    }

    return {
      ok: true,
      json: async () => ({ data: { Media: mockMedia } })
    };
  };

  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const metadata = await originalFetch(`${baseUrl}/library/metadata/anilist-15125`).then((response) => response.json());
    assert.equal(metadata.MediaContainer.Metadata[0].guid, 'tv.plex.agents.custom.animoku://show/anilist-15125');
    assert.equal(metadata.MediaContainer.identifier, 'tv.plex.agents.custom.animoku');
    assert.equal(metadata.MediaContainer.Metadata[0].rating, 8);
    assert.equal(metadata.MediaContainer.Metadata[0].studio, 'Example Studio');
    assert.deepEqual(metadata.MediaContainer.Metadata[0].Genre, [{ tag: 'Action' }, { tag: 'Fantasy' }]);

    const children = await originalFetch(`${baseUrl}/library/metadata/anilist-15125/children`, {
      headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '10' }
    }).then((response) => response.json());
    assert.equal(children.MediaContainer.Metadata.length, 2);
    assert.equal(children.MediaContainer.Metadata[0].type, 'season');
    assert.equal(children.MediaContainer.Metadata[0].ratingKey, 'anilist-15125-s1');
    assert.equal(children.MediaContainer.Metadata[0].images.coverPoster, 'https://img/poster.jpg');
    assert.equal(children.MediaContainer.Metadata[1].ratingKey, 'anilist-15125-s2-a20000');
    assert.equal(children.MediaContainer.Metadata[1].parentTitle, 'Example Anime');
    // Each season carries its own AniList cover art instead of reusing the root show's poster.
    assert.equal(children.MediaContainer.Metadata[1].images.coverPoster, 'https://img/season2.jpg');

    const grandchildren = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-s1/grandchildren`, {
      headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '2' }
    }).then((response) => response.json());
    assert.equal(grandchildren.MediaContainer.Metadata[0].type, 'episode');
    assert.equal(grandchildren.MediaContainer.Metadata[0].images.snapshot, 'https://img/poster.jpg#episode-1');

    const season2Grandchildren = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-s2-a20000/grandchildren`, {
      headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '2' }
    }).then((response) => response.json());
    assert.equal(season2Grandchildren.MediaContainer.Metadata[0].parentRatingKey, 'anilist-15125-s2-a20000');
    assert.equal(season2Grandchildren.MediaContainer.Metadata[0].grandparentRatingKey, 'anilist-15125');
    assert.equal(season2Grandchildren.MediaContainer.Metadata[0].grandparentTitle, 'Example Anime');

    // A season's `key` is its /children URL: it must list the season's episodes.
    const season2Children = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-s2-a20000/children?X-Plex-Container-Start=1&X-Plex-Container-Size=1`)
      .then((response) => response.json());
    assert.equal(season2Children.MediaContainer.offset, 1);
    assert.equal(season2Children.MediaContainer.size, 1);
    assert.equal(season2Children.MediaContainer.Metadata[0].type, 'episode');
    assert.equal(season2Children.MediaContainer.Metadata[0].index, 2);
    assert.equal(season2Children.MediaContainer.Metadata[0].parentRatingKey, 'anilist-15125-s2-a20000');

    // On the show itself, grandchildren span every season, not just the first.
    const showGrandchildren = await originalFetch(`${baseUrl}/library/metadata/anilist-15125/grandchildren`).then((response) => response.json());
    const parentKeys = new Set(showGrandchildren.MediaContainer.Metadata.map((episode) => episode.parentRatingKey));
    assert.ok(parentKeys.has('anilist-15125-s1'));
    assert.ok(parentKeys.has('anilist-15125-s2-a20000'));

    // Plex never calls /children or /grandchildren separately when browsing an
    // already-matched show - it relies on includeChildren=1 to get seasons (and,
    // on a season request, episodes) embedded directly in this one response.
    const showWithChildren = await originalFetch(`${baseUrl}/library/metadata/anilist-15125?includeChildren=1`).then((response) => response.json());
    const embeddedSeasons = showWithChildren.MediaContainer.Metadata[0].Children;
    assert.equal(embeddedSeasons.size, 2);
    assert.equal(embeddedSeasons.Metadata[0].ratingKey, 'anilist-15125-s1');
    assert.equal(embeddedSeasons.Metadata[1].ratingKey, 'anilist-15125-s2-a20000');

    const seasonWithChildren = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-s1?includeChildren=1`).then((response) => response.json());
    const embeddedEpisodes = seasonWithChildren.MediaContainer.Metadata[0].Children;
    assert.ok(embeddedEpisodes.size >= 1);
    assert.equal(embeddedEpisodes.Metadata[0].type, 'episode');
    assert.equal(embeddedEpisodes.Metadata[0].parentRatingKey, 'anilist-15125-s1');

    // A single-episode request must keep the episode under its real season: AniList
    // episode keys carry no season number, and defaulting it to 1 used to re-parent
    // season 2+ episodes under a non-existent "anilist-15125-s1-a20000" season.
    const season2Episode = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-e02-a20000`).then((response) => response.json());
    assert.equal(season2Episode.MediaContainer.Metadata[0].ratingKey, 'anilist-15125-e02-a20000');
    assert.equal(season2Episode.MediaContainer.Metadata[0].parentIndex, 2);
    assert.equal(season2Episode.MediaContainer.Metadata[0].parentRatingKey, 'anilist-15125-s2-a20000');
    // Same airing-schedule date as the season's embedded episode list, not a synthesized one.
    assert.equal(season2Episode.MediaContainer.Metadata[0].originallyAvailableAt, '2024-01-02');

    const season1Episode = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-e01`).then((response) => response.json());
    assert.equal(season1Episode.MediaContainer.Metadata[0].parentRatingKey, 'anilist-15125-s1');

    // An AniList season entry that's no longer part of the franchise chain has no
    // season to belong to - 404 rather than inventing one.
    const orphanEpisode = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-e01-a99999`);
    assert.equal(orphanEpisode.status, 404);

    const showWithoutChildren = await originalFetch(`${baseUrl}/library/metadata/anilist-15125`).then((response) => response.json());
    assert.equal(showWithoutChildren.MediaContainer.Metadata[0].Children, undefined);

    const images = await originalFetch(`${baseUrl}/library/metadata/anilist-15125/images`).then((response) => response.json());
    assert.ok(Array.isArray(images.MediaContainer.Image));
    assert.equal(images.MediaContainer.Image[0].type, 'coverPoster');

    const season2Images = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-s2-a20000/images`).then((response) => response.json());
    assert.equal(season2Images.MediaContainer.Image.find((image) => image.type === 'coverPoster').url, 'https://img/season2.jpg');

    const matches = await originalFetch(`${baseUrl}/library/metadata/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'Example.Anime.S01E03.mkv', manual: false })
    }).then((response) => response.json());
    assert.equal(matches.MediaContainer.Metadata[0].parsed.pattern, 'season-episode');
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

const mockTmdbShow = {
  id: 1668,
  name: 'Rick and Morty',
  overview: 'A sociopathic scientist and his grandson.',
  first_air_date: '2013-12-02',
  vote_average: 8.7,
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  genres: [{ name: 'Animation' }],
  number_of_episodes: 10,
  seasons: [{ season_number: 1, episode_count: 10, poster_path: '/season1.jpg', air_date: '2013-12-02' }],
  external_ids: { tvdb_id: 275274, imdb_id: 'tt2861424' }
};

test('server numbers AniList seasons like TVDB when the crosswalk maps them (split cour merged into one season)', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (url.toString().includes('Fribb/anime-lists')) {
      // Like Fate/Zero: both AniList entries are TVDB season 1, the second from episode 13.
      return {
        ok: true,
        json: async () => ([
          { anilist_id: 15125, tvdb_id: 999, season: { tvdb: 1 } },
          { anilist_id: 20000, tvdb_id: 999, season: { tvdb: 1 }, episode_offset: { tvdb: 12 } }
        ])
      };
    }
    const payload = JSON.parse(options.body || '{}');
    if (payload.query.includes('query EpisodeSchedule')) {
      return { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [] } } }) };
    }
    const media = payload.variables?.id === mockSequelMedia.id ? mockSequelMedia : mockMedia;
    return { ok: true, json: async () => ({ data: { Media: media } }) };
  };

  const server = await new Promise((resolve) => {
    const instance = createApp().listen(0, () => resolve(instance));
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/library/metadata`;
    const get = (path) => originalFetch(`${baseUrl}/${path}`);

    const show = await get('anilist-15125?includeChildren=1').then((response) => response.json());
    assert.deepEqual(show.MediaContainer.Metadata[0].Children.Metadata.map((season) => season.ratingKey), ['anilist-15125-s1']);

    const season = await get('anilist-15125-s1?includeChildren=1').then((response) => response.json());
    const episodes = season.MediaContainer.Metadata[0].Children.Metadata;
    assert.equal(episodes.length, 22);
    // The second entry's episodes continue the season's numbering but keep their own keys.
    assert.equal(episodes[12].index, 13);
    assert.equal(episodes[12].ratingKey, 'anilist-15125-e01-a20000');
    assert.equal(episodes[12].parentRatingKey, 'anilist-15125-s1');
    assert.equal(episodes[12].title, 'Episode 13');

    const episode = await get('anilist-15125-e01-a20000').then((response) => response.json());
    assert.equal(episode.MediaContainer.Metadata[0].parentIndex, 1);
    assert.equal(episode.MediaContainer.Metadata[0].index, 13);

    // The pre-alignment key for the second entry no longer names a season.
    assert.equal((await get('anilist-15125-s2-a20000')).status, 404);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('server dispatches tmdb- rating keys to the TMDB provider for non-anime content', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    const href = url.toString();

    // match.js searches AniList and TMDB in parallel - AniList has no results for
    // a Western cartoon like this, so return an empty page.
    if (href.includes('graphql.anilist.co')) {
      const payload = JSON.parse(options.body || '{}');
      if (payload.query.includes('query SearchMedia')) {
        return {
          ok: true,
          json: async () => ({ data: { Page: { pageInfo: { total: 0, currentPage: 1, perPage: 5, hasNextPage: false }, media: [] } } })
        };
      }
      return { ok: true, json: async () => ({ data: { Media: null } }) };
    }

    if (href.includes('/search/tv')) {
      return {
        ok: true,
        json: async () => ({ page: 1, total_results: 1, total_pages: 1, results: [mockTmdbShow] })
      };
    }

    if (href.includes('/season/1')) {
      return {
        ok: true,
        json: async () => ({
          episodes: [{ episode_number: 1, name: 'Pilot', overview: 'First episode', air_date: '2013-12-02' }]
        })
      };
    }

    if (href.includes('/images')) {
      return { ok: true, json: async () => ({ posters: [], backdrops: [], logos: [] }) };
    }

    if (href.includes('/tv/1668')) {
      return { ok: true, json: async () => mockTmdbShow };
    }

    throw new Error(`Unexpected TMDB fetch: ${href}`);
  };

  try {
    const app = createApp();
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const matches = await originalFetch(`${baseUrl}/library/metadata/matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Rick and Morty' })
      }).then((response) => response.json());
      const tmdbMatch = matches.MediaContainer.Metadata.find((entry) => entry.ratingKey.startsWith('tmdb-'));
      assert.ok(tmdbMatch, 'expected a tmdb- prefixed candidate in match results');
      assert.equal(tmdbMatch.ratingKey, 'tmdb-1668');
      assert.equal(tmdbMatch.title, 'Rick and Morty');

      const show = await originalFetch(`${baseUrl}/library/metadata/tmdb-1668`).then((response) => response.json());
      assert.equal(show.MediaContainer.Metadata[0].guid, 'tv.plex.agents.custom.animoku://show/tmdb-1668');
      assert.equal(show.MediaContainer.Metadata[0].title, 'Rick and Morty');

      const showWithChildren = await originalFetch(`${baseUrl}/library/metadata/tmdb-1668?includeChildren=1`).then((response) => response.json());
      const embeddedSeasons = showWithChildren.MediaContainer.Metadata[0].Children;
      assert.equal(embeddedSeasons.size, 1);
      assert.equal(embeddedSeasons.Metadata[0].ratingKey, 'tmdb-1668-s1');

      const seasonWithChildren = await originalFetch(`${baseUrl}/library/metadata/tmdb-1668-s1?includeChildren=1`).then((response) => response.json());
      const embeddedEpisodes = seasonWithChildren.MediaContainer.Metadata[0].Children;
      assert.equal(embeddedEpisodes.size, 1);
      assert.equal(embeddedEpisodes.Metadata[0].title, 'Pilot');

      const children = await originalFetch(`${baseUrl}/library/metadata/tmdb-1668/children`).then((response) => response.json());
      assert.equal(children.MediaContainer.Metadata[0].ratingKey, 'tmdb-1668-s1');

      const grandchildren = await originalFetch(`${baseUrl}/library/metadata/tmdb-1668-s1/grandchildren`).then((response) => response.json());
      assert.equal(grandchildren.MediaContainer.Metadata[0].title, 'Pilot');
      // TMDB seasons have no id of their own, so the season number is part of the
      // episode key - otherwise every season's episode 1 would share one guid.
      assert.equal(grandchildren.MediaContainer.Metadata[0].ratingKey, 'tmdb-1668-s1-e01');

      const episode = await originalFetch(`${baseUrl}/library/metadata/tmdb-1668-s1-e01`).then((response) => response.json());
      assert.equal(episode.MediaContainer.Metadata[0].title, 'Pilot');
      assert.equal(episode.MediaContainer.Metadata[0].parentRatingKey, 'tmdb-1668-s1');

      assert.deepEqual(show.MediaContainer.Metadata[0].Guid, [
        { id: 'imdb://tt2861424' },
        { id: 'tmdb://1668' },
        { id: 'tvdb://275274' }
      ]);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.TMDB_API_KEY;
    } else {
      process.env.TMDB_API_KEY = originalKey;
    }
  }
});

test('server refuses automatic /matches (503) but keeps manual ones on TMDB when AniList is rate-limited', async () => {
  const originalKey = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const href = url.toString();

    // AniList's Cloudflare-fronted API returns a bare 403 (not a JSON error body)
    // when its per-IP rate limit is hit - searchMedia should reject, not throw a
    // JSON-parsing error, and match.js must not let that reject the whole request.
    if (href.includes('graphql.anilist.co')) {
      return { ok: false, status: 403, headers: new Headers({ 'retry-after': '60' }) };
    }

    if (href.includes('/search/tv')) {
      return {
        ok: true,
        json: async () => ({ page: 1, total_results: 1, total_pages: 1, results: [mockTmdbShow] })
      };
    }

    throw new Error(`Unexpected fetch: ${href}`);
  };

  try {
    const app = createApp();
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const automatic = await originalFetch(`${baseUrl}/library/metadata/matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Rick and Morty' })
      });
      assert.equal(automatic.status, 503);

      const response = await originalFetch(`${baseUrl}/library/metadata/matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Rick and Morty', manual: 1 })
      });

      assert.equal(response.status, 200);
      const matches = await response.json();
      assert.equal(matches.MediaContainer.Metadata.length, 1);
      assert.equal(matches.MediaContainer.Metadata[0].ratingKey, 'tmdb-1668');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.TMDB_API_KEY;
    } else {
      process.env.TMDB_API_KEY = originalKey;
    }
  }
});

test('server answers client errors with 400 and hides internal errors behind a generic 500', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1')) {
      return originalFetch(url, options);
    }
    throw new Error('connect ECONNREFUSED internal-detail');
  };
  const server = await new Promise((resolve) => {
    const instance = createApp().listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const badKey = await fetch(`${baseUrl}/library/metadata/not-a-key`);
    assert.equal(badKey.status, 400);
    assert.deepEqual(await badKey.json(), { error: 'Unsupported rating key' });

    const badJson = await fetch(`${baseUrl}/library/metadata/matches`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops'
    });
    assert.equal(badJson.status, 400);

    const upstream = await fetch(`${baseUrl}/library/metadata/anilist-1`);
    assert.equal(upstream.status, 500);
    assert.deepEqual(await upstream.json(), { error: 'Unexpected server error' });
    assert.equal(upstream.headers.get('x-powered-by'), null);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});
