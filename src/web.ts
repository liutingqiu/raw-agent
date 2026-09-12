/**
 * Web search + fetch with no npm dependencies.
 *
 * Key-less backends are scraped HTML; key-based backends are used first when a
 * key is present in the environment. If a backend fails or returns nothing the
 * next one is tried, and every attempt is reported in `note`.
 */
import { truncate } from "./util.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchOutcome = { engine: string; results: SearchResult[]; note?: string };

const DEFAULT_TIMEOUT = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * tiny html helpers
 * ------------------------------------------------------------------ */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, e: string) => {
    if (e[0] === "#") {
      const hex = e[1] === "x" || e[1] === "X";
      const n = hex ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[e.toLowerCase()] ?? whole;
  });
}

/** strip tags + entities, collapse whitespace */
export function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(href: string, base?: string): string {
  try {
    return base ? new URL(href, base).href : new URL(href).href;
  } catch {
    return href;
  }
}

/** Bing wraps results in https://www.bing.com/ck/a?...&u=a1<base64url> */
export function decodeBingUrl(href: string): string {
  const m = /[?&]u=a1([^&]+)/.exec(href);
  if (!m) return href.startsWith("//") ? "https:" + href : href;
  try {
    return Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return href;
  }
}

/** Readable markdown-ish text from an HTML document. */
export function htmlToText(html: string, baseUrl?: string): string {
  let h = html;
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  h = h.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  h = h.replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  h = h.replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*\/?>/gi, " ");
  h = h.replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = clean(inner);
    if (!text) return " ";
    const abs = absolutize(decodeEntities(href), baseUrl);
    return /^(javascript|mailto|tel):/i.test(abs) || !abs ? text : `[${text}](${abs})`;
  });
  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${clean(t)}\n\n`);
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, t: string) => `\n\n\`\`\`\n${decodeEntities(t.replace(/<[^>]*>/g, "")).trim()}\n\`\`\`\n\n`);
  h = h.replace(/<li\b[^>]*>/gi, "\n- ");
  h = h.replace(/<(br|hr)\s*\/?>/gi, "\n");
  h = h.replace(/<\/(p|div|section|article|header|footer|tr|ul|ol|table|blockquote|figure|form|nav|main|aside)\s*>/gi, "\n\n");
  h = h.replace(/<t[dh]\b[^>]*>/gi, " | ");
  h = h.replace(/<[^>]*>/g, "");
  h = decodeEntities(h);
  return h
    .replace(/[ \t\u00a0\u200b]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ *
 * http
 * ------------------------------------------------------------------ */

type Fetched = { status: number; contentType: string; body: string; finalUrl: string };

async function readBody(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`response is too large (${declared} bytes; limit ${MAX_RESPONSE_BYTES})`);
  }
  if (!res.body) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, total);
  const declaredCharset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(declaredCharset || "utf-8").decode(bytes);
  } catch {
    // Unknown labels are common on old sites; UTF-8 with replacement
    // characters is still more useful than failing the entire fetch.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  timeoutMs = DEFAULT_TIMEOUT,
  signal?: AbortSignal,
): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...init.headers,
      },
      body: init.body,
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } })?.cause?.code ?? "";
    const hint = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|UND_ERR|fetch failed/i.test(String(err) + cause)
      ? " (network unreachable — if this site is blocked, set HTTPS_PROXY or RAW_PROXY)"
      : "";
    throw new Error(`${url} → ${cause || (err instanceof Error ? err.message : String(err))}${hint}`);
  }
  const body = await readBody(res);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status} ${res.statusText}: ${truncate(body, 300)}`);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", body, finalUrl: res.url || url };
}

/* ------------------------------------------------------------------ *
 * search backends
 * ------------------------------------------------------------------ */

function clip(s: string, n = 400): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

async function searchBing(query: string, count: number, timeoutMs: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 30)}&setlang=en`;
  const { body } = await request(url, {}, timeoutMs, signal);
  const out: SearchResult[] = [];
  const re =
    /<h2[^>]*>\s*<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)(?=<li class="b_algo"|<li class="b_ans"|<\/ol>|$)/gi;
  for (const m of body.matchAll(re)) {
    const link = decodeBingUrl(decodeEntities(m[1]));
    const title = clean(m[2]);
    const snippet = clean((/<p[^>]*>([\s\S]*?)<\/p>/i.exec(m[3]) ?? [])[1] ?? "");
    if (title && /^https?:/i.test(link)) out.push({ title, url: link, snippet: clip(snippet) });
    if (out.length >= count) break;
  }
  return out;
}

async function search360(query: string, count: number, timeoutMs: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://www.so.com/s?q=${encodeURIComponent(query)}`;
  const { body } = await request(url, {}, timeoutMs, signal);
  const out: SearchResult[] = [];
  const re =
    /<h3[^>]*class="[^"]*res-title[^"]*"[^>]*>\s*<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<h3[^>]*class="[^"]*res-title|<\/ol>|$)/gi;
  for (const m of body.matchAll(re)) {
    const link = decodeEntities(m[1]);
    const title = clean(m[2]);
    const snippet = clean(
      (/class="res-desc"[^>]*>([\s\S]*?)<\/p>/i.exec(m[3]) ?? /class="res-comm-con"[^>]*>([\s\S]*?)<\/p>/i.exec(m[3]) ?? [])[1] ?? "",
    );
    if (title && /^https?:/i.test(link)) out.push({ title, url: link, snippet: clip(snippet) });
    if (out.length >= count) break;
  }
  return out;
}

async function searchTavily(query: string, count: number, timeoutMs: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const { body } = await request(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: count, search_depth: "advanced" }),
    },
    timeoutMs,
    signal,
  );
  const json = JSON.parse(body) as { results?: { title?: string; url?: string; content?: string }[] };
  return (json.results ?? [])
    .map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: clip(r.content ?? "") }))
    .filter((r) => r.url);
}

async function searchExa(query: string, count: number, timeoutMs: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const { body } = await request(
    "https://api.exa.ai/search",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, numResults: count, contents: { text: { maxCharacters: 600 } } }),
    },
    timeoutMs,
    signal,
  );
  const json = JSON.parse(body) as { results?: { title?: string; url?: string; text?: string }[] };
  return (json.results ?? [])
    .map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: clip(r.text ?? "") }))
    .filter((r) => r.url);
}

async function searchSerper(query: string, count: number, timeoutMs: number, key: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const { body } = await request(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ q: query, num: count }),
    },
    timeoutMs,
    signal,
  );
  const json = JSON.parse(body) as { organic?: { title?: string; link?: string; snippet?: string }[] };
  return (json.organic ?? [])
    .map((r) => ({ title: r.title ?? "", url: r.link ?? "", snippet: clip(r.snippet ?? "") }))
    .filter((r) => r.url);
}

async function searchSearxng(query: string, count: number, timeoutMs: number, base: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `${base.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const { body } = await request(url, {}, timeoutMs, signal);
  const json = JSON.parse(body) as { results?: { title?: string; url?: string; content?: string }[] };
  return (json.results ?? [])
    .slice(0, count)
    .map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: clip(r.content ?? "") }))
    .filter((r) => r.url);
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

export const BACKENDS = ["tavily", "exa", "serper", "searxng", "bing", "360"] as const;
export type Backend = (typeof BACKENDS)[number];

export function availableBackends(): Backend[] {
  const list: Backend[] = [];
  if (process.env.TAVILY_API_KEY) list.push("tavily");
  if (process.env.EXA_API_KEY) list.push("exa");
  if (process.env.SERPER_API_KEY) list.push("serper");
  if (process.env.SEARXNG_URL) list.push("searxng");
  list.push("bing", "360");
  return list;
}

async function runBackend(engine: Backend, query: string, count: number, timeoutMs: number, signal?: AbortSignal): Promise<SearchResult[]> {
  switch (engine) {
    case "tavily":
      return searchTavily(query, count, timeoutMs, process.env.TAVILY_API_KEY!, signal);
    case "exa":
      return searchExa(query, count, timeoutMs, process.env.EXA_API_KEY!, signal);
    case "serper":
      return searchSerper(query, count, timeoutMs, process.env.SERPER_API_KEY!, signal);
    case "searxng":
      return searchSearxng(query, count, timeoutMs, process.env.SEARXNG_URL!, signal);
    case "bing":
      return searchBing(query, count, timeoutMs, signal);
    case "360":
      return search360(query, count, timeoutMs, signal);
    default:
      throw new Error(`unknown engine ${engine}`);
  }
}

export type SearchOptions = { count?: number; engine?: string; timeoutMs?: number; signal?: AbortSignal };

export async function webSearch(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
  const count = Math.max(1, Math.min(opts.count ?? 8, 30));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  let order: Backend[];
  if (opts.engine) {
    if (!BACKENDS.includes(opts.engine as Backend)) {
      throw new Error(`unknown engine "${opts.engine}". Available: ${availableBackends().join(", ")}`);
    }
    order = [opts.engine as Backend];
  } else {
    order = availableBackends();
  }

  const problems: string[] = [];
  for (const engine of order) {
    try {
      const results = await runBackend(engine, query, count, timeoutMs, opts.signal);
      if (results.length) {
        return { engine, results, note: problems.length ? problems.join("; ") : undefined };
      }
      problems.push(`${engine}: no results`);
    } catch (err) {
      problems.push(`${engine}: ${truncate(err instanceof Error ? err.message : String(err), 200)}`);
    }
  }
  return { engine: "none", results: [], note: problems.join("; ") };
}

export type FetchOptions = { maxChars?: number; raw?: boolean; timeoutMs?: number; signal?: AbortSignal };

export async function webFetch(
  url: string,
  opts: FetchOptions = {},
): Promise<{ url: string; contentType: string; text: string }> {
  const maxChars = Math.max(1, Math.min(opts.maxChars ?? 20_000, 200_000));
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const r = await request(target, {}, opts.timeoutMs ?? DEFAULT_TIMEOUT, opts.signal);
  const isJson = r.contentType.includes("json");
  const isHtml = r.contentType.includes("html") || /^\s*<(!doctype|html)/i.test(r.body);

  let text: string;
  if (opts.raw || (!isHtml && !isJson)) text = r.body;
  else if (isJson) text = JSON.stringify(JSON.parse(r.body), null, 2);
  else text = htmlToText(r.body, r.finalUrl);

  return { url: r.finalUrl, contentType: r.contentType, text: truncate(text, maxChars) };
}
