# Configuration and deployment

AniMoku is configured entirely through environment variables. With Docker Compose, copy [`.env.example`](../.env.example) to `.env` next to `docker-compose.yml` and edit it. Every variable is optional: with none set, AniMoku runs on AniList alone.

## Environment variables

### Data sources

| Variable | Default | Description |
| --- | --- | --- |
| `TMDB_API_KEY` | – | TMDB v3 API key. Enables localised episode titles and summaries, matching of non-anime shows, and the TMDB artwork gallery. Free at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api). |
| `TMDB_ACCESS_TOKEN` | – | TMDB v4 read access token. Same access as the API key; set either one. Takes priority when both are set. |
| `FANART_API_KEY` | – | Personal Fanart.tv key, for extra posters, backgrounds, clear logos and season art. Free at [fanart.tv/get-an-api-key](https://fanart.tv/get-an-api-key/). |
| `ANIDB_CLIENT` | – | Name of your registered AniDB HTTP client. Register one (free) at [anidb.net/software/add](https://anidb.net/software/add). |
| `ANIDB_CLIENTVER` | – | Version of that client. Both values are needed to enable AniDB. |

### Behaviour

| Variable | Default | Description |
| --- | --- | --- |
| `EPISODE_ORDER` | `tvdb` | `tvdb` numbers seasons as TVDB, Sonarr and Jellyfin do (`S03E13`). `absolute` puts every regular episode in season 1 (`S01E103`). See [Absolute episode order](how-it-works.md#absolute-episode-order). |
| `TITLE_LANGUAGE_ORDER` | `english,romaji,native` | Priority of AniList's three title fields for show titles. Keys you omit are appended in default order. AniList has no other languages. |
| `LOG_LEVEL` | `info` | pino log level: `trace`, `debug`, `info`, `warn`, `error` or `fatal`. |
| `PORT` | `3000` | HTTP port inside the container. |

### Caching and rate limits

| Variable | Default | Description |
| --- | --- | --- |
| `METADATA_CACHE_TTL_SECONDS` | `600` | How long AniList, TMDB and Fanart.tv responses stay in the in-memory cache. `0` disables it. |
| `ANILIST_MIN_INTERVAL_MS` | `2000` | Minimum gap between AniList requests (about 30 per minute, AniList's limit when degraded). |
| `ANILIST_MAX_RETRY_WAIT_SECONDS` | `30` | Longest `Retry-After` AniList waits out. A longer one starts a cooldown during which AniList calls fail fast. |
| `ANIDB_MIN_INTERVAL_SECONDS` | `4` | Seconds between AniDB requests (minimum 2, AniDB's own limit). |
| `ANIDB_WAIT_SECONDS` | `10` | Longest a Plex request waits for AniDB. A slower fetch finishes in the background and is used on the next refresh. |
| `CACHE_DIR` | `./data/cache` | Where the persistent AniDB cache lives. The Compose file sets it to `/app/data/cache`. |

### Docker Compose only

| Variable | Default | Description |
| --- | --- | --- |
| `ANIMOKU_IMAGE` | `animoku:latest` | Image to run. Leave unset to build from this repository, or point it at an image you pushed to a registry. |
| `PUID` / `PGID` | `1000` / `1000` | User and group the container runs as. `./data` must be writable by them. |

## Running with Docker Compose

```bash
cp .env.example .env
mkdir -p data && sudo chown 1000:1000 data   # match PUID:PGID
docker compose up -d --build
```

The container runs as an unprivileged user with `no-new-privileges`. If `./data` isn't writable by `PUID:PGID`, AniMoku still starts, but the AniDB cache stays in memory only. That costs AniDB requests on every restart and raises the risk of a ban.

### Using a prebuilt image

Build and push the image to any registry, for example GitHub Container Registry:

```bash
docker build -t ghcr.io/<you>/animoku:latest .
docker push ghcr.io/<you>/animoku:latest
```

Then set `ANIMOKU_IMAGE=ghcr.io/<you>/animoku:latest` in `.env` and run `docker compose up -d`.

### Sharing a network with Plex

If Plex runs in Docker, put AniMoku on the same network so Plex reaches it by service name, without publishing a port to the LAN:

```yaml
services:
  animoku:
    # ...as in docker-compose.yml, without the ports: section
    networks:
      - plex_net

networks:
  plex_net:
    external: true   # the network your Plex stack already uses
```

Check that Plex can reach it:

```bash
docker exec -it <plex_container> curl -s http://animoku:3000/health
# {"status":"ok"}
```

## Registering the provider in Plex

1. In Plex Web, open **Settings → Metadata Agents** and add a provider with the base URL, for example `http://animoku:3000` or `http://<host-ip>:3000`.
2. Plex reads `GET /` and lists the agent as **AniMoku**.
3. In each anime library, choose the agent under **Edit library → Advanced**, then run **Refresh All Metadata**.

The provider identifier is `tv.plex.agents.custom.anime.anilist`. Guids look like `tv.plex.agents.custom.anime.anilist://show/anilist-15125`. The identifier never changes, so existing matches survive upgrades.

## Folder name tags

Tags in a show's folder name steer matching, following the convention used by HAMA and by Plex's own agents. Square and curly brackets both work, and so do `-` and `=` as separators. Tags are stripped before searching.

| Tag | Effect |
| --- | --- |
| `{anilist-154587}` | Match this AniList entry directly |
| `{tvdb-267440}`, `{anidb-9541}`, `{mal-5114}`, `{imdb-tt0944947}`, `{tmdb-1429}` | Map the id to AniList through the Fribb crosswalk. A TMDB id with no anime mapping is served from TMDB. |
| `[absolute]` | Use the absolute episode order for this show |
| `[tvdb]` | Use the TVDB order for this show when `EPISODE_ORDER=absolute` |

The order tags also work when typed into Plex's **Fix Match** search.
