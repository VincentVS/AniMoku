const DEFAULT_TTL_MS = 10 * 60 * 1000;

function resolveTtlMs() {
  const raw = Number(process.env.METADATA_CACHE_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : DEFAULT_TTL_MS;
}

// Simple in-memory TTL cache shared by the provider modules to avoid re-fetching
// AniList/TMDB/Fanart.tv data on every Plex request - Plex frequently calls
// metadata/children/grandchildren/images back-to-back for the same entry, and
// AniList in particular rate-limits/outright disables its API under load with no
// documented recovery time. A single process instance (the Docker deployment
// model, see README) makes an in-memory cache sufficient - no Redis needed.
function createCache(ttlMs = resolveTtlMs()) {
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value) {
    if (ttlMs <= 0) {
      return;
    }
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Caches the resolved value of `loader()`, including a rejected promise's
  // failure - NOT cached, so a transient error (e.g. AniList 403) doesn't get
  // remembered and returned to subsequent requests once the upstream recovers.
  async function wrap(key, loader) {
    const cached = get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await loader();
    set(key, value);
    return value;
  }

  return {
    get, set, wrap
  };
}

module.exports = { createCache };
