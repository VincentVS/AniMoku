# Anime Metadata Provider (AniList)

Anime Metadata Provider (AniList) is an external metadata provider for Plex Media Server 1.43+ built on the new Plex Metadata Providers model. It exposes show, season, episode, image, and matching endpoints backed by the AniList GraphQL API, with an optional TMDB fallback for non-anime content.

## Features

- Plex provider root JSON in `/config/provider.json`
- Metadata lookup for show, season, and episode records
- Children and grandchildren endpoints with Plex paging headers
- AniList-powered title matching for automatic and manual searches
- Optional TMDB fallback so non-anime titles (Western cartoons, live-action) can also be matched, see [Non-anime content via TMDB](#non-anime-content-via-tmdb)
- Filename parsing for `SxxEyy`, absolute episode numbering, and dated episodes
- Structured request/error logging via [pino](https://getpino.io/), see [Logging](#logging)
- Docker and Docker Compose deployment support

## Plex requirements

- Plex Media Server 1.43 or newer
- Access from Plex to the provider HTTP endpoint
- A library or external provider configuration that references the scheme `tv.plex.agents.custom.anime.anilist`

## Project structure

```text
/src
  /server.js
  /routes
    metadata.js
    match.js
    images.js
    children.js
    grandchildren.js
  /providers
    anilist.js
    tmdb.js
    fanart.js
    crosswalk.js
  /utils
    guid.js
    filenameParser.js
    paging.js
    mapping.js
    logger.js
    cache.js
    childData.js
/config
  provider.json
Dockerfile
docker-compose.yml
README.md
LICENSE
```

## Running locally

```bash
npm install
npm start
```

The service listens on port `3000` by default.

## Docker deployment

### Docker

```bash
docker build -t anime-metadata-provider .
docker run -p 3000:3000 --restart unless-stopped anime-metadata-provider
```

### Docker Compose

```bash
docker compose up -d --build
```

## Plex configuration

1. Deploy the service where Plex can reach it.
2. Verify the provider root document is available at `http://HOST:3000/`.
3. Register the external provider in Plex using the identifier `tv.plex.agents.custom.anime.anilist`.
4. Point Plex metadata lookups to the provider base URL.
5. Use GUIDs in the format `tv.plex.agents.custom.anime.anilist://show/anilist-15125`.

## Endpoint summary

- `GET /library/metadata/:id`
- `GET /library/metadata/:id/children`
- `GET /library/metadata/:id/grandchildren`
- `GET /library/metadata/:id/images`
- `POST /library/metadata/matches`

Every `:id` is a rating key prefixed with the provider that produced it — `anilist-<id>...` or `tmdb-<id>...` (see [Non-anime content via TMDB](#non-anime-content-via-tmdb)). The prefix is only ever used internally to route the request to the right backend; Plex just treats it as an opaque identifier, same as before.

## Example requests

### Provider root

```http
GET /
```

### Show metadata

```http
GET /library/metadata/anilist-15125
```

Example response:

```json
{
  "MediaContainer": {
    "size": 1,
    "Metadata": [
      {
        "type": "show",
        "ratingKey": "anilist-15125",
        "guid": "tv.plex.agents.custom.anime.anilist://show/anilist-15125",
        "title": "Example Anime",
        "originalTitle": "Example Anime Romaji",
        "summary": "AniList summary mapped for Plex.",
        "originallyAvailableAt": "2024-01-01",
        "year": 2024,
        "genres": ["Action", "Fantasy"],
        "Genre": [{ "tag": "Action" }, { "tag": "Fantasy" }],
        "studio": "Example Studio",
        "Studio": [{ "tag": "Example Studio" }],
        "contentRating": null,
        "rating": 8.5,
        "Rating": [{ "image": "tv.plex.agents.custom.anime.anilist://image.rating", "type": "audience", "value": 8.5 }],
        "Role": [{ "tag": "Voice Actor Name", "role": "Character Name", "order": 1, "thumb": "https://.../actor.jpg" }],
        "images": {
          "coverPoster": "https://.../poster.jpg",
          "background": "https://.../banner.jpg",
          "clearLogo": null,
          "snapshot": null
        },
        "childCount": 1
      }
    ]
  }
}
```

### Children with paging

```http
GET /library/metadata/anilist-15125/children
X-Plex-Container-Start: 0
X-Plex-Container-Size: 50
```

The provider resolves the full season chain for a show by walking AniList `relations` edges (`PREQUEL`/`SEQUEL`, using `relationType(version: 2)`) starting from the matched root entry, keeping only entries whose `format` is `TV`, `TV_SHORT`, or `ONA`. Each discovered season is a distinct AniList `Media` object, so its own `coverImage`/`bannerImage` is used instead of reusing the root show's artwork. A season backed by a different AniList entry than the root gets a rating key with an `-a<seasonAnilistId>` suffix, e.g.:

```json
{
  "MediaContainer": {
    "size": 2,
    "Metadata": [
      { "type": "season", "ratingKey": "anilist-15125-s1", "parentTitle": "Example Anime", "images": { "coverPoster": "https://.../poster.jpg" } },
      { "type": "season", "ratingKey": "anilist-15125-s2-a20000", "parentTitle": "Example Anime", "images": { "coverPoster": "https://.../season2-poster.jpg" } }
    ]
  }
}
```

Single-season shows keep the original `anilist-<id>-s1` format with no suffix, so previously matched Plex libraries are unaffected.

### Grandchildren with paging

```http
GET /library/metadata/anilist-15125-s1/grandchildren
X-Plex-Container-Start: 0
X-Plex-Container-Size: 25
```

For a non-root season (e.g. `anilist-15125-s2-a20000/grandchildren`), episodes are fetched from that season's own AniList id while `grandparentRatingKey`/`grandparentTitle` still point back to the root show.

### Match request

```http
POST /library/metadata/matches
Content-Type: application/json

{
  "filename": "Example.Anime.S01E03.mkv",
  "manual": false
}
```

Example response:

```json
{
  "MediaContainer": {
    "size": 1,
    "Metadata": [
      {
        "type": "show",
        "ratingKey": "anilist-15125",
        "guid": "tv.plex.agents.custom.anime.anilist://show/anilist-15125",
        "title": "Example Anime",
        "score": 92,
        "manual": false,
        "filename": "Example.Anime.S01E03.mkv",
        "parsed": {
          "title": "Example Anime",
          "seasonNumber": 1,
          "episodeNumber": 3,
          "airDate": null,
          "pattern": "season-episode"
        }
      }
    ]
  }
}
```

When `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN` is set, AniList and TMDB are searched in parallel and the results are merged into a single, score-sorted `Metadata` array — candidates can carry either an `anilist-` or a `tmdb-` rating key, so a title AniList has no real entry for (e.g. "Rick and Morty") can still surface a correct TMDB match. See [Non-anime content via TMDB](#non-anime-content-via-tmdb).

## Testing with Bruno

A Bruno collection is included under `/bruno`. Import the folder in [Bruno](https://www.usebruno.com/) to get all the requests pre-configured.

```
bruno/
  Bruno.json               ← collection descriptor
  environments/
    Local.bru              ← base_url=http://localhost:3000
    Docker.bru             ← base_url=http://YOUR_DOCKER_HOST:3000
  Provider Root.bru
  Health Check.bru
  Metadata/
    Show Metadata.bru
    Season Metadata.bru
    Episode Metadata.bru
    Children (Seasons).bru
    Grandchildren (Episodes).bru
    Images.bru
  Match/
    Match by Filename.bru
    Match by Title (Manual).bru
```

1. Open Bruno and choose **Open Collection** → select the `bruno/` folder.
2. Select the **Local** environment to test against `npm start`, or **Docker** to point at your container.
3. Edit `Docker.bru` and replace `YOUR_DOCKER_HOST` with the actual IP or hostname of your Docker host.

All Metadata requests use AniList ID `15125` (Fullmetal Alchemist: Brotherhood) as the default example value; adjust the URL parameter to any valid AniList series ID.

---

## Deploying alongside Plex on a Docker host

### Publishing the image to a registry

Before referencing the image in a remote Docker host or a Synology NAS, build and push it to a container registry.

#### Docker Hub

```bash
docker build -t <DOCKERHUB_USER>/<REPO_NAME>:latest .
docker push <DOCKERHUB_USER>/<REPO_NAME>:latest
```

#### GitHub Container Registry (ghcr.io)

```bash
echo $GITHUB_PAT | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin

docker build -t ghcr.io/YOUR_GITHUB_USER/anime-metadata-provider:latest .
docker push ghcr.io/YOUR_GITHUB_USER/anime-metadata-provider:latest
```

#### Private / self-hosted registry

```bash
docker build -t YOUR_REGISTRY_HOST/anime-metadata-provider:latest .
docker push YOUR_REGISTRY_HOST/anime-metadata-provider:latest
```

Once pushed, set the `ANIME_PROVIDER_IMAGE` variable and the compose file will pull from the registry instead of building locally. Copy [`.env.example`](.env.example) to `.env` (gitignored) next to `docker-compose.yml` and adjust it:

```bash
# .env
ANIME_PROVIDER_IMAGE=<DOCKERHUB_USER>/<REPO_NAME>:latest
TITLE_LANGUAGE_ORDER=english,romaji,native
FANART_API_KEY=
TMDB_API_KEY=
TMDB_ACCESS_TOKEN=
LOG_LEVEL=info
```

```bash
docker compose up -d
```

---

The easiest way to expose the provider to an existing Plex container is to put both services on the same Docker network so Plex can reach the provider by container name.

### docker-compose with a shared network

```yaml
# docker-compose.yml (add to the existing definition)
services:
  anime-provider:
    image: ${ANIME_PROVIDER_IMAGE}   # set in .env or environment
    ports:
      - "3000:3000"
    restart: unless-stopped
    environment:
      TITLE_LANGUAGE_ORDER: ${TITLE_LANGUAGE_ORDER:-english,romaji,native}
      FANART_API_KEY: ${FANART_API_KEY:-}
      TMDB_API_KEY: ${TMDB_API_KEY:-}
      TMDB_ACCESS_TOKEN: ${TMDB_ACCESS_TOKEN:-}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    networks:
      - plex_net          # join the same network as Plex

networks:
  plex_net:
    external: true        # must already exist, created by the Plex compose stack
```

If your Plex stack uses a different network name, replace `plex_net` with the actual name. You can inspect it with:

```bash
docker network ls
docker inspect <plex_container_name> --format '{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}'
```

### Registering the provider URL in Plex

Once the container is running and reachable from Plex, set the provider base URL to:

```
http://anime-provider:3000
```

(use the container service name when both containers share a Docker network, or the host IP when they do not).

Verify connectivity from the Plex container before registering:

```bash
docker exec -it <plex_container_name> curl -s http://anime-provider:3000/health
# expected: {"status":"ok"}
```

### Synology NAS (DSM 7 / Container Manager)

1. In **Container Manager → Project**, import this repository or create a new project with the `docker-compose.yml`.
2. In the **Network** tab, add the project to the same bridge network used by your Plex container.
3. Note the IP assigned to the `anime-provider` container (visible under **Container → Details → Network**) and use `http://<IP>:3000` as the provider URL if a shared named network is not available.

---

## Metadata fields

Show and season records are enriched with the following AniList-derived fields, mapped to the field names expected by Plex's Metadata Provider API (confirmed against the official [`plexinc/tmdb-example-provider`](https://github.com/plexinc/tmdb-example-provider) reference):

| Field | Source | Notes |
| --- | --- | --- |
| `originalTitle` | `title.romaji` | Romanized (Latin-script) original title, e.g. `"Shingeki no Kyojin"`; `null` if AniList has no romaji title. Native (kanji/kana) script is intentionally not used here since it isn't readable to most users |
| `Genre` / `genres` | `genres` | `Genre` is the Plex-shaped `[{tag}]` array; `genres` is kept as a flat array for backward compatibility |
| `studio` / `Studio` | `studios(isMain: true)` | `studio` is the first studio name (string), `Studio` is the full `[{tag}]` array |
| `rating` / `Rating` | `averageScore` | AniList's 0-100 score divided by 10 and rounded to one decimal; omitted when AniList has no score |
| `contentRating` | `isAdult` | Coarse only — `'NC-17'` when `isAdult` is true, otherwise `null`. AniList has no real-world rating-board data |
| `Role` | `characters` + `voiceActors` | `tag` is the Japanese voice actor's name (falls back to the character name), `role` is the character name |

## Real per-season cover art

Previously every season reused the root show's own artwork because the provider only ever queried a single AniList `Media` entry. AniList models each season of a franchise (sequels, second seasons, etc.) as a **separate `Media` entry** linked through `relations` edges rather than as sub-objects of one entry.

The provider now resolves the full season chain by walking `relations` edges in both the `PREQUEL` and `SEQUEL` direction from the matched root entry (using `relationType(version: 2)` for accurate typing), re-fetching each newly discovered entry's own relations to continue the walk (capped at 12 hops per direction), and keeping only entries whose `format` is `TV`, `TV_SHORT`, or `ONA` so movies/OVAs/specials aren't treated as seasons. Each season in the resulting chain keeps its own `coverImage`/`bannerImage`, while `parentTitle`/`grandparentTitle` and the show-level rating key still point back to the originally matched root entry.

To stay backward compatible with already-matched Plex libraries, the rating-key format only changes when a season is backed by a different AniList id than the root: single-season shows (the majority case) keep the original `anilist-<id>` / `anilist-<id>-s1` format byte-for-byte; multi-season franchises get an additional `-a<seasonAnilistId>` suffix, e.g. `anilist-15125-s2-a20000`.

If a franchise's seasons still show up with a mismatched cover after this fix, it's usually because Plex had already matched the show under the old single-season behavior and cached it — use **Fix Match** (re-select the match) or **Refresh Metadata** on the affected show so Plex re-fetches `/children` and picks up the new season list/artwork.

## Title language preference

`title` (and `parentTitle`/`grandparentTitle`/match-result titles) are resolved from AniList's `title.english`, `title.romaji`, and `title.native` fields, in that priority order by default. Set the `TITLE_LANGUAGE_ORDER` environment variable to a comma-separated list of those three keys to change the priority, e.g.:

```bash
TITLE_LANGUAGE_ORDER=romaji,english,native
```

Any key you omit is appended after the ones you listed, so you only need to specify the keys you want to move up. Unknown keys (e.g. `italian`) are ignored. Leaving the variable unset keeps the original `english,romaji,native` behavior.

Note this only reorders AniList's own three title fields — **AniList has no Italian title field at all**, so no ordering can produce real Italian text. Getting genuine Italian titles would require pulling them from a second source (e.g. TMDB's `it-IT` translations) keyed off a title search, which is a bigger, separately-scoped change not implemented here.

`TITLE_LANGUAGE_ORDER` only affects which title is *displayed*; it's independent from match **scoring**. Match candidates are scored against all three of AniList's title fields (english/romaji/native) simultaneously, not just the resolved/preferred one — so a romaji release filename (e.g. `Enen.no.Shouboutai...`) still gets a correct exact-match bonus against the real "Fire Force" entry even though its *displayed* title is the English one. Scoring against the resolved title alone was the root cause of a previous bug where an unrelated entry could outrank the correct show for romaji-named files.

## Extra artwork via Fanart.tv

AniList's schema only ever has **one** `coverImage` and **one** `bannerImage` per entry — no gallery of alternate posters, no clear logo, no square artwork. That's a hard data-source limit, not a bug: Plex's own poster/art picker will only ever show as many options as the `/images` endpoint returns, and a plain AniList-only setup returns exactly one.

Set `FANART_API_KEY` (free personal key from [fanart.tv/get-an-api-key](https://fanart.tv/get-an-api-key/)) to have the `/images` endpoint supplement AniList's defaults with extra options pulled from [Fanart.tv](https://fanart.tv/):

```bash
FANART_API_KEY=your-personal-fanart-api-key
```

```bash
docker exec -it <plex_container_name> curl -s http://anime-provider:3000/library/metadata/anilist-20/images
```

When set, the following are merged in behind AniList's own poster/background (deduplicated, AniList's stays first so an already-matched show keeps its current art as the default):

| Type | Source |
| --- | --- |
| `coverPoster` (extra) | Fanart.tv `tvposter`, plus `seasonposter` entries matching the requested season when the request is for a season (not the root show) |
| `background` (extra) | Fanart.tv `showbackground` |
| `clearLogo` | Fanart.tv `hdtvlogo` (falls back to `clearlogo`) |
| `backgroundSquare` | The `showbackground` entry closest to a 1:1 aspect ratio, if any |

Fanart.tv is indexed by **TheTVDB id**, not AniList id, so a show is looked up by first resolving its AniList id to a TVDB id via the [Fribb/anime-lists](https://github.com/Fribb/anime-lists) community id-mapping dataset (fetched once and cached in memory for the life of the process). This means coverage isn't universal: shows without a TheTVDB entry (common for niche, JP-only-distribution titles) or without any Fanart.tv-contributed art simply keep the single AniList image, exactly like today. Any failure in this path (missing key, no crosswalk match, Fanart.tv rate limit/outage) is swallowed silently and falls back to AniList-only — it never breaks the `/images` endpoint.

A `GET .../images` request for a season entry (e.g. `anilist-15125-s2-a20000/images`) now also pulls Fanart.tv's `seasonposter`/`seasonthumb` entries tagged for that specific season number (or tagged `all`), ahead of the show-level `tvposter` fallback. TMDB seasons get the same treatment via its own `/tv/{id}/season/{n}/images` endpoint. Previously every season only ever received the root show's own gallery, so a franchise with dedicated per-season artwork on Fanart.tv/TMDB (e.g. Fire Force season 2) still showed the exact same poster options as season 1 in Plex's picker.

The crosswalk lookup always uses the root show's own AniList id, even when requesting images for a non-root season (e.g. `anilist-15125-s2-a20000/images`). The Fribb/anime-lists dataset generally only maps a franchise's root/season-1 id to a TVDB id, so looking a later season up by its own distinct AniList id would almost always miss and silently drop its extra Fanart.tv artwork — this was previously the case and has been fixed.

`backgroundSquare` specifically remains unfilled for shows with no Fanart.tv background close enough to square — neither AniList nor Fanart.tv model a dedicated "square art" asset type, so this is a best-effort pick among existing backgrounds, not a guaranteed field.

## Logging

Requests, provider errors, and notable fallback events (crosswalk misses, TMDB/Fanart.tv failures, etc.) are logged via [pino](https://getpino.io/) as structured JSON to stdout — convenient for `docker logs` / log aggregators, at the cost of raw readability in an interactive terminal. Every completed request logs its method, URL, status code, and duration; unhandled route errors are logged with the full error before the 500 response is sent.

Control verbosity with `LOG_LEVEL` (one of pino's standard levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`; defaults to `info`):

```bash
LOG_LEVEL=debug
```

## Caching

Plex frequently calls `metadata`/`children`/`grandchildren`/`images` back-to-back for
the same show, and AniList's API rate-limits (and occasionally disables itself
outright) under load. To cut down on repeat upstream calls, AniList/TMDB/Fanart.tv
responses are cached in memory per-process for `METADATA_CACHE_TTL_SECONDS` (default
`600`, i.e. 10 minutes):

```bash
METADATA_CACHE_TTL_SECONDS=600
```

Set it to `0` to disable caching entirely (every request always hits the upstream
API fresh). A transient failure (network error, rate limit, non-2xx response) is
never cached, so it doesn't get "remembered" and served back once the upstream
provider recovers. Cached entries are per-process, in memory only — nothing to
configure or run alongside the container, but a restart clears the cache and cache
state is not shared across replicas if you ever run more than one instance.

## Non-anime content via TMDB

AniList's catalogue is anime-only, so a title like *Rick and Morty* or any other Western cartoon/live-action show has no real entry to match against — previously, the only candidates `/library/metadata/matches` could return for those searches were unrelated anime that happened to score non-zero.

Set `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN` (free credentials from [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)) to have [TMDB](https://www.themoviedb.org/) searched alongside AniList. TMDB issues both credentials together on the same dashboard page — the legacy v3 "API Key" (sent as an `api_key` query param) and the v4 "API Read Access Token" (sent as an `Authorization: Bearer` header) — and per TMDB's own docs they provide identical access, so either works:

```bash
TMDB_API_KEY=your-personal-tmdb-api-key
# or
TMDB_ACCESS_TOKEN=your-personal-tmdb-read-access-token
```

If both are set, `TMDB_ACCESS_TOKEN` takes priority. With one set:

- `POST /library/metadata/matches` merges AniList and TMDB candidates into one score-sorted list, so shows outside AniList's catalogue can be matched via a `tmdb-<id>` rating key.
- `GET /library/metadata/:id`, `/children`, `/grandchildren`, and `/images` all transparently dispatch to TMDB for any `tmdb-` prefixed rating key, using TMDB's own season/episode/image data (TMDB exposes a full image gallery directly, so unlike AniList it needs no Fanart.tv crosswalk for extra artwork).

AniList and TMDB are searched independently: if one of them errors (e.g. AniList's Cloudflare-fronted API occasionally returns `403` under per-IP rate limiting), `/matches` still returns `200` with whichever provider's candidates succeeded, instead of failing the whole request.

Leave both unset to keep the provider AniList-only — TMDB search silently returns no candidates and `tmdb-` rating keys are simply never produced, so nothing changes for existing anime-only libraries.

Note one limitation shared with the pre-existing AniList episode gap (see [Compatibility notes](#compatibility-notes)): a direct single-episode `GET` for a non-root TMDB season, called outside the normal children → grandchildren flow, can't recover the true season number and may report it as `1`.

## Compatibility notes

- `clearLogo` and the extra poster/background/square-art options are only populated when `FANART_API_KEY` is set (see [Extra artwork via Fanart.tv](#extra-artwork-via-fanarttv)) and the show has a matching TheTVDB entry; otherwise `clearLogo` stays `null` and only AniList's single poster/background are available, as before.
- Non-anime titles (Western cartoons, live-action) are only matched when `TMDB_API_KEY` or `TMDB_ACCESS_TOKEN` is set (see [Non-anime content via TMDB](#non-anime-content-via-tmdb)); otherwise `/matches` only ever returns AniList candidates, as before.
- AniList episode-level metadata is limited; when explicit episode data is unavailable, the provider synthesizes episode titles and dates from airing schedules and show metadata. Real per-episode titles (e.g. from `streamingEpisodes`) are a known gap, intentionally left out of the current scope.
- The season/format heuristic (`TV`/`TV_SHORT`/`ONA`) may miss a legitimate season that AniList tags with an unusual format.
- A direct single-episode `GET` for a non-root season, called outside the normal children → grandchildren flow, may report the season number as `1` since resolving the true season number would require an extra lookup on every request. This applies to both AniList and TMDB seasons.
- The provider is designed for Synology and any Docker-capable environment that can run Node.js containers.
