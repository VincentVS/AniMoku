const path = require('node:path');

const NOISE_TOKENS = new Set([
  '1080p',
  '720p',
  '2160p',
  '480p',
  'x264',
  'x265',
  'h264',
  'hevc',
  'aac',
  'dual',
  'multi',
  'sub',
  'subs',
  'dub',
  'bluray',
  'bdrip',
  'webrip',
  'web',
  'nf',
  'amzn',
  'cr',
  'vostfr'
]);

function stripBracketedSections(value) {
  let result = '';
  let squareDepth = 0;
  let roundDepth = 0;

  for (const character of value) {
    if (character === '[') {
      squareDepth += 1;
      continue;
    }

    if (character === ']') {
      squareDepth = Math.max(squareDepth - 1, 0);
      continue;
    }

    if (character === '(') {
      roundDepth += 1;
      continue;
    }

    if (character === ')') {
      roundDepth = Math.max(roundDepth - 1, 0);
      continue;
    }

    if (squareDepth === 0 && roundDepth === 0) {
      result += character;
    }
  }

  return result;
}

function isWhitespace(character) {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f' || character === '\v';
}

function normalizeSeparators(value) {
  let result = '';

  for (const character of value) {
    result += character === '.' || character === '_' ? ' ' : character;
  }

  return result;
}

function splitOnWhitespace(value) {
  const tokens = [];
  let current = '';

  for (const character of value) {
    if (isWhitespace(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function trimEdgeDashes(value) {
  let start = 0;
  let end = value.length;

  while (start < end && (value[start] === '-' || isWhitespace(value[start]))) {
    start += 1;
  }

  while (end > start && (value[end - 1] === '-' || isWhitespace(value[end - 1]))) {
    end -= 1;
  }

  return value.slice(start, end);
}

function normalizeTitle(rawTitle) {
  return splitOnWhitespace(normalizeSeparators(stripBracketedSections(rawTitle)))
    .filter((token) => !NOISE_TOKENS.has(token.toLowerCase()))
    .join(' ')
    .trim();
}

// A 4-digit "episode" in this range is almost always a year ("Show - 2019"), not an
// episode of a long runner like "Show - 1071".
function isLikelyYear(value) {
  const number = Number(value);
  return String(value).length === 4 && number >= 1900 && number <= 2099;
}

// "S2", "Season 2", "2nd Season" right before an absolute episode number: fansub
// releases name later seasons this way ("Show S2 - 05") instead of using SxxEyy.
const SEASON_MARKER = String.raw`(?:S(\d{1,2})|Season\s?(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s+Season)`;

// Tried in order; the first hit wins. `episode` is a 4-digit-capable group so long
// runners ("Show - 1071") work, and an optional `v2` revision suffix is accepted.
// Everything before the hit is the series title - whatever follows (episode title,
// resolution, codec, release group) is never part of it.
const EPISODE_PATTERNS = [
  {
    pattern: 'season-episode',
    regex: /\bS(\d{1,2})\s?E(\d{1,4})(?:v\d+)?\b/i,
    read: (m) => ({ seasonNumber: Number(m[1]), episodeNumber: Number(m[2]) })
  },
  {
    pattern: 'season-episode',
    regex: /\b(\d{1,2})x(\d{2,4})\b/i,
    read: (m) => ({ seasonNumber: Number(m[1]), episodeNumber: Number(m[2]) })
  },
  {
    pattern: 'date',
    regex: /\b(\d{4}-\d{2}-\d{2})\b/,
    read: (m) => ({ airDate: m[1] })
  },
  {
    pattern: 'season-absolute',
    regex: new RegExp(String.raw`\b${SEASON_MARKER}\s+(?:-\s+)?(?:E|EP|Episode\s?)?(\d{1,4})(?:v\d+)?(?=\s|$)`, 'i'),
    read: (m) => ({ seasonNumber: Number(m[1] || m[2] || m[3]), episodeNumber: Number(m[4]) })
  },
  {
    pattern: 'absolute',
    regex: /\b(?:E|EP|Ep\s|Episode\s?)(\d{1,4})(?:v\d+)?\b/i,
    read: (m) => ({ episodeNumber: Number(m[1]) })
  },
  {
    // "Show - 05", the fansub convention: only a dash-separated number counts, so a
    // number that belongs to the title ("Squad 100", "42") is left alone.
    pattern: 'absolute',
    regex: /\s-\s+(\d{1,4})(?:v\d+)?(?=\s|$)/,
    read: (m) => (isLikelyYear(m[1]) ? null : { episodeNumber: Number(m[1]) })
  },
  {
    // Last resort: a trailing bare number ("Show 05").
    pattern: 'absolute',
    regex: /\s(\d{1,4})(?:v\d+)?$/,
    read: (m) => (isLikelyYear(m[1]) ? null : { episodeNumber: Number(m[1]) })
  }
];

function parseAnimeFilename(filename) {
  if (!filename) {
    return { title: '', seasonNumber: null, episodeNumber: null, airDate: null, pattern: null };
  }

  const basename = path.basename(filename, path.extname(filename));
  const working = splitOnWhitespace(normalizeSeparators(stripBracketedSections(basename))).join(' ');
  const result = { seasonNumber: null, episodeNumber: null, airDate: null, pattern: null };
  let titlePart = working;

  for (const candidate of EPISODE_PATTERNS) {
    const match = candidate.regex.exec(working);
    const values = match && candidate.read(match);
    if (!values) {
      continue;
    }

    Object.assign(result, values, { pattern: candidate.pattern });
    // A release that starts with the marker ("S01E05 - Show") has no title before it.
    titlePart = working.slice(0, match.index).trim() || working.slice(match.index + match[0].length);
    break;
  }

  return {
    title: trimEdgeDashes(normalizeTitle(titlePart)) || titleFromFolders(filename),
    ...result
  };
}

const SEASON_FOLDER = /^(?:season\s*\d+|s\d{1,2}|specials?|extras?)$/i;

// Plex sends the file path relative to the library root ("/Show/Season 01/S01E05.mkv"),
// so a file named only by its episode marker still has the show in its folder name.
function titleFromFolders(filename) {
  const folders = path.dirname(String(filename)).split(/[\\/]/).filter(Boolean).reverse();
  const showFolder = folders.find((folder) => folder !== '.' && !SEASON_FOLDER.test(folder.trim()));
  return showFolder ? trimEdgeDashes(normalizeTitle(showFolder)) : '';
}

module.exports = {
  parseAnimeFilename,
  normalizeTitle,
  stripBracketedSections,
  splitOnWhitespace
};
