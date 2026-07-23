function parsePaging(input = {}) {
  const startValue = Number(input.start ?? input['X-Plex-Container-Start'] ?? input['x-plex-container-start'] ?? 0);
  const sizeValue = Number(input.size ?? input['X-Plex-Container-Size'] ?? input['x-plex-container-size'] ?? 50);

  const start = Number.isFinite(startValue) && startValue > 0 ? Math.floor(startValue) : 0;
  const size = Number.isFinite(sizeValue) && sizeValue > 0 ? Math.floor(sizeValue) : 50;

  return { start, size };
}

function paginate(items, paging = {}) {
  const { start, size } = parsePaging(paging);
  const totalSize = items.length;
  const metadata = items.slice(start, start + size);

  return {
    metadata,
    start,
    size,
    totalSize,
    end: start + metadata.length
  };
}

module.exports = {
  parsePaging,
  paginate
};
