import { load } from "cheerio/slim";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withLock } from "./locks.js";
import {
  AnnaDownload,
  downloadLink,
  LiberResponse,
  parseHtml,
  parseMemory,
  parseSize,
  ZDownload,
  ZLogin,
  ZSearch,
  type Hit,
  type Location,
} from "./catalogues.js";
import {
  failure,
  accountForMirror,
  httpsOrigin,
  httpsUrl,
  type Credentials,
  type Mirror,
  type PluginIndexerConfig,
  type PluginReleaseQuery,
} from "./model.js";
import { checkedText, json, request, text, page, Network } from "./network.js";

const sessions = new Map<
  string,
  { credential: string; until: number; headers: Record<string, string> }
>();
const cacheKey = (cfg: PluginIndexerConfig, origin: string) =>
  `${cfg.id}:${origin}`;
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () => failure("Source returned an unexpected API response."),
  });
const queryText = (q: PluginReleaseQuery) =>
  q.isbn13 || [q.title, q.author].filter(Boolean).join(" ");

const createSession = Effect.fnUntraced(function* (
  mirror: Mirror,
  cfg: PluginIndexerConfig,
  accounts: Credentials,
) {
  const account = accountForMirror(accounts, mirror);
  if (!account) return {} as Record<string, string>;
  const now = yield* Clock.currentTimeMillis;
  for (const [key, session] of sessions)
    if (session.until <= now) sessions.delete(key);
  const credential = yield* Effect.tryPromise({
    try: async () =>
      Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(account)),
        ),
      ).toString("hex"),
    catch: () => failure("Could not identify the configured account."),
  });
  const cached = sessions.get(cacheKey(cfg, mirror.origin));
  if (cached && cached.credential === credential) return cached.headers;
  let headers: Record<string, string>;
  if (mirror.family === "annas") {
    if (!account.key)
      return yield* Effect.fail(
        failure("Anna's account needs a key.", "unauthorized"),
      );
    const response = yield* request(mirror.origin + "/account/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ key: account.key }).toString(),
    });
    const cookies = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .filter((cookie) => /^aa_[\w-]+=/.test(cookie))
      .join("; ");
    if (!cookies) {
      const body = yield* text(response);
      return yield* Effect.fail(
        failure(
          /invalid secret key/i.test(body)
            ? "Anna's rejected the account key."
            : `Anna's sign-in returned HTTP ${response.status} without a session.`,
          /invalid secret key/i.test(body) ? "unauthorized" : "error",
        ),
      );
    }
    headers = { Cookie: cookies };
  } else {
    let userId = account.userId;
    let userKey = account.userKey;
    if (!userId || !userKey) {
      if (!account.email || !account.password)
        return yield* Effect.fail(
          failure(
            "Z-Library needs email/password or userId/userKey.",
            "unauthorized",
          ),
        );
      const response = yield* request(mirror.origin + "/eapi/user/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: account.email,
          password: account.password,
        }).toString(),
      });
      const body = yield* decode(ZLogin, yield* json(response));
      if (!body.success || !body.user)
        return yield* Effect.fail(
          failure("Z-Library rejected sign-in.", "unauthorized"),
        );
      userId = String(body.user.id);
      userKey = body.user.remix_userkey;
    }
    headers = {
      "remix-userid": userId,
      "remix-userkey": userKey,
      Cookie: `remix_userid=${encodeURIComponent(userId)}; remix_userkey=${encodeURIComponent(userKey)}`,
    };
  }
  if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
  sessions.set(cacheKey(cfg, mirror.origin), {
    credential,
    until: now + 15 * 60 * 1000,
    headers,
  });
  return headers;
});

const auth = (
  mirror: Mirror,
  cfg: PluginIndexerConfig,
  accounts: Credentials,
) =>
  withLock(
    `auth:${cacheKey(cfg, mirror.origin)}`,
    createSession(mirror, cfg, accounts),
  );

const authenticated = Effect.fnUntraced(function* (
  mirror: Mirror,
  cfg: PluginIndexerConfig,
  accounts: Credentials,
  path: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const url = yield* Effect.try({
    try: () => httpsUrl(path, mirror.origin),
    catch: () => failure("Invalid source URL."),
  });
  if (url.origin !== mirror.origin)
    return yield* Effect.fail(
      failure("Refusing to send credentials outside their configured origin."),
    );
  const headers = yield* auth(mirror, cfg, accounts);
  let response = yield* request(url.href, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const expiredSession =
    response.status === 401 ||
    (response.status >= 300 &&
      response.status < 400 &&
      /\/account\/|\/login(?:\/|\?|$)/i.test(
        response.headers.get("location") ?? "",
      ));
  if (expiredSession && Object.keys(headers).length) {
    sessions.delete(cacheKey(cfg, mirror.origin));
    const refreshed = yield* auth(mirror, cfg, accounts);
    response = yield* request(url.href, {
      ...init,
      headers: { ...refreshed, ...init.headers },
    });
  }
  return response;
});

export const searchMirror = Effect.fnUntraced(function* (
  mirror: Mirror,
  q: PluginReleaseQuery,
  cfg: PluginIndexerConfig,
  accounts: Credentials,
) {
  const term = queryText(q);
  if (mirror.family === "memory") {
    const response = yield* request(
      `${mirror.origin}/search/title/${encodeURIComponent(q.title)}?limit=${Math.min(q.limit, 50)}`,
    );
    const body = yield* json(response);
    return yield* Effect.try({
      try: () => parseMemory(body, mirror),
      catch: () =>
        failure("Memory of the World catalogue response is not recognized."),
    });
  }
  if (mirror.family === "liber3") return yield* searchLiber(mirror, q);
  if (mirror.family === "zlibrary") {
    if (!accountForMirror(accounts, mirror))
      return yield* Effect.fail(
        failure(
          "Z-Library requires account credentials for API access.",
          "unauthorized",
        ),
      );
    const response = yield* authenticated(
      mirror,
      cfg,
      accounts,
      "/eapi/book/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          message: term,
          limit: String(Math.min(q.limit, 50)),
          page: "1",
        }).toString(),
      },
    );
    const body = yield* decode(ZSearch, yield* json(response));
    if (!body.success)
      return yield* Effect.fail(
        failure("Z-Library search refused the session.", "unauthorized"),
      );
    return (body.books ?? []).map((book): Hit => ({
      title: book.title,
      bookTitle: book.title,
      author: book.author,
      format: book.extension.toLowerCase(),
      language:
        book.language?.trim().toLowerCase() === "english"
          ? "en"
          : book.language,
      md5: book.md5,
      sha256: book.sha256,
      sizeBytes: parseSize(book.filesizeString ?? ""),
      seeders: null,
      leechers: null,
      primaryFileCount: 1,
      location: {
        ...mirror,
        id: String(book.id),
        page: `/book/${book.id}/${book.hash}`,
      },
    }));
  }
  const path =
    mirror.family === "annas"
      ? `/search?${new URLSearchParams({ q: term, ...(q.language ? { lang: q.language } : {}), ...(q.mediaKind === "audiobook" ? { content: "audiobook" } : {}) })}`
      : `/index.php?${new URLSearchParams({ req: term, res: "50" })}`;
  const { browser } = yield* Network;
  const html = yield* checkedText(
    browser
      ? yield* page(mirror.origin + path)
      : yield* authenticated(mirror, cfg, accounts, path),
  );
  return yield* Effect.try({
    try: () => parseHtml(html, mirror),
    catch: () => failure(`${mirror.origin}: search layout not recognized.`),
  });
});

const searchLiber = Effect.fnUntraced(function* (
  mirror: Mirror,
  q: PluginReleaseQuery,
) {
  const html = yield* checkedText(yield* page(mirror.origin));
  const $ = load(html);
  const scriptPath = $('script[type="module"][src]').first().attr("src");
  if (!scriptPath)
    return yield* Effect.fail(
      failure("Liber3 did not publish its catalogue entrypoint."),
    );
  const scriptUrl = yield* Effect.try({
    try: () => httpsUrl(scriptPath, mirror.origin),
    catch: () => failure("Invalid Liber3 entrypoint URL."),
  });
  if (scriptUrl.origin !== mirror.origin)
    return yield* Effect.fail(
      failure("Liber3 entrypoint has an unexpected origin."),
    );
  const script = yield* checkedText(yield* request(scriptUrl.href));
  const gateway = /\bGATEWAY\s*=\s*["'](https:\/\/[^"']+)["']/.exec(
    script,
  )?.[1];
  if (!gateway)
    return yield* Effect.fail(
      failure("Liber3 catalogue gateway not recognized."),
    );
  const origin = yield* Effect.try({
    try: () => httpsOrigin(gateway),
    catch: () => failure("Invalid Liber3 gateway origin."),
  });
  // Only read queries; escape query syntax before it enters the gateway's documented SQL endpoint.
  const term = q.title.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!term) return [] as Hit[];
  const sql = `select ipfs_cid,title,author,extension,language,filesize,_id from library.ebook where query_string('title: "${term}"') limit 0, ${Math.max(1, Math.min(50, q.limit))}`;
  const response = yield* request(
    origin + "/blockved/glitterchain/index/sql/simple_query",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    },
  );
  const body = yield* decode(LiberResponse, yield* json(response));
  const hits: Hit[] = [];
  for (const item of body.result) {
    const row = Object.fromEntries(
      Object.entries(item.row).map(([key, field]) => [
        key,
        field.column_value_type === "BytesColumn"
          ? Buffer.from(field.value, "base64").toString("utf8")
          : field.value,
      ]),
    );
    if (
      !row.title ||
      !row.ipfs_cid ||
      !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(row.ipfs_cid)
    )
      continue;
    hits.push({
      title: row.title,
      bookTitle: row.title,
      author: row.author,
      format: row.extension?.toLowerCase(),
      language: row.language,
      sizeBytes: Number(row.filesize) || null,
      seeders: null,
      leechers: null,
      primaryFileCount: 1,
      location: { ...mirror, id: row.ipfs_cid },
    });
  }
  return hits;
});

export const resolveLocation = Effect.fnUntraced(function* (
  location: Location,
  cfg: PluginIndexerConfig,
  accounts: Credentials,
  ipfsOrigin: string,
) {
  const mirror: Mirror = {
    family: location.family,
    origin: httpsOrigin(location.origin),
    status: "unknown",
  };
  if (location.family === "memory" && location.url) {
    const url = yield* Effect.try({
      try: () => httpsUrl(location.url!),
      catch: () => failure("Invalid Memory of the World file URL."),
    });
    if (url.origin !== mirror.origin || !url.pathname.startsWith("/files/"))
      return yield* Effect.fail(
        failure("Invalid Memory of the World file URL."),
      );
    return url.href;
  }
  if (location.family === "liber3") {
    if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(location.id))
      return yield* Effect.fail(failure("Invalid IPFS content identifier."));
    return `${httpsOrigin(ipfsOrigin)}/ipfs/${location.id}`;
  }
  const account = accountForMirror(accounts, mirror);
  if (location.family === "annas") {
    if (!account?.key)
      return yield* Effect.fail(
        failure(
          "Anna’s Archive requires a membership API key for downloads.",
          "unauthorized",
        ),
      );
    if (!/^[a-f0-9]{32}$/.test(location.id))
      return yield* Effect.fail(
        failure("Invalid Anna’s Archive file identifier."),
      );
    const url = new URL("/dyn/api/fast_download.json", mirror.origin);
    url.searchParams.set("md5", location.id);
    url.searchParams.set("key", account.key);
    const result = yield* decode(
      AnnaDownload,
      yield* json(yield* request(url.href)),
    );
    if (result.download_url) return result.download_url;
    if (/quota|download.?limit|daily.?limit/i.test(result.error ?? ""))
      return yield* Effect.fail(
        failure(
          "Anna’s Archive download quota is exhausted. Check your membership allowance.",
          "throttled",
        ),
      );
    if (/invalid.*key/i.test(result.error ?? ""))
      return yield* Effect.fail(
        failure("Anna's rejected the account key.", "unauthorized"),
      );
    return yield* Effect.fail(
      failure(
        "Anna's has no fast download for this file; trying other sources.",
      ),
    );
  }
  if (location.family === "zlibrary") {
    if (!account)
      return yield* Effect.fail(
        failure(
          "Z-Library requires account credentials for downloads.",
          "unauthorized",
        ),
      );
    const parts = /^\/book\/(\d+)\/([a-z0-9]+)$/i.exec(location.page ?? "");
    if (!parts) return yield* Effect.fail(failure("Invalid Z-Library record."));
    const response = yield* authenticated(
      mirror,
      cfg,
      accounts,
      `/eapi/book/${parts[1]}/${parts[2]}/file`,
    );
    const result = yield* decode(ZDownload, yield* json(response));
    if (result.success && result.file?.downloadLink)
      return result.file.downloadLink;
    if (
      /quota|download.?limit|daily.?limit|too many downloads/i.test(
        result.error ?? "",
      )
    )
      return yield* Effect.fail(
        failure(
          "Z-Library download quota is exhausted. Check your account allowance.",
          "throttled",
        ),
      );
    return yield* Effect.fail(
      failure("Z-Library did not return a download URL."),
    );
  }
  const path =
    location.family === "libgen" && /^[a-f0-9]{32}$/.test(location.id)
      ? `/ads.php?md5=${location.id}`
      : (location.page ?? `/md5/${location.id}`);
  const url = yield* Effect.try({
    try: () => httpsUrl(path, mirror.origin),
    catch: () => failure("Invalid download page URL."),
  });
  if (url.origin !== mirror.origin)
    return yield* Effect.fail(failure("Invalid download page origin."));
  const html = yield* checkedText(yield* page(url.href));
  const link = yield* Effect.try({
    try: () => downloadLink(html, mirror.origin),
    catch: () => failure("Invalid download link."),
  });
  if (!link)
    return yield* Effect.fail(
      failure(`${mirror.origin}: no direct download link was found.`),
    );
  return link;
});
