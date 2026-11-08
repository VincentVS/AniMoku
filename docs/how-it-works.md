# How AniMoku works

AniMoku implements the [Plex Metadata Providers](https://github.com/plexinc/tmdb-example-provider) protocol (Plex Media Server 1.43+). Plex sends it match requests and metadata lookups. AniMoku answers them by combining several sources.

| Source | Used for | Required |
| --- | --- | --- |
| [AniList](https://anilist.co) | Matching, show and season data, cast, ratings | Yes (no key needed) |
| [Fribb/anime-lists](https://github.com/Fribb/anime-lists) | Mapping AniList ids to TVDB, TMDB, AniDB and IMDb | Yes (no key needed) |
| [TMDB](https://www.themoviedb.org) | Episode titles and summaries in the library language, non-anime shows, artwork | Optional |
| [AniDB](https://anidb.net) | Episode titles in many languages, summaries, air dates | Optional |
| [Fanart.tv](https://fanart.tv) | Extra posters, backgrounds, clear logos, season art | Optional |

## Matching

Plex sends the show's title, year and a filename. AniMoku:

1. **Looks for a precise hint first.** A guid from an earlier match, or an id tag in the folder name such as `{tvdb-123456}` (see [folder name tags](configuration.md#folder-name-tags)), resolves straight to an entry.
2. **Parses the filename.** It understands `S02E05`, fansub-style absolute numbers (`[Group] Show - 105 [1080p].mkv`), `S2 - 05` and dated episodes.
3. **Searches AniList and, if configured, TMDB in parallel.** Candidates are scored against all three AniList titles (English, romaji, native), so a romaji filename still finds the entry whose display title is English. On equal scores AniList wins, so an anime that TMDB also lists keeps its AniList seasons.
4. **Folds TMDB duplicates into AniList.** A TMDB result that the crosswalk maps to an AniList entry is that entry: it's dropped when the AniList entry is also listed, and replaced by it when it would be the automatic match. So an anime is never matched to TMDB just because TMDB found the folder name first.
5. **Applies a threshold to automatic matches.** A library scan gets the best candidate only if it scores at least 70. A manual **Fix Match** gets the full ranked list. With `MATCH_LABEL_SOURCE=true` and `MATCH_LABEL_EPISODES=true` each title is labelled with its source, format and episode count (`Show [AniList · TV · 24 ep]`; for an AniList show, the episodes of the whole series as TMDB counts them, not just its first season), since AniList and TMDB often list a show under the same name and year.

If AniList is unavailable during an **automatic** match, AniMoku answers `503` rather than offering only TMDB candidates. Otherwise Plex would re-match the anime to its TMDB entry, changing every guid and losing seasons and watch state. Plex keeps the existing match and retries on the next refresh. A manual match still falls back to TMDB.

## Seasons

AniList makes a separate entry for every season, and often for every cour. AniMoku walks the `PREQUEL`/`SEQUEL` relations from the matched entry (up to 12 hops each way). It keeps the `TV`, `TV_SHORT` and `ONA` entries, and each season keeps its own cover art.

### TVDB-aligned season numbering

Release filenames, Sonarr and Jellyfin number seasons the TVDB way. For example, a third season and its "Part 2" are often two AniList entries, but they make up TVDB season 3, episodes 1–12 and 13–25.

AniMoku uses the `season.tvdb` and `episode_offset.tvdb` fields of the Fribb crosswalk to place every entry where TVDB puts it:

- Entries that share a TVDB season become one Plex season. Their episodes are numbered `offset + AniList episode`.
- Entries that TVDB files under a different series are left out, because they belong in a different show folder.
- Entries the crosswalk doesn't map yet, such as a season that has just started airing, follow the last mapped season.
- Season 0 (TVDB specials) is supported and titled "Specials". With `TVDB_API_KEY` set, a show whose AniList chain fills no season 0 gets TVDB's specials there, numbered as TVDB numbers them (`S00E05`), with titles and summaries in the library language. Their keys carry the season (`anilist-<id>-s0-e05`), so they never collide with a regular episode.
- A movie, OVA or special joins a regular season only if the crosswalk puts it there. A "Final Chapters" special, for instance, can be TVDB S04E29.

Some long runners are a single AniList entry with hundreds of episodes that the crosswalk maps to no TVDB season, while TVDB splits them into arc seasons. For these, AniMoku reads TMDB's community "TVDB Order" episode group (TMDB credentials needed) and cuts the entry into the same seasons. For example, 366 episodes become seasons 1–16, and a sequel that TVDB files as season 17 stays there. Episodes keep their AniList number in their guid, so watch state survives the regrouping. If your files keep absolute numbers inside season folders (`Show - S02.E21`), set `FILE_NUMBERING=absolute`.

Without that group, AniMoku reads the seasons from TheTVDB itself when `TVDB_API_KEY` is set (a 64-episode entry that TMDB keeps as one season and TVDB splits into 16 + 24 + 24). Without a TVDB key, it falls back to TMDB's own seasons, but only for an entry longer than TMDB's season 1: those are often TVDB's split already.

The same TVDB lookup covers an entry the crosswalk files under one season while TVDB splits it over several (13 episodes as seasons 1 and 2, 10 + 3): the entry runs on into the next seasons, as long as no other entry is placed there.

If the matched entry isn't in the crosswalk and none of these sources split it, seasons follow their position in the AniList chain.

With `FILE_NUMBERING=absolute` and `TVDB_API_KEY`, episodes carry TVDB's absolute numbers, which are what Sonarr writes. TVDB counts some specials in them, so a season can start one number later than a plain count: season 2 at 28 after a 26-episode season 1. Numbering always starts at 1 with the first regular episode. A special that TVDB numbers absolutely is indexed by that number (`S00.E202`), as long as it is higher than every special's own number.

### Absolute episode order

HAMA with the Absolute Series Scanner numbered every episode of a franchise in one run (`S01E103`). To keep a library named that way, set `EPISODE_ORDER=absolute`, or tag a single show folder with `[absolute]` (`Show [absolute]`).

In this order, all regular entries are merged into season 1 and numbered consecutively in TVDB order. Season 0 is unchanged. The order is chosen at match time and stored in the show's guid (`anilistabs-` instead of `anilist-`). So an existing show keeps its order even if `EPISODE_ORDER` changes. To switch it, add or remove the tag and use **Fix Match**.

## Episode titles, summaries and stills

AniList has titles for only a fraction of episodes (a 1100+ episode long runner has fewer than 70) and no episode summaries. AniMoku fills each episode in from:

- **TMDB**, in the library language (`X-Plex-Language`) with English fallback. TMDB, TVDB and AniList split seasons differently but in the same order, so episodes are looked up by their position among the franchise's regular episodes. An episode with an AniList air date re-anchors on the TMDB episode aired that day, which absorbs recaps counted by only one side. If several dated episodes of an entry match nothing, that entry's TMDB data is ignored.
- **AniDB**, by episode number in the AniDB anime the crosswalk names. It provides titles in several languages, a summary and the air date.

For each field, the first usable value wins:

| Field | Priority |
| --- | --- |
| Title | TMDB (library language) › AniDB (library language) › TMDB (English) › AniDB (English) › AniDB (romaji) › AniList |
| Summary | TMDB (library language) › TMDB (English) › AniDB › AniList |
| Air date | TMDB › AniDB › AniList |
| Still | TMDB › AniList |

Placeholder titles such as `Episode 12`, `Episodio 12` or `第12話` are skipped, so they never hide a real title from the next source.

Show titles come from AniList's English, romaji and native fields, plus a `localized` title in the library language, in the order set by `TITLE_LANGUAGE_ORDER`. AniList has no other languages, so the localised title and synopsis come from the TMDB translation of the show that the crosswalk maps the entry to. Only an entry that starts its TMDB show is translated: a later cour shares the series' TMDB id, and that synopsis would describe season 1.

## Show metadata

| Plex field | Source |
| --- | --- |
| `title` | AniList title or TMDB translation, see `TITLE_LANGUAGE_ORDER` |
| `summary` | TMDB translation in the library language, otherwise AniList description |
| `originalTitle` | AniList romaji title |
| `Genre` | AniList genres |
| `Studio` | AniList main studios |
| `rating` | AniList average score ÷ 10 |
| `contentRating` | AniList: `NC-17` for adult entries, otherwise empty, because AniList has no rating-board data. TMDB shows: the rating for the library's region, then the US one. |
| `Role` | AniList characters with their Japanese voice actors |
| `Guid` | `tvdb://`, `tmdb://` and `imdb://` ids from the crosswalk, so Trakt, Kometa or JellyPlex-Watched can match the show |

## Artwork

AniList has a single cover and a single banner per entry. With `FANART_API_KEY`, the `/images` endpoint adds Fanart.tv artwork behind AniList's, so the current poster stays the default:

| Plex type | Fanart.tv source |
| --- | --- |
| `coverPoster` | `tvposter`, plus `seasonposter` for the requested season |
| `background` | `showbackground` |
| `clearLogo` | `hdtvlogo`, else `clearlogo` |
| `backgroundSquare` | The `showbackground` closest to 1:1, if any |

Fanart.tv is indexed by TVDB id, which AniMoku resolves through the crosswalk using the root show's AniList id. Shows without a TVDB entry keep AniList's images only. Any Fanart.tv failure is ignored and never breaks `/images`.

## Non-anime shows

AniList is anime-only. With TMDB credentials set, AniMoku searches TMDB as well. Shows AniList doesn't have, such as Western cartoons or live action, can then be matched with `tmdb-` rating keys and served entirely from TMDB, including its full image gallery. Without TMDB credentials, nothing changes for anime-only libraries.

## Caching and rate limits

**In-memory cache.** Plex often calls `metadata`, `children`, `grandchildren` and `images` back to back for the same show. AniList, TMDB and Fanart.tv responses are therefore cached in memory for `METADATA_CACHE_TTL_SECONDS` (10 minutes by default). Failures are never cached. The cache is per process and is cleared on restart.

**AniList queue.** Every AniList call goes through one queue, at least `ANILIST_MIN_INTERVAL_MS` apart. A `429` or `403` pauses the whole queue for its `Retry-After`, or backs off 1 s and then 2 s when AniList sends none. A `Retry-After` longer than `ANILIST_MAX_RETRY_WAIT_SECONDS` starts a cooldown: AniList calls fail immediately until it ends, and Plex keeps the metadata it already has.

**Crosswalk.** The Fribb dataset is downloaded once and refreshed every 24 hours.

### AniDB limits

AniDB's HTTP API is free but strict. Clients must be registered, may send at most one request every 2 seconds, and must not download the same anime repeatedly. Breaking these rules gets your IP banned. AniMoku:

- stores each response in `CACHE_DIR/anidb/<aid>.json`. Mount it as a volume so it survives restarts. A cached anime is refreshed at most once a day while it airs and once a week after it ends;
- sends requests through a single queue, `ANIDB_MIN_INTERVAL_SECONDS` apart, and prefetches a show's seasons when Plex opens it;
- waits at most `ANIDB_WAIT_SECONDS` per Plex request. Slower fetches complete in the background, and a stale copy is used if a refresh fails;
- pauses AniDB for 24 hours after a ban, and for an hour after other API errors such as an unregistered client. The pause is written to disk, so a restart doesn't cut it short.

Look for `AniDB anime fetched` in the logs to confirm the client works. `AniDB requests paused` gives the reason AniDB refused a request.

## Logging

Requests and notable events are logged by [pino](https://getpino.io/) as JSON on stdout. Every request logs its method, URL, status and duration. Plex tokens and API keys in query strings are redacted. Set the verbosity with `LOG_LEVEL`.

## Known limitations

- A season that AniList tags with an unusual format, anything other than `TV`, `TV_SHORT` or `ONA`, may be missed unless the crosswalk places it.
- Show titles are limited to AniList's English, romaji and native titles.
- `backgroundSquare` is a best-effort pick: neither AniList nor Fanart.tv has a dedicated square artwork type.

## Project layout

```text
src/
  server.js              Express app, error handling
  routes/                Plex endpoints: metadata, children, grandchildren, images, matches
  providers/             anilist, tmdb, anidb, fanart, crosswalk (Fribb)
  utils/
    childData.js         season layout (TVDB / absolute) and episode lists
    episodeSources.js    merges TMDB / AniDB / AniList episode fields
    filenameParser.js    release filename parsing
    guid.js              rating keys and guids
    mapping.js           source data → Plex metadata objects
    cache.js, paging.js, language.js, logger.js
config/provider.json     provider root document served on GET /
test/                    node:test suite
bruno/                   Bruno API collection
```
