# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Plugin rules

- Use `host.fetch` for every network request; never native fetch, filesystem or shell APIs in the plugin.
- Credentials belong only in BookOrbit's encrypted credential field, never settings or logs.
- Default account trust to Open Slum mirrors in the same library family. Honor trustedOrigins overrides (including an empty list) and legacy origin pins. Never share session cookies between hosts or follow authenticated redirects.
- Do not bypass browser challenges. Surface them and fall back to another source.
- Run `pnpm check` before delivering `dist/index.mjs`. Tests use synthetic credentials and fixture responses.
