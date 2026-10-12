import { Cause, Effect, Exit, Schema } from "effect";
import { discover } from "./discovery.js";
import { GuidSchema, mergeHits, type Hit, type Location } from "./catalogues.js";
import { credentials, failure, Family, httpsOrigin, SourceError, stringSetting, type Credentials, type IndexerPlugin, type Mirror, type PluginHost, type PluginIndexerConfig, type PluginReleaseCandidate, type PluginReleaseQuery } from "./model.js";
import { Network, request, text } from "./network.js";
import { resolveLocation, searchMirror } from "./sources.js";

const families = ["annas", "libgen", "zlibrary", "welib", "memory", "liber3", "libstc"] as const;
const settings = (cfg: PluginIndexerConfig) => {
  const enabled = stringSetting(cfg.settings, "libraries", families.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  return { enabled: Schema.decodeUnknownSync(Schema.Array(Family))(enabled), ipfsOrigin: httpsOrigin(stringSetting(cfg.settings, "ipfsOrigin", "https://dweb.link")) };
};
const configuredMirrors = (mirrors: Mirror[], accounts: Credentials): Mirror[] => {
  const all = [...mirrors];
  for (const family of ["annas", "zlibrary"] as const) {
    const account = accounts[family];
    if (account && !all.some((m) => m.family === family && m.origin === httpsOrigin(account.origin))) all.push({ family, origin: httpsOrigin(account.origin), status: "unknown" });
  }
  return all;
};
const byPriority = (family: string, accounts: Credentials) => (a: Mirror, b: Mirror) => {
  const pinned = family === "annas" ? accounts.annas?.origin : family === "zlibrary" ? accounts.zlibrary?.origin : undefined;
  const rank = (m: Mirror) => m.origin === pinned ? -1 : ({ up: 0, protected: 1, degraded: 2, unknown: 3, down: 4 }[m.status] ?? 3);
  return rank(a) - rank(b);
};
const searchAll = Effect.fnUntraced(function*(q: PluginReleaseQuery, cfg: PluginIndexerConfig, accounts: Credentials, mirrors: Mirror[]) {
  const { host } = yield* Network;
  const { enabled } = settings(cfg);
  const successes: string[] = [];
  const failures: string[] = [];
  const results = yield* Effect.forEach(enabled, (family) => {
    const candidates = mirrors.filter((m) => m.family === family).sort(byPriority(family, accounts));
    const searchFamily = Effect.gen(function*() {
      if (!candidates.length) return yield* Effect.fail(failure(`${family}: not present in the directory.`));
      let answered = false;
      let last: SourceError = failure(`${family}: no working catalogue.`);
      for (const mirror of candidates) {
        const result = yield* searchMirror(mirror, q, cfg, accounts).pipe(
          Effect.map((hits) => ({ ok: true as const, hits })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (result.ok) {
          answered = true;
          if (result.hits.length) { host.logger.log(`${family}: ${result.hits.length} releases from ${mirror.origin}.`); successes.push(family); return result.hits; }
        } else {
          last = result.error;
          host.logger.warn(`${family}: ${last.message}`);
        }
      }
      if (answered) { successes.push(family); return [] as Hit[]; }
      return yield* Effect.fail(last);
    });
    return searchFamily.pipe(
      Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.fail(failure(`${family}: mirror search budget expired.`, "timeout")) }),
      Effect.catch((error) => { failures.push(`${family}: ${error.message}`); return Effect.succeed([] as Hit[]); }),
    );
  }, { concurrency: 4 });
  if (!successes.length) return yield* Effect.fail(failure(`No library completed a search. ${failures.join(" ")}`));
  for (const message of failures) host.logger.warn(message);
  // Interleave sources so a large catalogue cannot fill the limit before others contribute.
  const mixed: Hit[] = [];
  const count = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < count; i++) for (const list of results) if (list[i]) mixed.push(list[i]);
  return mergeHits(mixed, q.mediaKind, q.language, q.limit);
});

const run = async <A>(effect: Effect.Effect<A, unknown, Network>, cfg: PluginIndexerConfig, host: PluginHost, signal?: AbortSignal): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provideService(Network, { host })), { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted) throw host.fail("timeout", "Search cancelled or timed out.");
  const error = Cause.squash(exit.cause);
  if (error instanceof SourceError) throw host.fail(error.kind, error.message);
  throw host.fail("error", "Source configuration or response was invalid. Check the encrypted credential JSON and library settings.");
};

export const health = Effect.fnUntraced(function*(mirrors: Mirror[]) {
  const { host } = yield* Network;
  return yield* Effect.forEach(mirrors, (mirror) => Effect.gen(function*() {
    const response = yield* request(mirror.origin);
    const html = yield* text(response);
    const status = response.status === 401 || response.status === 403 || /ddos-guard|checking your browser|cf-chl-|captcha/i.test(html) ? "protected" : response.ok ? "up" : response.status >= 300 && response.status < 400 ? "redirect" : `HTTP ${response.status}`;
    return { ...mirror, status };
  }).pipe(
    Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.fail(failure("Probe timed out.", "timeout")) }),
    Effect.catch(() => Effect.succeed({ ...mirror, status: "unreachable" })),
    Effect.tap((result) => Effect.sync(() => host.logger.log(`Domain check ${result.family}: ${result.origin} — ${result.status}.`))),
  ), { concurrency: 4 });
});

const prepare = Effect.fnUntraced(function*(cfg: PluginIndexerConfig, refresh = false) {
  const accounts = yield* Effect.try({ try: () => credentials(cfg.credential), catch: () => failure("Invalid encrypted credential JSON.", "unauthorized") });
  const mirrors = configuredMirrors(yield* discover(cfg.baseUrl, refresh), accounts);
  return { accounts, mirrors };
});

export default {
  apiVersion: 1,
  version: "0.1.0",
  type: "bookorbit-shadowlib-plugin",
  label: "BookOrbit ShadowLib",
  requiresCredential: false,
  credentialKind: "apiKey",
  mediaKinds: ["ebook", "audiobook"],
  supportsIsbnSearch: true,
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: "https://open-slum.org",
  baseUrlHint: "Open Slum directory origin. Credentials are JSON in the encrypted API key field; never enter them as settings.",
  settingsFields: [
    { key: "libraries", type: "string", format: "list", options: families, minItems: 1, label: "Libraries to search", default: families.join(","), hint: "Search every selected catalogue, using working mirrors within each. Sci-Hub and software archives are excluded." },
    { key: "ipfsOrigin", type: "string", label: "IPFS gateway", default: "https://dweb.link", hint: "HTTPS origin used for Liber3 files." },
  ],
  async search(q, cfg, host, signal) {
    return run(Effect.gen(function*() {
      const { accounts, mirrors } = yield* prepare(cfg);
      return yield* searchAll(q, cfg, accounts, mirrors);
    }), cfg, host, signal);
  },
  async test(cfg, host) {
    try {
      return await run(Effect.gen(function*() {
        const { accounts, mirrors } = yield* prepare(cfg, true);
        const checks = yield* health(mirrors);
        const releases = yield* searchAll({ title: "Pride and Prejudice", author: "Jane Austen", isbn13: null, isbn13s: [], mediaKind: "ebook", language: "en", limit: 10 }, cfg, accounts, mirrors);
        if (!releases.length) return { success: false, error: "Domain checks completed, but no source returned a readable catalogue result. See domain diagnostics in the BookOrbit logs." };
        const up = checks.filter((m) => m.status === "up").length;
        const protectedCount = checks.filter((m) => m.status === "protected").length;
        return { success: true, indexerName: `BookOrbit ShadowLib: ${checks.length} domains checked (${up} up, ${protectedCount} protected); ${releases.length} test releases` };
      }), cfg, host);
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : "Connection test failed." }; }
  },
  async resolveFile(release: PluginReleaseCandidate, cfg: PluginIndexerConfig, host: PluginHost, signal: AbortSignal) {
    return run(Effect.gen(function*() {
      const { accounts, mirrors } = yield* prepare(cfg);
      const value = yield* Effect.try({ try: () => Schema.decodeUnknownSync(GuidSchema)(JSON.parse(release.guid)), catch: () => failure("Invalid release identifier.") });
      const { enabled, ipfsOrigin } = settings(cfg);
      const locations: Location[] = value.locations.filter((l) => enabled.includes(l.family) && mirrors.some((m) => m.family === l.family && m.origin === l.origin));
      if (value.md5 && /^[a-f0-9]{32}$/.test(value.md5)) {
        for (const m of mirrors.filter((m) => m.family === "libgen" && enabled.includes("libgen"))) if (!locations.some((l) => l.origin === m.origin)) locations.push({ family: m.family, origin: m.origin, id: value.md5 });
      }
      let last = failure("No authorized source remains for this release.");
      for (const location of locations) {
        const result = yield* resolveLocation(location, cfg, accounts, ipfsOrigin).pipe(Effect.map((url) => ({ ok: true as const, url })), Effect.catch((error) => Effect.succeed({ ok: false as const, error })));
        if (!result.ok) { last = result.error; host.logger.warn(`${location.family}: ${last.message}`); continue; }
        const url = new URL(result.url);
        if (url.protocol !== "https:" || url.username || url.password) { last = failure("Source returned an unsafe download URL."); continue; }
        const format = (release.format ?? "epub").toLowerCase().replace(/[^a-z0-9]/g, "");
        const title = release.title.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").replace(/^\.+/, "_").slice(0, 180) || "book";
        return { url: url.href, fileName: `${title}.${format}`, format, sizeBytes: release.sizeBytes };
      }
      return yield* Effect.fail(last);
    }), cfg, host, signal);
  },
} satisfies IndexerPlugin;
