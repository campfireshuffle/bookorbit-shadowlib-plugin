# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Plugin rules

- Keep user documentation focused on setup and use. Code comments should explain non-obvious behavior or constraints, not development history.

- Use `host.fetch` for every network request; never native fetch, filesystem or shell APIs in the plugin.
- Credentials belong only in BookOrbit's encrypted credential field, never settings or logs.
- Default account trust to Open Slum mirrors in the same library family. Honor trustedOrigins overrides (including an empty list). Never share session cookies between hosts or follow authenticated redirects.
- Delegate public browser challenges only to the operator-configured helper. Never forward library credentials to it; surface unsolved challenges and try alternatives.
- Run `pnpm check` before delivering `dist/index.mjs`. Tests use synthetic credentials and fixture responses.

# Module design and checks

- `index.ts` adapts BookOrbit to the three Effect operations in `library.ts`.
- `library.ts` owns discovery, account trust, search scheduling and file fallback. Keep these details out of callers.
- `sources.ts` owns provider protocols and host-scoped sessions; `network.ts` owns HTTP redirects, retries and cooldowns.
- Prefer private helpers and small interfaces. Reuse `Effect.result` for recoverable outcomes; validate configuration through typed errors.
- `pnpm lint` runs Knip for unused files, exports and dependencies. Vendored upstream types stay unchanged.
- `pnpm build` produces the standalone `dist/index.mjs`. `pnpm check` also verifies formatting, Knip, types, tests and BookOrbit upload compatibility.
- To release, bump `package.json` and merge a passing PR. Actions automatically signs and publishes the bundle and update manifest from the main-only `plugin-signing` environment.
