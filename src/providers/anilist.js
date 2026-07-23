const ANILIST_URL = 'https://graphql.anilist.co';
const { buildDate, resolveTitle, stripHtml } = require('../utils/mapping');

async function runQuery(query, variables = {}) {
  const response = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`AniList request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }

  return payload.data;
}

const MEDIA_FIELDS = `
  id
  title {
    romaji
    english
    native
  }
  description(asHtml: false)
  episodes
  duration
  genres
  bannerImage
  coverImage {
    large
    extraLarge
  }
  startDate {
    year
    month
    day
  }
`;

async function getMediaById(id) {
  const query = `
    query MediaById($id: Int!) {
      Media(id: $id, type: ANIME) {
        ${MEDIA_FIELDS}
      }
    }
  `;

  const data = await runQuery(query, { id: Number(id) });
  return data.Media;
}

async function searchMedia(search, page = 1, perPage = 5) {
  const query = `
    query SearchMedia($search: String!, $page: Int!, $perPage: Int!) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          total
          currentPage
          perPage
          hasNextPage
        }
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          ${MEDIA_FIELDS}
        }
      }
    }
  `;

  const data = await runQuery(query, { search, page, perPage });
  return data.Page;
}

async function getEpisodesPage(id, start = 0, size = 50) {
  const media = await getMediaById(id);
  const totalEpisodes = Number(media?.episodes || 0);
  const safeTotal = totalEpisodes > 0 ? totalEpisodes : Math.max(start + size, 1);
  const page = Math.floor(start / size) + 1;

  const query = `
    query EpisodeSchedule($mediaId: Int!, $page: Int!, $perPage: Int!) {
      Page(page: $page, perPage: $perPage) {
        airingSchedules(mediaId: $mediaId, sort: EPISODE) {
          episode
          airingAt
        }
      }
    }
  `;

  let schedules = [];
  try {
    const data = await runQuery(query, { mediaId: Number(id), page, perPage: size });
    schedules = data.Page?.airingSchedules || [];
  } catch (error) {
    schedules = [];
  }

  function formatAiringDate(airingAt) {
    if (!airingAt) {
      return buildDate(media.startDate);
    }

    return new Date(airingAt * 1000).toISOString().slice(0, 10);
  }

  const episodes = [];
  const limit = Math.min(start + size, safeTotal);
  for (let number = start + 1; number <= limit; number += 1) {
    const scheduled = schedules.find((entry) => entry.episode === number);
    episodes.push({
      episodeNumber: number,
      airDate: formatAiringDate(scheduled?.airingAt),
      title: `Episode ${String(number).padStart(2, '0')}`,
      summary: stripHtml(media.description || '')
    });
  }

  return {
    media,
    episodes,
    totalSize: safeTotal
  };
}

function createMatchScore(media, term, parsed = {}) {
  const title = resolveTitle(media).toLowerCase();
  const normalizedTerm = String(term || '').toLowerCase();

  let score = 60;
  if (normalizedTerm && title === normalizedTerm) {
    score = 100;
  } else if (normalizedTerm && title.includes(normalizedTerm)) {
    score = 92;
  }

  if (parsed.episodeNumber) {
    score -= 2;
  }

  if (parsed.airDate) {
    score -= 3;
  }

  return Math.max(score, 1);
}

module.exports = {
  getMediaById,
  searchMedia,
  getEpisodesPage,
  createMatchScore
};
