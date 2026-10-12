# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Plugin rules

- Use `host.fetch` for every network request; never native fetch, filesystem or shell APIs in the plugin.
- Credentials belong only in BookOrbit's encrypted credential field, never settings or logs.
- Discovered mirrors do not authorize forwarding credentials. Bind every credential to an explicit HTTPS origin.
- Do not bypass browser challenges. Surface them and fall back to another source.
- Run `pnpm check` before delivering `dist/index.mjs`. Tests use synthetic credentials and fixture responses.
