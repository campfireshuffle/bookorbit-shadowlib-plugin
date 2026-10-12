import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  credentials,
  failure,
  stringSetting,
  type PluginHost,
  type PluginIndexerConfig,
  SourceError,
} from "./model.js";

const Envelope = Schema.Struct({
  status: Schema.String,
  session: Schema.optionalKey(Schema.String),
  solution: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Number,
      response: Schema.String,
      url: Schema.String,
    }),
  ),
});
const sessions = new Map<
  string,
  { id: string; endpoint: string; until: number; token?: string }
>();
const locks = new Map<string, Semaphore.Semaphore>();
const instance = crypto.randomUUID();

export interface BrowserHelper {
  check: Effect.Effect<void, SourceError>;
  fetchPage(
    url: string,
    timeoutMs: number,
  ): Effect.Effect<Response, SourceError>;
}

export const browserHelper = Effect.fnUntraced(function* (
  cfg: PluginIndexerConfig,
  host: PluginHost,
) {
  const input = stringSetting(cfg.settings, "browserHelperUrl", "").trim();
  if (!input) return undefined;
  const { endpoint, token } = yield* Effect.try({
    try: () => {
      const endpoint = new URL(input);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw Error("Invalid helper URL");
      const path = endpoint.pathname.replace(/\/+$/, "");
      endpoint.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
      const account = credentials(cfg.credential).browserHelper;
      if (account && new URL(account.origin).origin !== endpoint.origin)
        throw Error("Helper credential origin mismatch");
      return { endpoint: endpoint.href, token: account?.token };
    },
    catch: (error) =>
      error instanceof SourceError
        ? error
        : failure(
            "Use an HTTP(S) browser helper URL without credentials, query or fragment. Any encrypted helper token must match its origin.",
            "unauthorized",
          ),
  });
  let lock = locks.get(endpoint);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(endpoint, lock);
  }
  const call = Effect.fnUntraced(function* (body: Record<string, unknown>) {
    const response = yield* Effect.tryPromise({
      try: () =>
        host.fetch(endpoint, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      catch: () =>
        failure(
          "Cannot reach the browser helper. Check its URL and enable Allow private IP addresses for a LAN helper.",
          "unreachable",
        ),
    });
    if (!response.ok)
      return yield* Effect.fail(
        failure(
          `Browser helper returned HTTP ${response.status}. ${response.status === 401 || response.status === 403 ? "Check helper authentication." : "Check that the helper is healthy; the site may be blocked or unavailable."}`,
        ),
      );
    const envelope = yield* Effect.tryPromise({
      try: async () =>
        Schema.decodeUnknownSync(Envelope)(await response.json()),
      catch: () =>
        failure("Browser helper returned an invalid FlareSolverr response."),
    });
    if (envelope.status !== "ok")
      return yield* Effect.fail(
        failure(
          "Browser helper could not complete the request. It may still be warming up or need manual intervention; run Test connection and retry.",
        ),
      );
    return envelope;
  });
  const fetchPage = Effect.fnUntraced(function* (
    url: string,
    timeoutMs: number,
  ) {
    const origin = new URL(url).origin;
    const key = `${cfg.id}:${endpoint}:${origin}`;
    const now = yield* Clock.currentTimeMillis;
    let session = sessions.get(key);
    if (session && (session.until <= now || session.token !== token)) {
      yield* call({ cmd: "sessions.destroy", session: session.id }).pipe(
        Effect.ignore,
      );
      sessions.delete(key);
      session = undefined;
    }
    if (!session) {
      const owned = [...sessions].filter(([, s]) => s.endpoint === endpoint);
      if (owned.length >= 16) {
        const oldest = owned[0];
        sessions.delete(oldest[0]);
        yield* call({ cmd: "sessions.destroy", session: oldest[1].id }).pipe(
          Effect.ignore,
        );
      }
      const id = `shadowlib-${instance}-${cfg.id}-${crypto.randomUUID()}`;
      const created = yield* call({ cmd: "sessions.create", session: id });
      session = {
        id: created.session ?? id,
        endpoint,
        until: now + 10 * 60 * 1000,
        token,
      };
      sessions.set(key, session);
    }
    const sessionId = session.id;
    const result = yield* call({
      cmd: "request.get",
      url,
      session: session.id,
      session_ttl_minutes: 10,
      maxTimeout: timeoutMs,
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          sessions.delete(key);
          yield* call({ cmd: "sessions.destroy", session: sessionId }).pipe(
            Effect.ignore,
          );
          return yield* Effect.fail(error);
        }),
      ),
    );
    const solution = result.solution;
    const returnedOrigin = yield* Effect.try({
      try: () => (solution ? new URL(solution.url).origin : undefined),
      catch: () => failure("Browser helper returned an invalid page URL."),
    });
    if (!solution || solution.status !== 200 || returnedOrigin !== origin)
      return yield* Effect.fail(
        failure(
          "Browser helper did not return a successful page from the requested origin.",
        ),
      );
    session.until = (yield* Clock.currentTimeMillis) + 10 * 60 * 1000;
    return new Response(solution.response, {
      headers: { "Content-Type": "text/html" },
    });
  });
  return {
    check: call({ cmd: "sessions.list" }).pipe(Effect.asVoid),
    fetchPage: (url, timeoutMs) => lock.withPermit(fetchPage(url, timeoutMs)),
  } satisfies BrowserHelper;
});
