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

Once pushed, set the `ANIME_PROVIDER_IMAGE` variable and the compose file will pull from the registry instead of building locally:

```bash
# .env (create next to docker-compose.yml, never commit it)
ANIME_PROVIDER_IMAGE=<DOCKERHUB_USER>/<REPO_NAME>:latest
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

## Compatibility notes

- AniList does not provide a native clear logo asset, so `clearLogo` is returned as `null` unless you extend the provider with another image source.
- AniList episode-level metadata is limited; when explicit episode data is unavailable, the provider synthesizes episode titles and dates from airing schedules and show metadata.
- The provider is designed for Synology and any Docker-capable environment that can run Node.js containers.
