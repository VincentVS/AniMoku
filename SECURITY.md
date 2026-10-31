# Security policy

## Supported versions

Only the latest release on the `main` branch receives security fixes.

## Deployment model

AniMoku has **no authentication**, because the Plex Metadata Providers protocol doesn't define any. It is designed to run on a trusted network, next to Plex:

- Don't publish it to the internet, and don't put it behind a public reverse proxy. Anyone who can reach it can spend your TMDB, Fanart.tv and AniDB quotas, and could get your AniDB client banned.
- Prefer a private Docker network shared with Plex over publishing port 3000 on the host.
- Keep API keys in `.env`, which is gitignored, and never in `docker-compose.yml`.

The container runs as an unprivileged user with `no-new-privileges`. Plex tokens and API keys that appear in request URLs are redacted from the logs.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through [GitHub's private vulnerability reporting](https://github.com/VincentVS/AniMoku/security/advisories/new) instead.

Include the version (`GET /` returns it), a description of the issue and steps to reproduce it. You can expect a first answer within a week.
