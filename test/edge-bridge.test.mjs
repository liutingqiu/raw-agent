import "./_setup.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const repo = path.resolve(import.meta.dirname, "..");
const extensionDir = path.join(repo, "edge-bridge", "extension");
const coreSource = fs.readFileSync(path.join(extensionDir, "bridge-core.js"), "utf8");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadCore() {
  const context = vm.createContext({
    navigator: { userAgent: "Mock Edge", userAgentData: { brands: [{ brand: "Microsoft Edge", version: "140" }] } },
  });
  vm.runInContext(coreSource, context, { filename: "bridge-core.js" });
  return context.RawEdgeBridgeCore;
}

function createChromeMock(initialTabs = []) {
  let tabs = initialTabs.map((tab) => ({ ...tab }));
  const calls = {
    attach: [], detach: [], sendCommand: [], remove: [], tabUpdate: [], windowUpdate: [], windowRemove: [], cancel: [],
    proxyGet: [], proxySet: [], proxyClear: [], notify: [], historySearch: [], browsingRemove: [], insertCSS: [], removeCSS: [],
    cookiesGetAll: [], cookiesGet: [], cookiesSet: [], cookiesRemove: [], downloadStart: [], setEnabled: [], frames: [],
  };
  let proxyValue = { mode: "system" };
  let nextTabId = Math.max(0, ...tabs.map((tab) => tab.id)) + 1;
  const windows = new Map(tabs.map((tab) => [tab.windowId, {
    id: tab.windowId,
    left: 10,
    top: 20,
    width: 1200,
    height: 800,
    state: "normal",
  }]));

  const chrome = {
    tabs: {
      async query(query) {
        if (query.active) return tabs.filter((tab) => tab.active);
        return tabs.map((tab) => ({ ...tab }));
      },
      async get(tabId) {
        const tab = tabs.find((item) => item.id === Number(tabId));
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return { ...tab };
      },
      async create(options) {
        const tab = {
          id: nextTabId++,
          title: "",
          url: options.url ?? "about:blank",
          active: options.active !== false,
          windowId: 1,
        };
        if (tab.active) tabs = tabs.map((item) => ({ ...item, active: false }));
        tabs.push(tab);
        windows.set(1, windows.get(1) ?? { id: 1, state: "normal" });
        return { ...tab };
      },
      async remove(tabId) {
        calls.remove.push(Number(tabId));
        tabs = tabs.filter((item) => item.id !== Number(tabId));
      },
      async update(tabId, options) {
        calls.tabUpdate.push([Number(tabId), plain(options)]);
        if (options.active) tabs = tabs.map((item) => ({ ...item, active: item.id === Number(tabId) }));
        return chrome.tabs.get(tabId);
      },
    },
    windows: {
      async get(windowId) {
        return { ...windows.get(Number(windowId)) };
      },
      async getAll() {
        return [...windows.values()].map((win) => ({ ...win }));
      },
      async update(windowId, options) {
        calls.windowUpdate.push([Number(windowId), plain(options)]);
        windows.set(Number(windowId), { ...windows.get(Number(windowId)), ...options });
        return windows.get(Number(windowId));
      },
      async remove(windowId) {
        calls.windowRemove.push(Number(windowId));
        windows.delete(Number(windowId));
      },
    },
    debugger: {
      async attach(target, version) {
        calls.attach.push([plain(target), version]);
      },
      async detach(target) {
        calls.detach.push(plain(target));
      },
      async sendCommand(target, method, params) {
        calls.sendCommand.push([plain(target), method, plain(params)]);
        return { forwarded: method, params: plain(params) };
      },
    },
    downloads: {
      async download(options) {
        calls.downloadStart.push(plain(options));
        return 77;
      },
      async cancel(id) {
        calls.cancel.push(id);
      },
    },
    sessions: {
      async restore(sessionId) {
        calls.restore = sessionId ?? null;
        const tab = { id: nextTabId++, title: "Restored", url: "about:blank", active: true, windowId: 1 };
        tabs.push(tab);
        return { tab: { ...tab } };
      },
    },
    runtime: {
      getURL(assetPath) {
        return `chrome-extension://mock/${assetPath}`;
      },
      getManifest() {
        return { version: "0.3.0", icons: { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" } };
      },
    },
    proxy: {
      settings: {
        async get(details) {
          calls.proxyGet.push(plain(details ?? {}));
          return { value: { ...proxyValue }, levelOfControl: "controlled_by_this_extension" };
        },
        async set(request) {
          calls.proxySet.push(plain(request));
          proxyValue = request.value;
        },
        async clear(request) {
          calls.proxyClear.push(plain(request));
          proxyValue = { mode: "system" };
        },
      },
    },
    notifications: {
      async create(options) {
        calls.notify.push(plain(options));
        return "notification-1";
      },
    },
    history: {
      async search(query) {
        calls.historySearch.push(plain(query));
        return [{ url: "https://history.test/", title: "Visited", lastVisitTime: 1000, visitCount: 3 }];
      },
    },
    bookmarks: {
      async getTree() {
        return [{ id: "0", title: "", children: [{ id: "1", title: "Bookmark", url: "https://bookmark.test/" }] }];
      },
    },
    management: {
      async getAll() {
        return [{ id: "ext-1", name: "Raw Edge Bridge", enabled: true, type: "extension", version: "0.2.0", installType: "development" }];
      },
      async setEnabled(id, enabled) {
        calls.setEnabled.push([id, enabled]);
      },
    },
    cookies: {
      async getAll(details) {
        calls.cookiesGetAll.push(plain(details ?? {}));
        return [{ name: "session", value: "abc", domain: "example.test", path: "/", secure: true, httpOnly: true, session: false, sameSite: "lax", expirationDate: 1234, storeId: "0", hostOnly: true }];
      },
      async get(details) {
        calls.cookiesGet.push(plain(details));
        return { name: details.name, value: "abc", domain: "example.test", path: "/" };
      },
      async set(details) {
        calls.cookiesSet.push(plain(details));
        return { name: details.name, value: details.value, domain: details.domain ?? "example.test", path: "/" };
      },
      async remove(details) {
        calls.cookiesRemove.push(plain(details));
        return { url: details.url, name: details.name };
      },
    },
    webNavigation: {
      async getAllFrames(query) {
        calls.frames.push(plain(query));
        return [
          { frameId: 0, parentFrameId: -1, url: "https://top.test/", errorOccurred: false },
          { frameId: 3, parentFrameId: 0, url: "https://embed.test/", errorOccurred: false },
        ];
      },
    },
    browsingData: {
      async remove(options, dataTypes) {
        calls.browsingRemove.push([plain(options ?? {}), plain(dataTypes ?? {})]);
      },
    },
    scripting: {
      async insertCSS(injection) {
        calls.insertCSS.push(plain(injection));
      },
      async removeCSS(injection) {
        calls.removeCSS.push(plain(injection));
      },
    },
  };
  return { chrome, calls, tabs: () => tabs.map((tab) => ({ ...tab })) };
}

const fixtures = [
  { id: 11, title: "HTTP", url: "https://example.test/", active: true, windowId: 1 },
  { id: 12, title: "File", url: "file:///C:/fixture.html", active: false, windowId: 1 },
  { id: 21, title: "Blank", url: "about:blank", active: false, windowId: 2 },
  { id: 22, title: "Data", url: "data:text/html,fixture", active: false, windowId: 2 },
  { id: 23, title: "Edge", url: "edge://version/", active: false, windowId: 2 },
];

test("Edge bridge enumerates tabs across windows without URL-scheme filtering", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const tabs = plain(await createBridgeExecutor(mock.chrome).execute({ op: "listTabs" }));
  assert.deepEqual(tabs.map((tab) => tab.id), ["11", "12", "21", "22", "23"]);
  assert.deepEqual(new Set(tabs.map((tab) => tab.windowId)), new Set([1, 2]));
  assert.ok(tabs.some((tab) => tab.url.startsWith("edge://")));
  assert.ok(tabs.some((tab) => tab.url.startsWith("data:")));
});

test("page CDP forwards every tested domain, including cookie and upload methods", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);
  const methods = [
    ["Page.captureScreenshot", { format: "png" }],
    ["Network.enable", {}],
    ["Network.getCookies", { urls: ["https://example.test/"] }],
    ["Storage.getCookies", {}],
    ["Runtime.evaluate", { expression: "1 + 1" }],
    ["DOM.setFileInputFiles", { files: ["C:/fixture.txt"], backendNodeId: 1 }],
    ["Fetch.enable", { patterns: [] }],
  ];
  for (const [method, params] of methods) {
    const result = await bridge.execute({ op: "cdp", payload: { tabId: 11, method, params } });
    assert.equal(result.forwarded, method);
  }
  assert.deepEqual(mock.calls.sendCommand.map((call) => call[1]), methods.map((item) => item[0]));
  assert.equal(mock.calls.attach.length, 1, "one tab debugger attachment is reused across domains");
});

test("unknown browser-level methods are forwarded instead of denied", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const result = await createBridgeExecutor(mock.chrome).execute({
    op: "browserCdp",
    payload: { method: "Browser.getHistograms", params: { query: "Memory" }, targetId: "11" },
  });
  assert.equal(result.forwarded, "Browser.getHistograms");
  assert.deepEqual(mock.calls.sendCommand[0], [{ tabId: 11 }, "Browser.getHistograms", { query: "Memory" }]);
});

test("Target lifecycle maps create, attach, activate, close, and detach to extension APIs", async () => {
  const { createBridgeExecutor, sessionIdFor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);
  await bridge.execute({ op: "browserCdp", payload: { method: "Target.setDiscoverTargets", params: { discover: true } } });
  await bridge.execute({ op: "browserCdp", payload: { method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } } });
  assert.equal(bridge.shouldEmitTargetEvents(), true);
  assert.equal(bridge.shouldAutoAttach(), true);
  const created = await bridge.execute({ op: "browserCdp", payload: { method: "Target.createTarget", params: { url: "about:blank", background: true } } });
  const targetId = created.targetId;
  assert.equal(mock.tabs().find((tab) => String(tab.id) === targetId).active, false);
  const attached = await bridge.execute({ op: "browserCdp", payload: { method: "Target.attachToTarget", params: { targetId, flatten: true } } });
  assert.equal(attached.sessionId, sessionIdFor(targetId));
  await bridge.execute({ op: "browserCdp", payload: { method: "Target.activateTarget", params: { targetId } } });
  assert.equal(mock.tabs().find((tab) => String(tab.id) === targetId).active, true);
  await bridge.execute({ op: "browserCdp", payload: { method: "Target.detachFromTarget", params: { sessionId: attached.sessionId } } });
  assert.equal(mock.calls.detach.length, 1);
  assert.deepEqual(plain(await bridge.execute({ op: "browserCdp", payload: { method: "Target.closeTarget", params: { targetId } } })), { success: true });
  assert.ok(!mock.tabs().some((tab) => String(tab.id) === targetId));
});

test("concurrent commands share one in-flight debugger attachment", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  let release;
  mock.chrome.debugger.attach = async (target, version) => {
    mock.calls.attach.push([plain(target), version]);
    await new Promise((resolve) => { release = resolve; });
  };
  const bridge = createBridgeExecutor(mock.chrome);
  const first = bridge.execute({ op: "cdp", payload: { tabId: 11, method: "Page.enable" } });
  const second = bridge.execute({ op: "cdp", payload: { tabId: 11, method: "Network.enable" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mock.calls.attach.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(mock.calls.sendCommand.length, 2);
});

test("failed debugger attachment propagates and a later command can retry", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  let attempts = 0;
  mock.chrome.debugger.attach = async () => {
    attempts++;
    if (attempts === 1) throw new Error("attach denied by test fixture");
  };
  const bridge = createBridgeExecutor(mock.chrome);
  await assert.rejects(bridge.execute({ op: "cdp", payload: { tabId: 11, method: "Page.enable" } }), /attach denied/);
  await bridge.execute({ op: "cdp", payload: { tabId: 11, method: "Page.enable" } });
  assert.equal(attempts, 2);
});

test("Browser window and download methods use extension APIs", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);
  const current = plain(await bridge.execute({ op: "browserCdp", payload: { method: "Browser.getWindowForTarget", params: { targetId: "21" } } }));
  assert.equal(current.windowId, 2);
  await bridge.execute({ op: "browserCdp", payload: { method: "Browser.setWindowBounds", params: { windowId: 2, bounds: { width: 900, height: 700 } } } });
  await bridge.execute({ op: "browserCdp", payload: { method: "Browser.cancelDownload", params: { guid: "42" } } });
  assert.deepEqual(mock.calls.cancel, [42]);
  assert.equal(mock.calls.windowUpdate[0][0], 2);
});

test("restoreClosedTab uses the sessions API and returns a serializable tab", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const restored = plain(await createBridgeExecutor(mock.chrome).execute({ op: "restoreClosedTab", payload: {} }));
  assert.equal(mock.calls.restore, null);
  assert.equal(restored.tab.url, "about:blank");
  assert.equal(typeof restored.tab.id, "string");
});

test("bridge source has generic host routing, endpoint authentication, and no credential denylist", () => {
  const serviceWorker = fs.readFileSync(path.join(extensionDir, "service-worker.js"), "utf8");
  const host = fs.readFileSync(path.join(repo, "edge-bridge", "host", "Program.cs"), "utf8");
  const browser = fs.readFileSync(path.join(repo, "src", "browser.ts"), "utf8");
  const gitignore = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.doesNotMatch(serviceWorker + coreSource, /BLOCKED_CDP_METHODS|blocks credential-bearing/);
  assert.match(host, /BrowserRequestAsync\(method/);
  assert.match(host, /unsupported bridge operation: browserCdp/);
  assert.match(host, /method\.StartsWith\("Target\."/);
  assert.match(host, /method\.StartsWith\("Browser\."/);
  assert.match(browser, /async waitForPopup\(action:/);
  assert.match(browser, /!before\.has\(target\.id\)/);
  assert.match(browser, /!this\.knownTargetIds\.has\(t\.id\)/);
  for (const endpoint of ["/json/version", "/json/list", "/json/new", "/json/close/{tabId}", "/json/activate/{tabId}", "/json/restore"]) {
    const body = host.slice(host.indexOf(endpoint), host.indexOf("});", host.indexOf(endpoint)));
    assert.match(body, /Authorized\(context\)/, `${endpoint} must require the bridge token`);
  }
  assert.match(gitignore, /edge-bridge\/extension\.pem/);
  assert.match(gitignore, /edge-bridge\/extension\.crx/);
});

/* ------------------- extension-only capabilities ------------------- */

test("proxy settings round-trip through the extension API", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  const initial = plain(await bridge.execute({ op: "browserCdp", payload: { method: "Raw.proxyGet", params: {} } }));
  assert.equal(initial.value.mode, "system");
  assert.equal(initial.levelOfControl, "controlled_by_this_extension");

  await bridge.execute({
    op: "browserCdp",
    payload: {
      method: "Raw.proxySet",
      params: { value: { mode: "fixed_servers", rules: { singleProxy: { host: "127.0.0.1", port: 8080 } } } },
    },
  });
  assert.equal(mock.calls.proxySet[0].scope, "regular");

  const afterSet = plain(await bridge.execute({ op: "browserCdp", payload: { method: "Raw.proxyGet", params: {} } }));
  assert.equal(afterSet.value.mode, "fixed_servers");

  await bridge.execute({ op: "browserCdp", payload: { method: "Raw.proxyClear", params: {} } });
  const afterClear = plain(await bridge.execute({ op: "browserCdp", payload: { method: "Raw.proxyGet", params: {} } }));
  assert.equal(afterClear.value.mode, "system");
});

test("Raw.proxySet rejects a value that is not a proxy configuration", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  await assert.rejects(
    () => bridge.execute({ op: "browserCdp", payload: { method: "Raw.proxySet", params: { value: "direct" } } }),
    /needs a proxy value object/,
  );
  assert.equal(mock.calls.proxySet.length, 0, "a malformed value must never reach the browser");
});

test("Raw.clearBrowsingData refuses to clear anything the caller did not name", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  await assert.rejects(
    () => bridge.execute({ op: "browserCdp", payload: { method: "Raw.clearBrowsingData", params: {} } }),
    /at least one explicit dataTypes flag/,
  );
  await assert.rejects(
    () =>
      bridge.execute({
        op: "browserCdp",
        payload: { method: "Raw.clearBrowsingData", params: { dataTypes: { cache: false, cookies: false } } },
      }),
    /at least one explicit dataTypes flag/,
  );
  assert.equal(mock.calls.browsingRemove.length, 0, "nothing may be removed without an explicit true flag");

  const result = plain(
    await bridge.execute({
      op: "browserCdp",
      payload: {
        method: "Raw.clearBrowsingData",
        params: { dataTypes: { cache: true, cookies: false }, options: { since: 1000 } },
      },
    }),
  );
  assert.deepEqual(result.cleared, ["cache"]);
  assert.deepEqual(mock.calls.browsingRemove[0][1], { cache: true, cookies: false });
});

test("history, bookmarks, management and notifications expose the extension surfaces", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  const history = plain(
    await bridge.execute({
      op: "browserCdp",
      payload: { method: "Raw.historySearch", params: { query: { text: "test", maxResults: 5 } } },
    }),
  );
  assert.deepEqual(history, [{ url: "https://history.test/", title: "Visited", lastVisitTime: 1000, visitCount: 3 }]);
  assert.deepEqual(mock.calls.historySearch[0], { text: "test", maxResults: 5 });

  const defaults = plain(await bridge.execute({ op: "browserCdp", payload: { method: "Raw.historySearch", params: {} } }));
  assert.equal(defaults.length, 1);
  assert.deepEqual(mock.calls.historySearch[1], { text: "", maxResults: 100 });

  const bookmarks = plain(await bridge.execute({ op: "browserCdp", payload: { method: "Raw.bookmarksList", params: {} } }));
  assert.equal(bookmarks[0].children[0].url, "https://bookmark.test/");

  const extensions = plain(await bridge.execute({ op: "browserCdp", payload: { method: "Raw.managementList", params: {} } }));
  assert.deepEqual(extensions[0], {
    id: "ext-1",
    name: "Raw Edge Bridge",
    enabled: true,
    type: "extension",
    version: "0.2.0",
    installType: "development",
  });

  const notified = plain(
    await bridge.execute({ op: "browserCdp", payload: { method: "Raw.notify", params: { title: "done", message: "task finished" } } }),
  );
  assert.equal(notified.id, "notification-1");
  assert.equal(mock.calls.notify[0].title, "done");
  assert.match(mock.calls.notify[0].iconUrl, /icons\/icon128\.png$/);
});

test("Raw.insertCSS and Raw.removeCSS target the requested tab", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  await bridge.execute({
    op: "browserCdp",
    payload: { method: "Raw.insertCSS", params: { tabId: "11", css: "body{display:none}" } },
  });
  assert.deepEqual(mock.calls.insertCSS[0], { target: { tabId: 11, allFrames: false }, css: "body{display:none}" });

  await bridge.execute({
    op: "browserCdp",
    payload: { method: "Raw.removeCSS", params: { tabId: "11", css: "body{display:none}", allFrames: true } },
  });
  assert.deepEqual(mock.calls.removeCSS[0], { target: { tabId: 11, allFrames: true }, css: "body{display:none}" });
});

test("the extension manifest declares every permission the new surfaces need", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  const required = ["activeTab", "bookmarks", "browsingData", "cookies", "history", "management", "notifications", "proxy", "scripting", "webNavigation"];
  for (const permission of required) {
    assert.ok(manifest.permissions.includes(permission), `manifest must declare "${permission}"`);
  }
  assert.ok(manifest.host_permissions.includes("<all_urls>"), "cookies and scripting need a host permission to act on any site");
});

test("the extension ships the icons a notification requires", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  assert.ok(manifest.icons?.["128"], "chrome.notifications rejects create() without a usable icon");
  for (const [size, relative] of Object.entries(manifest.icons)) {
    const file = path.join(extensionDir, relative);
    assert.ok(fs.existsSync(file), `icons[${size}] points at ${relative}, which does not exist`);
    const signature = [...fs.readFileSync(file).subarray(0, 4)];
    assert.deepEqual(signature, [0x89, 0x50, 0x4e, 0x47], `${relative} is not a PNG`);
  }
});

test("Raw.notify resolves the icon the manifest declares", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  await bridge.execute({ op: "browserCdp", payload: { method: "Raw.notify", params: { title: "t", message: "m" } } });

  assert.equal(mock.calls.notify[0].iconUrl, "chrome-extension://mock/icons/icon128.png");
  assert.match(mock.calls.notify[0].iconUrl, /^chrome-extension:\/\//, "the icon must be an extension URL");
});

/* ------------------------- profile surfaces ------------------------- */

test("cookies read, write and delete through the extension API", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  const all = plain(
    await bridge.execute({
      op: "browserCdp",
      payload: { method: "Raw.cookiesAll", params: { details: { domain: "example.test" } } },
    }),
  );
  assert.equal(all[0].name, "session");
  assert.equal(all[0].httpOnly, true);
  assert.equal(all[0].hostOnly, undefined, "only actionable fields should cross the bridge");
  assert.deepEqual(mock.calls.cookiesGetAll[0], { domain: "example.test" });

  const one = plain(
    await bridge.execute({
      op: "browserCdp",
      payload: { method: "Raw.cookiesGet", params: { details: { url: "https://example.test/", name: "session" } } },
    }),
  );
  assert.equal(one.value, "abc");

  const written = plain(
    await bridge.execute({
      op: "browserCdp",
      payload: { method: "Raw.cookiesSet", params: { details: { url: "https://example.test/", name: "token", value: "xyz" } } },
    }),
  );
  assert.equal(written.name, "token");

  const removed = plain(
    await bridge.execute({
      op: "browserCdp",
      payload: { method: "Raw.cookiesRemove", params: { details: { url: "https://example.test/", name: "token" } } },
    }),
  );
  assert.equal(removed.name, "token");
});

test("cookie writes require a url and a name", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  await assert.rejects(
    () => bridge.execute({ op: "browserCdp", payload: { method: "Raw.cookiesSet", params: { details: { name: "token" } } } }),
    /needs at least \{ url, name \}/,
  );
  await assert.rejects(
    () =>
      bridge.execute({
        op: "browserCdp",
        payload: { method: "Raw.cookiesRemove", params: { details: { url: "https://x.test/" } } },
      }),
    /needs \{ url, name \}/,
  );
  assert.equal(mock.calls.cookiesSet.length, 0, "a malformed write must never reach the browser");
  assert.equal(mock.calls.cookiesRemove.length, 0);
});

test("tab properties, downloads and extension toggles route to their APIs", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  const pinned = plain(
    await bridge.execute({ op: "browserCdp", payload: { method: "Raw.updateTab", params: { tabId: "11", update: { pinned: true } } } }),
  );
  assert.equal(pinned.id, "11");
  assert.deepEqual(mock.calls.tabUpdate[0], [11, { pinned: true }]);

  await assert.rejects(
    () => bridge.execute({ op: "browserCdp", payload: { method: "Raw.updateTab", params: { tabId: "11", update: {} } } }),
    /needs an update object/,
  );

  const started = plain(
    await bridge.execute({ op: "browserCdp", payload: { method: "Raw.download", params: { options: { url: "https://x.test/f.zip" } } } }),
  );
  assert.equal(started.id, 77);
  assert.deepEqual(mock.calls.downloadStart[0], { url: "https://x.test/f.zip" });

  await assert.rejects(
    () => bridge.execute({ op: "browserCdp", payload: { method: "Raw.download", params: { options: {} } } }),
    /needs \{ url \}/,
  );

  await bridge.execute({ op: "browserCdp", payload: { method: "Raw.cancelDownload", params: { id: 77 } } });
  assert.deepEqual(mock.calls.cancel, [77]);

  const toggled = plain(
    await bridge.execute({
      op: "browserCdp",
      payload: { method: "Raw.setExtensionEnabled", params: { id: "ext-1", enabled: false } },
    }),
  );
  assert.deepEqual(toggled, { ok: true, id: "ext-1", enabled: false });
  assert.deepEqual(mock.calls.setEnabled[0], ["ext-1", false]);
});

test("Raw.frames lists every frame in a tab, cross-origin ones included", async () => {
  const { createBridgeExecutor } = loadCore();
  const mock = createChromeMock(fixtures);
  const bridge = createBridgeExecutor(mock.chrome);

  const frames = plain(await bridge.execute({ op: "browserCdp", payload: { method: "Raw.frames", params: { tabId: "11" } } }));
  assert.deepEqual(frames, [
    { frameId: 0, parentFrameId: -1, url: "https://top.test/", errorOccurred: false },
    { frameId: 3, parentFrameId: 0, url: "https://embed.test/", errorOccurred: false },
  ]);
  assert.deepEqual(mock.calls.frames[0], { tabId: 11 });
});
