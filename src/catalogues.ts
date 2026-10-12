import { load } from "cheerio/slim";
import * as Schema from "effect/Schema";
import {
  Family,
  failure,
  httpsUrl,
  type Mirror,
  type PluginReleaseCandidate,
} from "./model.js";

const LocationSchema = Schema.Struct({
  family: Family,
  origin: Schema.String,
  id: Schema.String,
  page: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});
export type Location = typeof LocationSchema.Type;
export type Hit = Omit<PluginReleaseCandidate, "guid"> & {
  location: Location;
  md5?: string;
  sha256?: string;
};
export const GuidSchema = Schema.Struct({
  locations: Schema.Array(LocationSchema),
  md5: Schema.optionalKey(Schema.String),
});
const extensions =
  "epub|pdf|mobi|azw3|fb2|djvu|cbz|cbr|mp3|m4b|m4a|flac|ogg|opus|zip";
const formats = new RegExp(`\\b(${extensions})\\b`, "i");
const bookFile = new RegExp(`\\.(?:${extensions})(?:$|[?#])`, "i");
const audioFormats = new Set(["mp3", "m4b", "m4a", "flac", "ogg", "opus"]);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
function wholeBytes(value: number | null): number | null {
  if (value === null) return null;
  const size = Math.round(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}
function bytes(value: string): number | null {
  const match = /([\d.]+)\s*(bytes?|[kmgt]i?b)\b/i.exec(value);
  if (!match) return null;
  return wholeBytes(
    Number(match[1]) * 1024 ** ("kmgt".indexOf(match[2][0].toLowerCase()) + 1),
  );
}
function hit(
  title: string,
  context: string,
  location: Location,
  author?: string,
): Hit {
  return {
    location,
    title: clean(title),
    bookTitle: clean(title),
    author: author ? clean(author) : undefined,
    format: formats.exec(context)?.[1].toLowerCase(),
    language: /\[([a-z]{2,3})\]/i.exec(context)?.[1].toLowerCase(),
    sizeBytes: bytes(context),
    seeders: null,
    leechers: null,
    fileCount: 1,
    primaryFileCount: 1,
  };
}
export function parseHtml(html: string, mirror: Mirror): Hit[] {
  const $ = load(html);
  const results: Hit[] = [];
  if (mirror.family === "libgen" && $("#tablelibgen").length) {
    $("#tablelibgen tr").each((_, row) => {
      const cells = $(row).children("td");
      const link = cells
        .eq(0)
        .find('a[href^="edition.php"]')
        .filter((_, el) => !!$(el).text().trim())
        .first();
      const md5 = /md5=([a-f0-9]{32})/i
        .exec(cells.eq(8).html() ?? "")?.[1]
        .toLowerCase();
      if (!md5 || !link.length) return;
      const r = hit(
        link.text(),
        cells.text(),
        { ...mirror, id: md5 },
        cells.eq(1).text(),
      );
      r.md5 = md5;
      r.format = clean(cells.eq(7).text()).toLowerCase();
      const language = clean(cells.eq(4).text()).toLowerCase();
      r.language =
        language === "english"
          ? "en"
          : language === "spanish"
            ? "es"
            : language === "french"
              ? "fr"
              : undefined;
      results.push(r);
    });
    return results;
  }
  $("a[href]").each((_, element) => {
    const link = $(element);
    const href = link.attr("href") ?? "";
    if (!/(?:\/md5\/|\/book\/|\/books\/|edition\.php|book\.php)/i.test(href))
      return;
    const title = clean(link.text());
    if (!title || /^(?:get|download|mirror|cover|[\d]+)$/i.test(title)) return;
    let card = link.closest("tr,article,.book,.book-item,.book-card,.result");
    if (!card.length) {
      card = link;
      for (let i = 0; i < 6; i++) {
        const parent = card.parent();
        if (!parent.length) break;
        card = parent;
        if (card.hasClass("flex") && card.hasClass("pt-3")) break;
      }
    }
    const md5 = /(?:\/md5\/|md5=)([a-f0-9]{32})/i.exec(href)?.[1].toLowerCase();
    const author = card
      .find(
        '[slot="author"],.author,a[href*="termtype=author"],a:has(span[class*="user-edit"])',
      )
      .first()
      .text();
    const r = hit(
      title,
      card.text(),
      { ...mirror, id: md5 ?? href, page: href },
      author,
    );
    r.md5 = md5;
    if (!results.some((existing) => existing.location.id === r.location.id))
      results.push(r);
  });
  if (
    !results.length &&
    !/no (?:books|results|matches)|0 results|nothing found|tablelibgen|js-search-results|search-results|searchresult/i.test(
      html,
    )
  )
    throw failure(`${mirror.origin}: catalogue layout is not recognized.`);
  return results;
}

const MemoryBook = Schema.Struct({
  _id: Schema.String,
  title: Schema.String,
  authors: Schema.Array(Schema.String),
  library_url: Schema.String,
  formats: Schema.Array(
    Schema.Struct({
      format: Schema.String,
      dir_path: Schema.String,
      file_name: Schema.String,
      size: Schema.Number,
    }),
  ),
  languages: Schema.optionalKey(Schema.Array(Schema.String)),
});
const MemoryResponse = Schema.Struct({
  _items: Schema.NullOr(Schema.Array(MemoryBook)),
});
export function parseMemory(body: unknown, mirror: Mirror): Hit[] {
  const result = Schema.decodeUnknownSync(MemoryResponse)(body);
  return (result._items ?? []).flatMap((book) =>
    book.formats.map((file) => {
      const base = httpsUrl(book.library_url, mirror.origin);
      if (base.origin !== mirror.origin)
        throw failure("Memory library returned an unexpected file origin.");
      const path = [file.dir_path, file.file_name]
        .join("")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return {
        location: {
          ...mirror,
          id: book._id + ":" + file.format,
          url: httpsUrl(path, base.href).href,
        },
        title: book.title,
        bookTitle: book.title,
        author: book.authors.join("; "),
        format: file.format.toLowerCase(),
        language: book.languages?.[0] === "eng" ? "en" : book.languages?.[0],
        sizeBytes: file.size,
        seeders: null,
        leechers: null,
        fileCount: 1,
        primaryFileCount: 1,
      };
    }),
  );
}
const StringOrNumber = Schema.Union([Schema.String, Schema.Number]);
export const ZLogin = Schema.Struct({
  success: Schema.Number,
  user: Schema.optionalKey(
    Schema.Struct({ id: StringOrNumber, remix_userkey: Schema.String }),
  ),
});
export const ZSearch = Schema.Struct({
  success: Schema.Number,
  books: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: StringOrNumber,
        hash: Schema.String,
        title: Schema.String,
        author: Schema.optionalKey(Schema.String),
        extension: Schema.String,
        language: Schema.optionalKey(Schema.String),
        filesizeString: Schema.optionalKey(Schema.String),
        md5: Schema.optionalKey(Schema.String),
        sha256: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export const ZDownload = Schema.Struct({
  success: Schema.Number,
  error: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(
    Schema.Struct({ downloadLink: Schema.optionalKey(Schema.String) }),
  ),
});
export const AnnaDownload = Schema.Struct({
  download_url: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export const LiberResponse = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({
      row: Schema.Record(
        Schema.String,
        Schema.Struct({
          value: Schema.String,
          column_value_type: Schema.String,
        }),
      ),
    }),
  ),
});

const libraryNames = {
  annas: "Anna’s Archive",
  libgen: "LibGen",
  zlibrary: "Z-Library",
  memory: "Memory of the World",
  liber3: "Liber3",
} satisfies Record<typeof Family.Type, string>;

export function mergeHits(
  hits: Hit[],
  media: string,
  language: string | null,
  limit: number,
): PluginReleaseCandidate[] {
  const groups = new Map<string, { first: Hit; locations: Location[] }>();
  const aliases = new Map<string, string>();
  for (const h of hits) {
    if (media === "audiobook" && (!h.format || !audioFormats.has(h.format)))
      continue;
    if (media === "ebook" && h.format && audioFormats.has(h.format)) continue;
    if (language && h.language && h.language !== language) continue;
    const keys = [
      `record:${h.location.family}:${h.location.id}:${h.format ?? "unknown"}`,
    ];
    if (h.sha256 && /^[a-f0-9]{64}$/i.test(h.sha256))
      keys.unshift(`sha256:${h.sha256.toLowerCase()}`);
    if (h.md5 && /^[a-f0-9]{32}$/i.test(h.md5))
      keys.unshift(`md5:${h.md5.toLowerCase()}`);
    if (h.location.url || h.location.page) {
      let url: URL;
      try {
        url = httpsUrl(h.location.url ?? h.location.page!, h.location.origin);
      } catch {
        continue;
      }
      url.hash = "";
      for (const key of [...url.searchParams.keys()])
        if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      keys.push(`url:${url.href}:${h.format ?? "unknown"}`);
    }
    const matched = [
      ...new Set(
        keys
          .map((k) => aliases.get(k))
          .filter((k): k is string => k !== undefined),
      ),
    ];
    const key = matched[0] ?? keys[0];
    for (const otherKey of matched.slice(1)) {
      const primary = groups.get(key)!;
      const other = groups.get(otherKey)!;
      for (const location of other.locations)
        if (
          primary.locations.length < 5 &&
          !primary.locations.some(
            (l) => l.origin === location.origin && l.id === location.id,
          )
        )
          primary.locations.push(location);
      primary.first.md5 ??= other.first.md5;
      groups.delete(otherKey);
      for (const [alias, groupKey] of aliases)
        if (groupKey === otherKey) aliases.set(alias, key);
    }
    for (const alias of keys) aliases.set(alias, key);
    const previous = groups.get(key);
    if (previous) previous.first.md5 ??= h.md5;
    if (previous) {
      if (
        previous.locations.length < 5 &&
        !previous.locations.some(
          (l) => l.origin === h.location.origin && l.id === h.location.id,
        )
      )
        previous.locations.push(h.location);
    } else groups.set(key, { first: { ...h }, locations: [h.location] });
  }
  return [...groups.values()]
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map(({ first, locations }) => {
      const { location: _, md5, sha256: _sha256, ...release } = first;
      const identifiers = locations
        .map((location) => Schema.decodeUnknownSync(LocationSchema)(location))
        .sort((a, b) =>
          `${a.family}:${a.origin}:${a.id}`.localeCompare(
            `${b.family}:${b.origin}:${b.id}`,
          ),
        );
      const libraries = [
        ...new Set(identifiers.map(({ family }) => libraryNames[family])),
      ].join(", ");
      return {
        ...release,
        title: `${release.title} · ${libraries}`,
        bookTitle: release.bookTitle ?? release.title,
        sizeBytes: wholeBytes(release.sizeBytes),
        guid: JSON.stringify({
          locations: identifiers,
          ...(md5 ? { md5 } : {}),
        }),
      };
    });
}

export function downloadLink(html: string, origin: string): string | undefined {
  const $ = load(html);
  const candidate = $(
    'a[href^="get.php?"],a[href*="/get.php?"],a[href*="/dl/"],a[href*="/download/"],a[download],a[href$=".epub"],a[href$=".pdf"],a[href$=".m4b"],a[href$=".mp3"]',
  )
    .filter((_, el) => {
      const link = $(el);
      const href = link.attr("href") ?? "";
      if (link.closest('template,[hidden],[aria-hidden="true"]').length)
        return false;
      if (/\.torrent(?:$|\?)/i.test(href)) return false;
      if (!link.is("[download]")) return true;
      const filename = link.attr("download") ?? "";
      return (
        bookFile.test(filename || href) ||
        (!filename && /get\.php\?|\/dl\/|\/download\//i.test(href))
      );
    })
    .first()
    .attr("href");
  if (!candidate) return undefined;
  const url = new URL(candidate, origin);
  if (url.protocol !== "https:" || url.username || url.password)
    throw failure("Source returned an unsafe download link.");
  return url.href;
}
