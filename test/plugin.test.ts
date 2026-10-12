import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Effect } from "effect";
import plugin from "../src/index.js";
import { parseDirectory } from "../src/discovery.js";
import { mergeHits, parseMemory, type Hit } from "../src/catalogues.js";
import {
  credentials,
  type PluginHost,
  type PluginIndexerConfig,
  type PluginReleaseQuery,
} from "../src/model.js";
import { Network, request } from "../src/network.js";

const q: PluginReleaseQuery = {
  title: "Pride and Prejudice",
  author: "Jane Austen",
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: "en",
  limit: 20,
};
let counter = 0;
const cfg = (
  libraries = "annas,libgen,memory",
  credential: string | null = null,
): PluginIndexerConfig => ({
  id: ++counter,
  name: "Fixture",
  baseUrl: `https://directory-${counter}.example`,
  credential,
  allowPrivateAddress: false,
  categories: { ebook: [], audiobook: [], comic: [] },
  settings: { libraries },
});
function directory(groups: Record<string, string[]>) {
  return Object.entries(groups)
    .map(
      ([family, origins]) =>
        `<div class="site-card"><a class="site-card-title">${family}</a>${origins.map((origin) => `<li class="domain-item-dense"><a class="domain-link" href="${origin}"></a><div class="status-col"><span class="status-badge">UP</span></div></li>`).join("")}</div>`,
    )
    .join("");
}
const annaHtml = (md5 = "a".repeat(32), title = q.title, format = "epub") =>
  `<div class="flex pt-3"><a class="js-vim-focus" href="/md5/${md5}">${title}</a><div>[en] · ${format} · 2 MB</div></div>`;
const libgenHtml = (md5 = "b".repeat(32)) =>
  `<table id="tablelibgen"><tr><td><a href="edition.php?id=1">${q.title}</a></td><td>${q.author}</td><td></td><td>1813</td><td>English</td><td></td><td>1 MB</td><td>epub</td><td><a href="ads.php?md5=${md5}">1</a></td></tr></table>`;
const memoryBody = (format = "epub") => ({
  _items: [
    {
      _id: "memory-book",
      title: q.title,
      authors: [q.author],
      library_url: "/files/test/",
      languages: ["eng"],
      formats: [
        {
          format,
          dir_path: "Jane Austen/Pride/",
          file_name: `Pride.${format}`,
          size: 100,
        },
      ],
    },
  ],
});
function host(
  handler: (
    url: URL,
    init?: Parameters<PluginHost["fetch"]>[1],
  ) => Response | Promise<Response>,
) {
  const calls: { url: string; init?: Parameters<PluginHost["fetch"]>[1] }[] =
    [];
  const logs: string[] = [];
  const value: PluginHost = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(new URL(url), init);
    },
    logger: { log: (s) => logs.push(s), warn: (s) => logs.push(s) },
    fail: (kind, message) => Object.assign(new Error(message), { kind }),
    buildSearchText: (query) => query.title,
    saveCredential: async () => {
      throw Error("Unexpected credential write");
    },
  };
  return { value, calls, logs };
}

test("live Open Slum fixture discovers books, excluding Sci-Hub and the software archive", () => {
  const result = parseDirectory(
    readFileSync(new URL("fixtures/open-slum.html", import.meta.url), "utf8"),
  );
  assert.equal(result.length, 20);
  assert(
    !result.some(
      (m) =>
        m.origin.includes("sci-hub") ||
        m.origin.includes("sci-net") ||
        m.origin.includes("software."),
    ),
  );
  assert.deepEqual(
    new Set(result.map((m) => m.family)),
    new Set([
      "annas",
      "libgen",
      "zlibrary",
      "welib",
      "memory",
      "liber3",
      "libstc",
    ]),
  );
});
test("credential JSON must bind secrets to an HTTPS origin and does not echo malformed secrets", () => {
  const secret = "private-test-secret";
  assert.throws(
    () =>
      credentials(
        `{"annas":{"origin":"http://invalid.example","key":"${secret}"}}`,
      ),
    (e) => e instanceof Error && !e.message.includes(secret),
  );
  assert.throws(
    () => credentials(secret),
    (e) => e instanceof Error && !e.message.includes(secret),
  );
});
test("each library is searched even after Anna's succeeds; a failed mirror falls back", async () => {
  const config = cfg();
  const h = host((url) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          annas: ["https://anna-ok.example"],
          libgen: ["https://libgen-bad.example", "https://libgen-ok.example"],
          other: ["https://library.memoryoftheworld.example"],
        }),
      );
    if (url.hostname === "anna-ok.example") return new Response(annaHtml());
    if (url.hostname === "libgen-bad.example")
      return new Response("Blocked", { status: 403 });
    if (url.hostname === "libgen-ok.example") return new Response(libgenHtml());
    return Response.json(memoryBody());
  });
  const result = await plugin.search(
    q,
    config,
    h.value,
    AbortSignal.timeout(3000),
  );
  assert.equal(result.length, 3);
  assert(h.calls.some((c) => c.url.startsWith("https://libgen-ok.example")));
  assert(
    h.calls.some((c) =>
      c.url.startsWith("https://library.memoryoftheworld.example"),
    ),
  );
});
test("502 login failure is retried and falls back without leaking a key to another mirror", async () => {
  const key = "fake-anna-key";
  const config = cfg(
    "annas,libgen",
    JSON.stringify({ annas: { origin: "https://anna-login.example", key } }),
  );
  const h = host((url) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          annas: ["https://anna-login.example", "https://anna-public.example"],
          libgen: ["https://libgen-fallback.example"],
        }),
      );
    if (url.pathname === "/account/")
      return new Response("Unavailable", { status: 502 });
    if (url.hostname.startsWith("anna"))
      return new Response("Blocked", { status: 403 });
    return new Response(libgenHtml());
  });
  const result = await plugin.search(
    q,
    config,
    h.value,
    AbortSignal.timeout(5000),
  );
  assert.equal(result.length, 1);
  assert.equal(
    h.calls.filter((c) => new URL(c.url).pathname === "/account/").length,
    3,
  );
  assert(
    h.calls
      .filter((c) => c.init?.body?.includes(key))
      .every((c) => c.url.startsWith("https://anna-login.example/")),
  );
  assert(!h.logs.join("\n").includes(key));
});
test("a successful Anna's session is reused across test/search calls", async () => {
  const config = cfg(
    "annas",
    JSON.stringify({
      annas: {
        origin: "https://anna-session.example",
        key: "session-test-key",
      },
    }),
  );
  const h = host((url, init) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({ annas: ["https://anna-session.example"] }),
      );
    if (url.pathname === "/account/")
      return new Response("", {
        status: 302,
        headers: { "Set-Cookie": "aa_session=synthetic; Secure; HttpOnly" },
      });
    assert.equal(init?.headers?.Cookie, "aa_session=synthetic");
    return new Response(annaHtml());
  });
  await plugin.search(q, config, h.value, AbortSignal.timeout(3000));
  await plugin.search(q, config, h.value, AbortSignal.timeout(3000));
  assert.equal(
    h.calls.filter((c) => new URL(c.url).pathname === "/account/").length,
    1,
  );
});
test("long Retry-After is honored by skipping retries and cooling down the host", async () => {
  const h = host(
    () =>
      new Response("Wait", { status: 429, headers: { "Retry-After": "60" } }),
  );
  const effect = request("https://throttled.example/search").pipe(
    Effect.provideService(Network, { host: h.value }),
  );
  await assert.rejects(Effect.runPromise(effect));
  await assert.rejects(Effect.runPromise(effect));
  assert.equal(h.calls.length, 1);
});
test("cancellation stops scheduled retries", async () => {
  const config = cfg("annas");
  const h = host((url) =>
    url.origin === config.baseUrl
      ? new Response(directory({ annas: ["https://cancel.example"] }))
      : new Response("Unavailable", { status: 502 }),
  );
  const controller = new AbortController();
  const pending = plugin.search(q, config, h.value, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /cancelled|timed out/);
  assert.equal(
    h.calls.filter((c) => c.url.startsWith("https://cancel.example")).length,
    1,
  );
});
test("dedupe merges hashes and links, retaining formats and editions", () => {
  const base: Hit = {
    title: q.title,
    format: "epub",
    sizeBytes: 100,
    seeders: null,
    leechers: null,
    md5: "a".repeat(32),
    location: { family: "annas", origin: "https://a.example", id: "one" },
  };
  const hits: Hit[] = [
    base,
    {
      ...base,
      location: { family: "libgen", origin: "https://b.example", id: "two" },
    },
    {
      ...base,
      md5: "b".repeat(32),
      format: "pdf",
      location: { ...base.location, id: "three" },
    },
    {
      ...base,
      md5: "c".repeat(32),
      location: { ...base.location, id: "four" },
    },
  ];
  const result = mergeHits(hits, "ebook", "en", 20);
  assert.equal(result.length, 3);
  assert.equal(JSON.parse(result[0].guid).locations.length, 2);
  const linked = [
    {
      ...base,
      md5: undefined,
      location: {
        ...base.location,
        url: "https://files.example/book.epub?utm_source=x#part",
      },
    },
    {
      ...base,
      md5: undefined,
      location: {
        ...base.location,
        id: "different",
        url: "https://files.example/book.epub",
      },
    },
  ];
  assert.equal(mergeHits(linked, "ebook", null, 20).length, 1);
  const hashed = [
    { ...base, md5: undefined, sha256: "f".repeat(64) },
    {
      ...base,
      md5: undefined,
      sha256: "f".repeat(64),
      location: { ...base.location, id: "other" },
    },
  ];
  assert.equal(mergeHits(hashed, "ebook", null, 20).length, 1);
  const bridge = [
    { ...base, md5: "d".repeat(32) },
    {
      ...base,
      md5: undefined,
      sha256: "e".repeat(64),
      location: { ...base.location, id: "sha-only" },
    },
    {
      ...base,
      md5: "d".repeat(32),
      sha256: "e".repeat(64),
      location: { ...base.location, id: "both" },
    },
  ];
  assert.equal(mergeHits(bridge, "ebook", null, 20).length, 1);
});
test("audiobook requests retain audio and exclude ebook-only files", () => {
  const mirror = {
    family: "memory" as const,
    origin: "https://library.memoryoftheworld.example",
    status: "up",
  };
  const hits = [
    ...parseMemory(memoryBody(), mirror),
    ...parseMemory(memoryBody("m4b"), mirror),
  ];
  const result = mergeHits(hits, "audiobook", null, 20);
  assert.equal(result.length, 1);
  assert.equal(result[0].format, "m4b");
});
test("download falls back from failed Anna's to discovered LibGen; filename is sanitized", async () => {
  const key = "fake-download-key";
  const config = cfg(
    "annas,libgen",
    JSON.stringify({ annas: { origin: "https://anna-download.example", key } }),
  );
  const h = host((url) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          annas: ["https://anna-download.example"],
          libgen: ["https://libgen-download.example"],
        }),
      );
    if (url.pathname === "/dyn/api/fast_download.json")
      return new Response("Bad Gateway", { status: 502 });
    return new Response(
      `<a href="get.php?md5=${"a".repeat(32)}&amp;key=public-file-token">GET</a>`,
    );
  });
  const release = mergeHits(
    [
      {
        title: "../../Pride/Prejudice",
        format: "epub",
        sizeBytes: 100,
        seeders: null,
        leechers: null,
        md5: "a".repeat(32),
        location: {
          family: "annas",
          origin: "https://anna-download.example",
          id: "a".repeat(32),
        },
      },
    ],
    "ebook",
    null,
    20,
  )[0];
  const file = await plugin.resolveFile(
    release,
    config,
    h.value,
    AbortSignal.timeout(5000),
  );
  assert(file.url.startsWith("https://libgen-download.example/get.php?"));
  assert(!file.fileName.includes("/"));
  assert(!h.logs.join("\n").includes(key));
});
test("tampered release identifiers cannot cause credential forwarding", async () => {
  const config = cfg(
    "annas",
    JSON.stringify({
      annas: { origin: "https://trusted.example", key: "secret-fixture-key" },
    }),
  );
  const h = host(
    () => new Response(directory({ annas: ["https://trusted.example"] })),
  );
  const release = {
    title: "Book",
    guid: JSON.stringify({
      locations: [
        { family: "annas", origin: "https://evil.example", id: "a".repeat(32) },
      ],
    }),
    sizeBytes: null,
    seeders: null,
    leechers: null,
  };
  await assert.rejects(
    plugin.resolveFile(release, config, h.value, AbortSignal.timeout(2000)),
    /No authorized source/,
  );
  assert(!h.calls.some((c) => c.url.includes("evil.example")));
});

test("parallel sources stay within the concurrency bound and results include each source", async () => {
  const config = cfg("annas,libgen,memory");
  let active = 0;
  let peak = 0;
  const h = host(async (url) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          annas: ["https://parallel-anna.example"],
          libgen: ["https://parallel-libgen.example"],
          other: ["https://library.memoryoftheworld-parallel.example"],
        }),
      );
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    if (url.hostname.startsWith("parallel-anna"))
      return new Response(annaHtml());
    if (url.hostname.startsWith("parallel-libgen"))
      return new Response(libgenHtml());
    return Response.json(memoryBody());
  });
  const result = await plugin.search(
    { ...q, limit: 3 },
    config,
    h.value,
    AbortSignal.timeout(3000),
  );
  assert(peak > 1 && peak <= 4);
  assert.deepEqual(
    new Set(result.map((r) => JSON.parse(r.guid).locations[0].family)),
    new Set(["annas", "libgen", "memory"]),
  );
});
test("simultaneous searches share one sign-in through the Effect semaphore", async () => {
  const config = cfg(
    "annas",
    JSON.stringify({
      annas: {
        origin: "https://anna-singleflight.example/",
        key: "singleflight-key",
      },
    }),
  );
  const h = host(async (url) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({ annas: ["https://anna-singleflight.example"] }),
      );
    if (url.pathname === "/account/") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("", {
        status: 302,
        headers: { "Set-Cookie": "aa_session=shared; Secure" },
      });
    }
    return new Response(annaHtml());
  });
  await Promise.all([
    plugin.search(q, config, h.value, AbortSignal.timeout(3000)),
    plugin.search(q, config, h.value, AbortSignal.timeout(3000)),
  ]);
  assert.equal(
    h.calls.filter((c) => new URL(c.url).pathname === "/account/").length,
    1,
  );
});
test("Z-Library credentials use the encrypted field and file resolution uses its API", async () => {
  const password = "fixture-password";
  const config = cfg(
    "zlibrary",
    JSON.stringify({
      zlibrary: {
        origin: "https://zlibrary-fixture.example",
        email: "test@example.invalid",
        password,
      },
    }),
  );
  const h = host((url, init) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          zlibrary: [
            "https://zlibrary-fixture.example",
            "https://zlibrary-other.example",
          ],
        }),
      );
    if (url.pathname === "/eapi/user/login")
      return Response.json({
        success: 1,
        user: { id: 42, remix_userkey: "fixture-session" },
      });
    assert.equal(init?.headers?.["remix-userid"], "42");
    if (url.pathname === "/eapi/book/search")
      return Response.json({
        success: 1,
        books: [
          {
            id: 12,
            hash: "abc",
            title: q.title,
            author: q.author,
            extension: "EPUB",
            language: "english",
          },
        ],
      });
    if (url.pathname === "/eapi/book/12/abc/file")
      return Response.json({
        success: 1,
        file: { downloadLink: "https://files.example/pride.epub" },
      });
    throw Error("Unexpected URL");
  });
  const releases = await plugin.search(
    q,
    config,
    h.value,
    AbortSignal.timeout(3000),
  );
  const result = await plugin.resolveFile(
    releases[0],
    config,
    h.value,
    AbortSignal.timeout(3000),
  );
  assert.equal(result.url, "https://files.example/pride.epub");
  assert.equal(
    h.calls.filter((c) => c.url.endsWith("/eapi/user/login")).length,
    1,
  );
  assert(!h.calls.some((c) => c.url.includes("zlibrary-other.example")));
  assert(!h.logs.join("\n").includes(password));
});

test("test connection refreshes discovery and refuses a reachable but unsearchable site", async () => {
  const config = cfg("annas");
  const h = host((url) =>
    url.origin === config.baseUrl
      ? new Response(directory({ annas: ["https://layout-unknown.example"] }))
      : new Response("<html><title>A website, not a catalogue</title></html>"),
  );
  const result = await plugin.test(config, h.value);
  assert.equal(result.success, false);
  assert(h.logs.some((line) => line.includes("Domain check")));
  const second = await plugin.test(config, h.value);
  assert.equal(second.success, false);
  assert.equal(h.calls.filter((c) => c.url === config.baseUrl).length, 2);
});
test("Liber3 discovers its gateway without running its script and decodes the published row format", async () => {
  const config = cfg("liber3");
  const cid = "Qm" + "a".repeat(44);
  const h = host((url) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({ other: ["https://liber3-fixture.example"] }),
      );
    if (url.pathname === "/")
      return new Response('<script type="module" src="./app.js"></script>');
    if (url.pathname === "/app.js")
      return new Response(
        'const GATEWAY="https://gateway-fixture.example"; throw Error("must never execute");',
      );
    return Response.json({
      result: [
        {
          row: {
            ipfs_cid: { value: cid, column_value_type: "StringColumn" },
            title: {
              value: Buffer.from(q.title).toString("base64"),
              column_value_type: "BytesColumn",
            },
            author: { value: q.author, column_value_type: "StringColumn" },
            extension: { value: "epub", column_value_type: "StringColumn" },
            language: { value: "en", column_value_type: "StringColumn" },
            filesize: { value: "100", column_value_type: "IntColumn" },
          },
        },
      ],
    });
  });
  const releases = await plugin.search(
    q,
    config,
    h.value,
    AbortSignal.timeout(3000),
  );
  assert.equal(releases[0].title, q.title);
  const file = await plugin.resolveFile(
    releases[0],
    config,
    h.value,
    AbortSignal.timeout(3000),
  );
  assert.equal(file.url, `https://dweb.link/ipfs/${cid}`);
});

test("browser challenges at 200 or 503 fall back once and cool down without requiring credentials", async () => {
  for (const status of [200, 503]) {
    const config = cfg("annas,libgen");
    const blocked = `https://challenge-${status}.example`;
    const h = host((url) => {
      if (url.origin === config.baseUrl)
        return new Response(
          directory({
            annas: [blocked],
            libgen: [`https://challenge-fallback-${status}.example`],
          }),
        );
      if (url.origin === blocked)
        return new Response(
          '<title>Just a moment...</title><form id="challenge-form"></form>',
          {
            status,
            headers: {
              "Content-Type": "text/html",
              ...(status === 503 ? { "cf-mitigated": "challenge" } : {}),
            },
          },
        );
      return new Response(libgenHtml());
    });
    const first = await plugin.search(
      q,
      config,
      h.value,
      AbortSignal.timeout(3000),
    );
    const second = await plugin.search(
      q,
      config,
      h.value,
      AbortSignal.timeout(3000),
    );
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(
      h.calls.filter((c) => new URL(c.url).origin === blocked).length,
      1,
    );
    assert(!h.calls.some((c) => new URL(c.url).pathname === "/account/"));
    assert(h.logs.some((line) => line.includes("browser challenge")));
  }
});
test("normal Cloudflare JavaScript detection is not mistaken for a blocking challenge", async () => {
  const h = host(
    () =>
      new Response(
        '<title>A library</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/api.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      ),
  );
  const response = await Effect.runPromise(
    request("https://ordinary-cloudflare.example").pipe(
      Effect.provideService(Network, { host: h.value }),
    ),
  );
  assert.equal(response.status, 200);
  assert((await response.text()).includes("A library"));
});
test("a blocked anonymous domain probe does not prevent a valid account from searching", async () => {
  const config = cfg(
    "annas",
    JSON.stringify({
      annas: {
        origin: "https://member-only-fixture.example",
        key: "member-fixture-key",
      },
    }),
  );
  const h = host((url, init) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({ annas: ["https://member-only-fixture.example"] }),
      );
    if (url.pathname === "/")
      return new Response("<title>DDoS-Guard</title>", { status: 403 });
    if (url.pathname === "/account/")
      return new Response("", {
        status: 302,
        headers: { "Set-Cookie": "aa_session=member; Secure" },
      });
    assert.equal(init?.headers?.Cookie, "aa_session=member");
    return new Response(annaHtml());
  });
  const result = await plugin.test(config, h.value);
  assert.equal(result.success, true);
  assert(h.logs.some((line) => line.includes("protected")));
});
