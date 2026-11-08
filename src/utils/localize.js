const tmdb = require('../providers/tmdb');
const { getExternalIds, getTmdbPlacement } = require('../providers/crosswalk');

// AniList titles are english/romaji/native and its synopses English only. For a
// library in another language, the TMDB translation of the show the crosswalk maps an
// entry to fills title.localized (picked through TITLE_LANGUAGE_ORDER) and replaces the
// description. Only an entry that starts its TMDB show is localized: a later cour
// shares the series' TMDB id, whose overview describes season 1. Returns the media
// unchanged when there's nothing to borrow.
async function localizeMedia(media, language) {
  if (!media || !language || String(language).startsWith('en')) {
    return media;
  }

  const placement = await getTmdbPlacement(media.id);
  const tmdbId = placement
    ? (placement.season === 1 && !placement.episodeOffset ? placement.tmdbId : null)
    : (await getExternalIds(media.id)).tmdb;
  const translation = tmdbId ? await tmdb.getTranslation(tmdbId, language) : null;
  if (!translation) {
    return media;
  }

  return {
    ...media,
    title: { ...media.title, localized: translation.title },
    description: translation.summary || media.description
  };
}

module.exports = { localizeMedia };
