const test = require('node:test');
const assert = require('node:assert/strict');

// No spacing between AniList calls in tests - the queue itself is still exercised.
process.env.ANILIST_MIN_INTERVAL_MS = '0';
process.env.TMDB_API_KEY = 'test';
const { createApp } = require('../src/server');

// The real fetch, for calling the test server while global.fetch is mocked.
const httpFetch = global.fetch;

function media(id, overrides = {}) {
  return {
    id,
    title: { english: 'Longrun', romaji: 'Longrun', native: null },
    synonyms: [],
    description: `Summary ${id}`,
    episodes: 9,
    duration: 24,
    genres: ['Action'],
    format: 'TV',
    averageScore: 80,
    isAdult: false,
    bannerImage: null,
    coverImage: { large: `https://img/${id}.jpg`, extraLarge: `https://img/${id}.jpg` },
    startDate: { year: 2004, month: 10, day: 5 },
    studios: { nodes: [] },
    characters: { edges: [] },
    relations: { edges: [] },
    streamingEpisodes: [],
    ...overrides
  };
}

// A long runner: one AniList entry (700) that Fribb maps to no TVDB season,
// and a sequel (701) that is TVDB season 4 / TMDB season 2. TMDB's "TVDB Order" group
// cuts the 9-episode first TMDB season into TVDB seasons 1-3.
const CATALOG = {
  700: media(700, { relations: { edges: [{ relationType: 'SEQUEL', node: { id: 701, format: 'TV' } }] } }),
  701: media(701, {
    title: { english: 'Longrun: Final Arc', romaji: 'Longrun: Final Arc', native: null },
    episodes: 4,
    startDate: { year: 2022, month: 10, day: 11 },
    relations: { edges: [{ relationType: 'PREQUEL', node: { id: 700, format: 'TV' } }] }
  }),
  // Long runners with no "TVDB Order" group on TMDB (see TMDB_SHOWS): 710 runs over
  // TMDB seasons 1-2, 720 fits in TMDB season 1, which holds its sequel too.
  710: media(710, { relations: { edges: [{ relationType: 'SEQUEL', node: { id: 711, format: 'TV' } }] } }),
  711: media(711, { episodes: 4, relations: { edges: [{ relationType: 'PREQUEL', node: { id: 710, format: 'TV' } }] } }),
  712: media(712, { format: 'OVA', episodes: 1 }),
  // One entry each that TMDB keeps as one season and TVDB splits (see TVDB_SERIES).
  730: media(730),
  740: media(740),
  720: media(720, { relations: { edges: [{ relationType: 'SEQUEL', node: { id: 721, format: 'TV' } }] } }),
  721: media(721, { episodes: 4, relations: { edges: [{ relationType: 'PREQUEL', node: { id: 720, format: 'TV' } }] } })
};

const FRIBB = [
  { anilist_id: 700, type: 'TV', tvdb_id: 800, themoviedb_id: 900, season: { tmdb: 1 } },
  { anilist_id: 701, type: 'TV', tvdb_id: 800, themoviedb_id: 900, season: { tvdb: 4, tmdb: 2 } },
  // No TVDB or TMDB season for any of these, only the sequel's absolute offset.
  { anilist_id: 710, type: 'TV', tvdb_id: 810, themoviedb_id: { tv: 910 } },
  { anilist_id: 711, type: 'TV', tvdb_id: 810, themoviedb_id: { tv: 910 }, episode_offset: { tvdb: 9 } },
  { anilist_id: 712, type: 'OVA', tvdb_id: 810, themoviedb_id: { tv: 910 }, season: { tvdb: 0, tmdb: 0 } },
  // 730 has no season in Fribb; 740 is filed as TVDB season 1, all 9 episodes of it.
  { anilist_id: 730, type: 'TV', tvdb_id: 830, themoviedb_id: { tv: 930 } },
  { anilist_id: 740, type: 'TV', tvdb_id: 840, themoviedb_id: { tv: 940 }, season: { tvdb: 1, tmdb: 1 } },
  { anilist_id: 720, type: 'TV', tvdb_id: 820, themoviedb_id: { tv: 920 } },
  { anilist_id: 721, type: 'TV', tvdb_id: 820, themoviedb_id: { tv: 920 }, episode_offset: { tvdb: 9 } }
];

// Episodes per TMDB season of each show, and whether it has a "TVDB Order" group.
const TMDB_SHOWS = {
  900: { tvdb: 800, seasons: { 1: 9, 2: 4 }, tvdbGroup: true },
  // TMDB's own seasons are TVDB's: 3 + 6 for entry 710, then its sequel.
  910: { tvdb: 810, seasons: { 1: 3, 2: 6, 3: 4 }, tvdbGroup: false },
  // The whole franchise as one TMDB season: no hint of TVDB's split.
  920: { tvdb: 820, seasons: { 1: 13 }, tvdbGroup: false },
  930: { tvdb: 830, seasons: { 1: 9 }, tvdbGroup: false },
  940: { tvdb: 840, seasons: { 1: 9 }, tvdbGroup: false }
};

// Episodes per TheTVDB season (TVDB_API_KEY set): where only TVDB splits the entry.
const TVDB_SERIES = {
  830: { 0: 1, 1: 3, 2: 3, 3: 3 },
  840: { 1: 6, 2: 3 }
};

function tvdbResponse(url) {
  if (url.pathname === '/v4/login') {
    return { status: 'success', data: { token: 'tvdb-token' } };
  }
  const [, seriesId] = /^\/v4\/series\/(\d+)\/episodes\/default$/.exec(url.pathname) || [];
  const seasons = TVDB_SERIES[seriesId];
  if (!seasons) {
    return null;
  }
  const episodes = Object.entries(seasons).flatMap(([seasonNumber, count]) => Array.from(
    { length: count },
    (_, index) => ({ seasonNumber: Number(seasonNumber), number: index + 1 })
  ));
  return { status: 'success', data: { episodes }, links: { next: null } };
}
const TMDB_SEASONS = TMDB_SHOWS[900].seasons;

function tmdbEpisodes(seasonNumber, seasons = TMDB_SEASONS) {
  return Array.from({ length: seasons[seasonNumber] }, (_, index) => ({
    episode_number: index + 1,
    name: `TMDB ${seasonNumber}x${index + 1}`,
    overview: '',
    air_date: null
  }));
}

function groupEpisodes(seasonNumber, from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => ({ season_number: seasonNumber, episode_number: from + index }));
}

function tmdbShow(name = 'Longrun', id = 900) {
  const { tvdb, seasons } = TMDB_SHOWS[id];
  return {
    id,
    name,
    overview: 'Summary TMDB',
    first_air_date: '2004-10-05',
    number_of_episodes: 13,
    seasons: [0, ...Object.keys(seasons).map(Number)].map((n) => ({ season_number: n, episode_count: seasons[n] || 0 })),
    external_ids: { tvdb_id: tvdb }
  };
}

function tmdbResponse(url) {
  const path = url.pathname.replace(/^\/3/, '');
  if (path === '/search/tv') {
    const query = url.searchParams.get('query');
    return { page: 1, total_pages: 1, results: query.startsWith('Longrun') ? [tmdbShow(query)] : [] };
  }
  const [, showId, rest = ''] = /^\/tv\/(\d+)(\/.*)?$/.exec(path) || [];
  const show = TMDB_SHOWS[showId];
  if (show && !rest) {
    const data = tmdbShow('Longrun', Number(showId));
    for (const part of (url.searchParams.get('append_to_response') || '').split(',')) {
      const [, seasonNumber] = /^season\/(\d+)$/.exec(part) || [];
      if (show.seasons[seasonNumber]) {
        data[part] = { episodes: tmdbEpisodes(seasonNumber, show.seasons) };
      }
    }
    return data;
  }
  if (show && rest === '/content_ratings') {
    return { results: [] };
  }
  if (show && rest === '/episode_groups' && !show.tvdbGroup) {
    return { results: [{ id: 'arcs', name: 'Arcs', episode_count: 13 }] };
  }
  if (path === '/tv/900/translations') {
    return {
      translations: [
        { iso_639_1: 'it', iso_3166_1: 'CH', data: { name: 'Longrun CH', overview: 'Trama CH' } },
        { iso_639_1: 'it', iso_3166_1: 'IT', data: { name: 'Longrun IT', overview: 'Trama IT' } }
      ]
    };
  }
  if (path === '/tv/900/episode_groups') {
    return {
      results: [
        { id: 'absolute', name: 'Absolute Order (TVDB)', episode_count: 13 },
        { id: 'tvdb', name: 'TVDB Order', episode_count: 13 }
      ]
    };
  }
  if (path === '/tv/episode_group/tvdb') {
    return {
      groups: [
        { name: 'Specials', order: 0, episodes: [] },
        { name: 'Season 1', order: 1, episodes: groupEpisodes(1, 1, 3) },
        // Arc titles: numbered by position, a number in the title is not the season.
        { name: 'Guard 13 Invasion Arc', order: 2, episodes: groupEpisodes(1, 4, 8) },
        { name: 'The Past Arc', order: 3, episodes: groupEpisodes(1, 9, 9) },
        { name: 'Season 4', order: 4, episodes: groupEpisodes(2, 1, 4) }
      ]
    };
  }
  return null;
}

// Fribb + AniList GraphQL + TMDB. `search` maps an AniList search term -> ids.
function installBackend({ search = {} } = {}) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = url.toString();
    if (href.includes('anime-lists')) {
      return { ok: true, json: async () => FRIBB };
    }
    if (href.startsWith('https://webservice.fanart.tv/v3/tv/800')) {
      const seasonposter = ['1', '2', '3', '4', 'all'].map((season) => ({ season, url: `https://fanart/s${season}.jpg` }));
      return { ok: true, json: async () => ({ seasonposter }) };
    }
    if (href.startsWith('https://api4.thetvdb.com')) {
      const data = tvdbResponse(new URL(href));
      if (!data) {
        throw new Error(`Unexpected TVDB fetch: ${href}`);
      }
      return { ok: true, status: 200, json: async () => data };
    }
    if (href.startsWith('https://api.themoviedb.org')) {
      const data = tmdbResponse(new URL(href));
      if (!data) {
        throw new Error(`Unexpected TMDB fetch: ${href}`);
      }
      return { ok: true, status: 200, json: async () => data };
    }
    if (!href.includes('graphql.anilist.co')) {
      throw new Error(`Unexpected fetch: ${href}`);
    }

    const payload = JSON.parse(options.body || '{}');
    let data;
    if (payload.query.includes('query SearchMedia')) {
      const ids = search[payload.variables.search] || [];
      data = { Page: { pageInfo: { hasNextPage: false }, media: ids.map((id) => CATALOG[id]) } };
    } else if (payload.query.includes('query EpisodeSchedule')) {
      data = { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [] } };
    } else {
      data = { Media: CATALOG[payload.variables.id] || null };
    }
    return { ok: true, headers: new Headers(), json: async () => ({ data }) };
  };
  return { restore: () => { global.fetch = originalFetch; } };
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

function getMetadata(baseUrl, ratingKey, query = '') {
  return httpFetch(`${baseUrl}/library/metadata/${ratingKey}?includeChildren=1${query}`)
    .then(async (response) => ({ status: response.status, body: await response.json() }));
}

test('a long runner with no TVDB season is cut into TVDB seasons by TMDB\'s TVDB-order group', async () => {
  const backend = installBackend();
  try {
    await withServer(async (baseUrl) => {
      const show = await getMetadata(baseUrl, 'anilist-700');
      assert.equal(show.status, 200);
      const seasons = show.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(
        seasons.map((season) => [season.index, season.ratingKey]),
        [[1, 'anilist-700-s1'], [2, 'anilist-700-s2'], [3, 'anilist-700-s3'], [4, 'anilist-700-s4-a701']]
      );

      // Season 2 holds AniList episodes 4-8, numbered from 1 within the season; their
      // ratingKeys keep the AniList number, so watch state survives the regrouping.
      const season2 = await getMetadata(baseUrl, 'anilist-700-s2');
      const episodes = season2.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(episodes.map((episode) => episode.index), [1, 2, 3, 4, 5]);
      assert.equal(episodes[0].title, 'TMDB 1x4');
      assert.equal(episodes[0].ratingKey.startsWith('anilist-700-e04'), true);

      // The sequel stays where Fribb puts it on TVDB.
      const season4 = await getMetadata(baseUrl, 'anilist-700-s4-a701');
      const finalArc = season4.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(finalArc.map((episode) => episode.index), [1, 2, 3, 4]);
      assert.equal(finalArc[0].title, 'TMDB 2x1');
    });
  } finally {
    backend.restore();
  }
});

test('a long runner with no TVDB-order group is cut by the TMDB show seasons', async () => {
  const backend = installBackend();
  try {
    await withServer(async (baseUrl) => {
      const show = await getMetadata(baseUrl, 'anilist-710');
      const seasons = show.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(
        seasons.map((season) => [season.index, season.ratingKey]),
        [[1, 'anilist-710-s1'], [2, 'anilist-710-s2'], [3, 'anilist-710-s3-a711']]
      );

      // Season 2 holds AniList episodes 4-9, TMDB season 2.
      const season2 = await getMetadata(baseUrl, 'anilist-710-s2');
      const episodes = season2.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(episodes.map((episode) => episode.index), [1, 2, 3, 4, 5, 6]);
      assert.equal(episodes[0].title, 'TMDB 2x1');
      assert.equal(episodes[0].ratingKey.startsWith('anilist-710-e04'), true);

      const season3 = await getMetadata(baseUrl, 'anilist-710-s3-a711');
      assert.equal(season3.body.MediaContainer.Metadata[0].Children.Metadata[0].title, 'TMDB 3x1');
    });
  } finally {
    backend.restore();
  }
});

test('a long runner keyed on its sequel series gets the seasons of the whole series', async () => {
  const backend = installBackend();
  try {
    await withServer(async (baseUrl) => {
      const show = await getMetadata(baseUrl, 'anilist-711');
      const seasons = show.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(
        seasons.map((season) => [season.index, season.ratingKey]),
        [[1, 'anilist-711-s1-a710'], [2, 'anilist-711-s2-a710'], [3, 'anilist-711-s3']]
      );
      const season3 = await getMetadata(baseUrl, 'anilist-711-s3');
      assert.equal(season3.body.MediaContainer.Metadata[0].Children.Metadata[0].title, 'TMDB 3x1');
    });
  } finally {
    backend.restore();
  }
});

test('a TVDB id names the first series of a long runner, not its OVA, and its sequel is re-keyed on it', async () => {
  const backend = installBackend();
  try {
    await withServer(async (baseUrl) => {
      const hinted = await postMatch(baseUrl, { type: 2, title: 'Longrun', guid: 'tvdb://810' });
      assert.equal(hinted.body.MediaContainer.Metadata[0].ratingKey, 'anilist-710');
    });
    const { findFranchiseRoot } = require('../src/providers/crosswalk');
    assert.equal(await findFranchiseRoot(711), 710);
    assert.equal(await findFranchiseRoot(710), null);
  } finally {
    backend.restore();
  }
});

async function withTvdb(run) {
  process.env.TVDB_API_KEY = 'test';
  try {
    await run();
  } finally {
    delete process.env.TVDB_API_KEY;
  }
}

test('an entry TMDB keeps whole is cut by the seasons TheTVDB lists', async () => {
  const backend = installBackend();
  try {
    await withTvdb(() => withServer(async (baseUrl) => {
      const show = await getMetadata(baseUrl, 'anilist-730');
      const seasons = show.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(seasons.map((season) => season.ratingKey), ['anilist-730-s1', 'anilist-730-s2', 'anilist-730-s3']);

      const season3 = await getMetadata(baseUrl, 'anilist-730-s3');
      const episodes = season3.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(episodes.map((episode) => episode.index), [1, 2, 3]);
      assert.equal(episodes[0].ratingKey.startsWith('anilist-730-e07'), true);
      // TMDB's single season still gives the titles, by position.
      assert.equal(episodes[0].title, 'TMDB 1x7');
    }));
  } finally {
    backend.restore();
  }
});

test('an entry Fribb files as one season runs on into the next TheTVDB seasons', async () => {
  const backend = installBackend();
  try {
    await withTvdb(() => withServer(async (baseUrl) => {
      const show = await getMetadata(baseUrl, 'anilist-740');
      const seasons = show.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(seasons.map((season) => season.ratingKey), ['anilist-740-s1', 'anilist-740-s2']);

      const season2 = await getMetadata(baseUrl, 'anilist-740-s2');
      const episodes = season2.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(episodes.map((episode) => episode.index), [1, 2, 3]);
      assert.equal(episodes[0].ratingKey.startsWith('anilist-740-e07'), true);
    }));
  } finally {
    backend.restore();
  }
});

test('without a TVDB-order group, a root that fits in TMDB season 1 keeps one season per entry', async () => {
  const backend = installBackend();
  try {
    await withServer(async (baseUrl) => {
      const show = await getMetadata(baseUrl, 'anilist-720');
      const seasons = show.body.MediaContainer.Metadata[0].Children.Metadata;
      assert.deepEqual(seasons.map((season) => season.ratingKey), ['anilist-720-s1', 'anilist-720-s2-a721']);
    });
  } finally {
    backend.restore();
  }
});

test('a sequel Fribb files past a gap follows the long runner\'s last TVDB season', () => {
  const { closeSeasonGaps } = require('../src/utils/childData');
  // The long runner cut into TVDB seasons 1-6, its final act filed by Fribb as season 8
  // (TVDB lists it as 7), and specials in season 0.
  const parts = [
    ...[1, 2, 3, 4, 5, 6].map((seasonNumber) => ({ seasonNumber, start: (seasonNumber - 1) * 27 })),
    { seasonNumber: 8, offset: 0 },
    { seasonNumber: 0, offset: 0 }
  ];
  closeSeasonGaps(parts);
  assert.deepEqual(parts.map((part) => part.seasonNumber), [1, 2, 3, 4, 5, 6, 7, 0]);

  // Seasons that already follow on (a sequel filed as season 17 after 16) are untouched.
  const contiguous = [{ seasonNumber: 16, start: 0 }, { seasonNumber: 17, offset: 0 }, { seasonNumber: 17, offset: 13 }];
  closeSeasonGaps(contiguous);
  assert.deepEqual(contiguous.map((part) => part.seasonNumber), [16, 17, 17]);
});

test('a long runner\'s seasons cut from one AniList entry take their Fanart.tv season poster', async () => {
  const backend = installBackend();
  const original = process.env.FANART_API_KEY;
  process.env.FANART_API_KEY = 'test';
  try {
    await withServer(async (baseUrl) => {
      const show = await getMetadata(baseUrl, 'anilist-700');
      const posters = show.body.MediaContainer.Metadata[0].Children.Metadata
        .map((season) => season.Image.find((image) => image.type === 'coverPoster').url);
      // Seasons 1-3 share entry 700's cover; season 4 is entry 701 and keeps its own.
      assert.deepEqual(posters, ['https://fanart/s1.jpg', 'https://fanart/s2.jpg', 'https://fanart/s3.jpg', 'https://img/701.jpg']);

      const season2 = await getMetadata(baseUrl, 'anilist-700-s2');
      const images = season2.body.MediaContainer.Metadata[0].Image.filter((image) => image.type === 'coverPoster');
      assert.deepEqual(images.map((image) => image.url), ['https://fanart/s2.jpg', 'https://img/700.jpg']);
    });
  } finally {
    if (original === undefined) {
      delete process.env.FANART_API_KEY;
    } else {
      process.env.FANART_API_KEY = original;
    }
    backend.restore();
  }
});

test('episode matching reads ambiguous numbers as absolute only with FILE_NUMBERING=absolute', async () => {
  const backend = installBackend({ search: { Longrun: [700] } });
  const original = process.env.FILE_NUMBERING;
  try {
    await withServer(async (baseUrl) => {
      // "S02E04": season 2's 4th episode (AniList 7), or absolute episode 4.
      const episode = { type: 4, grandparentTitle: 'Longrun', parentIndex: 2, index: 4 };
      delete process.env.FILE_NUMBERING;
      const relative = await postMatch(baseUrl, episode);
      assert.equal(relative.body.MediaContainer.Metadata[0].ratingKey.startsWith('anilist-700-e07'), true);

      process.env.FILE_NUMBERING = 'absolute';
      const absolute = await postMatch(baseUrl, episode);
      assert.equal(absolute.body.MediaContainer.Metadata[0].ratingKey.startsWith('anilist-700-e04'), true);

      // Plex pairs files with the season's episodes by index: season 2 (AniList 4-8)
      // must list them as 4-8, the numbers its files carry.
      const season2 = await getMetadata(baseUrl, 'anilist-700-s2');
      assert.deepEqual(season2.body.MediaContainer.Metadata[0].Children.Metadata.map((item) => item.index), [4, 5, 6, 7, 8]);
      const pastSeason1 = await postMatch(baseUrl, { ...episode, index: 6 });
      assert.equal(pastSeason1.body.MediaContainer.Metadata[0].ratingKey.startsWith('anilist-700-e06'), true);
      // A season-relative file in such a library is still found by its position.
      const relativeFile = await postMatch(baseUrl, { ...episode, index: 2 });
      assert.equal(relativeFile.body.MediaContainer.Metadata[0].ratingKey.startsWith('anilist-700-e05'), true);

      // An index past the season can only be absolute, whatever the setting.
      delete process.env.FILE_NUMBERING;
      const pastSeason = await postMatch(baseUrl, { ...episode, index: 9 });
      assert.equal(pastSeason.body.MediaContainer.Metadata[0].ratingKey.startsWith('anilist-700-e09'), true);
    });
  } finally {
    if (original === undefined) {
      delete process.env.FILE_NUMBERING;
    } else {
      process.env.FILE_NUMBERING = original;
    }
    backend.restore();
  }
});

test('TMDB hits the crosswalk maps to AniList are folded into the AniList entry', async () => {
  const backend = installBackend({ search: { Longrun: [700] } });
  try {
    await withServer(async (baseUrl) => {
      // AniList doesn't find the folder name, TMDB does: the match is still AniList's.
      const automatic = await postMatch(baseUrl, { type: 2, title: 'Longrun 2004' });
      assert.equal(automatic.body.MediaContainer.size, 1);
      assert.equal(automatic.body.MediaContainer.Metadata[0].ratingKey, 'anilist-700');
      assert.equal(automatic.body.MediaContainer.Metadata[0].title, 'Longrun');

      // A manual list keeps one entry per show, clean by default...
      const plain = await postMatch(baseUrl, { type: 2, title: 'Longrun', manual: 1 });
      assert.deepEqual(
        plain.body.MediaContainer.Metadata.map((show) => [show.ratingKey, show.title]),
        [['anilist-700', 'Longrun']]
      );

      // ...labelled on request with its provider and format, and with the episodes of
      // the whole series (TMDB's 13), not of the first entry alone (9).
      process.env.MATCH_LABEL_SOURCE = 'true';
      const source = await postMatch(baseUrl, { type: 2, title: 'Longrun', manual: 1 });
      assert.equal(source.body.MediaContainer.Metadata[0].title, 'Longrun [AniList · TV]');

      process.env.MATCH_LABEL_EPISODES = 'true';
      const both = await postMatch(baseUrl, { type: 2, title: 'Longrun', manual: 1 });
      assert.equal(both.body.MediaContainer.Metadata[0].title, 'Longrun [AniList · TV · 13 ep]');

      delete process.env.MATCH_LABEL_SOURCE;
      const episodes = await postMatch(baseUrl, { type: 2, title: 'Longrun', manual: 1 });
      assert.equal(episodes.body.MediaContainer.Metadata[0].title, 'Longrun [13 ep]');
    });
  } finally {
    delete process.env.MATCH_LABEL_SOURCE;
    delete process.env.MATCH_LABEL_EPISODES;
    backend.restore();
  }
});

test('a long runner\'s sequel entry is folded into the long runner, which has no TVDB season 1', async () => {
  const backend = installBackend({ search: { Longrun: [700, 701] } });
  try {
    await withServer(async (baseUrl) => {
      // AniList lists the sequel under its own title too: the Fix Match list keeps one show.
      const manual = await postMatch(baseUrl, { type: 2, title: 'Longrun', manual: 1 });
      assert.deepEqual(manual.body.MediaContainer.Metadata.map((show) => show.ratingKey), ['anilist-700']);
    });
  } finally {
    backend.restore();
  }
});

test('a non-English library gets the show title and synopsis from TMDB translations', async () => {
  const backend = installBackend();
  try {
    await withServer(async (baseUrl) => {
      const show = await getMetadata(baseUrl, 'anilist-700', '&X-Plex-Language=it');
      const metadata = show.body.MediaContainer.Metadata[0];
      assert.equal(metadata.title, 'Longrun IT');
      assert.equal(metadata.summary, 'Trama IT');
      // Seasons cut from the root share its synopsis; the sequel keeps its own.
      const seasons = metadata.Children.Metadata;
      assert.equal(seasons[0].summary, 'Trama IT');
      assert.equal(seasons[0].parentTitle, 'Longrun IT');
      assert.equal(seasons[3].summary, 'Summary 701');

      const english = await getMetadata(baseUrl, 'anilist-700', '&X-Plex-Language=en');
      assert.equal(english.body.MediaContainer.Metadata[0].title, 'Longrun');
      assert.equal(english.body.MediaContainer.Metadata[0].summary, 'Summary 700');
    });
  } finally {
    backend.restore();
  }
});
