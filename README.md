# BookOrbit ShadowLib plugin

This BookOrbit plugin searches and dedupes results from the book and audiobook libraries listed on
[Open Slum](https://open-slum.org/).

## Install

1. Download `index.mjs` from the [latest release](https://github.com/sarimabbas/bookorbit-shadowlib-plugin/releases/latest).
2. In BookOrbit, open **Settings → Server → Requests → Install a plugin** and
   upload it.
3. Add **BookOrbit ShadowLib** as a source. Keep the base URL as
   `https://open-slum.org` and choose the libraries to search.
4. Leave **API key** empty to use public access, then click **Test connection**.

## Updates

After installing this version, use **Check for updates** in BookOrbit. Enable
**Install signed updates automatically** if you want updates applied for you.

## Optional accounts

Enter JSON in the source's **API key** field. BookOrbit encrypts this field (you must have
`BOOK_REQUEST_ENCRYPTION_KEY` configured). Include only the accounts you use:

```json
{
  "annas": {
    "key": "YOUR-ANNA-ACCOUNT-KEY"
  },
  "zlibrary": {
    "email": "YOUR-EMAIL",
    "password": "YOUR-PASSWORD"
  }
}
```

By default, accounts are shared with Open Slum mirrors for the same library,
with separate sessions per host. Add `"trustedOrigins": ["https://YOUR-TRUSTED-HOST"]`
to an account to restrict credential sharing; `[]` disables credential use.
Existing `origin` configs stay pinned; remove `origin` to use discovered mirrors.

## Caveats

- Browser checks can block access. The plugin detects
  blocks and tries some alternatives.
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
