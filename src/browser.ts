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
import { BROWSER_PROFILE, CONFIG_DIR, DOWNLOAD_DIR, ensureDir } from "./paths.ts";

export type ImagePart = { mime: string; data: string };

const EXTERNAL_BRIDGE = process.env.RAW_BROWSER_EXTERNAL_BRIDGE === "1";

/**
 * The installer writes {version, token, port} to ~/.raw/edge-bridge.json, and
 * the bridge host rejects unauthenticated requests. Reading that file here is
 * what makes extension mode work from a single environment variable, instead
 * of making the user copy the token across by hand.
 */
export function readBridgeConfig(configDir: string): { token?: string; port?: number } {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(configDir, "edge-bridge.json"), "utf8"),
    ) as { token?: unknown; port?: unknown };
    return {
      token: typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : undefined,
      port: typeof parsed.port === "number" && Number.isInteger(parsed.port) ? parsed.port : undefined,
    };
  } catch {
    return {};
  }
}

const BRIDGE_CONFIG = EXTERNAL_BRIDGE ? readBridgeConfig(CONFIG_DIR) : {};
const BRIDGE_TOKEN = process.env.RAW_BROWSER_BRIDGE_TOKEN ?? BRIDGE_CONFIG.token;
/** edge-bridge/host/Program.cs binds this fixed port in extension mode */
const BRIDGE_PORT = BRIDGE_CONFIG.port ?? 9333;
const configuredPort = process.env.RAW_BROWSER_PORT;
const PORT = configuredPort === undefined ? (EXTERNAL_BRIDGE ? BRIDGE_PORT : 9222) : Number(configuredPort);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`invalid RAW_BROWSER_PORT "${configuredPort}" (expected 1-65535)`);
}
const BASE = `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.RAW_BROWSER_HEADLESS === "1";
const PROFILE = process.env.RAW_BROWSER_PROFILE || BROWSER_PROFILE;
const BROWSER_MARKER = path.join(PROFILE, ".raw-browser.json");

function debuggerFetch(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (BRIDGE_TOKEN) headers.set("X-Raw-Bridge-Token", BRIDGE_TOKEN);
  return fetch(`${BASE}${pathname}`, { ...init, headers });
}

/* ------------------------------------------------------------------ *
 * CDP transport
 * ------------------------------------------------------------------ */

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: any) => void>>();
  private closeListeners = new Set<() => void>();
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
    ws.addEventListener("close", () => this.markClosed());
    ws.addEventListener("error", () => this.markClosed());
  }

  private markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
    this.pending.clear();
    for (const cb of this.closeListeners) cb();
    this.closeListeners.clear();
  }

  static connect(url: string, timeoutMs = 15_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const endpoint = (() => {
        try {
          const parsed = new URL(url);
          return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
        } catch {
          return "browser debugger";
        }
      })();
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`timed out connecting to ${endpoint}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`cannot connect to ${endpoint}`));
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

  onClosed(cb: () => void): () => void {
    if (this.closed) {
      cb();
      return () => {};
    }
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
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
    const res = await debuggerFetch("/json/version", { signal: AbortSignal.timeout(1500) });
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

  if (!EXTERNAL_BRIDGE) ensureDir(PROFILE);
  const args = EXTERNAL_BRIDGE
    ? ["--profile-directory=Default", "about:blank"]
    : [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-features=Translate,MediaRouter",
        "--disable-popup-blocking",
        "about:blank",
      ];
  if (HEADLESS && !EXTERNAL_BRIDGE) args.unshift("--headless=new");

  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const info = await debuggerAlive();
    if (info?.webSocketDebuggerUrl) {
      if (!EXTERNAL_BRIDGE) {
        fs.writeFileSync(BROWSER_MARKER, JSON.stringify({
          port: PORT,
          pid: child.pid,
          profile: PROFILE,
          webSocketDebuggerUrl: info.webSocketDebuggerUrl,
        }));
      }
      return;
    }
  }
  throw new Error(`browser did not expose a debugger on port ${PORT} within 30s`);
}

function ownsDefaultDebugger(info: DebuggerInfo): boolean {
  if (EXTERNAL_BRIDGE) return info.Browser?.startsWith("RawEdgeBridge/") === true;
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
    const res = await debuggerFetch("/json/list", { signal: AbortSignal.timeout(5000) });
    const targets = (await res.json()) as any[];
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) return page.webSocketDebuggerUrl as string;

    for (const method of ["PUT", "GET"]) {
      try {
        const created = await debuggerFetch("/json/new?about:blank", { method, signal: AbortSignal.timeout(5000) });
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

type TargetInfo = {
  id: string;
  type: string;
  title?: string;
  url: string;
  active?: boolean;
  windowId?: number;
  webSocketDebuggerUrl?: string;
};
type TabSelector = string | { id?: string; url?: string };

/** every page this process has a live CDP connection to */
const attached = new Set<string>();
const connections = new Set<Cdp>();

async function listTargets(): Promise<TargetInfo[]> {
  const res = await debuggerFetch("/json/list", { signal: AbortSignal.timeout(5000) });
  return (await res.json()) as TargetInfo[];
}

async function newPageTarget(url: string, active = true): Promise<TargetInfo> {
  for (const method of ["PUT", "GET"]) {
    try {
      const res = await debuggerFetch(`/json/new?${encodeURIComponent(url)}`, {
        method,
        headers: { "X-Raw-Tab-Active": active ? "1" : "0" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return (await res.json()) as TargetInfo;
    } catch {
      /* try the other verb */
    }
  }
  throw new Error("could not open a new tab");
}

function targetIdFromWebSocketUrl(wsUrl: string): string {
  const match = /\/devtools\/page\/([^/?#]+)/.exec(new URL(wsUrl).pathname);
  if (!match) throw new Error(`cannot determine target id from debugger URL: ${wsUrl}`);
  return decodeURIComponent(match[1]);
}

async function resolvePageTarget(selector: TabSelector): Promise<TargetInfo> {
  const targets = (await listTargets()).filter((target) => target.type === "page");
  const matches = typeof selector === "string"
    ? targets.filter((target) => target.id === selector || target.url === selector)
    : targets.filter((target) =>
        (selector.id === undefined || target.id === selector.id) &&
        (selector.url === undefined || target.url === selector.url)
      );
  if (matches.length === 0) throw new Error(`no page tab matched ${JSON.stringify(selector)}`);
  if (matches.length > 1) throw new Error(`multiple page tabs matched ${JSON.stringify(selector)}; select by tab id`);
  if (!matches[0].webSocketDebuggerUrl) throw new Error(`tab ${matches[0].id} has no debugger URL`);
  return matches[0];
}

async function targetHttpAction(action: "activate" | "close", targetId: string): Promise<void> {
  let lastError = "";
  for (const method of ["PUT", "GET"]) {
    try {
      const res = await debuggerFetch(`/json/${action}/${encodeURIComponent(targetId)}`, {
        method,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      lastError = `${res.status} ${await res.text()}`.trim();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`could not ${action} tab ${targetId}${lastError ? `: ${lastError}` : ""}`);
}

async function enableDomains(cdp: Cdp) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
}

async function attachPage(wsUrl: string): Promise<{ cdp: Cdp; page: PageHandle }> {
  const cdp = await Cdp.connect(wsUrl);
  await enableDomains(cdp);
  const knownTargetIds = new Set((await listTargets()).filter((target) => target.type === "page").map((target) => target.id));
  attached.add(wsUrl);
  connections.add(cdp);
  cdp.onClosed(() => {
    attached.delete(wsUrl);
    connections.delete(cdp);
  });
  return { cdp, page: new PageHandle(cdp, wsUrl, knownTargetIds) };
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
  const res = await debuggerFetch("/json/version", { signal: AbortSignal.timeout(5000) });
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

/** a drag endpoint is an element locator or raw viewport coordinates */
type DragPoint = { x: number; y: number };
type DragTarget = number | string | DragPoint;

/** CDP Input.dispatchMouseEvent modifier bitmask */
const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  shift: 8,
};

const BUTTON_BITS: Record<string, number> = { left: 1, right: 2, middle: 4 };

export function modifierMask(modifiers?: string[]): number {
  let mask = 0;
  for (const name of modifiers ?? []) mask |= MODIFIER_BITS[String(name).toLowerCase()] ?? 0;
  return mask;
}

/**
 * Rounded points from a to b, excluding the start and including the end.
 * Canvas editors judge "drag" against "click" by the distance travelled
 * between pointermove events, so teleporting to the target reads as a click.
 */
export function interpolatePath(from: DragPoint, to: DragPoint, steps: number): DragPoint[] {
  const count = Math.max(1, Math.min(Math.floor(steps), 200));
  const points: DragPoint[] = [];
  for (let i = 1; i <= count; i++) {
    points.push({
      x: Math.round(from.x + ((to.x - from.x) * i) / count),
      y: Math.round(from.y + ((to.y - from.y) * i) / count),
    });
  }
  return points;
}

function isDragPoint(target: DragTarget): target is DragPoint {
  return typeof target === "object" && target !== null && "x" in target && "y" in target;
}

function describeDragTarget(target: DragTarget): string {
  return isDragPoint(target) ? `${Math.round(target.x)},${Math.round(target.y)}` : String(target);
}

class PageHandle {
  private cdp: Cdp;
  private wsUrl: string;
  private knownTargetIds: Set<string>;
  private installed = false;
  private dialogPolicy: DialogPolicy = "accept";
  private lastDialog: { type: string; message: string; at: number } | null = null;
  private netInFlight = 0;
  private lastNetworkAt = Date.now();
  /** last known pointer position, so an interpolated move has an origin */
  private pointer: DragPoint | null = null;

  private chooser: { backendNodeId?: number; mode?: string } | null = null;

  constructor(cdp: Cdp, wsUrl: string, knownTargetIds: Set<string>) {
    this.cdp = cdp;
    this.wsUrl = wsUrl;
    this.knownTargetIds = knownTargetIds;
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
  async newTab(url = "about:blank", opts: { active?: boolean } = {}): Promise<PageHandle> {
    const target = await newPageTarget(url, opts.active !== false);
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

  /** attach to one existing tab by exact target id or exact URL */
  async attachTab(selector: TabSelector): Promise<PageHandle> {
    const target = await resolvePageTarget(selector);
    return (await attachPage(target.webSocketDebuggerUrl!)).page;
  }

  /** activate and attach to one existing tab by exact target id or exact URL */
  async switchTab(selector: TabSelector): Promise<PageHandle> {
    const target = await resolvePageTarget(selector);
    await targetHttpAction("activate", target.id);
    return (await attachPage(target.webSocketDebuggerUrl!)).page;
  }

  /** activate this tab, or another tab selected by exact target id or URL */
  async activateTab(selector?: TabSelector): Promise<void> {
    const targetId = selector === undefined ? targetIdFromWebSocketUrl(this.wsUrl) : (await resolvePageTarget(selector)).id;
    await targetHttpAction("activate", targetId);
  }

  /** close the actual Edge/Chrome tab, not just this JavaScript handle */
  async closeTab(selector?: TabSelector): Promise<void> {
    const currentId = targetIdFromWebSocketUrl(this.wsUrl);
    const targetId = selector === undefined ? currentId : (await resolvePageTarget(selector)).id;
    await targetHttpAction("close", targetId);
    if (targetId === currentId) this.close();
  }

  /** restore Edge's most recently closed tab through the extension bridge */
  async restoreClosedTab(): Promise<{ tab?: TargetInfo; window?: { id?: number; tabs?: TargetInfo[] } }> {
    const res = await debuggerFetch("/json/restore", { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`could not restore the most recently closed tab: ${res.status} ${await res.text()}`.trim());
    return (await res.json()) as { tab?: TargetInfo; window?: { id?: number; tabs?: TargetInfo[] } };
  }

  /** stable CDP target id for this handle */
  targetId(): string {
    return targetIdFromWebSocketUrl(this.wsUrl);
  }

  /**
   * A click that opens a new tab leaves this handle behind — call this to get a
   * handle for the popup. Only considers tabs created after this handle was made.
   * Prefer waitForPopup(action) when unrelated tabs may open concurrently.
   */
  async followPopup(opts: { timeoutMs?: number } = {}): Promise<PageHandle> {
    const deadline = Date.now() + (opts.timeoutMs ?? 8000);
    while (Date.now() < deadline) {
      const targets = await listTargets();
      const fresh = targets.filter((t) =>
        t.type === "page" &&
        t.webSocketDebuggerUrl &&
        !this.knownTargetIds.has(t.id) &&
        !attached.has(t.webSocketDebuggerUrl)
      );
      const pick = fresh[fresh.length - 1];
      if (pick?.webSocketDebuggerUrl) {
        this.knownTargetIds.add(pick.id);
        return (await attachPage(pick.webSocketDebuggerUrl)).page;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("no new tab appeared");
  }

  /** run an action and attach only to a tab created after that action began */
  async waitForPopup(action: () => Promise<unknown>, opts: { timeoutMs?: number } = {}): Promise<PageHandle> {
    const before = new Set((await listTargets()).filter((target) => target.type === "page").map((target) => target.id));
    await action();
    const deadline = Date.now() + (opts.timeoutMs ?? 8000);
    while (Date.now() < deadline) {
      const targets = await listTargets();
      const pick = targets.find((target) =>
        target.type === "page" && target.webSocketDebuggerUrl && !before.has(target.id)
      );
      if (pick?.webSocketDebuggerUrl) {
        this.knownTargetIds.add(pick.id);
        return (await attachPage(pick.webSocketDebuggerUrl)).page;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("no new tab appeared");
  }

  /** every open tab known to the browser */
  async tabs() {
    const targets = await listTargets();
    return targets
      .filter((t) => t.type === "page")
      .map((t) => ({
        id: t.id,
        title: t.title ?? "",
        url: t.url,
        active: t.active,
        windowId: t.windowId,
        attached: attached.has(t.webSocketDebuggerUrl ?? ""),
      }));
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

  private async resolveDragPoint(target: DragTarget): Promise<DragPoint> {
    if (isDragPoint(target)) return { x: Number(target.x), y: Number(target.y) };
    const box = await this.elementBox(target as number | string);
    return { x: box.x, y: box.y };
  }

  /** move the pointer; steps > 1 interpolates from the last known position */
  async mouseMove(x: number, y: number, opts: { steps?: number; delay?: number; modifiers?: string[] } = {}) {
    const steps = Math.max(1, Math.min(Math.floor(opts.steps ?? 1), 200));
    const delay = Math.max(0, opts.delay ?? 0);
    const modifiers = modifierMask(opts.modifiers);
    const from = this.pointer;
    if (steps === 1 || !from) {
      this.pointer = { x, y };
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
      return `moved to ${Math.round(x)},${Math.round(y)}`;
    }
    for (const point of interpolatePath(from, { x, y }, steps)) {
      this.pointer = point;
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers });
      if (delay) await this.sleep(delay);
    }
    return `moved to ${Math.round(x)},${Math.round(y)} in ${steps} steps`;
  }

  /** press and hold a mouse button at a viewport point */
  async mouseDown(
    x: number,
    y: number,
    opts: { button?: "left" | "right" | "middle"; modifiers?: string[]; clickCount?: number } = {},
  ) {
    const button = opts.button ?? "left";
    this.pointer = { x, y };
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: BUTTON_BITS[button] ?? 1,
      clickCount: opts.clickCount ?? 1,
      modifiers: modifierMask(opts.modifiers),
    });
    return `mouse down (${button}) at ${Math.round(x)},${Math.round(y)}`;
  }

  /** release a held mouse button at a viewport point */
  async mouseUp(
    x: number,
    y: number,
    opts: { button?: "left" | "right" | "middle"; modifiers?: string[]; clickCount?: number } = {},
  ) {
    const button = opts.button ?? "left";
    this.pointer = { x, y };
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: opts.clickCount ?? 1,
      modifiers: modifierMask(opts.modifiers),
    });
    return `mouse up (${button}) at ${Math.round(x)},${Math.round(y)}`;
  }

  /**
   * Drag a locator or a raw viewport point onto another. Canvas editors
   * (React Flow, Konva, tldraw, Dify) decide "drag" versus "click" from how
   * far the pointer travelled between moves, so the whole path is paced
   * instead of teleporting to the target.
   */
  async dragAndDrop(
    source: DragTarget,
    target: DragTarget,
    opts: { steps?: number; delay?: number; modifiers?: string[]; dropDelay?: number } = {},
  ) {
    const a = await this.resolveDragPoint(source);
    const b = await this.resolveDragPoint(target);
    const steps = Math.max(1, Math.min(Math.floor(opts.steps ?? 12), 200));
    const delay = Math.max(0, opts.delay ?? 8);
    const modifiers = modifierMask(opts.modifiers);

    await this.mouseMove(a.x, a.y);
    await this.mouseDown(a.x, a.y, { modifiers: opts.modifiers });
    if (delay) await this.sleep(delay);

    for (const point of interpolatePath(a, b, steps)) {
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        modifiers,
      });
      if (delay) await this.sleep(delay);
    }
    this.pointer = b;

    if (opts.dropDelay) await this.sleep(opts.dropDelay);
    await this.mouseUp(b.x, b.y, { modifiers: opts.modifiers });
    return `dragged ${describeDragTarget(source)} → ${describeDragTarget(target)} (${steps} steps)`;
  }

  /**
   * Write text into a field. Rich editors own their own document model, so a
   * plain `el.value = x` is silently discarded there. The page-side helper
   * probes Monaco, CodeMirror 5/6 and contenteditable first, then reports
   * which strategy actually ran, so a no-op is never mistaken for a write.
   */
  async setValue(
    selector: number | string,
    value: string,
    opts: { append?: boolean; notifyChange?: boolean } = {},
  ) {
    await this.ensureHelpers();
    const options = { append: opts.append === true, notifyChange: opts.notifyChange !== false };
    const res = (await this.evaluate(
      `window.__mai.setValue(${JSON.stringify(selector)}, ${JSON.stringify(value)}, ${JSON.stringify(options)})`,
    )) as { ok: boolean; strategy: string; detail?: string; length?: number } | null;
    if (!res || !res.ok) {
      throw new Error(`could not write into ${String(selector)}: ${res?.detail ?? "the page returned no result"}`);
    }
    return { strategy: res.strategy, length: res.length ?? String(value).length };
  }

  async fill(selector: number | string, value: string, opts: { clearFirst?: boolean } = {}) {
    const res = await this.setValue(selector, value, { append: opts.clearFirst === false });
    return `filled ${String(selector)} with "${String(value).slice(0, 60)}" via ${res.strategy}`;
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

  /**
   * Resolve when this page receives a network response the predicate accepts.
   * The predicate runs in the host process, so it can inspect status, url,
   * headers and resource type instead of being serialised into the page.
   */
  async waitForResponse(
    predicate:
      | string
      | RegExp
      | ((response: { url: string; status: number; mimeType?: string; resourceType?: string; headers?: Record<string, string> }) => boolean),
    opts: { timeout?: number; resourceType?: string; status?: number } = {},
  ) {
    const timeout = opts.timeout ?? 30_000;
    const wantedType = opts.resourceType?.toLowerCase();
    return await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let off: (() => void) | undefined;
      const stop = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (off) off();
      };
      off = this.cdp.on("Network.responseReceived", (p: any) => {
        const response = {
          url: String(p?.response?.url ?? ""),
          status: Number(p?.response?.status ?? 0),
          mimeType: p?.response?.mimeType as string | undefined,
          resourceType: p?.type as string | undefined,
          headers: p?.response?.headers as Record<string, string> | undefined,
        };
        if (wantedType && String(response.resourceType ?? "").toLowerCase() !== wantedType) return;
        if (opts.status !== undefined && response.status !== opts.status) return;
        const hit =
          typeof predicate === "function"
            ? predicate(response)
            : predicate instanceof RegExp
              ? predicate.test(response.url)
              : response.url.includes(String(predicate));
        if (!hit) return;
        stop();
        resolve(`${response.status} ${response.url}`);
      });
      timer = setTimeout(() => {
        stop();
        reject(new Error(`timed out after ${timeout}ms waiting for a matching response`));
      }, timeout);
    });
  }

  /**
   * Wait for a DOM change that makes the condition true, driven by a
   * MutationObserver inside the page instead of a polling loop. Resolves as
   * soon as the mutation lands, so a slow canvas editor costs nothing.
   */
  async waitForMutation(
    selector: string,
    opts: {
      timeout?: number;
      state?: "attached" | "visible" | "hidden" | "detached";
      text?: string;
    } = {},
  ) {
    const timeout = opts.timeout ?? 20_000;
    const state = opts.state ?? "visible";
    await this.ensureHelpers();
    const result = await this.evaluate(
      `(() => {
        const sel = ${JSON.stringify(selector)};
        const state = ${JSON.stringify(state)};
        const needle = ${JSON.stringify(opts.text ?? null)};
        const check = () => {
          const el = window.__mai.find(sel);
          if (state === 'attached') return !!el;
          if (state === 'detached') return !el;
          if (state === 'hidden') return !el || !window.__mai.visible(el);
          if (!el || !window.__mai.visible(el)) return false;
          if (needle === null) return true;
          return window.__mai.textOf(el).toLowerCase().includes(String(needle).toLowerCase());
        };
        return new Promise((resolve) => {
          if (check()) { resolve('matched'); return; }
          const root = document.documentElement || document;
          const observer = new MutationObserver(() => {
            if (!check()) return;
            observer.disconnect();
            resolve('matched');
          });
          observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
          setTimeout(() => { observer.disconnect(); resolve(null); }, ${timeout});
        });
      })()`,
      timeout + 5_000,
    );
    if (result !== "matched") {
      throw new Error(`timed out after ${timeout}ms waiting for ${selector} to be ${state}`);
    }
    return `selector ${selector} is ${state}`;
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

  /* ---------------- extension bridge surfaces ---------------- *
   * Proxy configuration, browsing data, history, bookmarks, extension
   * management and system notifications sit above the debugging protocol,
   * so CDP has no equivalent for any of them. Each call needs the Edge
   * extension bridge; the error says so instead of failing obscurely.
   * ---------------------------------------------------------- */

  private async bridgeOnly(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!EXTERNAL_BRIDGE) {
      throw new Error(
        `${method} needs the Edge extension bridge. Start the bridge host and set RAW_BROWSER_EXTERNAL_BRIDGE=1 — plain CDP has no equivalent.`,
      );
    }
    return await this.browserCdpSend(method, params);
  }

  /** the current proxy configuration */
  async proxy(): Promise<{ value: any; levelOfControl?: string }> {
    return await this.bridgeOnly("Raw.proxyGet");
  }

  /** switch the browser proxy; pass { mode: "direct" } to stop using one */
  async setProxy(value: Record<string, unknown>, opts: { scope?: string } = {}) {
    return await this.bridgeOnly("Raw.proxySet", { value, scope: opts.scope });
  }

  /** hand proxy control back to the operating system */
  async clearProxy(opts: { scope?: string } = {}) {
    return await this.bridgeOnly("Raw.proxyClear", { scope: opts.scope });
  }

  /** show a system notification — useful for reporting a long task from a background run */
  async notify(title: string, message: string, opts: { silent?: boolean } = {}) {
    return await this.bridgeOnly("Raw.notify", { title, message, silent: opts.silent });
  }

  /** search the profile's browsing history */
  async history(query: { text?: string; maxResults?: number; startTime?: number; endTime?: number } = {}) {
    return await this.bridgeOnly("Raw.historySearch", { query });
  }

  /** read the bookmark tree */
  async bookmarks() {
    return await this.bridgeOnly("Raw.bookmarksList");
  }

  /** list every installed extension with its enabled state */
  async extensions() {
    return await this.bridgeOnly("Raw.managementList");
  }

  /**
   * Clear browsing data. Destructive by nature, so nothing is removed unless
   * it is named here: a call with no true flag is rejected rather than
   * quietly wiping the profile.
   */
  async clearBrowsingData(
    dataTypes: {
      cache?: boolean;
      cacheStorage?: boolean;
      cookies?: boolean;
      downloads?: boolean;
      fileSystems?: boolean;
      formData?: boolean;
      history?: boolean;
      indexedDB?: boolean;
      localStorage?: boolean;
      passwords?: boolean;
      pluginData?: boolean;
      serviceWorkers?: boolean;
      webSQL?: boolean;
    },
    opts: { since?: number; origins?: string[] } = {},
  ) {
    const options: Record<string, unknown> = {};
    if (opts.since !== undefined) options.since = opts.since;
    if (opts.origins !== undefined) options.origins = opts.origins;
    return await this.bridgeOnly("Raw.clearBrowsingData", { dataTypes, options });
  }

  /** every cookie in the profile, optionally filtered by domain, url, name or path */
  async cookies(
    details: { domain?: string; url?: string; name?: string; path?: string; secure?: boolean; session?: boolean } = {},
  ) {
    return await this.bridgeOnly("Raw.cookiesAll", { details });
  }

  /** one cookie, or null when it does not exist */
  async cookie(details: { url: string; name: string }) {
    return await this.bridgeOnly("Raw.cookiesGet", { details });
  }

  /** create or overwrite a cookie */
  async setCookie(details: {
    url: string;
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    expirationDate?: number;
  }) {
    return await this.bridgeOnly("Raw.cookiesSet", { details });
  }

  /** delete one cookie */
  async removeCookie(details: { url: string; name: string }) {
    return await this.bridgeOnly("Raw.cookiesRemove", { details });
  }

  /** change tab properties: pinned, muted, url, autoDiscardable, active */
  async updateTab(
    update: { pinned?: boolean; muted?: boolean; url?: string; autoDiscardable?: boolean; active?: boolean },
    opts: { tabId?: number } = {},
  ) {
    const tabId = opts.tabId ?? Number(this.targetId());
    return await this.bridgeOnly("Raw.updateTab", { tabId, update });
  }

  /** start a download in the browser itself, so it uses the profile's own download settings */
  async download(url: string, opts: { filename?: string; saveAs?: boolean } = {}) {
    return await this.bridgeOnly("Raw.download", {
      options: { url, filename: opts.filename, saveAs: opts.saveAs === true },
    });
  }

  /** cancel a download by the id reported by page.downloads() */
  async cancelDownload(id: number) {
    return await this.bridgeOnly("Raw.cancelDownload", { id });
  }

  /** enable or disable another installed extension */
  async setExtensionEnabled(id: string, enabled = true) {
    return await this.bridgeOnly("Raw.setExtensionEnabled", { id, enabled });
  }

  /** every frame in a tab, including cross-origin iframes, with its URL */
  async frames(opts: { tabId?: number } = {}) {
    const tabId = opts.tabId ?? Number(this.targetId());
    return await this.bridgeOnly("Raw.frames", { tabId });
  }

  /** inject a stylesheet into a tab (this tab by default) */
  async insertCSS(css: string, opts: { tabId?: number; allFrames?: boolean } = {}) {
    const tabId = opts.tabId ?? Number(this.targetId());
    return await this.bridgeOnly("Raw.insertCSS", { tabId, css, allFrames: opts.allFrames });
  }

  /** remove a stylesheet previously added by insertCSS */
  async removeCSS(css: string, opts: { tabId?: number; allFrames?: boolean } = {}) {
    const tabId = opts.tabId ?? Number(this.targetId());
    return await this.bridgeOnly("Raw.removeCSS", { tabId, css, allFrames: opts.allFrames });
  }

  /** raw browser-level CDP escape hatch (Target.*, Browser.*, or a session command) */
  async browserCdpSend(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return (await ensureBrowserCdp()).send(method, params);
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
    `profile: ${EXTERNAL_BRIDGE ? "Edge Default (extension bridge)" : PROFILE}`,
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

function runtimeRequest<T>(request: WorkerRequestWithoutId, timeoutMs: number, startupMs = 0, signal?: AbortSignal): Promise<T> {
  const worker = ensureRuntime();
  worker.ref();
  const id = ++runtimeId;
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      runtimePending.delete(id);
      cleanup();
      const err = new Error("browser operation was cancelled");
      reject(err);
      stopRuntime(err);
    };
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
        cleanup();
        resolve(value);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
      ready: () => arm(timeoutMs + 500),
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
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
  opts: { timeoutMs?: number; space?: string; signal?: AbortSignal } = {},
): Promise<{ text: string; images?: ImagePart[] }> {
  const { signal, ...workerOpts } = opts;
  if (!isMainThread) return runBrowserScriptLocal(script, workerOpts);
  const timeout = opts.timeoutMs ?? 180_000;
  try {
    return await runtimeRequest({ kind: "run", script, opts: workerOpts }, timeout, 35_000, signal);
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
