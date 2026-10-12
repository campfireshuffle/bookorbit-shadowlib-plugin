# BookOrbit ShadowLib

Search books and audiobooks across Z-Library, Anna’s Archive, LibGen,
Memory of the World, and Liber3. The plugin finds mirrors through
[Open Slum](https://open-slum.org/) and merges duplicate files while keeping
separate formats.

## Install

1. Download `index.mjs` from the [latest release](https://github.com/sarimabbas/bookorbit-shadowlib-plugin/releases/latest).
2. In BookOrbit, open **Settings → Server → Requests → Install a plugin** and upload it.
3. Add **BookOrbit ShadowLib** as a source. Keep the base URL as `https://open-slum.org` and select your libraries.
4. Add account details below if needed, save, and click **Test connection**.

For future updates, use **Check for updates** or enable **Install signed updates automatically**.

## Accounts

Paste this JSON into the source’s **API key** field. Include only accounts you use:

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

- **Z-Library:** requires a free account. Your daily download limit applies.
- **Anna’s Archive:** downloads require a paid membership key. The plugin uses its fast-download API, never free/slow download pages.
- **LibGen, Memory of the World, Liber3:** no credentials needed; leave **API key** empty if you use only these.

BookOrbit encrypts account details. Your server needs `BOOK_REQUEST_ENCRYPTION_KEY` configured.

## Browser checks

If website searches are blocked, enter your existing stock **TRAWL**, **Byparr**,
or **FlareSolverr** URL in **Browser helper URL**. A base URL or `/v1` works.
For a LAN helper, enable **Allow private IP addresses**. Save and run **Test connection**, then retry your search.

When configured, the helper loads public website pages first; otherwise the plugin
fetches them directly. Library credentials are never sent to it. API requests stay direct. Some browser checks may still fail.
Test connection checks helper access and one readable catalogue. It does not verify every source or guarantee a download will work.

<details>
<summary>Advanced configuration</summary>

Add `"trustedOrigins": ["https://YOUR-TRUSTED-HOST"]` inside an account to restrict
where its credentials are used. Without this override, the plugin uses Open Slum
mirrors for that library. `[]` disables credential use; an existing `origin` keeps
an account pinned to that host. Sessions remain separate per host.

Z-Library also accepts `"userId": "YOUR-ID"` and `"userKey": "YOUR-KEY"` instead
of email/password.

For a helper requiring a bearer token, include `browserHelper` alongside your
accounts in the same JSON:

```json
{
  "browserHelper": {
    "origin": "https://YOUR-HELPER",
    "token": "YOUR-TOKEN"
  }
}
```

Its origin must match **Browser helper URL**. Liber3’s **IPFS gateway** setting
accepts an HTTPS origin and needs no API key.

Anna’s Archive and LibGen still use HTML search. LibGen also uses website download
links; Memory uses JSON catalogue file links and Liber3 uses IPFS links. API
failures never switch Anna or Z-Library to anonymous downloads.

Welib and LibSTC are no longer supported. Saved selections skip them; choose
another library if they were your only selections. BookOrbit’s logs identify
sources that could not complete a search.

</details>

## Development

With Node.js and pnpm installed:

```sh
pnpm install
pnpm check
pnpm build
```

The uploadable file is `dist/index.mjs`. To release, bump `package.json` and merge
a passing PR; GitHub Actions builds, signs, and publishes the plugin and update
manifest automatically.

MIT licensed. Vendored BookOrbit types retain their upstream license in `vendor/`.
