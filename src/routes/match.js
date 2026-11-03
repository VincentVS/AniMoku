const express = require('express');
const { searchMedia, createMatchScore, getMediaById } = require('../providers/anilist');
const tmdb = require('../providers/tmdb');
const {
  findAnilistId, findFranchiseRoot, getExternalIds, getTmdbPlacement
} = require('../providers/crosswalk');
const logger = require('../utils/logger');
const {
  SCHEME, ABSOLUTE_PROVIDER, buildRatingKey, createGuid, parseRatingKey, isAbsoluteOrder
} = require('../utils/guid');
const { parseAnimeFilename, normalizeTitle } = require('../utils/filenameParser');
const { buildDate, resolveTitle, stripHtml } = require('../utils/mapping');
const { SERIES_FORMATS, getAllSeasons, getAllEpisodes } = require('../utils/childData');
const { resolveRequestLanguage } = require('../utils/language');
const providerConfig = require('../../config/provider.json');

const router = express.Router();
const providerIdentifier = providerConfig.MediaProvider?.identifier;

// Plex metadata type ids (see docs/MediaProvider.md in plexinc/tmdb-example-provider).
const PLEX_TYPES = { 2: 'show', 3: 'season', 4: 'episode' };

// Below this an automatic match has no title in common with the search term at all
// (see createMatchScore): handing it to Plex would silently attach the wrong series,
// while an empty answer leaves the item unmatched for a manual Fix Match.
const MIN_AUTOMATIC_SCORE = 70;

class UpstreamUnavailableError extends Error {}

// Plex sends its flags as 1/0 integers; Boolean("0") would read them as true.
function readFlag(value) {
  return value === true || Number(value) === 1;
}

function readPlexType(value) {
  if (value === undefined || value === null || value === '') {
    return 'show';
  }
  const name = String(value).toLowerCase();
  return PLEX_TYPES[Number(value)] || (Object.values(PLEX_TYPES).includes(name) ? name : null);
}

function readNumber(value) {
  const number = Number(value);
  return value !== undefined && value !== null && value !== '' && Number.isFinite(number) ? number : null;
}

// Plex sends the series title in a different field per type: `title` for a show,
// `parentTitle` for a season, `grandparentTitle` for an episode (an episode's own
// `title` is the episode name, never the series). A folder-style "Show (2019)" year is
// split off so it scores as a year instead of being part of the title.
function resolveSearchInput(type, body, parsedFilename) {
  const explicit = {
    show: body.title,
    season: body.parentTitle || body.title,
    episode: body.grandparentTitle
  }[type];
  let term = String(explicit || '')
    .replace(ID_TAG_PATTERN, ' ')
    .replace(ORDER_TAG_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let year = readNumber(body.year);

  const trailingYear = /\s*\((\d{4})\)$/.exec(term);
  if (trailingYear) {
    term = term.slice(0, trailingYear.index).trim();
    year = year || Number(trailingYear[1]);
  }

  // Release-group noise (resolution, codecs...) is only stripped from filename-derived
  // titles: an explicit title is taken as Plex gives it.
  return { term: term || normalizeTitle(parsedFilename.title || ''), year };
}

// "[anilist-12345]", "{tvdb-123456}", "[anidb=1234]": the folder-tag convention HAMA
// and Plex's own agents use to pin a series. Plex only passes `guid` once an item has
// been matched, so on the first scan these tags are the only precise hint available.
const ID_TAG_PATTERN = /[[{](anilist|anidb|tvdb|tmdb|imdb|mal)[-=](tt\d+|\d+)[\]}]/gi;

// "[absolute]" / "{absolute}" picks the absolute episode order for this show (every
// regular season merged into season 1: S01E103 files), "[tvdb]" the TVDB one; with
// neither, EPISODE_ORDER decides. Either in the folder name or typed in Fix Match.
const ORDER_TAG_PATTERN = /[[{](absolute|tvdb)[\]}]/gi;

function findOrderTag(...texts) {
  for (const text of texts) {
    const match = new RegExp(ORDER_TAG_PATTERN.source, 'i').exec(String(text || ''));
    if (match) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

function fileNumbersAreAbsolute() {
  return String(process.env.FILE_NUMBERING || '').trim().toLowerCase() === 'absolute';
}

function defaultEpisodeOrder() {
  return String(process.env.EPISODE_ORDER || '').trim().toLowerCase() === 'absolute' ? 'absolute' : 'tvdb';
}

// AniList candidates take the requested order as their provider (see utils/guid.js).
// One of our own guids keeps the order it was matched with unless a tag says
// otherwise: changing it changes every rating key, and with them the watch state.
function applyEpisodeOrder(candidate, tagOrder) {
  if (!['anilist', ABSOLUTE_PROVIDER].includes(candidate.provider)) {
    return candidate;
  }
  if (!tagOrder && candidate.fixedOrder) {
    return candidate;
  }
  const order = tagOrder || defaultEpisodeOrder();
  return { ...candidate, provider: order === 'absolute' ? ABSOLUTE_PROVIDER : 'anilist' };
}

function findIdTag(...texts) {
  for (const text of texts) {
    const match = new RegExp(ID_TAG_PATTERN.source, 'i').exec(String(text || ''));
    if (match) {
      return `${match[1].toLowerCase()}://${match[2]}`;
    }
  }
  return null;
}

const GUID_SOURCES = {
  anilist: 'anilist',
  tvdb: 'tvdb',
  thetvdb: 'tvdb',
  tmdb: 'tmdb',
  themoviedb: 'tmdb',
  imdb: 'imdb',
  anidb: 'anidb',
  mal: 'mal',
  myanimelist: 'mal'
};

// `guid` is Plex's precise-match hint: one of our own guids on a refresh, or an
// external id such as `tvdb://123456` (e.g. from a `{tvdb-123456}` folder tag).
// External ids are mapped to AniList through the Fribb crosswalk; a TMDB id with no
// anime mapping falls back to the TMDB provider. Returns { provider, id } or null.
async function resolveGuidHint(guid) {
  const match = /^([a-z0-9.]+):\/\/(?:(?:show|season|episode)\/)?([^/?#]+)/i.exec(String(guid || '').trim());
  if (!match) {
    return null;
  }

  const [, scheme, value] = match;
  if (scheme.toLowerCase() === SCHEME) {
    try {
      const parsed = parseRatingKey(value);
      return { provider: parsed.provider, id: parsed.rootId, fixedOrder: true };
    } catch {
      return null;
    }
  }

  const source = GUID_SOURCES[scheme.toLowerCase()];
  if (!source) {
    return null;
  }
  if (source === 'anilist') {
    return Number(value) ? { provider: 'anilist', id: Number(value) } : null;
  }

  const anilistId = await findAnilistId(source, value);
  if (anilistId) {
    return { provider: 'anilist', id: anilistId };
  }
  if (source === 'tmdb' && Number(value) && tmdb.isConfigured()) {
    return { provider: 'tmdb', id: Number(value) };
  }
  return null;
}

async function fetchShow(hint, language) {
  if (hint.provider === 'tmdb') {
    return tmdb.getTvById(hint.id, language);
  }
  try {
    return await getMediaById(hint.id);
  } catch (error) {
    throw new UpstreamUnavailableError(error.message);
  }
}

// TMDB lists most anime too, often under the same title and year
// as AniList. A TMDB hit the crosswalk maps to an AniList entry is that entry: it's
// dropped when the AniList one is listed (which keeps the better score), and swapped
// for it when it would be the automatic match - otherwise Plex could attach the anime
// to TMDB's seasons and episodes. Expects candidates sorted by score; returns them so.
async function preferAnilist(candidates, manual) {
  const byAnilistId = new Map(candidates
    .filter((candidate) => candidate.provider === 'anilist')
    .map((candidate) => [candidate.media.id, candidate]));
  const kept = [];
  for (const candidate of candidates) {
    const anilistId = candidate.provider === 'tmdb' ? await findAnilistId('tmdb', candidate.media.id) : null;
    if (!anilistId) {
      kept.push(candidate);
    } else if (byAnilistId.has(anilistId)) {
      const listed = byAnilistId.get(anilistId);
      listed.score = Math.max(listed.score, candidate.score);
    } else if (!manual && !kept.length) {
      const media = await getMediaById(anilistId).catch(() => null);
      const swapped = media ? { provider: 'anilist', media, score: candidate.score } : candidate;
      if (media) {
        byAnilistId.set(anilistId, swapped);
      }
      kept.push(swapped);
    } else {
      kept.push(candidate);
    }
  }
  return kept.sort((a, b) => b.score - a.score);
}

// Ranked show candidates as { provider, media, score }. AniList (anime) and TMDB
// (everything else - Western cartoons, live action) are searched in parallel and
// merged; on equal scores AniList stays first, and TMDB duplicates of AniList entries
// are folded into them (see preferAnilist). TMDB is a silent no-op without credentials.
async function findShows({
  term, year, parsedFilename, guid, manual, includeAdult, language
}) {
  const hint = await resolveGuidHint(guid);
  if (hint) {
    const media = await fetchShow(hint, language);
    if (media) {
      logger.info({ guid, provider: hint.provider, id: hint.id }, 'match resolved from guid hint');
      return [{
        provider: hint.provider, media, score: 100, hinted: true, fixedOrder: Boolean(hint.fixedOrder)
      }];
    }
    logger.info({ guid }, 'guid hint did not resolve to an entry, falling back to title search');
  }

  if (!term) {
    return [];
  }

  const perPage = manual ? 10 : 5;
  const [anilistResult, tmdbResult] = await Promise.allSettled([
    searchMedia(term, 1, perPage, { includeAdult }),
    tmdb.searchTv(term, 1, language)
  ]);

  if (anilistResult.status === 'rejected') {
    // On an automatic match (library scan / refresh) a TMDB-only answer is worse
    // than no answer: Plex would happily re-match an anime to its TMDB entry,
    // swapping every guid and losing seasons and watch state. Failing the request
    // makes Plex keep the existing match and try again on the next refresh. A manual
    // "Fix Match" still gets the TMDB fallback - the user picks the candidate there.
    if (!manual) {
      logger.warn({ term, err: anilistResult.reason }, 'AniList search failed, refusing automatic match');
      throw new UpstreamUnavailableError('AniList is unavailable, retry later');
    }
    logger.warn({ term, err: anilistResult.reason }, 'AniList search failed, continuing with TMDB results only');
  }
  if (tmdbResult.status === 'rejected') {
    logger.warn({ term, err: tmdbResult.reason }, 'TMDB search failed, continuing with AniList results only');
  }

  const anilistMedia = anilistResult.status === 'fulfilled' ? anilistResult.value?.media || [] : [];
  const tmdbMedia = tmdbResult.status === 'fulfilled' ? (tmdbResult.value?.media || []).slice(0, perPage) : [];
  const score = (media) => createMatchScore(media, term, parsedFilename, { year });

  const candidates = await preferAnilist([
    ...anilistMedia.map((media) => ({ provider: 'anilist', media, score: score(media) })),
    ...tmdbMedia.map((media) => ({ provider: 'tmdb', media, score: score(media) }))
  ].sort((a, b) => b.score - a.score), manual);

  logger.info({
    term,
    year,
    anilistResults: anilistMedia.length,
    tmdbResults: tmdbMedia.length,
    best: candidates[0] ? { provider: candidates[0].provider, id: candidates[0].media.id, score: candidates[0].score } : null
  }, 'match search completed');

  return candidates;
}

// Re-keys an AniList search hit on its franchise's first season, so a folder named
// after a sequel ("Some Show II", "Some Show Season 2") still yields the show
// as a whole - title, year and poster of season 1, and one ratingKey/guid whichever
// season's folder name Plex happened to search with. Only the Fribb crosswalk is
// trusted for this: the AniList PREQUEL chain also links distinct shows (a series ->
// its sequel series), which Plex libraries keep as separate series. Explicit hints
// (guid, folder id tags) are never re-keyed: they say which entry was meant.
async function toFranchiseRoot(candidate) {
  if (candidate.provider !== 'anilist' || candidate.hinted) {
    return candidate;
  }

  try {
    const rootId = await findFranchiseRoot(candidate.media.id);
    if (!rootId || rootId === candidate.media.id) {
      return candidate;
    }

    const media = await getMediaById(rootId);
    if (!media) {
      return candidate;
    }
    logger.info({ matchedId: candidate.media.id, rootId }, 'match re-keyed on the franchise first season');
    return { ...candidate, media };
  } catch (error) {
    logger.warn({ id: candidate.media.id, err: error }, 'franchise root lookup failed, keeping the matched entry');
    return candidate;
  }
}

// Several seasons of one franchise collapse onto the same root: keep the best-scored.
function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(({ provider, media }) => {
    const key = `${provider}:${media.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// "[AniList · TV · 24 ep]": AniList and TMDB often list a show under the same title
// and year, and Plex's Fix Match list shows little else to tell them apart.
function candidateLabel(provider, media, episodeCount = media.episodes) {
  const source = provider === 'tmdb' ? 'TMDB' : 'AniList';
  const format = media.format ? media.format.replace(/_/g, ' ') : null;
  const episodes = episodeCount ? `${episodeCount} ep` : null;
  return `[${[source, format, episodes].filter(Boolean).join(' · ')}]`;
}

// An AniList candidate is a franchise's first entry, but stands for the whole show
// with every sequel season: its episode count is that of the TMDB show the crosswalk
// maps it to, which spans the whole series (only TMDB's season count would differ
// from TVDB's). Falls back to the entry's own count; a TMDB candidate already has it.
async function seriesEpisodeCount({ provider, media }, language) {
  if (provider === 'tmdb' || !SERIES_FORMATS.has(media.format)) {
    return media.episodes;
  }
  const placement = await getTmdbPlacement(media.id);
  const tmdbId = placement
    ? (placement.season === 1 && !placement.episodeOffset ? placement.tmdbId : null)
    : (await getExternalIds(media.id)).tmdb;
  const show = tmdbId ? await tmdb.getTvById(tmdbId, language) : null;
  return Math.max(show?.episodes || 0, media.episodes || 0) || null;
}

function toShowCandidate({ provider, media, score }, extras, episodeCount) {
  const ratingKey = buildRatingKey('show', media.id, undefined, undefined, provider);
  const title = resolveTitle(media);
  return {
    type: 'show',
    ratingKey,
    key: `/library/metadata/${ratingKey}/children`,
    guid: createGuid('show', ratingKey),
    // Only on manual lists: an automatic match's title is what Plex stores.
    title: extras?.manual ? `${title} ${candidateLabel(provider, media, episodeCount)}` : title,
    originalTitle: media.title?.romaji || null,
    summary: stripHtml(media.description || ''),
    year: media.startDate?.year || null,
    originallyAvailableAt: buildDate(media.startDate),
    thumb: media.coverImage?.extraLarge || media.coverImage?.large || null,
    score,
    ...extras
  };
}

async function loadSeasonEpisodes(show, season, language) {
  const key = parseRatingKey(season.ratingKey);
  const result = await getAllEpisodes(show.provider, show.media.id, key.seasonNumber, key.seasonAnilistId, language);
  return result?.episodes || [];
}

// Episodes are matched on the same TVDB-aligned season/index numbering the show's
// includeChildren embed exposes, so S03E13 lands on a split cour's "Part 2" entry.
// Fansub releases often number a whole franchise absolutely ("Show - 30" being season
// 2 episode 6): when season 1 has no such episode, the index is counted across the
// regular seasons in order. Sonarr's TVDB season folders can keep absolute numbers too
// ("S02E25" after a 24-episode season 1): a later season falls back the same way, but
// only for an index past season 1, which a season-relative number never is. When an
// index fits both ways (S02E21 with 20 episodes in season 1 and 21 in season 2), the
// season-relative reading wins unless FILE_NUMBERING=absolute says the library names
// files with absolute numbers (Sonarr's "S02.E21" with {absolute} as the episode).
// The absolute order has a single regular season, so the file's season is ignored there.
// `date` is the protocol's fallback when there's no index.
async function findEpisode(show, { parentIndex, index, date }, language) {
  const seasons = (await getAllSeasons(show.provider, show.media.id, language))?.seasons || [];
  const regularSeasons = seasons.filter((season) => season.index > 0).sort((a, b) => a.index - b.index);

  if (index) {
    const seasonNumber = isAbsoluteOrder(show.provider) ? 1 : (parentIndex ?? 1);
    const findDirect = async () => {
      const season = seasons.find((entry) => entry.index === seasonNumber);
      return season && (await loadSeasonEpisodes(show, season, language)).find((episode) => episode.index === index);
    };
    const findAbsolute = async () => {
      let remaining = index;
      for (const entry of regularSeasons) {
        const episodes = (await loadSeasonEpisodes(show, entry, language)).sort((a, b) => a.index - b.index);
        if (remaining <= episodes.length) {
          return episodes[remaining - 1];
        }
        remaining -= episodes.length;
      }
      return null;
    };

    const firstSeasonLength = regularSeasons.length
      ? (await loadSeasonEpisodes(show, regularSeasons[0], language)).length
      : 0;
    const absoluteAllowed = seasonNumber === 1 || index > firstSeasonLength;
    const lookups = absoluteAllowed && seasonNumber > 1 && fileNumbersAreAbsolute()
      ? [findAbsolute, findDirect]
      : [findDirect, ...(absoluteAllowed ? [findAbsolute] : [])];
    for (const lookup of lookups) {
      const episode = await lookup();
      if (episode) {
        return episode;
      }
    }
  }

  if (date) {
    for (const entry of seasons) {
      const episode = (await loadSeasonEpisodes(show, entry, language)).find((item) => item.originallyAvailableAt === date);
      if (episode) {
        return episode;
      }
    }
  }

  return null;
}

async function resolveMatches(type, body, language) {
  const parsedFilename = parseAnimeFilename(body.filename);
  const manual = readFlag(body.manual);
  const includeChildren = readFlag(body.includeChildren);
  const { term, year } = resolveSearchInput(type, body, parsedFilename);

  const guid = body.guid || findIdTag(body.title, body.parentTitle, body.grandparentTitle, body.filename);
  if (!term && !guid) {
    return { error: 'A title, parentTitle, grandparentTitle, guid, or filename is required' };
  }

  const shows = await findShows({
    term,
    year,
    parsedFilename,
    guid,
    manual,
    includeAdult: readFlag(body.includeAdult),
    language
  });
  const qualified = manual ? shows : shows.filter((show) => show.score >= MIN_AUTOMATIC_SCORE);
  if (!manual && shows.length && !qualified.length) {
    logger.info({ term, bestScore: shows[0].score }, 'no candidate scored high enough for an automatic match');
  }
  // Without `manual` the protocol expects only the best match; a manual list can hold
  // several seasons of one franchise, which collapse onto the same root.
  const tagOrder = findOrderTag(body.title, body.parentTitle, body.grandparentTitle, body.filename);
  const eligible = dedupeCandidates((await Promise.all(
    (manual ? qualified : qualified.slice(0, 1)).map(toFranchiseRoot)
  )).map((candidate) => applyEpisodeOrder(candidate, tagOrder)));

  if (type === 'show') {
    const episodeCounts = manual ? await Promise.all(eligible.map((show) => seriesEpisodeCount(show, language))) : [];
    const metadata = eligible.map((show, index) => toShowCandidate(show, {
      manual, filename: body.filename || null, parsed: parsedFilename
    }, episodeCounts[index]));
    if (includeChildren && metadata.length === 1) {
      const seasons = await getAllSeasons(eligible[0].provider, eligible[0].media.id, language);
      if (seasons) {
        metadata[0].Children = { size: seasons.seasons.length, Metadata: seasons.seasons };
      }
    }
    return { metadata };
  }

  // Seasons and episodes are resolved under the best show only: walking several
  // candidates' season chains would cost dozens of rate-limited AniList calls.
  const show = eligible[0];
  if (!show) {
    return { metadata: [] };
  }

  if (type === 'season') {
    const seasonIndex = readNumber(body.index) ?? parsedFilename.seasonNumber ?? 1;
    const season = (await getAllSeasons(show.provider, show.media.id, language))?.seasons
      .find((entry) => entry.index === seasonIndex);
    if (!season) {
      return { metadata: [] };
    }
    const metadata = { ...season, score: show.score };
    if (includeChildren) {
      const episodes = await loadSeasonEpisodes(show, season, language);
      metadata.Children = { size: episodes.length, Metadata: episodes };
    }
    return { metadata: [metadata] };
  }

  const episode = await findEpisode(show, {
    parentIndex: readNumber(body.parentIndex) ?? parsedFilename.seasonNumber,
    index: readNumber(body.index) ?? parsedFilename.episodeNumber,
    date: body.date || parsedFilename.airDate
  }, language);
  return { metadata: episode ? [{ ...episode, score: show.score }] : [] };
}

router.post('/matches', async (req, res, next) => {
  try {
    const body = { ...req.query, ...(req.body || {}) };
    const type = readPlexType(body.type);
    if (!type) {
      return res.status(400).json({ error: `Unsupported metadata type: ${body.type}` });
    }

    const { error, metadata } = await resolveMatches(type, body, resolveRequestLanguage(req));
    if (error) {
      return res.status(400).json({ error });
    }

    return res.json({
      MediaContainer: {
        offset: 0,
        totalSize: metadata.length,
        identifier: providerIdentifier,
        size: metadata.length,
        Metadata: metadata
      }
    });
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) {
      return res.status(503).json({ error: error.message });
    }
    return next(error);
  }
});

module.exports = router;
