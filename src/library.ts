import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { browserHelper } from "./browser.js";
import { discover } from "./discovery.js";
import {
  GuidSchema,
  mergeHits,
  isSupportedFormat,
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
  downloadUrl,
  SourceError,
  stringSetting,
  type Credentials,
  type Mirror,
  type PluginIndexerConfig,
  type PluginReleaseCandidate,
  type PluginReleaseQuery,
} from "./model.js";
import { Network } from "./network.js";
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
        .filter(Boolean);
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
const byPriority = (accounts: Credentials) => (a: Mirror, b: Mirror) => {
  const rank = (m: Mirror) => {
    const status =
      { up: 0, protected: 1, degraded: 2, unknown: 3, down: 4 }[m.status] ?? 3;
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
  budgetMs = warming ? 14000 : 8000,
) {
  const { host, browser } = yield* Network;
  const { accounts, mirrors, enabled } = prepared;
  const outcomes: {
    family: Family;
    outcome: Result.Result<Hit[], SourceError>;
  }[] = [];
  let expired = false;
  yield* Effect.forEach(
    enabled,
    (family, index) => {
      const candidates = mirrors
        .filter((m) => m.family === family)
        .sort(byPriority(accounts));
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
                ? "12 seconds"
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
        Effect.result,
        Effect.map((outcome) => {
          outcomes[index] = { family, outcome };
        }),
      );
    },
    { concurrency: 5, discard: true },
  ).pipe(
    Effect.timeoutOrElse({
      duration: Math.max(0, budgetMs),
      orElse: () =>
        Effect.sync(() => {
          expired = true;
          host.logger.warn(
            "Library search budget expired; keeping completed results.",
          );
        }),
    }),
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
    if (expired) kinds.push("timeout");
    const kind = kinds[0] ?? "error";
    return yield* Effect.fail(
      failure(
        `No library completed a search. ${expired ? "Library search budget expired. " : ""}${failures.join(" ")}`,
        kinds.every((value) => value === kind) ? kind : "error",
      ),
    );
  }
  // Interleave sources so a large catalogue cannot fill the limit before others contribute.
  const mixed: Hit[] = [];
  const count = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < count; i++)
    for (const list of results) if (list[i]) mixed.push(list[i]);
  const releases = mergeHits(mixed, q.mediaKind, q.limit);
  if (!releases.length && (expired || failures.length))
    return yield* Effect.fail(
      failure(
        "Some libraries could not complete the search. Retry or check source diagnostics in the BookOrbit logs.",
        expired ? "timeout" : "error",
      ),
    );
  return releases;
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
  const enabled = configuration.enabled.filter((family) =>
    family === "annas" || family === "zlibrary"
      ? Boolean(accounts[family]) &&
        accounts[family]?.trustedOrigins?.length !== 0
      : true,
  );
  if (!enabled.length)
    return yield* Effect.fail(
      failure(
        "Add credentials for Anna’s Archive or Z-Library in the API key field, or select LibGen, Memory of the World or Liber3. Check trustedOrigins if account access is disabled.",
        "unauthorized",
      ),
    );
  const discovered = yield* discover(cfg.baseUrl, refresh);
  for (const family of ["annas", "zlibrary"] as const) {
    const account = accounts[family];
    if (account)
      accounts[family] = {
        ...account,
        trustedOrigins:
          account.trustedOrigins ??
          discovered.filter((m) => m.family === family).map((m) => m.origin),
      };
  }
  const mirrors = configuredMirrors(discovered, accounts).filter((mirror) =>
    mirror.family !== "annas" && mirror.family !== "zlibrary"
      ? true
      : Boolean(accountForMirror(accounts, mirror)),
  );
  return { accounts, mirrors, browser, ...configuration, enabled };
});

export const search = Effect.fnUntraced(function* (
  q: PluginReleaseQuery,
  cfg: PluginIndexerConfig,
) {
  const { host } = yield* Network;
  const started = yield* Clock.currentTimeMillis;
  const prepared = yield* prepare(cfg);
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  // Include discovery in the query budget so BookOrbit can try another search.
  return yield* searchAll(q, cfg, prepared, false, 8000 - elapsed).pipe(
    Effect.provideService(Network, { host, browser: prepared.browser }),
  );
});
export const test = Effect.fnUntraced(
  function* (cfg: PluginIndexerConfig) {
    const { host } = yield* Network;
    const prepared = yield* prepare(cfg, true);
    const { browser, enabled } = prepared;
    if (browser)
      yield* browser.check.pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () =>
            Effect.fail(
              failure(
                "Browser helper did not respond. Check its URL and connectivity.",
                "timeout",
              ),
            ),
        }),
      );
    const releases = yield* Effect.raceAll(
      enabled.map((family) =>
        searchAll(
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
          { ...prepared, enabled: [family] },
          Boolean(browser),
        ).pipe(
          Effect.flatMap((releases) =>
            releases.length
              ? Effect.succeed(releases)
              : Effect.fail(
                  failure(
                    `${family}: no readable test results. Check source diagnostics in the BookOrbit logs.`,
                  ),
                ),
          ),
        ),
      ),
    ).pipe(
      Effect.provideService(Network, {
        host,
        browser,
        browserTimeoutMs: 12000,
      }),
    );
    return {
      success: true,
      indexerName: `BookOrbit ShadowLib: ${releases.length} test releases from a readable catalogue${browser ? "; browser helper connected" : ""}`,
    };
  },
  Effect.timeoutOrElse({
    duration: "18 seconds",
    orElse: () =>
      Effect.fail(
        failure(
          "Connection test timed out. Check source diagnostics and retry to allow browser sessions to warm up.",
          "timeout",
        ),
      ),
  }),
);
export const resolveFile = Effect.fnUntraced(
  function* (release: PluginReleaseCandidate, cfg: PluginIndexerConfig) {
    if (!isSupportedFormat(release.format))
      return yield* Effect.fail(
        failure(
          "This release has no supported book or audiobook format. Search again.",
        ),
      );
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
        .sort(byPriority(accounts))) {
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
          return downloadUrl(result.success);
        },
        catch: () =>
          failure("Source returned an invalid or unsafe download URL."),
      }).pipe(Effect.result);
      if (Result.isFailure(destination)) {
        last = destination.failure;
        continue;
      }
      const format = release.format.toLowerCase();
      const title =
        (release.bookTitle ?? release.title)
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
