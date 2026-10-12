import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Effect } from "effect";
import plugin from "../src/index.js";
import { parseDirectory } from "../src/discovery.js";
import {
  downloadLink,
  mergeHits,
  parseHtml,
  parseMemory,
  type Hit,
} from "../src/catalogues.js";
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
  assert.equal(
    h.calls.filter((c) => new URL(c.url).origin === config.baseUrl).length,
    2,
  );
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

test("Memory empty ISBN results are a completed search, not a source failure", async () => {
  const config = cfg("memory");
  const h = host((url) =>
    url.origin === config.baseUrl
      ? new Response(
          directory({ other: ["https://library.memoryoftheworld.org"] }),
        )
      : Response.json({ _items: null, _meta: { total: 0 } }),
  );
  assert.deepEqual(
    await plugin.search(
      { ...q, isbn13: "9781538752036" },
      config,
      h.value,
      new AbortController().signal,
    ),
    [],
  );
});

test("public cookie redirects work without forwarding account credentials", async () => {
  const h = host((url, init) => {
    if (init?.headers?.Cookie === "__diamwall=synthetic")
      return new Response("catalogue");
    return new Response(null, {
      status: 307,
      headers: {
        Location: url.href,
        "Set-Cookie": "__diamwall=synthetic; Secure; HttpOnly",
      },
    });
  });
  const response = await Effect.runPromise(
    request("https://redirect-catalogue.example/search").pipe(
      Effect.provideService(Network, { host: h.value }),
    ),
  );
  assert.equal(response.status, 200);
  const accountResponse = await Effect.runPromise(
    request("https://redirect-catalogue.example/search", {
      headers: { Cookie: "session=synthetic" },
    }).pipe(Effect.provideService(Network, { host: h.value })),
  );
  assert.equal(accountResponse.status, 307);
  assert.equal(h.calls.length, 3);
});

test("a stalled file resolver falls back before BookOrbit cancels the operation", async () => {
  const config = cfg("libgen");
  const h = host((url) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          libgen: [
            "https://stalled-file.example",
            "https://working-file.example",
          ],
        }),
      );
    if (url.pathname === "/index.php") return new Response(libgenHtml());
    if (url.origin === "https://stalled-file.example")
      return new Promise<Response>(() => {});
    return new Response(
      '<a href="https://files.example/book.epub">Download</a>',
    );
  });
  const releases = await plugin.search(
    q,
    config,
    h.value,
    new AbortController().signal,
  );
  const file = await plugin.resolveFile!(
    releases[0],
    config,
    h.value,
    AbortSignal.timeout(4500),
  );
  assert.equal(file.url, "https://files.example/book.epub");
});

test("public redirects discard cookies across origins and remain bounded", async () => {
  const h = host((url, init) => {
    if (url.hostname === "public-redirect.example")
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://other-public.example/search",
          "Set-Cookie": "session=private; Secure",
        },
      });
    assert.equal(init?.headers?.Cookie, undefined);
    return new Response("catalogue");
  });
  await Effect.runPromise(
    request("https://public-redirect.example/search").pipe(
      Effect.provideService(Network, { host: h.value }),
    ),
  );
  const loop = host(
    (url) =>
      new Response(null, { status: 307, headers: { Location: url.href } }),
  );
  await assert.rejects(
    Effect.runPromise(
      request("https://redirect-loop.example/search").pipe(
        Effect.provideService(Network, { host: loop.value }),
      ),
    ),
    /redirect limit/,
  );
  assert.equal(loop.calls.length, 4);
  const unsafe = host(
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "http://unsafe-redirect.example" },
      }),
  );
  await assert.rejects(
    Effect.runPromise(
      request("https://secure-redirect.example/search").pipe(
        Effect.provideService(Network, { host: unsafe.value }),
      ),
    ),
    /unsafe redirect/,
  );
});

test("directory accounts reuse credentials across mirrors while sessions stay per host", async () => {
  const key = "shared-fixture-key";
  const config = cfg("annas", JSON.stringify({ annas: { key } }));
  const h = host((url, init) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          annas: [
            "https://mirror-first.example",
            "https://mirror-second.example",
          ],
        }),
      );
    if (url.pathname === "/account/") {
      assert.equal(new URLSearchParams(init?.body).get("key"), key);
      return new Response("signed in", {
        headers: { "Set-Cookie": `aa_session=${url.hostname}; Secure` },
      });
    }
    assert.equal(init?.headers?.Cookie, `aa_session=${url.hostname}`);
    return new Response(
      url.hostname === "mirror-first.example" ? "No results" : annaHtml(),
    );
  });
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await plugin.search(q, config, h.value, new AbortController().signal))
        .length,
      1,
    );
  assert.equal(
    h.calls.filter((c) => new URL(c.url).pathname === "/account/").length,
    2,
  );
  assert(!h.logs.join("\n").includes(key));
});

test("trustedOrigins replaces discovery defaults, including an empty override", async () => {
  for (const trustedOrigins of [["https://manual-member.example"], []]) {
    const config = cfg(
      "annas",
      JSON.stringify({ annas: { key: "override-fixture", trustedOrigins } }),
    );
    const h = host((url, init) => {
      if (url.origin === config.baseUrl)
        return new Response(
          directory({ annas: ["https://public-only.example"] }),
        );
      if (url.pathname === "/account/") {
        assert.equal(url.origin, "https://manual-member.example");
        return new Response("signed in", {
          headers: { "Set-Cookie": "aa_session=manual; Secure" },
        });
      }
      if (url.origin === "https://public-only.example")
        assert.equal(init?.headers?.Cookie, undefined);
      return new Response(annaHtml());
    });
    assert.equal(
      (await plugin.search(q, config, h.value, new AbortController().signal))
        .length,
      1,
    );
    assert.equal(
      h.calls.filter((c) => new URL(c.url).pathname === "/account/").length,
      trustedOrigins.length,
    );
  }
  assert.throws(
    () =>
      credentials(
        '{"zlibrary":{"password":"synthetic","trustedOrigins":["http://unsafe.example"]}}',
      ),
    /HTTPS origins/,
  );
});

test("directory refresh authorizes new family mirrors and revokes removed ones", async () => {
  const config = cfg(
    "annas",
    JSON.stringify({ annas: { key: "refresh-fixture" } }),
  );
  let current = "https://old-directory-mirror.example";
  const h = host((url) => {
    if (url.origin === config.baseUrl)
      return new Response(directory({ annas: [current] }));
    if (url.pathname === "/account/")
      return new Response("signed in", {
        headers: { "Set-Cookie": `aa_session=${url.hostname}; Secure` },
      });
    return new Response(annaHtml());
  });
  const old = (
    await plugin.search(q, config, h.value, new AbortController().signal)
  )[0];
  current = "https://new-directory-mirror.example";
  assert.equal((await plugin.test(config, h.value)).success, true);
  const before = h.calls.length;
  await assert.rejects(
    plugin.resolveFile(old, config, h.value, new AbortController().signal),
    /No authorized source/,
  );
  assert.equal(h.calls.length, before);
  assert(h.calls.some((c) => c.url === current + "/account/"));
});

test("Z-Library directory account uses the API on mirrors without a pinned origin", async () => {
  const config = cfg(
    "annas,zlibrary",
    JSON.stringify({
      zlibrary: { userId: "42", userKey: "shared-session-fixture" },
    }),
  );
  const h = host((url, init) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          zlibrary: ["https://z-first.example", "https://z-second.example"],
          annas: ["https://other-family.example"],
        }),
      );
    if (url.hostname === "other-family.example")
      return new Response(annaHtml());
    assert.equal(init?.headers?.["remix-userkey"], "shared-session-fixture");
    return Response.json({
      success: 1,
      books:
        url.hostname === "z-first.example"
          ? []
          : [
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
  });
  assert.equal(
    (await plugin.search(q, config, h.value, new AbortController().signal))[0]
      .format,
    "epub",
  );
  const others = h.calls.filter(
    (c) => new URL(c.url).hostname === "other-family.example",
  );
  assert.equal(others.length, 1);
  for (const call of others) {
    assert.equal(call.init?.headers?.Cookie, undefined);
    assert.equal(call.init?.headers?.["remix-userkey"], undefined);
    assert.equal(call.init?.body, undefined);
  }
  assert.equal(
    h.calls.filter((c) => c.url.endsWith("/eapi/book/search")).length,
    2,
  );
});

test("Anna's file fallback reuses the directory account key on the next mirror", async () => {
  const config = cfg(
    "annas",
    JSON.stringify({ annas: { key: "download-shared-fixture" } }),
  );
  const h = host((url) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({
          annas: [
            "https://download-first.example",
            "https://download-second.example",
          ],
        }),
      );
    if (url.pathname === "/account/")
      return new Response("signed in", {
        headers: { "Set-Cookie": "aa_session=synthetic; Secure" },
      });
    if (url.pathname === "/search") return new Response(annaHtml());
    assert.equal(url.searchParams.get("key"), "download-shared-fixture");
    return Response.json(
      url.hostname === "download-first.example"
        ? { error: "unavailable" }
        : { download_url: "https://files.example/fallback.epub" },
    );
  });
  const release = (
    await plugin.search(q, config, h.value, new AbortController().signal)
  )[0];
  assert.equal(
    (
      await plugin.resolveFile(
        release,
        config,
        h.value,
        new AbortController().signal,
      )
    ).url,
    "https://files.example/fallback.epub",
  );
});

test("browser helper clears public challenges and reuses a host-scoped session", async () => {
  const config = cfg("zlibrary");
  config.settings = {
    libraries: "zlibrary",
    browserHelperUrl: "https://solver.example/",
  };
  const commands: Record<string, unknown>[] = [];
  const h = host((url, init) => {
    if (url.origin === config.baseUrl)
      return new Response(
        directory({ zlibrary: ["https://zlib-browser.example"] }),
      );
    if (url.hostname === "solver.example") {
      assert.equal(url.pathname, "/v1");
      const command = JSON.parse(init!.body!);
      commands.push(command);
      return Response.json({
        status: "ok",
        session: command.session,
        ...(command.cmd === "request.get"
          ? {
              solution: {
                status: 200,
                url: command.url,
                response: `<z-bookcard id="123" href="/book/123/fixture.html" extension="epub" language="english"><div slot="title">${q.title}</div><div slot="author">${q.author}</div></z-bookcard>`,
              },
            }
          : {}),
      });
    }
    return new Response("<title>Checking your browser</title>", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    });
  });
  for (let i = 0; i < 2; i++) {
    const releases = await plugin.search(
      q,
      config,
      h.value,
      AbortSignal.timeout(3000),
    );
    assert.equal(releases.length, 1);
    assert.equal(releases[0].format, "epub");
  }
  assert.equal(commands.filter((c) => c.cmd === "sessions.create").length, 1);
  const gets = commands.filter((c) => c.cmd === "request.get");
  assert.equal(gets.length, 2);
  assert.equal(gets[0].session, gets[1].session);
  assert.equal(gets[0].maxTimeout, 4500);
  assert.equal((await plugin.test(config, h.value)).success, true);
  assert.equal(commands.at(-1)?.maxTimeout, 20000);
  const { browserHelper } = await import("../src/browser.js");
  const helper = await Effect.runPromise(browserHelper(config, h.value));
  await Effect.runPromise(
    helper!.fetchPage("https://another-zlib.example/s/fixture", 4500),
  );
  const created = commands.filter((c) => c.cmd === "sessions.create");
  assert.equal(created.length, 2);
  assert.notEqual(created[0].session, created[1].session);
});

test("helper tokens stay bound to the helper and failed sessions recover", async () => {
  const config = cfg(
    "annas",
    JSON.stringify({
      browserHelper: {
        origin: "https://token-helper.example",
        token: "synthetic-helper-token",
      },
    }),
  );
  config.settings = {
    libraries: "annas",
    browserHelperUrl: "https://token-helper.example/v1",
  };
  let fail = true;
  let creates = 0;
  const h = host((url, init) => {
    if (url.hostname === "token-helper.example") {
      assert.equal(
        init?.headers?.Authorization,
        "Bearer synthetic-helper-token",
      );
      const command = JSON.parse(init!.body!);
      if (command.cmd === "sessions.create") creates++;
      if (command.cmd === "request.get") {
        if (fail) {
          fail = false;
          return Response.json({
            status: "error",
            message: "Session not found; synthetic-helper-token",
          });
        }
        return Response.json({
          status: "ok",
          solution: { status: 200, url: command.url, response: annaHtml() },
        });
      }
      return Response.json({ status: "ok", session: command.session });
    }
    assert(!JSON.stringify(init).includes("synthetic-helper-token"));
    if (url.origin === config.baseUrl)
      return new Response(
        directory({ annas: ["https://anna-browser-restart.example"] }),
      );
    return new Response("blocked", { status: 403 });
  });
  await assert.rejects(
    plugin.search(q, config, h.value, AbortSignal.timeout(3000)),
    /Browser helper could not complete/,
  );
  assert.equal(
    (await plugin.search(q, config, h.value, AbortSignal.timeout(3000))).length,
    1,
  );
  assert.equal(creates, 2);
  assert(!h.logs.join(" ").includes("synthetic-helper-token"));
  config.settings.browserHelperUrl = "https://different-helper.example";
  const before = h.calls.length;
  await assert.rejects(
    plugin.search(q, config, h.value, AbortSignal.timeout(3000)),
    /match its origin/,
  );
  assert.equal(h.calls.length, before);
});

test("authenticated requests and rate limits never delegate to a browser helper", async () => {
  const config = cfg();
  config.settings = { browserHelperUrl: "https://no-secrets-helper.example" };
  const { browserHelper } = await import("../src/browser.js");
  const h = host(() => new Response("denied", { status: 403 }));
  const browser = await Effect.runPromise(browserHelper(config, h.value));
  await assert.rejects(
    Effect.runPromise(
      request("https://authenticated-browser.example/account/", {
        method: "POST",
        body: "key=synthetic-library-secret",
      }).pipe(Effect.provideService(Network, { host: h.value, browser })),
    ),
  );
  assert.equal(h.calls.length, 1);
  const throttled = host(
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
  );
  await assert.rejects(
    Effect.runPromise(
      request("https://throttled-browser.example/search").pipe(
        Effect.provideService(Network, { host: throttled.value, browser }),
      ),
    ),
  );
  assert.equal(throttled.calls.length, 1);
  assert.equal(h.calls.length, 1);
});

test("helper failures explain LAN permissions without echoing host errors", async () => {
  const config = cfg("zlibrary");
  config.settings = {
    libraries: "zlibrary",
    browserHelperUrl: "http://192.0.2.1:8191",
  };
  const h = host(() => {
    throw Error("private details and credentials");
  });
  const { browserHelper } = await import("../src/browser.js");
  const helper = await Effect.runPromise(browserHelper(config, h.value));
  await assert.rejects(
    Effect.runPromise(helper!.check),
    (e) =>
      e instanceof Error &&
      e.message.includes("Allow private IP addresses") &&
      !e.message.includes("private details"),
  );
});

test("decimal catalogue sizes are whole bytes accepted by the download database", () => {
  const [release] = parseHtml(
    `<z-bookcard id="123" href="/book/123/fixture" extension="epub" filesize="2.15 MB"><div slot="title">Fixture</div></z-bookcard>`,
    { family: "zlibrary", origin: "https://zlib-size.example", status: "up" },
  );
  assert.equal(release.sizeBytes, 2254438);
  assert(Number.isSafeInteger(release.sizeBytes));
});

test("file resolution ignores access info and hidden decoys before the real download", () => {
  const html = `<a href="/access-info" download="Z-Library_access.txt">Save access info</a>
    <template><a href="/dl/decoy-template">Download</a></template>
    <a href="/dl/decoy-hidden" hidden>Download</a>
    <a href="/dl/decoy-aria" aria-hidden="true">Download</a>
    <a href="https://reader.example/read/book">Read Online</a>
    <a href="/dl/real-file">epub, 2.15 MB</a>`;
  assert.equal(
    downloadLink(html, "https://zlib-files.example"),
    "https://zlib-files.example/dl/real-file",
  );
  assert.equal(
    downloadLink(
      '<a href="/access-info" download="access.txt">Save access info</a>',
      "https://zlib-files.example",
    ),
    undefined,
  );
});

test("non-HTML sources also emit safe integer byte counts", () => {
  const base: Hit = {
    title: "Fixture",
    sizeBytes: 2254438.4,
    seeders: null,
    leechers: null,
    format: "epub",
    location: {
      family: "memory",
      origin: "https://memory-size.example",
      id: "one",
    },
  };
  const results = mergeHits(
    [
      base,
      {
        ...base,
        sizeBytes: Infinity,
        location: {
          family: "liber3",
          origin: "https://liber-size.example",
          id: "two",
        },
      },
    ],
    "ebook",
    null,
    10,
  );
  assert.deepEqual(
    results.map((r) => r.sizeBytes),
    [2254438, null],
  );
});

test("other libraries retain direct download routes and named book attachments", () => {
  for (const href of [
    "get.php?md5=abc",
    "/download/book",
    "/files/book.epub?key=fixture",
  ]) {
    assert.equal(
      downloadLink(
        `<a href="${href}" download>Get</a>`,
        "https://files-fixture.example",
      ),
      new URL(href, "https://files-fixture.example").href,
    );
  }
  assert.equal(
    downloadLink(
      '<a href="/opaque" download="Book.m4b">Audio</a>',
      "https://files-fixture.example",
    ),
    "https://files-fixture.example/opaque",
  );
});
