const test = require('node:test');
const assert = require('node:assert/strict');
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
    assert.equal(metadata.MediaContainer.Metadata[0].guid, 'tv.plex.agents.custom.anime.anilist://show/anilist-15125');
    assert.equal(metadata.MediaContainer.identifier, 'tv.plex.agents.custom.anime.anilist');
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
  seasons: [{ season_number: 1, episode_count: 10, poster_path: '/season1.jpg', air_date: '2013-12-02' }]
};

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
      assert.equal(show.MediaContainer.Metadata[0].guid, 'tv.plex.agents.custom.anime.anilist://show/tmdb-1668');
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
      assert.equal(grandchildren.MediaContainer.Metadata[0].ratingKey, 'tmdb-1668-e01');
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

test('server keeps /matches working (200) with TMDB-only results when AniList is rate-limited', async () => {
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

      const response = await originalFetch(`${baseUrl}/library/metadata/matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Rick and Morty' })
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
