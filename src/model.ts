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
  trustedOrigins: Schema.optionalKey(Schema.Array(Schema.String)),
  key: Schema.optionalKey(Schema.NonEmptyString),
  email: Schema.optionalKey(Schema.NonEmptyString),
  password: Schema.optionalKey(Schema.NonEmptyString),
  userId: Schema.optionalKey(Schema.NonEmptyString),
  userKey: Schema.optionalKey(Schema.NonEmptyString),
});
export const Credentials = Schema.Struct({
  annas: Schema.optionalKey(
    Account.check(
      Schema.makeFilter(
        (account) =>
          !!account.key &&
          !account.email &&
          !account.password &&
          !account.userId &&
          !account.userKey,
      ),
    ),
  ),
  zlibrary: Schema.optionalKey(
    Account.check(
      Schema.makeFilter(
        (account) =>
          !account.key &&
          !!account.email === !!account.password &&
          !!account.userId === !!account.userKey &&
          (!!account.email || !!account.userId),
      ),
    ),
  ),
  browserHelper: Schema.optionalKey(
    Schema.Struct({ origin: Schema.String, token: Schema.NonEmptyString }),
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
export function httpsUrl(input: string, base?: string): URL {
  try {
    const url = new URL(input, base);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error("Unsafe URL");
    return url;
  } catch {
    throw failure("Use a valid HTTPS URL without user information.");
  }
}
export function httpsOrigin(input: string): string {
  const url = httpsUrl(input);
  if (url.pathname !== "/" || url.search || url.hash)
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
      "Invalid account JSON. Anna needs key; Z-Library needs email/password or userId/userKey. Library trustedOrigins must be HTTPS origins; browserHelper needs an HTTP(S) origin and nonempty token.",
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
