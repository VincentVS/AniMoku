const DEFAULT_LANGUAGE = 'en-US';

// A bare ISO 639-1 code doesn't always map to the country of the same code
// ("en" -> "en-EN", "ja" -> "ja-JA" don't exist), so the common ones are explicit.
const DEFAULT_REGIONS = {
  en: 'US', ja: 'JP', zh: 'CN', ko: 'KR', pt: 'BR', sv: 'SE', da: 'DK', cs: 'CZ', el: 'GR', uk: 'UA', he: 'IL'
};

function toTmdbLanguage(value) {
  const first = String(value || '').split(',')[0].split(';')[0].trim().replace('_', '-');
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/i.test(first)) {
    return DEFAULT_LANGUAGE;
  }

  const [language, region] = first.split('-');
  const lower = language.toLowerCase();
  return `${lower}-${(region || DEFAULT_REGIONS[lower] || lower).toUpperCase()}`;
}

// The Metadata Providers protocol passes the library language as X-Plex-Language,
// either as a header or as a query parameter; Accept-Language is only a fallback for
// clients calling the provider directly (Bruno, curl). AniList has no per-language
// titles or summaries beyond english/romaji/native: its entries borrow TMDB's
// translations instead (see utils/localize.js).
function resolveRequestLanguage(req) {
  return toTmdbLanguage(
    req.query?.['X-Plex-Language']
      || req.headers?.['x-plex-language']
      || req.headers?.['accept-language']
  );
}

module.exports = { DEFAULT_LANGUAGE, toTmdbLanguage, resolveRequestLanguage };
