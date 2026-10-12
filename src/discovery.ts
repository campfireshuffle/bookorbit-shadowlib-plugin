import { load } from "cheerio/slim";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { failure, httpsOrigin, MirrorSchema, type Mirror } from "./model.js";
import { checkedText, Network, request } from "./network.js";

export function parseDirectory(html: string): Mirror[] {
  const $ = load(html);
  const result: Mirror[] = [];
  $(".site-card").each((_, card) => {
    const group = $(card).find(".site-card-title").text().trim().toLowerCase();
    if (group === "scihub") return;
    $(card)
      .find(".domain-item-dense")
      .each((_, row) => {
        const href = $(row).find("a.domain-link").attr("href");
        if (!href) return;
        try {
          const origin = httpsOrigin(href);
          const hostname = new URL(origin).hostname;
          if (hostname.startsWith("software.")) return;
          const family = ["annas", "libgen", "zlibrary"].includes(group)
            ? group
            : hostname.includes("memoryoftheworld")
              ? "memory"
              : hostname.includes("liber3")
                ? "liber3"
                : hostname.includes("libstc")
                  ? "libstc"
                  : hostname.includes("welib")
                    ? "welib"
                    : null;
          if (!family) return;
          const mirror = Schema.decodeUnknownSync(MirrorSchema)({
            family,
            origin,
            status:
              $(row)
                .find(".status-col .status-badge")
                .text()
                .trim()
                .toLowerCase() || "unknown",
          });
          if (!result.some((r) => r.origin === origin)) result.push(mirror);
        } catch {
          /* Invalid directory entries never become destinations. */
        }
      });
  });
  if (!result.length)
    throw failure("Open Slum did not contain recognizable book-library cards.");
  return result;
}
const cache = new Map<string, { at: number; mirrors: Mirror[] }>();
export const discover = Effect.fnUntraced(function* (
  directoryOrigin: string,
  refresh = false,
) {
  const origin = httpsOrigin(directoryOrigin);
  const now = yield* Clock.currentTimeMillis;
  const cached = cache.get(origin);
  if (!refresh && cached && now - cached.at < 60 * 60 * 1000)
    return cached.mirrors;
  const fresh = Effect.gen(function* () {
    const html = yield* checkedText(yield* request(origin));
    const mirrors = yield* Effect.try({
      try: () => parseDirectory(html),
      catch: () =>
        failure("Could not parse Open Slum's book-library directory."),
    });
    cache.set(origin, { at: now, mirrors });
    return mirrors;
  });
  return yield* fresh.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (!cached || now - cached.at >= 24 * 60 * 60 * 1000)
          return yield* Effect.fail(error);
        const { host } = yield* Network;
        host.logger.warn(
          "Open Slum refresh failed; using the last successful directory (less than 24 hours old).",
        );
        return cached.mirrors;
      }),
    ),
  );
});
