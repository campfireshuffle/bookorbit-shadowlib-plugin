import { Clock, Context, Effect, Schedule } from "effect";
import { failure, type PluginHost, type PluginRequestInit, SourceError } from "./model.js";

export class Network extends Context.Service<Network, { host: PluginHost }>()("open-slum/Network") {}
const cooldowns = new Map<string, number>();
const retrySchedule = Schedule.max([Schedule.exponential("250 millis"), Schedule.recurs(2)]).pipe(
  Schedule.setInputType<SourceError>(),
  Schedule.while(({ input }) => input.retryable),
  Schedule.addDelay(({ input }) => Effect.succeed(input.retryAfterMs)),
);
export const request = Effect.fnUntraced(function*(url: string, init: PluginRequestInit = {}) {
  const { host } = yield* Network;
  const origin = new URL(url).origin;
  const now = yield* Clock.currentTimeMillis;
  if ((cooldowns.get(origin) ?? 0) > now) return yield* Effect.fail(failure(`${origin}: cooling down after rate limiting.`, "throttled"));
  const attempt = Effect.gen(function*() {
    const response = yield* Effect.tryPromise({ try: () => host.fetch(url, { ...init, redirect: "manual", headers: { "User-Agent": "BookOrbit-Open-Slum/0.1", ...init.headers } }), catch: () => failure(`${origin}: network request failed.`, "unreachable", true) });
    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      const retryHeader = response.headers.get("retry-after");
      const clock = yield* Clock.currentTimeMillis;
      const wait = retryHeader ? (/^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : Math.max(0, Date.parse(retryHeader) - clock)) : 1000;
      const delay = Number.isFinite(wait) ? wait : 1000;
      if (response.status === 429) cooldowns.set(origin, clock + Math.max(1000, delay));
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
  if (/ddos-guard|checking your browser|just a moment\.\.\.|cf-chl-|captcha-container/i.test(body)) return yield* Effect.fail(failure("Source requires a browser challenge; try another mirror."));
  return body;
});
