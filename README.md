# BookOrbit ShadowLib plugin

Search and dedupe books and audiobooks from Anna’s Archive, Z-Library, LibGen,
Memory of the World, and Liber3. Mirrors are discovered through
[Open Slum](https://open-slum.org/). Only libraries with API endpoints are included.

## Install

1. Download `index.mjs` from the [latest release](https://github.com/sarimabbas/bookorbit-shadowlib-plugin/releases/latest).
2. In BookOrbit, open **Settings → Server → Requests → Install a plugin** and
   upload it.
3. Add **BookOrbit ShadowLib** as a source. Keep the base URL as
   `https://open-slum.org` and choose the libraries to search.
4. Add account JSON below if needed, then click **Test connection**.

Existing selections automatically skip the removed Welib and LibSTC sources. If
you selected only those sources, choose a supported library before searching.

## Updates

After installing this version, use **Check for updates** in BookOrbit. Enable
**Install signed updates automatically** if you want updates applied for you.

## Browser checks

If sites block searches, enter your existing **TRAWL** or **FlareSolverr** URL in
**Browser helper URL** (a base URL or `/v1` works). For a LAN helper, enable
**Allow private IP addresses**. Save, run **Test connection** to warm the browser,
then search again. Leave the URL empty if you do not use a helper.

The helper handles public pages and keeps separate sessions per host. Library
passwords and keys are never sent to it. Some challenges still need manual help.

## Account JSON

Paste JSON into the source’s **API key** field. BookOrbit encrypts it; your server
must have `BOOK_REQUEST_ENCRYPTION_KEY` configured. Include only accounts you use.

| Library                        | Credentials                                                              | API coverage                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Z-Library (`zlibrary`)         | Required free account: `email` and `password`, or `userId` and `userKey` | Account search and download URLs; daily account limits apply.                                           |
| Anna’s Archive (`annas`)       | Required paid membership for downloads: `key` from your account          | Fast download URLs. Search still uses the website. [API details](https://annas-archive.gl/faq#api).     |
| LibGen (`libgen`)              | None; leave out of account JSON                                          | Some mirrors expose JSON metadata lookup. This plugin currently uses website search and download links. |
| Memory of the World (`memory`) | None; leave out of account JSON                                          | Public JSON search and file links.                                                                      |
| Liber3 (`liber3`)              | None; leave out of account JSON                                          | Public catalogue gateway and IPFS file links.                                                           |

For Z-Library and Anna’s Archive together:

```json
{
  "zlibrary": {
    "email": "YOUR-EMAIL",
    "password": "YOUR-PASSWORD"
  },
  "annas": {
    "key": "YOUR-MEMBERSHIP-KEY"
  }
}
```

If you already have Z-Library session credentials, replace its account entry with:

```json
{
  "zlibrary": {
    "userId": "YOUR-USER-ID",
    "userKey": "YOUR-USER-KEY"
  }
}
```

For LibGen, Memory of the World, and Liber3, leave **API key** empty or use `{}`.
Select them in **Libraries to search**; do not add empty account entries for them.
Liber3’s **IPFS gateway** setting accepts an HTTPS origin and needs no API key.

By default, accounts are shared with Open Slum mirrors for the same library,
with separate sessions per host. Add `"trustedOrigins": ["https://YOUR-TRUSTED-HOST"]`
inside either account to restrict credential sharing; `[]` disables credential use.
Existing `origin` configs stay pinned; remove `origin` to use discovered mirrors.

If your optional browser helper requires a bearer token, include this alongside
library accounts in the same encrypted JSON:

```json
{
  "browserHelper": {
    "origin": "https://YOUR-HELPER",
    "token": "YOUR-TOKEN"
  }
}
```

Its origin must match **Browser helper URL**. Library credentials are never sent
to the helper. A paid library account does not require a paid browser helper.

## Caveats

- Anna’s downloads use only the membership API, never free/slow download pages.
- Z-Library requires credentials and uses only its account APIs.
- API failures do not switch to anonymous download pages or invent a LibGen fallback.
  Mirror retries stay within the same library; deduped results can retain verified
  locations from multiple libraries.

- Public search does not guarantee anonymous downloads; some libraries require an account.
- The browser helper loads catalogue pages. Protected file downloads may still need a browser-capable downloader.
- **Test connection** refreshes the mirror list and checks catalogue searches. If
  a search fails, BookOrbit's logs show which sources were unavailable.

## Development

Requires Node.js and pnpm. The plugin uses TypeScript and Effect.

```sh
pnpm install
pnpm build
```

Upload the resulting `dist/index.mjs` to BookOrbit. Run `pnpm check` before
submitting a pull request.

The vendored BookOrbit plugin API and its license are in `vendor/`.

## Releasing

Bump the version in `package.json` and merge a pull request after checks pass.
GitHub Actions automatically builds, signs, and publishes `index.mjs` and its
update manifest after checks pass.
The signing key is held in the main-only `plugin-signing` environment.

MIT licensed; vendored files retain their upstream licenses.
