#!/usr/bin/env node
/**
 * raw-bridge - drive your own browser from any shell, without starting a full
 * agent session.
 *
 * The Edge extension bridge already speaks CDP on 127.0.0.1:9333 and the
 * extension exposes its own extension-only surfaces on top of it. This script
 * is a thin, dependency-free client for both, so any session, script or human
 * reaches the same logged-in browser the raw agent uses.
 *
 *   node raw-bridge.mjs status
 *   node raw-bridge.mjs tabs
 *   node raw-bridge.mjs goto 123 https://example.com
 *   node raw-bridge.mjs eval 123 "document.title"
 *   node raw-bridge.mjs snapshot 123
 *   node raw-bridge.mjs cookies example.com
 *   node raw-bridge.mjs call Raw.proxyGet
 *
 * Every command prints JSON, so a caller can parse it instead of scraping
 * prose. Exit code is 0 on success and 1 on any failure.
 *
 * Note: `cookies` and `eval` return whatever the page holds, which can include
 * live session material. That is the point of the tool, but treat the output
 * as a secret when you redirect it anywhere.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG = path.join(os.homedir(), ".raw", "edge-bridge.json");
const TIMEOUT_MS = Number(process.env.RAW_BRIDGE_TIMEOUT_MS ?? 45_000);

function readConfig() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch {
    throw new Error(
      `no bridge config at ${CONFIG}. Install the extension bridge first (see scripts/install-edge-bridge.ps1).`,
    );
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error(`bridge config at ${CONFIG} has no token`);
  }
  return { token: parsed.token, port: Number(parsed.port) || 9333 };
}

const config = readConfig();
const base = `http://127.0.0.1:${config.port}`;
const authHeaders = { "X-Raw-Bridge-Token": config.token };

async function http(pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { ...authHeaders, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** open a CDP-over-WebSocket channel: /devtools/browser/... or /devtools/page/{id} */
function openSocket(kind, tabId) {
  const route = kind === "browser" ? "/devtools/browser/raw-edge" : `/devtools/page/${encodeURIComponent(tabId)}`;
  const url = `${base.replace("http", "ws")}${route}?token=${encodeURIComponent(config.token)}`;
  const socket = new WebSocket(url);
  let counter = 0;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error(`cannot reach the bridge on port ${config.port}`)));
  });

  const send = async (method, params = {}) => {
    await ready;
    const id = ++counter;
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });
  };

  return { send, close: () => socket.close(), ready };
}

async function callBrowser(method, params = {}) {
  const channel = openSocket("browser");
  try {
    return await channel.send(method, params);
  } finally {
    channel.close();
  }
}

async function callPage(tabId, method, params = {}) {
  const channel = openSocket("page", tabId);
  try {
    return await channel.send(method, params);
  } finally {
    channel.close();
  }
}

async function evaluate(tabId, expression, awaitPromise = true) {
  const result = await callPage(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed");
  }
  return result?.result?.value;
}

/** pick a tab: the given id, or the active one */
async function resolveTab(explicit) {
  if (explicit !== undefined && explicit !== "") return String(explicit);
  const targets = await http("/json/list");
  const active = targets.find((target) => target.active) ?? targets[0];
  if (!active) throw new Error("no open tab to work with");
  return String(active.id);
}

const commands = {
  async status() {
    const version = await http("/json/version");
    return {
      bridge: version.Browser,
      protocol: version["Protocol-Version"],
      extension: version["Raw-Extension-Version"],
      port: config.port,
    };
  },

  async tabs() {
    const targets = await http("/json/list");
    return targets.map((target) => ({
      id: target.id,
      title: target.title,
      url: target.url,
      active: target.active === true,
    }));
  },

  async new(url = "about:blank") {
    const target = await http(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    return { id: target.id, url: target.url };
  },

  async close(tabId) {
    const id = await resolveTab(tabId);
    // the extension host exposes tab lifecycle over HTTP, not as a Raw.* method
    await http(`/json/close/${encodeURIComponent(id)}`, { method: "PUT" });
    return { closed: id };
  },

  async goto(tabId, url) {
    const id = await resolveTab(tabId);
    await callPage(id, "Page.enable");
    await callPage(id, "Page.navigate", { url });
    return { tabId: id, url };
  },

  async eval(tabId, expression) {
    return await evaluate(await resolveTab(tabId), expression);
  },

  async title(tabId) {
    return await evaluate(await resolveTab(tabId), "document.title");
  },

  async url(tabId) {
    return await evaluate(await resolveTab(tabId), "location.href");
  },

  async text(tabId, selector) {
    const id = await resolveTab(tabId);
    return await evaluate(
      id,
      selector ? `document.querySelector(${JSON.stringify(selector)})?.innerText ?? null` : "document.body.innerText",
    );
  },

  /** a compact, numbered list of interactive elements plus page text */
  async snapshot(tabId) {
    const id = await resolveTab(tabId);
    return await evaluate(
      id,
      `(() => {
        const items = [];
        const seen = new Set();
        for (const el of document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]')) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.placeholder || '').trim().slice(0, 80);
          if (!label || seen.has(label)) continue;
          seen.add(label);
          items.push({ index: items.length, tag: el.tagName.toLowerCase(), label, x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
          if (items.length >= 200) break;
        }
        return { title: document.title, url: location.href, elements: items, text: (document.body.innerText || '').slice(0, 4000) };
      })()`,
    );
  },

  async click(tabId, selector) {
    const id = await resolveTab(tabId);
    const point = await evaluate(
      id,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    if (!point) throw new Error(`element not found: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await callPage(id, "Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    }
    return { clicked: selector, at: point };
  },

  async fill(tabId, selector, value) {
    const id = await resolveTab(tabId);
    const written = await evaluate(
      id,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        el.focus();
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value; })()`,
    );
    if (written === null) throw new Error(`element not found: ${selector}`);
    return { filled: selector, length: String(written).length };
  },

  async screenshot(tabId, target) {
    const id = await resolveTab(tabId);
    const result = await callPage(id, "Page.captureScreenshot", { format: "png", fromSurface: true });
    const file = path.resolve(target ?? `raw-shot-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, "base64"));
    return { saved: file, bytes: fs.statSync(file).size };
  },

  async cookies(_tabId, domain) {
    const details = domain ? { domain } : {};
    const list = await callBrowser("Raw.cookiesAll", { details });
    return list.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, expires: cookie.expirationDate }));
  },

  async proxy(_tabId, action, mode) {
    if (action === "set") return await callBrowser("Raw.proxySet", { value: { mode } });
    if (action === "clear") return await callBrowser("Raw.proxyClear", {});
    return await callBrowser("Raw.proxyGet", {});
  },

  async history(_tabId, text) {
    const items = await callBrowser("Raw.historySearch", { query: { text: text ?? "", maxResults: 50 } });
    return items.map((item) => ({ url: item.url, title: item.title, lastVisit: item.lastVisitTime, visits: item.visitCount }));
  },

  async bookmarks() {
    return await callBrowser("Raw.bookmarksList", {});
  },

  async extensions() {
    return await callBrowser("Raw.managementList", {});
  },

  async frames(tabId) {
    const id = await resolveTab(tabId);
    return await callBrowser("Raw.frames", { tabId: Number(id) });
  },

  async notify(_tabId, title, message) {
    return await callBrowser("Raw.notify", { title: title ?? "raw", message: message ?? "" });
  },

  /** escape hatch: any Raw.* or CDP method, with a JSON params argument */
  async call(_tabId, method, rawParams) {
    if (!method) throw new Error("call needs a method name");
    const params = rawParams ? JSON.parse(rawParams) : {};
    return await callBrowser(method, params);
  },
};

function usage() {
  console.log(`raw-bridge <command> [args]

  status                          bridge and extension version
  tabs                            list open tabs
  new [url]                       open a tab
  close [tabId]                   close a tab
  goto [tabId] <url>              navigate
  eval [tabId] <js>               run JavaScript in the page
  title | url [tabId]             page title or URL
  text [tabId] [selector]         read text
  snapshot [tabId]                numbered elements plus page text
  click [tabId] <selector>        click an element
  fill [tabId] <selector> <value> write into a field
  screenshot [tabId] [file.png]   save a PNG
  cookies [domain]                list cookies (values included)
  proxy [get|set <mode>|clear]    read or switch the proxy
  history [text]                  search browsing history
  bookmarks                       bookmark tree
  extensions                      installed extensions
  frames [tabId]                  iframes, cross-origin included
  notify <title> <message>        system notification
  call <method> [jsonParams]      any Raw.* or CDP method

Tab ids come from \`tabs\`; omit one to use the active tab.`);
}

const [command, ...args] = process.argv.slice(2);

// a leading numeric tabId is optional for the tab-scoped commands
const TAB_SCOPED = new Set(["goto", "eval", "title", "url", "text", "snapshot", "click", "fill", "screenshot", "cookies", "proxy", "history", "frames", "notify"]);

if (!command || command === "help" || command === "--help" || command === "-h") {
  usage();
  process.exit(command ? 0 : 1);
}

const handler = commands[command];
if (!handler) {
  console.error(`unknown command: ${command}\n`);
  usage();
  process.exit(1);
}

let argv = [...args];
let tabId;
if (TAB_SCOPED.has(command) && argv.length && /^\d+$/.test(argv[0])) {
  tabId = argv.shift();
}

try {
  const result = await handler(tabId, ...argv);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
