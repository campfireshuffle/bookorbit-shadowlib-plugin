import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { failure, type PluginHost, type PluginRequestInit, SourceError } from "./model.js";

export class Network extends Context.Service<Network, { host: PluginHost }>()("bookorbit-shadowlib-plugin/Network") {}
const cooldowns = new Map<string, { until: number; error: SourceError }>();
function challenged(headers: Headers, body = ""): boolean {
  return headers.get("cf-mitigated") === "challenge"
    || /<title[^>]*>\s*(?:just a moment|checking your browser|ddos-guard|verify (?:you are|you're) human)/i.test(body)
    || /(?:id=["']challenge-form["']|id=["']captcha-container["']|window\._cf_chl_opt\s*=)/i.test(body);
}
const retrySchedule = Schedule.max([Schedule.exponential("250 millis"), Schedule.recurs(2)]).pipe(
  Schedule.setInputType<SourceError>(),
  Schedule.while(({ input }) => input.retryable),
  Schedule.addDelay(({ input }) => Effect.succeed(input.retryAfterMs)),
);
export const request = Effect.fnUntraced(function*(url: string, init: PluginRequestInit = {}) {
  const { host } = yield* Network;
  const destination = new URL(url);
  const origin = destination.origin;
  const authenticated = Object.entries(init.headers ?? {}).some(([name, value]) => /^(cookie|authorization|remix-userkey)$/i.test(name) && !!value)
    || (init.method === "POST" && ["/account/", "/eapi/user/login"].includes(destination.pathname))
    || (destination.pathname === "/dyn/api/fast_download.json" && destination.searchParams.has("key"));
  const blockedKey = `${origin}:${authenticated ? "authenticated" : "public"}`;
  const now = yield* Clock.currentTimeMillis;
  const cooldown = [cooldowns.get(origin), cooldowns.get(blockedKey)].find((entry) => entry && entry.until > now);
  if (cooldown) return yield* Effect.fail(cooldown.error);
  const attempt = Effect.gen(function*() {
    let response = yield* Effect.tryPromise({ try: () => host.fetch(url, { ...init, redirect: "manual", headers: { "User-Agent": "BookOrbit-ShadowLib/0.1", ...init.headers } }), catch: () => failure(`${origin}: network request failed.`, "unreachable", true) });
    let challenge = challenged(response.headers);
    if (!challenge && /^(?:text\/html|text\/plain)/i.test(response.headers.get("content-type") ?? "") && ![204, 205, 304].includes(response.status)) {
      // Read through the host's bounded text reader; cloning could evade its size limit.
      const body = yield* text(response);
      challenge = challenged(response.headers, body);
      response = new Response(body, { status: response.status, headers: response.headers });
    }
    if (challenge || response.status === 403) {
      const clock = yield* Clock.currentTimeMillis;
      const error = failure(`${origin}: ${challenge ? "requires a browser challenge" : "access denied (HTTP 403)"}; trying other sources. Host paused for 5 minutes.`);
      cooldowns.set(blockedKey, { until: clock + 5 * 60 * 1000, error });
      yield* Effect.tryPromise({ try: async () => { await response.body?.cancel(); }, catch: () => failure("Could not release response.") }).pipe(Effect.ignore);
      return yield* Effect.fail(error);
    }
    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      const retryHeader = response.headers.get("retry-after");
      const clock = yield* Clock.currentTimeMillis;
      const wait = retryHeader ? (/^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : Math.max(0, Date.parse(retryHeader) - clock)) : 1000;
      const delay = Number.isFinite(wait) ? wait : 1000;
      if (response.status === 429) cooldowns.set(origin, { until: clock + Math.max(1000, delay), error: failure(`${origin}: cooling down after rate limiting.`, "throttled") });
      yield* Effect.tryPromise({ try: async () => { await response.body?.cancel(); }, catch: () => failure("Could not release response.") }).pipe(Effect.ignore);
      return yield* Effect.fail(failure(`${origin}: HTTP ${response.status}.`, response.status === 429 ? "throttled" : "error", delay <= 2000, delay));
    }
    return response;
  });
  return yield* attempt.pipe(Effect.retry(retrySchedule));
});
export const text = Effect.fnUntraced(function*(response: Response) {
  return yield* Effect.tryPromise({ try: () => response.text(), catch: () => failure("Could not read source response.", "unreachable") });
});
export const json = Effect.fnUntraced(function*(response: Response) {
  return yield* Effect.tryPromise({ try: (): Promise<unknown> => response.json(), catch: () => failure("Source returned invalid JSON.") });
});
export const checkedText = Effect.fnUntraced(function*(response: Response) {
  if (response.status === 401) return yield* Effect.fail(failure("Source rejected authentication.", "unauthorized"));
  if (!response.ok) return yield* Effect.fail(failure(`Source returned HTTP ${response.status}.`));
  const body = yield* text(response);
  if (challenged(response.headers, body)) return yield* Effect.fail(failure("Source requires a browser challenge; try another mirror."));
  return body;
});
