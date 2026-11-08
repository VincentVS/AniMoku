# HTTP API

AniMoku speaks the [Plex Metadata Providers](https://github.com/plexinc/tmdb-example-provider) protocol. You never need to call it yourself, but the endpoints are handy for debugging.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Provider root document (identifier, supported types, version) |
| `GET` | `/health` | Liveness check: `{"status":"ok"}` |
| `GET` | `/library/metadata/:ratingKey` | Show, season or episode metadata. Add `includeChildren=1` to embed every child. |
| `GET` | `/library/metadata/:ratingKey/children` | Seasons of a show, or episodes of a season (paged) |
| `GET` | `/library/metadata/:ratingKey/grandchildren` | Every episode of a show (paged) |
| `GET` | `/library/metadata/:ratingKey/images` | Artwork options |
| `POST` | `/library/metadata/matches` | Match a show from its title, year, filename or guid |

Paged endpoints honour the `X-Plex-Container-Start` and `X-Plex-Container-Size` headers. `X-Plex-Language` selects the language for TMDB and AniDB episode data.

When Plex refreshes a show it doesn't call `/children` on its own. It requests `GET /library/metadata/:ratingKey?includeChildren=1` and expects the full list of children embedded in the response, ignoring paging.

## Errors

| Status | When |
| --- | --- |
| `400` | Malformed rating key or request body |
| `404` | Unknown entry, or a key from an older numbering that no longer exists |
| `503` | Automatic match while AniList is unavailable. Plex keeps the current match and retries. |
| `500` | Anything else. The details go to the log, not to the response. |

## Rating keys

The rating key prefix tells AniMoku which backend to use. Plex treats keys as opaque strings.

| Type | AniList (TVDB order) | AniList (absolute order) | TMDB |
| --- | --- | --- | --- |
| Show | `anilist-12345` | `anilistabs-12345` | `tmdb-1234` |
| Season | `anilist-12345-s2-a20000` | `anilistabs-12345-s1` | `tmdb-1234-s2` |
| Episode | `anilist-12345-e05-a20000` | `anilistabs-12345-e05-a20000` | `tmdb-1234-s2-e05` |

- `-a<id>` names the AniList entry behind a season or episode when it differs from the show's root entry. A single-season show has no suffix.
- AniList episode keys carry their AniList entry and episode number, not the displayed season. So guids, and with them watch state, survive renumbering: `anilist-105310-e01-a179062` is displayed as S03E13.
- TMDB seasons have no ids of their own, so TMDB episode keys carry the season number.

Guids are `tv.plex.agents.custom.animoku://<type>/<ratingKey>`.

## Examples

```bash
# Provider root
curl http://localhost:3000/

# Show, with seasons embedded
curl "http://localhost:3000/library/metadata/anilist-12345?includeChildren=1"

# Episodes of a season, in Italian where available
curl -H "X-Plex-Language: it-IT" http://localhost:3000/library/metadata/anilist-12345-s1/children

# Automatic match from a filename
curl -X POST http://localhost:3000/library/metadata/matches \
  -H "Content-Type: application/json" \
  -d '{"type": 2, "title": "Example Show", "filename": "[Group] Example Show - 05 [1080p].mkv"}'
```

A match response looks like this (trimmed):

```json
{
  "MediaContainer": {
    "size": 1,
    "Metadata": [
      {
        "type": "show",
        "ratingKey": "anilist-12345",
        "guid": "tv.plex.agents.custom.animoku://show/anilist-12345",
        "title": "Example Show",
        "year": 2009,
        "score": 100
      }
    ]
  }
}
```

## Bruno collection

The [`bruno/`](../bruno) folder is a [Bruno](https://www.usebruno.com/) collection with a request for every endpoint. Open it with **Open Collection**, then pick the **Local** environment (`http://localhost:3000`) or **Docker**. For Docker, edit `environments/Docker.bru` with your host.
