import * as Schema from "effect/Schema";
export type {
  IndexerPlugin,
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
  PluginReleaseCandidate,
  PluginRequestInit,
} from "../vendor/bookorbit-plugin-api.js";
export const families = [
  "annas",
  "libgen",
  "zlibrary",
  "memory",
  "liber3",
] as const;
export const Family = Schema.Literals(families);
export type Family = typeof Family.Type;
const Account = Schema.Struct({
  origin: Schema.optionalKey(Schema.String),
  trustedOrigins: Schema.optionalKey(Schema.Array(Schema.String)),
  key: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String),
  userId: Schema.optionalKey(Schema.String),
  userKey: Schema.optionalKey(Schema.String),
});
export const Credentials = Schema.Struct({
  annas: Schema.optionalKey(Account),
  zlibrary: Schema.optionalKey(Account),
  browserHelper: Schema.optionalKey(
    Schema.Struct({ origin: Schema.String, token: Schema.String }),
  ),
});
export type Credentials = {
  -readonly [K in keyof typeof Credentials.Type]: (typeof Credentials.Type)[K];
};
export type Mirror = { family: Family; origin: string; status: string };
export const MirrorSchema = Schema.Struct({
  family: Family,
  origin: Schema.String,
  status: Schema.String,
});
export class SourceError extends Schema.TaggedError<SourceError>()(
  "SourceError",
  {
    message: Schema.String,
    kind: Schema.Literals([
      "unauthorized",
      "throttled",
      "timeout",
      "unreachable",
      "error",
    ]),
    retryable: Schema.Boolean,
    retryAfterMs: Schema.Number,
  },
) {}
export const failure = (
  message: string,
  kind: SourceError["kind"] = "error",
  retryable = false,
  retryAfterMs = 0,
) => new SourceError({ message, kind, retryable, retryAfterMs });
export function httpsOrigin(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw failure(
      "Use an HTTPS origin without a path, query, or user information.",
    );
  return url.origin;
}
export function credentials(input: string | null): Credentials {
  if (!input?.trim()) return {};
  try {
    const result = Schema.decodeUnknownSync(Credentials, {
      onExcessProperty: "error",
    })(JSON.parse(input));
    const normalized: Credentials = {};
    if (result.browserHelper) {
      const origin = new URL(result.browserHelper.origin);
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw Error("Invalid helper origin");
      normalized.browserHelper = {
        ...result.browserHelper,
        origin: origin.origin,
      };
    }
    for (const family of ["annas", "zlibrary"] as const) {
      const account = result[family];
      if (account)
        normalized[family] = {
          ...account,
          ...(account.origin !== undefined
            ? { origin: httpsOrigin(account.origin) }
            : {}),
          ...(account.trustedOrigins !== undefined
            ? {
                trustedOrigins: [
                  ...new Set(account.trustedOrigins.map(httpsOrigin)),
                ],
              }
            : {}),
        };
    }
    return normalized;
  } catch {
    throw failure(
      "Invalid account JSON. Library origin/trustedOrigins must be HTTPS origins; browserHelper needs an HTTP(S) origin and token.",
      "unauthorized",
    );
  }
}
export const stringSetting = (
  settings: Record<string, unknown> | null,
  key: string,
  fallback: string,
) =>
  typeof settings?.[key] === "string" ? (settings[key] as string) : fallback;

// prepare resolves directory defaults once; every credential use checks the resulting list.
export function accountForMirror(accounts: Credentials, mirror: Mirror) {
  const account =
    mirror.family === "annas"
      ? accounts.annas
      : mirror.family === "zlibrary"
        ? accounts.zlibrary
        : undefined;
  return account?.trustedOrigins?.includes(mirror.origin) ? account : undefined;
}
