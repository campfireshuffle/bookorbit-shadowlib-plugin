# BookOrbit ShadowLib

Search Anna’s Archive, LibGen, Z-Library, Memory of the World, Liber3, WeLib and
LibSTC from BookOrbit. Mirrors come from [Open Slum](https://open-slum.org/).
Results are combined and deduplicated while keeping different formats and editions.

## Install

1. [Download index.mjs](https://github.com/sarimabbas/bookorbit-shadowlib-plugin/releases/latest/download/index.mjs).
2. In BookOrbit, open **Settings → Server → Requests → Install a plugin** and upload it.
3. Add **BookOrbit ShadowLib** as a source. Keep the default base URL and choose your libraries.
4. Leave **API key** empty for public access, then click **Test connection**.

Disable separate sources for the same libraries to avoid duplicate searches.
No torrent or Usenet client is needed.

For updates, click **Check for updates** or enable **Install signed updates
automatically**. BookOrbit verifies each update’s hash and signature.

## Optional accounts

Enter only the accounts you use as JSON in the source’s **API key** field:

```json
{
  "annas": { "key": "YOUR-ANNA-ACCOUNT-KEY" },
  "zlibrary": { "email": "YOUR-EMAIL", "password": "YOUR-PASSWORD" }
}
```

BookOrbit encrypts this field; its server needs `BOOK_REQUEST_ENCRYPTION_KEY`.
Each account is reused across Open Slum’s mirrors for that library, with separate
sessions per host. This trusts Open Slum to identify hosts that may receive your credentials.

<details>
<summary>Restrict mirrors or use existing account settings</summary>

Add `"trustedOrigins": ["https://YOUR-TRUSTED-HOST"]` to an account to replace
the directory default. An empty list disables credential use. Explicit origins
can add mirrors missing from the directory; use HTTPS origins without paths.

An existing `origin` alone keeps the account pinned. Remove it for directory
defaults, or keep it with `trustedOrigins` to choose a preferred mirror.
Z-Library also accepts `userId` and `userKey` instead of email/password.

Anna’s download API puts its key in the request URL, which server or proxy logs
may retain. Authenticated redirects never forward credentials to another host.

</details>

## If a search fails

**Test connection** refreshes the mirror list and tests catalogue searches.
Check BookOrbit’s logs for individual source failures. A successful test does
not mean every library is accessible.

Browser challenges can block a source even from a residential IP. The plugin
tries alternatives but does not solve interactive challenges. WeLib and LibSTC
support is experimental. Ebooks and individually indexed audiobook files work;
audiobook archives may not be recognized. Sci-Hub and software archives are excluded.

<details>
<summary>Build from source</summary>

With Node.js 26 and pnpm installed:

```sh
pnpm install
pnpm build
```

Upload `dist/index.mjs` to BookOrbit. The build checks the 512 KiB upload limit
and verifies the module loads. Contributors should run `pnpm check` before a PR.

</details>

MIT licensed. Vendored BookOrbit types retain their upstream license in `vendor/`.
