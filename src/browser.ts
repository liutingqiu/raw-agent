/**
 * A CDP harness: drives a real Chrome/Edge and exposes the page to the model as
 * a JavaScript API, so a whole multi-step task can be composed in one script
 * instead of a "call → look → call" loop.
 *
 * Node's built-in fetch + WebSocket are the only transports; no npm packages.
 * The browser is launched detached with its own profile, so the session (and
 * logins) survive across runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { truncate } from "./util.ts";
import { BROWSER_PROFILE, DOWNLOAD_DIR, ensureDir } from "./paths.ts";
import type { ImagePart } from "./tools.ts";

const configuredPort = process.env.RAW_BROWSER_PORT;
const PORT = configuredPort === undefined ? 9222 : Number(configuredPort);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`invalid RAW_BROWSER_PORT "${configuredPort}" (expected 1-65535)`);
}
const BASE = `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.RAW_BROWSER_HEADLESS === "1";
const PROFILE = process.env.RAW_BROWSER_PROFILE || BROWSER_PROFILE;
const BROWSER_MARKER = path.join(PROFILE, ".raw-browser.json");

/* ------------------------------------------------------------------ *
 * CDP transport
 * ------------------------------------------------------------------ */

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: any) => void>>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message ?? "cdp error"} ${JSON.stringify(msg.error.data ?? "")}`.trim()));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
      this.pending.clear();
    });
    ws.addEventListener("error", () => {
      this.closed = true;
    });
  }

  static connect(url: string, timeoutMs = 15_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`timed out connecting to ${url}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to ${url}`));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, cb: (params: any) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * browser discovery + launch
 * ------------------------------------------------------------------ */

const CANDIDATES = [
  process.env.RAW_BROWSER_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(os.homedir(), "AppData", "Local", "Microsoft", "Edge", "Application", "msedge.exe"),
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];

function findBrowser(): string | null {
  for (const c of CANDIDATES) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

type DebuggerInfo = { Browser?: string; webSocketDebuggerUrl?: string };

async function debuggerAlive(): Promise<DebuggerInfo | null> {
  try {
    const res = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const info = (await res.json()) as DebuggerInfo;
    return info && typeof info === "object" ? info : null;
  } catch {
    return null;
  }
}

async function launchBrowser(): Promise<void> {
  const exe = findBrowser();
  if (!exe) throw new Error("no Chrome/Edge found. Set RAW_BROWSER_PATH to the executable.");

  ensureDir(PROFILE);
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter",
    "--disable-popup-blocking",
    "about:blank",
  ];
  if (HEADLESS) args.unshift("--headless=new");

  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const info = await debuggerAlive();
    if (info?.webSocketDebuggerUrl) {
      fs.writeFileSync(BROWSER_MARKER, JSON.stringify({
        port: PORT,
        pid: child.pid,
        profile: PROFILE,
        webSocketDebuggerUrl: info.webSocketDebuggerUrl,
      }));
      return;
    }
  }
  throw new Error(`browser did not expose a debugger on port ${PORT} within 30s`);
}

function ownsDefaultDebugger(info: DebuggerInfo): boolean {
  if (process.env.RAW_BROWSER_PORT) return true;
  try {
    const marker = JSON.parse(fs.readFileSync(BROWSER_MARKER, "utf8"));
    return marker?.port === PORT &&
      path.resolve(marker?.profile ?? "") === path.resolve(PROFILE) &&
      typeof marker?.webSocketDebuggerUrl === "string" &&
      marker.webSocketDebuggerUrl === info.webSocketDebuggerUrl;
  } catch {
    return false;
  }
}

async function ensureBrowser(): Promise<void> {
  const alive = await debuggerAlive();
  if (!alive) return launchBrowser();
  if (!ownsDefaultDebugger(alive)) {
    throw new Error(
      `debug port ${PORT} belongs to an unknown browser. Close it, or set RAW_BROWSER_PORT to a dedicated debugging port.`,
    );
  }
}

async function pickPageTarget(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) });
    const targets = (await res.json()) as any[];
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) return page.webSocketDebuggerUrl as string;

    for (const method of ["PUT", "GET"]) {
      try {
        const created = await fetch(`${BASE}/json/new?about:blank`, { method, signal: AbortSignal.timeout(5000) });
        if (created.ok) {
          const j = (await created.json()) as { webSocketDebuggerUrl?: string };
          if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
        }
      } catch {
        /* try the other verb */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no page target available in the browser");
}

/* ------------------------------------------------------------------ *
 * tab registry
 * ------------------------------------------------------------------ */

type TargetInfo = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };

/** every page this process has a live CDP connection to */
const attached = new Set<string>();
const connections = new Set<Cdp>();

async function listTargets(): Promise<TargetInfo[]> {
  const res = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) });
  return (await res.json()) as TargetInfo[];
}

async function newPageTarget(url: string): Promise<TargetInfo> {
  for (const method of ["PUT", "GET"]) {
    try {
      const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method, signal: AbortSignal.timeout(5000) });
      if (res.ok) return (await res.json()) as TargetInfo;
    } catch {
      /* try the other verb */
    }
  }
  throw new Error("could not open a new tab");
}

async function enableDomains(cdp: Cdp) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
}

async function attachPage(wsUrl: string): Promise<{ cdp: Cdp; page: PageHandle }> {
  const cdp = await Cdp.connect(wsUrl);
  await enableDomains(cdp);
  attached.add(wsUrl);
  connections.add(cdp);
  return { cdp, page: new PageHandle(cdp, wsUrl) };
}

/* ------------------------------------------------------------------ *
 * run-scoped state
 * ------------------------------------------------------------------ */

/** images produced by the script currently running, attached to its tool result */
let activeImages: ImagePart[] | null = null;
const MAX_IMAGES = 4;
const NO_IMAGES = process.env.RAW_NO_IMAGES === "1";

/** set by the tool layer so page.handoff() can reach the human */
let handoffHook: ((message: string, timeoutMs: number) => Promise<string>) | null = null;
let scriptReadyHook: (() => void) | null = null;

export function setHandoffHook(fn: ((message: string, timeoutMs: number) => Promise<string>) | undefined) {
  handoffHook = fn ?? null;
}

/* ------------------------------------------------------------------ *
 * browser-level connection: downloads live in the Browser domain
 * ------------------------------------------------------------------ */

type DownloadRecord = {
  guid: string;
  url: string;
  filename: string;
  state: string;
  path?: string;
  bytes: number;
  done: boolean;
};

const downloads = new Map<string, DownloadRecord>();
let browserCdp: Cdp | null = null;

async function ensureBrowserCdp(): Promise<Cdp> {
  if (browserCdp && !browserCdp.closed) return browserCdp;
  await ensureBrowser();
  const res = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(5000) });
  const info = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) throw new Error("browser exposed no browser-level debugger url");

  const cdp = await Cdp.connect(info.webSocketDebuggerUrl);
  connections.add(cdp);
  browserCdp = cdp;

  cdp.on("Browser.downloadWillBegin", (p) => {
    downloads.set(p.guid, {
      guid: p.guid,
      url: p.url ?? "",
      filename: p.suggestedFilename ?? "download",
      state: "inProgress",
      bytes: 0,
      done: false,
    });
  });
  cdp.on("Browser.downloadProgress", (p) => {
    const d = downloads.get(p.guid);
    if (!d) return;
    d.state = p.state ?? d.state;
    d.bytes = p.receivedBytes ?? d.bytes;
    if (p.filePath) d.path = p.filePath;
    if (p.state === "completed" || p.state === "canceled") d.done = true;
  });

  ensureDir(DOWNLOAD_DIR);
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOAD_DIR,
    eventsEnabled: true,
  });
  return cdp;
}

/** Chrome sometimes reports only the suggested name — resolve it against the download dir */
function resolveDownloadFile(d: DownloadRecord): string {
  if (d.path && fs.existsSync(d.path)) return d.path;
  const direct = path.join(DOWNLOAD_DIR, d.filename);
  if (fs.existsSync(direct)) return direct;
  try {
    const newest = fs
      .readdirSync(DOWNLOAD_DIR)
      .map((f) => path.join(DOWNLOAD_DIR, f))
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (newest && Date.now() - newest.m < 120_000) return newest.f;
  } catch {
    /* ignore */
  }
  return direct;
}

/* ------------------------------------------------------------------ *
 * spaces: isolated browser contexts (own cookies, own storage)
 * ------------------------------------------------------------------ */

export class Space {
  readonly name: string;
  private contextId: string;
  private handles: PageHandle[] = [];

  constructor(name: string, contextId: string) {
    this.name = name;
    this.contextId = contextId;
  }

  get id() {
    return this.contextId;
  }

  /** a new tab inside this isolated context */
  async newPage(url = "about:blank"): Promise<PageHandle> {
    const cdp = await ensureBrowserCdp();
    const { targetId } = await cdp.send("Target.createTarget", { url, browserContextId: this.contextId });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const targets = await listTargets();
      const t = targets.find((x) => x.id === targetId && x.webSocketDebuggerUrl);
      if (t?.webSocketDebuggerUrl) {
        const { page } = await attachPage(t.webSocketDebuggerUrl);
        this.handles.push(page);
        if (url !== "about:blank") {
          // Target.createTarget returns before the navigation starts
          const nav = Date.now() + 10_000;
          while (Date.now() < nav) {
            const href = await page.url().catch(() => "");
            if (href && href !== "about:blank") break;
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        return page;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("new page did not appear in the space");
  }

  /** the space's first page, created on demand */
  async page(): Promise<PageHandle> {
    return this.handles[0] ?? (await this.newPage());
  }

  pages(): PageHandle[] {
    return [...this.handles];
  }

  async close() {
    for (const h of this.handles) h.close();
    this.handles = [];
    // Closing a space must never launch or attach to a new browser.  During
    // shutdown the browser may already be gone, so use the existing connection
    // when available and otherwise just discard local handles.
    const cdp = browserCdp;
    if (cdp && !cdp.closed) {
      await cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId }).catch(() => {});
    }
    spaces.delete(this.name);
  }
}

const spaces = new Map<string, Space>();

export async function getSpace(name: string): Promise<Space> {
  const existing = spaces.get(name);
  if (existing) return existing;
  const cdp = await ensureBrowserCdp();
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  const space = new Space(name, browserContextId);
  spaces.set(name, space);
  return space;
}

/* ------------------------------------------------------------------ *
 * page-side helpers (installed once per page)
 * ------------------------------------------------------------------ */

const INSTALL = fs.readFileSync(new URL("./page-helpers.js", import.meta.url), "utf8");

/* ------------------------------------------------------------------ *
 * key / mouse helpers
 * ------------------------------------------------------------------ */

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Space: { code: "Space", keyCode: 32, text: " " },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
};

const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 };

function keyParams(chord: string) {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  let modifiers = 0;
  for (const m of parts) modifiers |= MODIFIERS[m] ?? MODIFIERS[m[0].toUpperCase() + m.slice(1).toLowerCase()] ?? 0;
  const known = KEYS[key] ?? KEYS[key[0]?.toUpperCase() + key.slice(1)];
  const base = known ?? { code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
  return {
    key: known ? key : key,
    code: base.code,
    windowsVirtualKeyCode: base.keyCode,
    nativeVirtualKeyCode: base.keyCode,
    modifiers,
    text: base.text && !modifiers ? base.text : key.length === 1 && !modifiers ? key : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * PageHandle
 * ------------------------------------------------------------------ */

type DialogPolicy = "accept" | "dismiss";

class PageHandle {
  private cdp: Cdp;
  private wsUrl: string;
  private installed = false;
  private dialogPolicy: DialogPolicy = "accept";
  private lastDialog: { type: string; message: string; at: number } | null = null;
  private netInFlight = 0;
  private lastNetworkAt = Date.now();

  private chooser: { backendNodeId?: number; mode?: string } | null = null;

  constructor(cdp: Cdp, wsUrl: string) {
    this.cdp = cdp;
    this.wsUrl = wsUrl;
    cdp.on("Page.fileChooserOpened", (p) => {
      this.chooser = { backendNodeId: p.backendNodeId, mode: p.mode };
    });
    cdp.on("Page.javascriptDialogOpening", (p) => {
      this.lastDialog = { type: p.type, message: p.message, at: Date.now() };
      this.cdp
        .send("Page.handleJavaScriptDialog", {
          accept: this.dialogPolicy === "accept",
          promptText: this.dialogPolicy === "accept" ? "" : undefined,
        })
        .catch(() => {});
    });
    cdp.on("Network.requestWillBeSent", () => {
      this.netInFlight++;
      this.lastNetworkAt = Date.now();
    });
    // a navigation or context reset wipes window.__mai, so re-install on demand
    cdp.on("Page.frameNavigated", (p) => {
      if (!p?.frame?.parentId) this.installed = false;
    });
    cdp.on("Runtime.executionContextsCleared", () => {
      this.installed = false;
    });
    const done = () => {
      this.netInFlight = Math.max(0, this.netInFlight - 1);
      this.lastNetworkAt = Date.now();
    };
    cdp.on("Network.loadingFinished", done);
    cdp.on("Network.loadingFailed", done);
  }

  private async evaluate(expression: string, timeoutMs = 30_000): Promise<any> {
    const r = await this.cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? "page evaluation failed");
    }
    return r.result?.value;
  }

  private async ensureHelpers() {
    if (this.installed) {
      // cheap guard: the context may have been replaced by a same-document nav
      const alive = await this.evaluate("typeof window.__mai !== 'undefined'");
      if (alive) return;
      this.installed = false;
    }
    await this.evaluate(INSTALL);
    this.installed = true;
  }

  private async elementBox(selector: number | string) {
    await this.ensureHelpers();
    const box = await this.evaluate(
      `(() => { const el = window.__mai.find(${JSON.stringify(selector)}); return el ? window.__mai.rect(el) : null; })()`,
    );
    if (!box) throw new Error(`element not found: ${String(selector)}`);
    return box as { x: number; y: number; w: number; h: number };
  }

  /* ---------------------------- pages ---------------------------- */

  /** open a new tab and return its own handle */
  async newTab(url = "about:blank"): Promise<PageHandle> {
    const target = await newPageTarget(url);
    if (!target.webSocketDebuggerUrl) throw new Error("new tab has no debugger url");
    const page = (await attachPage(target.webSocketDebuggerUrl)).page;
    if (url !== "about:blank") {
      // /json/new returns before the navigation starts; wait for it to leave about:blank
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const href = await page.url().catch(() => "");
        if (href && href !== "about:blank") break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return page;
  }

  /**
   * A click that opens a new tab leaves this handle behind — call this to get a
   * handle for the popup. Polls until a page appears that is not already attached.
   */
  async followPopup(opts: { timeoutMs?: number } = {}): Promise<PageHandle> {
    const deadline = Date.now() + (opts.timeoutMs ?? 8000);
    while (Date.now() < deadline) {
      const targets = await listTargets();
      const fresh = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl && !attached.has(t.webSocketDebuggerUrl));
      const pick = fresh[fresh.length - 1];
      if (pick?.webSocketDebuggerUrl) return (await attachPage(pick.webSocketDebuggerUrl)).page;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("no new tab appeared");
  }

  /** every open tab known to the browser */
  async tabs() {
    const targets = await listTargets();
    return targets
      .filter((t) => t.type === "page")
      .map((t) => ({ url: t.url, attached: attached.has(t.webSocketDebuggerUrl ?? "") }));
  }

  close() {
    this.cdp.close();
    attached.delete(this.wsUrl);
    connections.delete(this.cdp);
    return "tab handle closed (the tab itself stays open)";
  }

  /* ---------------------------- navigation ---------------------------- */

  async goto(url: string, timeoutMs = 30_000) {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    this.lastNetworkAt = Date.now();
    const loaded = new Promise<void>((resolve) => {
      const off = this.cdp.on("Page.loadEventFired", () => {
        clearTimeout(timer);
        off();
        resolve();
      });
      const timer = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
    });
    const r = await this.cdp.send("Page.navigate", { url: target }, timeoutMs);
    if (r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
    await loaded;
    this.installed = false;
    return this.url();
  }

  async reload(timeoutMs = 30_000) {
    const loaded = new Promise<void>((resolve) => {
      const off = this.cdp.on("Page.loadEventFired", () => {
        clearTimeout(timer);
        off();
        resolve();
      });
      const timer = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
    });
    await this.cdp.send("Page.reload", {});
    await loaded;
    this.installed = false;
    return this.url();
  }

  back() {
    return this.evaluate("(history.back(), 'ok')");
  }

  url(): Promise<string> {
    return this.evaluate("location.href");
  }

  title(): Promise<string> {
    return this.evaluate("document.title");
  }

  /* ---------------------------- reading ---------------------------- */

  async snapshot(opts: { scope?: "full" | "viewport"; root?: string; max?: number } = {}): Promise<string> {
    await this.ensureHelpers();
    return this.evaluate(`window.__mai.snapshot(${JSON.stringify(opts ?? {})})`);
  }

  text(selector?: string): Promise<string> {
    return this.ensureHelpers().then(() =>
      this.evaluate(
        selector
          ? `(() => { const el = window.__mai.find(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`
          : "document.body ? document.body.innerText : ''",
      ),
    );
  }

  html(selector?: string): Promise<string> {
    return this.ensureHelpers().then(() => this.evaluate(
      selector
        ? `(() => { const el = window.__mai.find(${JSON.stringify(selector)}); return el ? el.outerHTML : ''; })()`
        : "document.documentElement.outerHTML",
    ));
  }

  eval(js: string): Promise<any> {
    return this.ensureHelpers().then(() => this.evaluate(js));
  }

  /** element description for one locator, or null */
  async find(selector: string | number) {
    await this.ensureHelpers();
    return this.evaluate(
      `(() => { const el = window.__mai.find(${JSON.stringify(selector)}); return el ? window.__mai.describe(el) : null; })()`,
    );
  }

  /** element descriptions for every match of a locator */
  async findAll(selector: string | number) {
    await this.ensureHelpers();
    return this.evaluate(`window.__mai.findAll(${JSON.stringify(selector)}).slice(0, 50).map(window.__mai.describe)`);
  }

  /** how many elements a locator matches (any locator syntax) */
  async count(selector: string | number): Promise<number> {
    await this.ensureHelpers();
    return (await this.evaluate(`window.__mai.findAll(${JSON.stringify(selector)}).length`)) as number;
  }

  /* ---------------------------- input ---------------------------- */

  async click(selector: number | string, opts: { double?: boolean; button?: "left" | "right" | "middle" } = {}) {
    const box = await this.elementBox(selector);
    const button = opts.button ?? "left";
    const clickCount = opts.double ? 2 : 1;
    await this.mouseMove(box.x, box.y);
    for (let i = 1; i <= clickCount; i++) {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button, clickCount: i });
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button, clickCount: i });
    }
    return `clicked ${String(selector)} at ${Math.round(box.x)},${Math.round(box.y)}`;
  }

  dblclick(selector: number | string) {
    return this.click(selector, { double: true });
  }

  async hover(selector: number | string) {
    const box = await this.elementBox(selector);
    await this.mouseMove(box.x, box.y);
    return `hovered ${String(selector)}`;
  }

  async dragAndDrop(source: number | string, target: number | string) {
    const a = await this.elementBox(source);
    const b = await this.elementBox(target);
    await this.mouseMove(a.x, a.y);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: a.x + ((b.x - a.x) * i) / 8,
        y: a.y + ((b.y - a.y) * i) / 8,
        button: "left",
        buttons: 1,
      });
    }
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
    return `dragged ${String(source)} → ${String(target)}`;
  }

  mouseMove(x: number, y: number) {
    return this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async fill(selector: number | string, value: string, opts: { clearFirst?: boolean } = {}) {
    await this.ensureHelpers();
    const res = await this.evaluate(`(() => {
      const el = window.__mai.find(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = ${opts.clearFirst === false ? "String(el.value || '') + " : ""}${JSON.stringify(value)};
      if (setter && 'value' in el) setter.call(el, next);
      else if (el.isContentEditable) el.textContent = next;
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return String(next).slice(0, 60);
    })()`);
    if (res === null) throw new Error(`element not found: ${String(selector)}`);
    return `filled ${String(selector)} with "${res}"`;
  }

  /** keeps the old name working */
  type(selector: number | string, value: string) {
    return this.fill(selector, value);
  }

  async press(key: string) {
    const k = keyParams(key);
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      nativeVirtualKeyCode: k.nativeVirtualKeyCode,
      modifiers: k.modifiers,
      text: k.text,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      nativeVirtualKeyCode: k.nativeVirtualKeyCode,
      modifiers: k.modifiers,
    });
    return `pressed ${key}`;
  }

  async typeText(text: string, opts: { delay?: number } = {}) {
    for (const ch of text) {
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    }
    return `typed ${text.length} chars`;
  }

  async selectOption(selector: number | string, value: string) {
    await this.ensureHelpers();
    const res = await this.evaluate(`(() => {
      const el = window.__mai.find(${JSON.stringify(selector)});
      if (!el) return null;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    if (res === null) throw new Error(`element not found: ${String(selector)}`);
    return `selected "${res}"`;
  }

  async setInputFiles(selector: string, files: string | string[]) {
    const list = (Array.isArray(files) ? files : [files]).map((f) => path.resolve(f));
    for (const f of list) {
      if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
    }
    const { root } = await this.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await this.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`element not found: ${selector}`);
    await this.cdp.send("DOM.setFileInputFiles", { nodeId, files: list });
    return `attached ${list.length} file(s) to ${selector}`;
  }

  /* ---------------------------- waiting ---------------------------- */

  sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async waitForSelector(selector: string, opts: { timeout?: number; state?: "attached" | "visible" | "hidden" | "detached" } = {}) {
    const state = opts.state ?? "visible";
    const deadline = Date.now() + (opts.timeout ?? 15_000);
    await this.ensureHelpers();
    while (Date.now() < deadline) {
      const ok = await this.evaluate(`(() => {
        const el = window.__mai.find(${JSON.stringify(selector)});
        const state = ${JSON.stringify(state)};
        if (state === 'attached') return !!el;
        if (state === 'detached') return !el;
        if (state === 'hidden') return !el || !window.__mai.visible(el);
        return !!el && window.__mai.visible(el);
      })()`);
      if (ok) return `selector ${selector} is ${state}`;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for ${selector} to be ${state}`);
  }

  async waitForFunction(fnOrExpr: string, opts: { timeout?: number; polling?: number } = {}) {
    const deadline = Date.now() + (opts.timeout ?? 15_000);
    while (Date.now() < deadline) {
      const value = await this.evaluate(`(() => { const fn = (${fnOrExpr}); return typeof fn === 'function' ? !!fn() : !!(${fnOrExpr}); })()`);
      if (value) return "condition met";
      await new Promise((r) => setTimeout(r, opts.polling ?? 200));
    }
    throw new Error("timed out waiting for function");
  }

  async waitForURL(pattern: string, opts: { timeout?: number } = {}) {
    const deadline = Date.now() + (opts.timeout ?? 15_000);
    while (Date.now() < deadline) {
      const href = await this.url();
      if (href.includes(pattern) || new RegExp(pattern).test(href)) return href;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for URL matching ${pattern}`);
  }

  /** state: load | domcontentloaded | networkidle */
  async waitForLoadState(state: "load" | "domcontentloaded" | "networkidle" = "load", opts: { timeout?: number; idleMs?: number } = {}) {
    const timeout = opts.timeout ?? 20_000;
    const deadline = Date.now() + timeout;
    if (state === "networkidle") {
      // "no new network activity for idleMs" — long-polls and analytics beacons
      // mean a real page rarely reaches zero in-flight requests.
      const idle = opts.idleMs ?? 600;
      while (Date.now() < deadline) {
        if (Date.now() - this.lastNetworkAt >= idle) return "networkidle";
        await new Promise((r) => setTimeout(r, 100));
      }
      return `networkidle not reached within ${timeout}ms (${this.netInFlight} request(s) still in flight) — continuing`;
    }
    const ready = await this.evaluate("document.readyState");
    if (state === "domcontentloaded" && (ready === "interactive" || ready === "complete")) return ready;
    if (state === "load" && ready === "complete") return ready;
    while (Date.now() < deadline) {
      const r = await this.evaluate("document.readyState");
      if (r === "complete" || (state === "domcontentloaded" && r === "interactive")) return r;
      await new Promise((r2) => setTimeout(r2, 150));
    }
    throw new Error(`timed out waiting for ${state}`);
  }

  /* ---------------------------- artefacts ---------------------------- */

  /**
   * Capture the page. The PNG/JPEG is always written to disk, and is also
   * handed back to the model as an image when called from a browser script.
   */
  async screenshot(opts: { path?: string; fullPage?: boolean; inline?: boolean; format?: "png" | "jpeg"; quality?: number } = {}) {
    const format = opts.format ?? "png";
    const r = await this.cdp.send("Page.captureScreenshot", {
      format,
      ...(format === "jpeg" ? { quality: Math.min(100, Math.max(1, opts.quality ?? 70)) } : {}),
      captureBeyondViewport: opts.fullPage === true,
    });
    const data = r.data as string;
    const bytes = Buffer.from(data, "base64").length;
    const file = path.resolve(
      opts.path ?? path.join(DOWNLOAD_DIR, `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.${format === "jpeg" ? "jpg" : "png"}`),
    );
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, Buffer.from(data, "base64"));

    const mime = format === "jpeg" ? "image/jpeg" : "image/png";
    let attached = false;
    if (activeImages && opts.inline !== false && !NO_IMAGES) {
      if (activeImages.length < MAX_IMAGES) {
        activeImages.push({ mime, data });
        attached = true;
      }
    }
    return { path: file, bytes, attached, ...(attached ? {} : { note: "image saved to disk but not attached" }) };
  }

  /* ---------------------------- downloads ---------------------------- */

  async downloads() {
    await ensureBrowserCdp();
    return [...downloads.values()].map((d) => ({
      url: d.url,
      filename: d.filename,
      state: d.state,
      bytes: d.bytes,
      path: d.done ? resolveDownloadFile(d) : undefined,
    }));
  }

  /** wait for a download started after this call to finish, then return its path */
  async waitForDownload(opts: { timeoutMs?: number } = {}) {
    await ensureBrowserCdp();
    const before = new Set(downloads.keys());
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const fresh = [...downloads.values()].filter((d) => !before.has(d.guid));
      const done = fresh.find((d) => d.done);
      if (done) {
        const file = resolveDownloadFile(done);
        if (done.state === "canceled") throw new Error(`download of ${done.filename} was canceled`);
        return { path: file, filename: path.basename(file), bytes: done.bytes, url: done.url };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("no download finished in time");
  }

  /**
   * Arm file-chooser interception, then have the script click something that
   * opens a native picker. Must be called BEFORE the click.
   */
  async waitForFileChooser(opts: { timeoutMs?: number } = {}) {
    await this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
    const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      if (this.chooser) {
        const pending = this.chooser;
        this.chooser = null;
        return {
          mode: pending.mode,
          setFiles: async (files: string | string[]) => {
            const list = (Array.isArray(files) ? files : [files]).map((f) => path.resolve(f));
            for (const f of list) if (!fs.existsSync(f)) throw new Error(`file not found: ${f}`);
            await this.cdp.send("DOM.setFileInputFiles", { backendNodeId: pending.backendNodeId, files: list });
            return `attached ${list.length} file(s)`;
          },
        };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("no file chooser opened in time");
  }

  /* ---------------------------- human in the loop ---------------------------- */

  /**
   * Ask the person at the keyboard to do something in the browser (log in,
   * solve a captcha) and wait for them to confirm.
   */
  async handoff(message: string, opts: { timeoutMs?: number } = {}) {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    if (!handoffHook) return "no interactive user available — continuing without help";
    return handoffHook(message, timeoutMs);
  }

  /* ---------------------------- dialogs ---------------------------- */

  setDialogPolicy(policy: DialogPolicy) {
    this.dialogPolicy = policy;
    return `dialogs will be ${policy}ed`;
  }

  dialog() {
    return this.lastDialog;
  }

  async screenshot_removed() {
    return "";
  }

  /** fetch from inside the page, so the profile's cookies authenticate it */
  async fetch(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; saveAs?: string } = {}) {
    const expression = `(async () => {
      const res = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(opts.method ?? "GET")},
        headers: ${JSON.stringify(opts.headers ?? {})},
        body: ${opts.body ? JSON.stringify(opts.body) : "undefined"},
        credentials: 'include',
      });
      const text = await res.text();
      return { status: res.status, contentType: res.headers.get('content-type') || '', text };
    })()`;
    const out = (await this.evaluate(expression, 60_000)) as { status: number; contentType: string; text: string };
    if (opts.saveAs) {
      const file = path.resolve(opts.saveAs);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, out.text);
      return { status: out.status, contentType: out.contentType, path: file, bytes: out.text.length };
    }
    return { status: out.status, contentType: out.contentType, text: truncate(out.text, 20_000) };
  }

  scroll(dy = 800) {
    return this.evaluate(`(window.scrollBy(0, ${Number(dy) || 0}), window.scrollY)`);
  }

  /** raw CDP escape hatch */
  cdpSend(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.cdp.send(method, params);
  }
}

/* ------------------------------------------------------------------ *
 * session
 * ------------------------------------------------------------------ */

type Session = { cdp: Cdp; page: PageHandle };
let session: Session | null = null;

async function ensureSession(): Promise<Session> {
  if (session && !session.cdp.closed) return session;
  session = null;

  await ensureBrowser();
  const wsUrl = await pickPageTarget();
  session = await attachPage(wsUrl);
  return session;
}

async function browserStatusLocal(): Promise<string> {
  const alive = await debuggerAlive();
  const owned = alive ? ownsDefaultDebugger(alive) : false;
  return [
    `debugger: ${alive ? `running on port ${PORT} (${alive.Browser ?? "browser"})` : "not running"}`,
    `attach: ${alive ? (owned ? "will reuse the running browser" : "refused: the running browser is not owned by raw") : "will launch on first use"}`,
    `profile: ${PROFILE}`,
    `mode: ${HEADLESS ? "headless" : "headful"}`,
    `binary: ${findBrowser() ?? "not found (set RAW_BROWSER_PATH)"}`,
  ].join("\n");
}

async function closeBrowserLocal() {
  await Promise.all([...spaces.values()].map((space) => space.close().catch(() => {})));
  for (const cdp of connections) cdp.close();
  connections.clear();
  attached.clear();
  spaces.clear();
  browserCdp = null;
  session = null;
}

/**
 * Run a model-authored script with `page` in scope.
 * The script runs in Node (helpers) — use page.eval() for in-page JavaScript.
 */
async function runBrowserScriptLocal(
  script: string,
  opts: { timeoutMs?: number; space?: string } = {},
): Promise<{ text: string; images?: ImagePart[] }> {
  let page: PageHandle;
  if (opts.space) {
    page = await (await getSpace(opts.space)).page();
  } else {
    page = (await ensureSession()).page;
  }
  scriptReadyHook?.();

  const images: ImagePart[] = [];
  activeImages = images;

  const logs: string[] = [];
  const capture = {
    log: (...a: unknown[]) => logs.push(a.map(fmt).join(" ")),
    error: (...a: unknown[]) => logs.push(a.map(fmt).join(" ")),
    warn: (...a: unknown[]) => logs.push(a.map(fmt).join(" ")),
    info: (...a: unknown[]) => logs.push(a.map(fmt).join(" ")),
  };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  const fn = new AsyncFunction("page", "space", "sleep", "console", script);
  const timeout = opts.timeoutMs ?? 180_000;
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`script exceeded ${timeout}ms`)), timeout);
  });

  const finish = (text: string) => ({ text: truncate(text, 24_000), images: images.length ? images : undefined });

  try {
    const value = await Promise.race([
      fn(page, getSpace, (ms: number) => new Promise((r) => setTimeout(r, ms)), capture),
      guard,
    ]);
    const parts: string[] = [];
    if (logs.length) parts.push(logs.join("\n"));
    if (value !== undefined) parts.push(`returned: ${fmt(value)}`);
    if (!parts.length) parts.push("(script produced no output — use console.log to report results)");
    return finish(parts.join("\n"));
  } catch (err) {
    // Keep whatever the script logged, and any screenshots it took, so the model
    // can see how far it got instead of losing the whole run.
    const detail = err instanceof Error ? err.message : String(err);
    const head = logs.length ? `${logs.join("\n")}\n\n` : "";
    return finish(`Error: ${head}script failed — ${detail}`);
  } finally {
    activeImages = null;
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Isolated script runtime
 * ------------------------------------------------------------------ */

type WorkerRequest =
  | { id: number; kind: "run"; script: string; opts: { timeoutMs?: number; space?: string } }
  | { id: number; kind: "status" }
  | { id: number; kind: "close" }
  | { id: number; kind: "handoff-result"; value: string };

type WorkerRequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

type WorkerReply =
  | { id: number; kind: "result"; value: unknown }
  | { id: number; kind: "error"; error: string }
  | { id: number; kind: "ready" }
  | { id: number; kind: "handoff"; message: string; timeoutMs: number };

let runtimeWorker: Worker | null = null;
let runtimeId = 0;
const runtimePending = new Map<
  number,
  { resolve: (value: any) => void; reject: (err: Error) => void; ready: () => void }
>();

function stopRuntime(reason?: Error) {
  const worker = runtimeWorker;
  runtimeWorker = null;
  if (worker) void worker.terminate();
  if (reason) {
    for (const pending of runtimePending.values()) pending.reject(reason);
  }
  runtimePending.clear();
}

function ensureRuntime(): Worker {
  if (runtimeWorker) return runtimeWorker;
  const worker = new Worker(new URL(import.meta.url), {
    execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
  });
  runtimeWorker = worker;
  worker.unref();
  worker.on("message", async (reply: WorkerReply) => {
    if (reply.kind === "handoff") {
      let value = "no human handoff handler is available";
      try {
        if (handoffHook) value = await handoffHook(reply.message, reply.timeoutMs);
      } catch (err) {
        value = `handoff failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      worker.postMessage({ id: reply.id, kind: "handoff-result", value } satisfies WorkerRequest);
      return;
    }
    const pending = runtimePending.get(reply.id);
    if (!pending) return;
    if (reply.kind === "ready") {
      pending.ready();
      return;
    }
    runtimePending.delete(reply.id);
    if (reply.kind === "error") pending.reject(new Error(reply.error));
    else pending.resolve(reply.value);
    if (runtimePending.size === 0) worker.unref();
  });
  worker.on("error", (err) => stopRuntime(err));
  worker.on("exit", (code) => {
    if (runtimeWorker === worker) stopRuntime(code ? new Error(`browser runtime exited with code ${code}`) : undefined);
  });
  return worker;
}

function runtimeRequest<T>(request: WorkerRequestWithoutId, timeoutMs: number, startupMs = 0): Promise<T> {
  const worker = ensureRuntime();
  worker.ref();
  const id = ++runtimeId;
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        runtimePending.delete(id);
        const err = new Error(`browser operation exceeded ${timeoutMs}ms and was terminated`);
        reject(err);
        stopRuntime(err);
      }, ms);
    };
    arm(timeoutMs + startupMs);
    runtimePending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      ready: () => arm(timeoutMs + 500),
    });
    worker.postMessage({ ...request, id });
  });
}

export async function browserStatus(): Promise<string> {
  if (!isMainThread) return browserStatusLocal();
  return runtimeRequest<string>({ kind: "status" }, 15_000);
}

export async function closeBrowser() {
  if (!isMainThread) {
    await closeBrowserLocal();
    return;
  }
  if (!runtimeWorker) return;
  try {
    await runtimeRequest({ kind: "close" }, 5000);
  } finally {
    stopRuntime();
  }
}

export async function runBrowserScript(
  script: string,
  opts: { timeoutMs?: number; space?: string } = {},
): Promise<{ text: string; images?: ImagePart[] }> {
  if (!isMainThread) return runBrowserScriptLocal(script, opts);
  const timeout = opts.timeoutMs ?? 180_000;
  try {
    return await runtimeRequest({ kind: "run", script, opts }, timeout, 35_000);
  } catch (err) {
    return { text: `Error: script failed — ${err instanceof Error ? err.message : String(err)}` };
  }
}

if (!isMainThread && parentPort) {
  const handoffs = new Map<number, (value: string) => void>();
  let handoffId = 0;
  setHandoffHook((message, timeoutMs) =>
    new Promise<string>((resolve) => {
      const id = ++handoffId;
      handoffs.set(id, resolve);
      parentPort!.postMessage({ id, kind: "handoff", message, timeoutMs } satisfies WorkerReply);
    }),
  );
  parentPort.on("message", async (request: WorkerRequest) => {
    if (request.kind === "handoff-result") {
      const resolve = handoffs.get(request.id);
      handoffs.delete(request.id);
      resolve?.(request.value);
      return;
    }
    try {
      let value: unknown;
      if (request.kind === "run") {
        scriptReadyHook = () => parentPort!.postMessage({ id: request.id, kind: "ready" } satisfies WorkerReply);
        try {
          value = await runBrowserScriptLocal(request.script, request.opts);
        } finally {
          scriptReadyHook = null;
        }
      }
      else if (request.kind === "status") value = await browserStatusLocal();
      else {
        await closeBrowserLocal();
        value = undefined;
      }
      parentPort!.postMessage({ id: request.id, kind: "result", value } satisfies WorkerReply);
    } catch (err) {
      parentPort!.postMessage({
        id: request.id,
        kind: "error",
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      } satisfies WorkerReply);
    }
  });
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v, null, 1) ?? String(v);
  } catch {
    return String(v);
  }
}
