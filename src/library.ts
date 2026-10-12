import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { browserHelper } from "./browser.js";
import { discover } from "./discovery.js";
import {
  GuidSchema,
  mergeHits,
  type Hit,
  type Location,
} from "./catalogues.js";
import {
  credentials,
  families,
  accountForMirror,
  failure,
  Family,
  httpsOrigin,
  httpsUrl,
  SourceError,
  stringSetting,
  type Credentials,
  type Mirror,
  type PluginIndexerConfig,
  type PluginReleaseCandidate,
  type PluginReleaseQuery,
} from "./model.js";
import { Network, request, text } from "./network.js";
import { resolveLocation, searchMirror } from "./sources.js";

const settings = (cfg: PluginIndexerConfig) =>
  Effect.try({
    try: () => {
      const enabled = stringSetting(
        cfg.settings,
        "libraries",
        families.join(","),
      )
        .split(",")
        .map((s) => s.trim())
        .filter((family) => family && !["welib", "libstc"].includes(family));
      if (!enabled.length)
        throw failure("Select at least one supported library.");
      return {
        enabled: Schema.decodeUnknownSync(Schema.Array(Family))(enabled),
        ipfsOrigin: httpsOrigin(
          stringSetting(cfg.settings, "ipfsOrigin", "https://dweb.link"),
        ),
      };
    },
    catch: (error) =>
      error instanceof SourceError
        ? error
        : failure("Invalid library settings or IPFS gateway."),
  });
const configuredMirrors = (
  mirrors: Mirror[],
  accounts: Credentials,
): Mirror[] => {
  const all = [...mirrors];
  for (const family of ["annas", "zlibrary"] as const) {
    const account = accounts[family];
    for (const origin of account?.trustedOrigins ?? []) {
      if (!all.some((m) => m.family === family && m.origin === origin))
        all.push({ family, origin, status: "unknown" });
    }
  }
  return all;
};
const byPriority =
  (family: string, accounts: Credentials) => (a: Mirror, b: Mirror) => {
    const pinned =
      family === "annas"
        ? accounts.annas?.origin
        : family === "zlibrary"
          ? accounts.zlibrary?.origin
          : undefined;
    const rank = (m: Mirror) => {
      if (m.origin === pinned && accountForMirror(accounts, m)) return -1;
      const status =
        { up: 0, protected: 1, degraded: 2, unknown: 3, down: 4 }[m.status] ??
        3;
      return status + (accountForMirror(accounts, m) ? 0 : 5);
    };
    return rank(a) - rank(b);
  };
type Prepared = Effect.Success<ReturnType<typeof prepare>>;

const searchAll = Effect.fnUntraced(function* (
  q: PluginReleaseQuery,
  cfg: PluginIndexerConfig,
  prepared: Prepared,
  warming = false,
) {
  const { host, browser } = yield* Network;
  const { accounts, mirrors, enabled } = prepared;
  const outcomes = yield* Effect.forEach(
    enabled,
    (family) => {
      const candidates = mirrors
        .filter((m) => m.family === family)
        .sort(byPriority(family, accounts));
      let answered = false;
      const searchFamily = Effect.gen(function* () {
        if (!candidates.length)
          return yield* Effect.fail(
            failure(`${family}: not present in the directory.`),
          );
        let last: SourceError = failure(`${family}: no working catalogue.`);
        for (const mirror of candidates) {
          const result = yield* searchMirror(mirror, q, cfg, accounts).pipe(
            Effect.timeoutOrElse({
              duration: warming
                ? "20 seconds"
                : browser
                  ? "6 seconds"
                  : "3 seconds",
              orElse: () =>
                Effect.fail(
                  failure(
                    `${mirror.origin}: catalogue lookup timed out; trying another mirror.`,
                    "timeout",
                  ),
                ),
            }),
            Effect.result,
          );
          if (Result.isSuccess(result)) {
            answered = true;
            if (result.success.length) {
              host.logger.log(
                `${family}: ${result.success.length} releases from ${mirror.origin}.`,
              );
              return result.success;
            }
          } else {
            last = result.failure;
            host.logger.warn(`${family}: ${last.message}`);
          }
        }
        if (answered) {
          return [] as Hit[];
        }
        return yield* Effect.fail(last);
      });
      return searchFamily.pipe(
        Effect.timeoutOrElse({
          duration: warming ? "24 seconds" : "8 seconds",
          orElse: () =>
            answered
              ? Effect.succeed([] as Hit[])
              : Effect.fail(
                  failure(
                    `${family}: mirror search budget expired.`,
                    "timeout",
                  ),
                ),
        }),
        Effect.result,
        Effect.map((outcome) => ({ family, outcome })),
      );
    },
    { concurrency: 4 },
  );
  const failures = outcomes.flatMap(({ family, outcome }) =>
    Result.isFailure(outcome) ? [`${family}: ${outcome.failure.message}`] : [],
  );
  for (const message of failures) host.logger.warn(message);
  const results = outcomes.flatMap(({ outcome }) =>
    Result.isSuccess(outcome) ? [outcome.success] : [],
  );
  if (!results.length) {
    const kinds = outcomes.flatMap(({ outcome }) =>
      Result.isFailure(outcome) ? [outcome.failure.kind] : [],
    );
    const kind = kinds[0] ?? "error";
    return yield* Effect.fail(
      failure(
        `No library completed a search. ${failures.join(" ")}`,
        kinds.every((value) => value === kind) ? kind : "error",
      ),
    );
  }
  // Interleave sources so a large catalogue cannot fill the limit before others contribute.
  const mixed: Hit[] = [];
  const count = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < count; i++)
    for (const list of results) if (list[i]) mixed.push(list[i]);
  return mergeHits(mixed, q.mediaKind, q.language, q.limit);
});

const health = Effect.fnUntraced(function* (mirrors: Mirror[]) {
  const { host } = yield* Network;
  return yield* Effect.forEach(
    mirrors,
    (mirror) =>
      Effect.gen(function* () {
        const response = yield* request(mirror.origin);
        const html = yield* text(response);
        const status =
          response.status === 401 ||
          response.status === 403 ||
          /ddos-guard|checking your browser|cf-chl-|captcha/i.test(html)
            ? "protected"
            : response.ok
              ? "up"
              : response.status >= 300 && response.status < 400
                ? "redirect"
                : `HTTP ${response.status}`;
        return { ...mirror, status };
      }).pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.fail(failure("Probe timed out.", "timeout")),
        }),
        Effect.catch((error) =>
          Effect.succeed({
            ...mirror,
            status: /browser challenge|access denied/.test(error.message)
              ? "protected"
              : error.kind === "throttled"
                ? "throttled"
                : "unreachable",
          }),
        ),
        Effect.tap((result) =>
          Effect.sync(() =>
            host.logger.log(
              `Domain check ${result.family}: ${result.origin} — ${result.status}.`,
            ),
          ),
        ),
      ),
    { concurrency: 4 },
  );
});

const prepare = Effect.fnUntraced(function* (
  cfg: PluginIndexerConfig,
  refresh = false,
) {
  const { host } = yield* Network;
  const configuration = yield* settings(cfg);
  const browser = yield* browserHelper(cfg, host);
  const accounts = yield* Effect.try({
    try: () => credentials(cfg.credential),
    catch: (error) =>
      error instanceof SourceError
        ? error
        : failure("Invalid encrypted credential JSON.", "unauthorized"),
  });
  const discovered = yield* discover(cfg.baseUrl, refresh);
  for (const family of ["annas", "zlibrary"] as const) {
    const account = accounts[family];
    if (account)
      accounts[family] = {
        ...account,
        trustedOrigins:
          account.trustedOrigins ??
          (account.origin
            ? [account.origin]
            : discovered
                .filter((m) => m.family === family)
                .map((m) => m.origin)),
      };
  }
  const mirrors = configuredMirrors(discovered, accounts);
  return { accounts, mirrors, browser, ...configuration };
});

export const search = Effect.fnUntraced(function* (
  q: PluginReleaseQuery,
  cfg: PluginIndexerConfig,
) {
  const { host } = yield* Network;
  const prepared = yield* prepare(cfg);
  return yield* searchAll(q, cfg, prepared).pipe(
    Effect.provideService(Network, { host, browser: prepared.browser }),
  );
});
export const test = Effect.fnUntraced(function* (cfg: PluginIndexerConfig) {
  const { host } = yield* Network;
  const prepared = yield* prepare(cfg, true);
  const { mirrors, browser, enabled } = prepared;
  if (browser) yield* browser.check;
  const checks = yield* health(
    mirrors.filter((m) => enabled.includes(m.family)),
  );
  const releases = yield* searchAll(
    {
      title: "Pride and Prejudice",
      author: "Jane Austen",
      isbn13: null,
      isbn13s: [],
      mediaKind: "ebook",
      language: "en",
      limit: 10,
    },
    cfg,
    prepared,
    Boolean(browser),
  ).pipe(
    Effect.provideService(Network, { host, browser, browserTimeoutMs: 20000 }),
  );
  if (!releases.length)
    return {
      success: false,
      error:
        "Domain checks completed, but no source returned a readable catalogue result. See domain diagnostics in the BookOrbit logs.",
    };
  const up = checks.filter((m) => m.status === "up").length;
  const protectedCount = checks.filter((m) => m.status === "protected").length;
  return {
    success: true,
    indexerName: `BookOrbit ShadowLib: ${checks.length} domains checked (${up} up, ${protectedCount} protected); ${releases.length} test releases${browser ? "; browser helper connected" : ""}`,
  };
});
export const resolveFile = Effect.fnUntraced(
  function* (release: PluginReleaseCandidate, cfg: PluginIndexerConfig) {
    const { host } = yield* Network;
    const { accounts, mirrors, browser, enabled, ipfsOrigin } =
      yield* prepare(cfg);
    const value = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(GuidSchema)(JSON.parse(release.guid)),
      catch: () => failure("Invalid release identifier."),
    });
    const locations: Location[] = value.locations.filter(
      (l) =>
        enabled.includes(l.family) &&
        mirrors.some((m) => m.family === l.family && m.origin === l.origin),
    );
    for (const location of [...locations]) {
      if (!["annas", "zlibrary", "libgen"].includes(location.family)) continue;
      for (const mirror of mirrors
        .filter((m) => m.family === location.family)
        .sort(byPriority(location.family, accounts))) {
        if (
          !locations.some(
            (l) =>
              l.family === mirror.family &&
              l.origin === mirror.origin &&
              l.id === location.id,
          )
        )
          locations.push({ ...location, origin: mirror.origin });
      }
    }
    let last = failure("No authorized source remains for this release.");
    const throttled = new Set<string>();
    for (const location of locations) {
      if (throttled.has(location.family)) continue;
      const result = yield* resolveLocation(
        location,
        cfg,
        accounts,
        ipfsOrigin,
      ).pipe(
        Effect.provideService(Network, { host, browser }),
        Effect.timeoutOrElse({
          duration: browser ? "7 seconds" : "3 seconds",
          orElse: () =>
            Effect.fail(
              failure(
                `${location.origin}: file lookup timed out; trying another mirror.`,
                "timeout",
              ),
            ),
        }),
        Effect.result,
      );
      if (Result.isFailure(result)) {
        last = result.failure;
        if (last.kind === "throttled") throttled.add(location.family);
        host.logger.warn(`${location.family}: ${last.message}`);
        continue;
      }
      const destination = yield* Effect.try({
        try: () => {
          return httpsUrl(result.success);
        },
        catch: () =>
          failure("Source returned an invalid or unsafe download URL."),
      }).pipe(Effect.result);
      if (Result.isFailure(destination)) {
        last = destination.failure;
        continue;
      }
      const format = (release.format ?? "epub")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      const title =
        release.title
          .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_")
          .replace(/^\.+/, "_")
          .slice(0, 180) || "book";
      return {
        url: destination.success.href,
        fileName: `${title}.${format}`,
        format,
        sizeBytes: release.sizeBytes,
      };
    }
    return yield* Effect.fail(last);
  },
  Effect.timeoutOrElse({
    duration: "16 seconds",
    orElse: () =>
      Effect.fail(
        failure(
          "File lookup budget expired; none of the available mirrors resolved this release.",
          "timeout",
        ),
      ),
  }),
);
