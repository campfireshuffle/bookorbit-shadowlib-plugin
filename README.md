# BookOrbit ShadowLib

Search books and audiobooks across Z-Library, Anna’s Archive, LibGen,
Memory of the World, and Liber3. The plugin finds mirrors through
[Open Slum](https://open-slum.org/) and merges duplicate files while keeping
separate formats. Result titles show which libraries supplied each file.

## Install

1. Download `index.mjs` from the [latest release](https://github.com/sarimabbas/bookorbit-shadowlib-plugin/releases/latest).
2. In BookOrbit, open **Settings → Server → Requests → Install a plugin** and upload it.
3. Add **BookOrbit ShadowLib** as a source. Keep the base URL as `https://open-slum.org` and select your libraries.
4. Add account details below if needed, save, and click **Test connection**.

For future updates, use **Check for updates** or enable **Install signed updates automatically**.

## Settings

| Setting             | What to choose                                                           |
| ------------------- | ------------------------------------------------------------------------ |
| Base URL            | Keep `https://open-slum.org`.                                            |
| Libraries to search | Select the libraries you have access to. Account requirements are below. |
| Browser helper URL  | Optional. Leave blank unless searches need a browser helper.             |
| IPFS gateway        | Keep the default, `https://dweb.link`.                                   |

## Accounts

Paste the example for your account into the source’s **API key** field.
LibGen, Memory of the World, and Liber3 need no credentials; leave the field empty if you only use those. Anna’s Archive and Z-Library are skipped until you add their credentials.

**Z-Library** requires a free account. Your daily download limit applies.

```json
{
  "zlibrary": {
    "email": "YOUR-EMAIL",
    "password": "YOUR-PASSWORD"
  }
}
```

**Anna’s Archive** requires a paid membership key.

```json
{
  "annas": {
    "key": "YOUR-MEMBERSHIP-KEY"
  }
}
```

If you use both accounts, include both entries in one JSON object.
BookOrbit encrypts account details. Your server needs `BOOK_REQUEST_ENCRYPTION_KEY` configured.

## Browser checks

If website searches are blocked, enter your **TRAWL**, **Byparr**,
or **FlareSolverr** URL in **Browser helper URL**. A base URL or `/v1` works.
For a local helper, enable **Allow private addresses**. Save and run **Test connection**, then retry your search.

<details>
<summary>Advanced configuration</summary>

Add `"trustedOrigins": ["https://YOUR-TRUSTED-HOST"]` inside an account to choose
which websites can use its login details. Leave it out to use that library’s
Open Slum mirrors, or set `"trustedOrigins": []` to disable use of its login details.

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

Set `origin` to your **Browser helper URL** without `/v1` or other paths.
To change **IPFS gateway** for Liber3 downloads, use an HTTPS address without a path.

</details>

## Build

With Node.js and pnpm installed:

```sh
pnpm install
pnpm check
pnpm build
```

The uploadable file is `dist/index.mjs`.

MIT licensed. Vendored BookOrbit types retain their upstream license in `vendor/`.
