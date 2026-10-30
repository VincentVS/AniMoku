const tmdb = require('../providers/tmdb');
const anidb = require('../providers/anidb');

// AniList knows which episodes exist and how a franchise is split, but has a title
// for only a fraction of them (One Piece: 69 of 1100+) and no per-episode summary.
// So, like Jellyfin's TheMovieDb > AniDB episode order and HAMA's AniDB episode
// lists, each AniList episode is looked up in:
//   - TMDB, by its franchise-absolute position in the show's regular episodes
//     (TMDB, TVDB and AniList all split seasons differently, but the episodes run
//     in the same order), localized in the library language with English fallback;
//   - AniDB, by its number within the AniDB anime (usually one per AniList entry).
// Per field, the first usable value wins:
//   title    TMDB (library language) > AniDB (library language) > TMDB (English)
//            > AniDB (English) > AniDB (romaji) > AniList streaming title
//   summary  TMDB (library language) > TMDB (English) > AniDB > AniList
//   date     TMDB > AniDB > AniList
//   still    TMDB > AniList streaming thumbnail
const DAY_MS = 24 * 60 * 60 * 1000;
// How far (in episodes) a dated AniList episode is searched for around its expected
// TMDB position: absorbs recaps and specials one side counts as regular episodes.
const SEARCH_WINDOW = 5;
const SEARCH_OFFSETS = [0];
for (let step = 1; step <= SEARCH_WINDOW; step += 1) {
  SEARCH_OFFSETS.push(step, -step);
}

// "Episode 12", "Episodio 12", "第12話"...: what TMDB and AniDB put where they have
// no real title. Showing one would hide a real title from the next source.
const GENERIC_TITLE = /^(?:(?:episode|episodio|épisode|folge|ep\.?)\s*\d+|第\s*\d+\s*話)$/i;

function usableTitle(value) {
  const title = String(value || '').trim();
  return title && !GENERIC_TITLE.test(title) ? title : null;
}

function sameDay(a, b) {
  const distance = Math.abs(Date.parse(a) - Date.parse(b));
  return Number.isFinite(distance) && distance <= DAY_MS;
}

// Index in `list` of each AniList episode, starting from `base` (episodes of the
// franchise before this entry). Episodes with a real AniList air date re-anchor the
// position on the TMDB episode aired the same day (+/- 1, time zones); undated ones
// follow the last anchor. When several dated episodes all fail to line up, TMDB
// numbers this entry differently and none of its data is used.
function alignToList(episodes, list, base) {
  const positions = new Map();
  let shift = 0;
  let dated = 0;
  let matched = 0;
  for (const episode of episodes) {
    const expected = base + shift + episode.episodeNumber - 1;
    if (episode.airDate && !episode.airDateEstimated) {
      dated += 1;
      const found = SEARCH_OFFSETS.find((step) => list[expected + step]?.airDate
        && sameDay(list[expected + step].airDate, episode.airDate));
      if (found !== undefined) {
        shift += found;
        matched += 1;
      }
    }
    const index = base + shift + episode.episodeNumber - 1;
    if (index >= 0 && index < list.length) {
      positions.set(episode.episodeNumber, index);
    }
  }
  return dated >= 3 && matched === 0 ? new Map() : positions;
}

function isEnglish(language) {
  return /^en\b/i.test(String(language || ''));
}

// Fetched for every part of a season in parallel before any of them is used, so a
// season of several AniList entries waits for AniDB's throttled queue at most once.
async function loadSources(part, language) {
  const [primary, english, anime] = await Promise.all([
    part.tmdb ? tmdb.getRegularEpisodes(part.tmdb.id, language) : [],
    part.tmdb && !isEnglish(language) ? tmdb.getRegularEpisodes(part.tmdb.id, 'en-US') : [],
    part.anidb ? anidb.getAnime(part.anidb.aid) : null
  ]);
  return {
    primary, english, anime, language
  };
}

function enrichEpisodes(part, episodes, sources) {
  const {
    primary, english, anime, language
  } = sources;
  const reference = primary.length ? primary : english;
  const positions = part.tmdb && reference.length ? alignToList(episodes, reference, part.tmdb.offset) : new Map();
  const anidbEpisodes = new Map((anime?.episodes || []).map((episode) => [episode.number, episode]));
  const lang = String(language || '').slice(0, 2).toLowerCase();

  return episodes.map((episode) => {
    const index = positions.get(episode.episodeNumber);
    const local = index === undefined ? null : primary[index];
    const fallback = index === undefined ? null : english[index];
    const fromAnidb = part.anidb ? anidbEpisodes.get(part.anidb.offset + episode.episodeNumber) : null;
    const titles = fromAnidb?.titles || {};

    const title = usableTitle(local?.title)
      || usableTitle(titles[lang])
      || usableTitle(fallback?.title)
      || usableTitle(titles.en)
      || usableTitle(titles['x-jat'])
      || episode.title;

    return {
      ...episode,
      title,
      summary: local?.summary || fallback?.summary || fromAnidb?.summary || episode.summary,
      airDate: local?.airDate || fallback?.airDate || fromAnidb?.airDate || episode.airDate,
      thumbnail: local?.thumbnail || fallback?.thumbnail || episode.thumbnail
    };
  });
}

module.exports = {
  loadSources, enrichEpisodes, alignToList, usableTitle
};
