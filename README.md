# Anime Metadata Provider (AniList)

Anime Metadata Provider (AniList) is an external metadata provider for Plex Media Server 1.43+ built on the new Plex Metadata Providers model. It exposes anime show, season, episode, image, and matching endpoints backed by the AniList GraphQL API.

## Features

- Plex provider root JSON in `/config/provider.json`
- Metadata lookup for show, season, and episode records
- Children and grandchildren endpoints with Plex paging headers
- AniList-powered title matching for automatic and manual searches
- Filename parsing for `SxxEyy`, absolute episode numbering, and dated episodes
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
  /utils
    guid.js
    filenameParser.js
    paging.js
    mapping.js
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
        "summary": "AniList summary mapped for Plex.",
        "originallyAvailableAt": "2024-01-01",
        "year": 2024,
        "genres": ["Action", "Fantasy"],
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

### Grandchildren with paging

```http
GET /library/metadata/anilist-15125-s1/grandchildren
X-Plex-Container-Start: 0
X-Plex-Container-Size: 25
```

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

## Compatibility notes

- AniList does not provide a native clear logo asset, so `clearLogo` is returned as `null` unless you extend the provider with another image source.
- AniList episode-level metadata is limited; when explicit episode data is unavailable, the provider synthesizes episode titles and dates from airing schedules and show metadata.
- The provider is designed for Synology and any Docker-capable environment that can run Node.js containers.
