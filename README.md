# BookOrbit ShadowLib plugin

A private BookOrbit indexer built with TypeScript and Effect 4. It discovers
book-library domains from [Open Slum](https://open-slum.org/) and bundles into
one `dist/index.mjs` file for BookOrbit's plugin API v1 (checked against 3.3.0).

## Install

```sh
pnpm install
pnpm check
```

In BookOrbit, open **Settings → Server → Requests → Install a plugin** and upload
`dist/index.mjs`. Add **BookOrbit ShadowLib** as a source. Leave the base URL as
`https://open-slum.org`; select the libraries you want searched. Disable the old
Anna's-only source to avoid duplicate searches and additional sign-ins.

For authenticated sources, put the following JSON in the source's **API key**
field. This is BookOrbit's encrypted credential field, not a plugin setting.
`BOOK_REQUEST_ENCRYPTION_KEY` must be configured on the server. Remove any account
you do not use; the field can be left empty for public sources.

```json
{
  "annas": {
    "origin": "https://YOUR-VERIFIED-ANNA-HOST",
    "key": "YOUR-ANNA-ACCOUNT-KEY"
  },
  "zlibrary": {
    "origin": "https://YOUR-VERIFIED-ZLIB-HOST",
    "email": "YOUR-EMAIL",
    "password": "YOUR-PASSWORD"
  }
}
```

Z-Library also accepts `userId` and `userKey` instead of email/password. Use your
own verified HTTPS origins. A newly discovered domain never receives another
host's key, password, or session cookie. Credentials are never placed in release
IDs, settings, or plugin logs. Anna's fast-download API itself requires the key
in its query string; destination/proxy URL logs may retain it.

Click **Test connection** to refresh the directory immediately, probe every
book-related domain, and perform a real catalogue search. Domain reachability and
search results are reported separately in BookOrbit's logs. A successful test
requires actual test releases; a website returning HTTP 200 is not sufficient.

No torrent/Usenet client is required for these direct-file sources. Automatic
fulfilment still uses BookOrbit's normal Requests automation and Book Dock.
This plugin does not monitor bestseller lists.

## Search and fallback

- Search every selected library type, with up to four families active at once.
  Within each family, try the credential's pinned origin first, then available
  mirrors. Move to the next mirror on a failure or an empty result.
- Refresh Open Slum on demand, caching the result for one hour. If refresh fails,
  use the last successful directory for at most 24 hours, with an explicit log
  message. Caches are in memory and reset when BookOrbit restarts.
- Retry network failures, HTTP 408/429 and 5xx at most twice, with exponential
  backoff. Respect `Retry-After`; delays above two seconds trigger fallback and,
  for 429, an origin cooldown instead of holding the search open. Each library
  has an eight-second search budget. Cancellation interrupts retries and queued
  work; BookOrbit controls in-flight HTTP request cancellation through `host.fetch`.
- Cache authenticated sessions for 15 minutes. An Effect semaphore prevents
  simultaneous calls from signing in repeatedly. Refresh once on HTTP 401 or a
  redirect to login. Credential changes invalidate cached sessions.
- Interleave library results before limiting, so a larger catalogue cannot drown
  out a smaller one. Deduplicate published full-file MD5/SHA-256, exact normalized
  URLs, and stable provider IDs. Preserve formats and editions; titles alone are
  not deduplication keys. Up to five source locations are retained in a release
  identifier. Hashes are source claims, not locally verified integrity checks.
- Resolve each retained location in turn. For a known MD5, also try discovered
  LibGen mirrors. A 502 from Anna's is eligible for retry and fallback during
  both search and file resolution. Download resolution remains bounded by
  BookOrbit's supplied cancellation signal and per-request deadlines.

All network calls go through BookOrbit's `host.fetch`, retaining its private-IP
policy, response-size limits, and deadlines. The plugin does not execute remote
JavaScript, run browser challenge solvers, spawn processes, or read local files.
It has no background timers, telemetry, or automatic update channel. Rebuild and
upload manually to update this private plugin.

## Sources and verification

| Library | Catalogue / download method | Current verification |
| --- | --- | --- |
| Anna's Archive | HTML catalogue, session login, member fast-download API; LibGen fallback by MD5 | Fixture-tested authentication, session reuse, retries, search and fallback. Anonymous live mirrors were protected. |
| LibGen | HTML tables and record links, direct `get.php` links | Live catalogue returned results; download link parsing and fallback tested with fixtures. |
| Z-Library | Authenticated EAPI or public HTML book cards | Login, search, session reuse and file API fixture-tested. Anonymous live mirrors redirected or were protected; a real account is still needed for acceptance. |
| Memory of the World | JSON catalogue and library file paths | Live catalogue returned results. File mapping and audiobook filtering tested with fixtures. |
| Liber3 | Reads the site's entrypoint to discover its catalogue gateway; read-only catalogue query, IPFS files | Implemented against the site's published frontend protocol. Gateway was unreachable during the live check; not accepted end to end. |
| WeLib | Generic HTML book-record catalogue and direct links | Experimental. Live site returned HTTP 403; its layout and acquisition have not been accepted. |
| LibSTC | Generic HTML book-record catalogue and direct links | Experimental. Domain was unreachable; its layout and acquisition have not been accepted. |

Sci-Hub and Anna's software archive are excluded. Unknown site layouts fail
explicitly rather than pretending that an empty catalogue is a successful search.
Ebooks and individually indexed audio files are supported. Archive-packaged
audiobooks without reliable format metadata are not guessed to be audio.

The live smoke check on October 11, 2026 returned 20 merged releases from LibGen
and Memory of the World across EPUB, PDF, and MOBI. No live book files were
downloaded, real credentials submitted, or production plugin installed.

## Development

`pnpm check` runs strict TypeScript checking, deterministic fixture tests, and
the single-file ESM build. Effect supplies typed failures, retry schedules,
timeouts, interruptible execution, concurrency control, and session semaphores.
Cheerio parses HTML without executing it. The runtime has no external npm imports.

The vendored `vendor/bookorbit-plugin-api.ts` is the upstream API contract from
BookOrbit v3.3.0, not a runtime dependency. Its upstream license is preserved in
`vendor/BOOKORBIT-LICENSE`; see `vendor/NOTICE.md`.

References used for protocol verification:

- [BookOrbit plugin contract](https://github.com/bookorbit/bookorbit/blob/v3.3.0/packages/plugin-api/src/index.ts)
- [BookOrbit Requests](https://bookorbit.app/book-requests/)
- [Open Slum directory](https://open-slum.org/)
- [Z-Library API client](https://github.com/bipinkrish/Zlibrary-API)
- The currently served Liber3 and Memory of the World frontend scripts and public catalogue responses.
