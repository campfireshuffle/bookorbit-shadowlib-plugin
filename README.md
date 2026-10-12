# BookOrbit ShadowLib plugin

Search multiple book libraries from BookOrbit and download available files
directly into your library. ShadowLib discovers mirrors from
[Open Slum](https://open-slum.org/), retries temporary failures, and tries another
mirror when a source is unavailable.

It searches Anna's Archive, LibGen, Z-Library, Memory of the World, Liber3, WeLib,
and LibSTC. Results from different libraries are combined, with duplicates
removed while keeping different formats and editions.

## Install

1. Download `index.mjs` from the [latest release](https://github.com/sarimabbas/bookorbit-shadowlib-plugin/releases/latest).
2. In BookOrbit, open **Settings → Server → Requests → Install a plugin** and
   upload it.
3. Add **BookOrbit ShadowLib** as a source. Keep the base URL as
   `https://open-slum.org` and choose the libraries to search.
4. Leave **API key** empty to use public access, then click **Test connection**.

Disable any separate Anna's-only source to avoid duplicate searches and sign-ins.
No torrent or Usenet download client is required.

## Updates

After installing this version, use **Check for updates** in BookOrbit. Enable
**Install signed updates automatically** if you want updates applied for you.
BookOrbit verifies each update’s hash and signature against the key pinned in
your installed copy.

## Optional accounts

For Anna's member downloads or authenticated Z-Library access, enter JSON in the
source's **API key** field. BookOrbit encrypts this field; its server must have
`BOOK_REQUEST_ENCRYPTION_KEY` configured. Include only the accounts you use:

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

Replace each `origin` with the HTTPS address you trust for that account. The
plugin sends credentials only to that address; discovering a new mirror does
not give it access to your credentials. Z-Library also accepts `userId` and
`userKey` instead of email and password.

Anna's download API requires the account key in the request URL, so server or
proxy URL logs may retain it.

## What to expect

- Browser checks can block access even from a residential IP. The plugin detects
  blocks and tries alternatives; it does not solve interactive challenges.
- WeLib and LibSTC support is experimental. Source availability and search
  results depend on each library.
- Ebooks and individually indexed audiobook files are supported. Audiobooks
  packaged as archives may not be recognized.
- Sci-Hub and Anna's software archive are excluded.
- Automatic downloads use BookOrbit's Requests automation and Book Dock. The
  plugin does not follow bestseller lists.

**Test connection** refreshes the mirror list and checks catalogue searches. If
a search fails, BookOrbit's logs show which sources were unavailable.

## Development

Requires Node.js and pnpm. The plugin uses TypeScript and Effect.

```sh
pnpm install
pnpm check
```

`pnpm check` runs formatting checks, type checking, tests, and the build. Upload the resulting
`dist/index.mjs` to BookOrbit. The build checks BookOrbit's 512 KiB upload limit
and verifies that the plugin can be loaded.

The vendored BookOrbit plugin API and its license are in `vendor/`.

## Releasing

Bump the version in `package.json` and merge a pull request after checks pass.
GitHub Actions builds and checks the plugin. Approve the `plugin-signing`
deployment to sign and publish `index.mjs` and its update manifest.
The signing key is held in the main-only `plugin-signing` environment.

MIT licensed; vendored files retain their upstream licenses.
