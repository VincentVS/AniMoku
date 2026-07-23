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
  bannerImage: 'https://img/banner.jpg',
  coverImage: { large: 'https://img/poster-small.jpg', extraLarge: 'https://img/poster.jpg' },
  startDate: { year: 2024, month: 1, day: 1 }
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

    const children = await originalFetch(`${baseUrl}/library/metadata/anilist-15125/children`, {
      headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '10' }
    }).then((response) => response.json());
    assert.equal(children.MediaContainer.Metadata[0].type, 'season');

    const grandchildren = await originalFetch(`${baseUrl}/library/metadata/anilist-15125-s1/grandchildren`, {
      headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '2' }
    }).then((response) => response.json());
    assert.equal(grandchildren.MediaContainer.Metadata[0].type, 'episode');
    assert.equal(grandchildren.MediaContainer.Metadata[0].images.snapshot, 'https://img/poster.jpg#episode-1');

    const images = await originalFetch(`${baseUrl}/library/metadata/anilist-15125/images`).then((response) => response.json());
    assert.equal(images.MediaContainer.Metadata[0].images.coverPoster, 'https://img/poster.jpg');

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
