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

function normalizeTitle(rawTitle) {
  return stripBracketedSections(rawTitle)
    .replace(/[._]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !NOISE_TOKENS.has(token.toLowerCase()))
    .join(' ')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .trim();
}

function parseAnimeFilename(filename) {
  if (!filename) {
    return { title: '', seasonNumber: null, episodeNumber: null, airDate: null, pattern: null };
  }

  const basename = path.basename(filename, path.extname(filename));
  let working = basename;
  let seasonNumber = null;
  let episodeNumber = null;
  let airDate = null;
  let pattern = null;

  let match = working.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (match) {
    seasonNumber = Number(match[1]);
    episodeNumber = Number(match[2]);
    pattern = 'season-episode';
    working = working.replace(match[0], ' ');
  }

  if (!pattern) {
    match = working.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (match) {
      airDate = match[1];
      pattern = 'date';
      working = working.replace(match[0], ' ');
    }
  }

  if (!pattern) {
    match = working.match(/(?:^|\s|-)(\d{1,3})(?:\s|$|-)/);
    if (match) {
      episodeNumber = Number(match[1]);
      pattern = 'absolute';
      working = working.replace(match[0], ' ');
    }
  }

  return {
    title: normalizeTitle(working),
    seasonNumber,
    episodeNumber,
    airDate,
    pattern
  };
}

module.exports = {
  parseAnimeFilename,
  normalizeTitle,
  stripBracketedSections
};
