(function installRawEdgeBridgeCore(root) {
  const SESSION_PREFIX = "raw-edge-tab-";

  function tabIdFrom(value) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    const text = String(value ?? "");
    const normalized = text.startsWith(SESSION_PREFIX) ? text.slice(SESSION_PREFIX.length) : text;
    const tabId = Number(normalized);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`invalid Edge tab id: ${text}`);
    return tabId;
  }

  function sessionIdFor(tabId) {
    return `${SESSION_PREFIX}${tabIdFrom(tabId)}`;
  }

  function serializableTab(tab) {
    return {
      id: String(tab.id),
      title: tab.title ?? "",
      url: tab.url ?? tab.pendingUrl ?? "about:blank",
      active: tab.active === true,
      windowId: tab.windowId,
    };
  }

  function targetInfo(tab) {
    const value = serializableTab(tab);
    return {
      targetId: value.id,
      type: "page",
      title: value.title,
      url: value.url,
      attached: false,
      canAccessOpener: true,
      browserContextId: "",
    };
  }

  function windowBounds(win) {
    return {
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
      windowState: win.state ?? "normal",
    };
  }

  function createBridgeExecutor(chromeApi) {
    const attachedTabs = new Set();
    const attachingTabs = new Map();
    let discoverTargets = false;
    let autoAttachTargets = false;

    async function ensureAttached(value) {
      const tabId = tabIdFrom(value);
      if (attachedTabs.has(tabId)) return tabId;
      const pending = attachingTabs.get(tabId);
      if (pending) return pending;
      const attaching = (async () => {
        try {
          await chromeApi.debugger.attach({ tabId }, "1.3");
        } catch (error) {
          if (!String(error?.message ?? error).includes("already attached")) throw error;
        }
        attachedTabs.add(tabId);
        return tabId;
      })();
      attachingTabs.set(tabId, attaching);
      try {
        return await attaching;
      } finally {
        attachingTabs.delete(tabId);
      }
    }

    async function detach(value) {
      const tabId = tabIdFrom(value);
      if (attachedTabs.has(tabId)) await chromeApi.debugger.detach({ tabId });
      attachedTabs.delete(tabId);
    }

    async function listTabs() {
      return (await chromeApi.tabs.query({})).map(serializableTab);
    }

    async function tabFor(params = {}, required = true) {
      const raw = params.tabId ?? params.targetId ?? params.sessionId;
      if (raw !== undefined && raw !== null && raw !== "") return await chromeApi.tabs.get(tabIdFrom(raw));
      const [active] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
      const fallback = active ?? (await chromeApi.tabs.query({}))[0];
      if (!fallback && required) throw new Error("Edge has no tab target available for this CDP command");
      return fallback;
    }

    async function sendTabCommand(payload) {
      const tab = await tabFor(payload);
      const tabId = await ensureAttached(tab.id);
      return await chromeApi.debugger.sendCommand({ tabId }, payload.method, payload.params ?? {});
    }

    async function activate(value) {
      const tab = await chromeApi.tabs.get(tabIdFrom(value));
      await chromeApi.tabs.update(tab.id, { active: true });
      await chromeApi.windows.update(tab.windowId, { focused: true });
    }

    /** cookies carry a lot of noise; keep the fields a caller can act on */
    function cookieView(cookie) {
      if (!cookie) return null;
      return {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        session: cookie.session === true,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate,
        storeId: cookie.storeId,
      };
    }

    async function browserCommand(payload) {
      const method = String(payload.method ?? "");
      const params = payload.params ?? {};
      switch (method) {
        case "Target.getTargets": {
          const tabs = await chromeApi.tabs.query({});
          return { targetInfos: tabs.map((tab) => ({ ...targetInfo(tab), attached: attachedTabs.has(tab.id) })) };
        }
        case "Target.getTargetInfo": {
          const tab = await tabFor(params);
          return { targetInfo: { ...targetInfo(tab), attached: attachedTabs.has(tab.id) } };
        }
        case "Target.createTarget": {
          const tab = await chromeApi.tabs.create({ url: params.url || "about:blank", active: params.background !== true });
          return { targetId: String(tab.id) };
        }
        case "Target.closeTarget": {
          const tab = await tabFor(params);
          await chromeApi.tabs.remove(tab.id);
          attachedTabs.delete(tab.id);
          return { success: true };
        }
        case "Target.activateTarget": {
          const tab = await tabFor(params);
          await activate(tab.id);
          return {};
        }
        case "Target.attachToTarget": {
          const tab = await tabFor(params);
          await ensureAttached(tab.id);
          return { sessionId: sessionIdFor(tab.id) };
        }
        case "Target.detachFromTarget": {
          const tab = await tabFor(params);
          await detach(tab.id);
          return {};
        }
        case "Target.setDiscoverTargets":
          discoverTargets = params.discover === true;
          return {};
        case "Target.setAutoAttach":
          autoAttachTargets = params.autoAttach === true;
          return {};
        case "Target.setRemoteLocations":
          return {};
        case "Target.getBrowserContexts":
          return { browserContextIds: [] };
        case "Target.createBrowserContext":
          throw new Error("isolated browser contexts are unavailable in Edge extension mode");
        case "Target.disposeBrowserContext":
          return {};
        case "Browser.getVersion":
          return {
            protocolVersion: "1.3",
            product: `Microsoft Edge/${root.navigator?.userAgentData?.brands?.find((x) => /Edge/i.test(x.brand))?.version ?? "extension"}`,
            revision: "",
            userAgent: root.navigator?.userAgent ?? "",
            jsVersion: "",
          };
        case "Browser.getWindowForTarget": {
          const tab = await tabFor(params);
          const win = await chromeApi.windows.get(tab.windowId);
          return { windowId: win.id, bounds: windowBounds(win) };
        }
        case "Browser.getWindowBounds": {
          const win = await chromeApi.windows.get(Number(params.windowId));
          return { bounds: windowBounds(win) };
        }
        case "Browser.setWindowBounds": {
          const bounds = params.bounds ?? {};
          await chromeApi.windows.update(Number(params.windowId), {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            state: bounds.windowState,
          });
          return {};
        }
        case "Browser.setDownloadBehavior":
          return {};
        case "Browser.cancelDownload":
          await chromeApi.downloads.cancel(Number(params.guid));
          return {};
        case "Raw.restoreClosedTab": {
          const restored = await chromeApi.sessions.restore(params.sessionId);
          if (restored?.tab) return { tab: serializableTab(restored.tab) };
          if (restored?.window) {
            return {
              window: {
                id: restored.window.id,
                tabs: (restored.window.tabs ?? []).map(serializableTab),
              },
            };
          }
          return {};
        }
        /* ---------------------------------------------------------------- *
         * Extension-only capabilities.
         *
         * CDP has no equivalent for these: proxy configuration, browsing
         * data, history, bookmarks, extension management and system
         * notifications all sit above the debugging protocol. Ported from
         * reasonix-browser-bridge (MIT) so a single bridge covers both.
         * ---------------------------------------------------------------- */
        case "Raw.proxyGet": {
          const settings = await chromeApi.proxy.settings.get(params.incognito === true ? { incognito: true } : {});
          return { value: settings.value, levelOfControl: settings.levelOfControl };
        }
        case "Raw.proxySet": {
          const value = params.value;
          if (!value || typeof value !== "object" || typeof value.mode !== "string") {
            throw new Error(
              "Raw.proxySet needs a proxy value object, e.g. { mode: 'direct' } or { mode: 'fixed_servers', rules: { singleProxy: { host, port } } }",
            );
          }
          await chromeApi.proxy.settings.set({ value, scope: params.scope ?? "regular" });
          const applied = await chromeApi.proxy.settings.get({});
          return { ok: true, value: applied.value };
        }
        case "Raw.proxyClear": {
          await chromeApi.proxy.settings.clear({ scope: params.scope ?? "regular" });
          const applied = await chromeApi.proxy.settings.get({});
          return { ok: true, value: applied.value };
        }
        case "Raw.notify": {
          // notifications.create rejects a missing image, so resolve whatever
          // icon the manifest actually declares instead of a fixed path
          const declared = chromeApi.runtime.getManifest().icons ?? {};
          const icon = declared["128"] ?? declared["48"] ?? declared["32"] ?? declared["16"] ?? "icons/icon128.png";
          const id = await chromeApi.notifications.create({
            type: "basic",
            iconUrl: chromeApi.runtime.getURL(icon),
            title: String(params.title ?? "raw"),
            message: String(params.message ?? ""),
            silent: params.silent === true,
          });
          return { id };
        }
        case "Raw.historySearch": {
          const query = Object.assign({ text: "", maxResults: 100 }, params.query ?? {});
          const items = await chromeApi.history.search(query);
          return items.map((item) => ({
            url: item.url,
            title: item.title,
            lastVisitTime: item.lastVisitTime,
            visitCount: item.visitCount,
          }));
        }
        case "Raw.bookmarksList":
          return await chromeApi.bookmarks.getTree();
        case "Raw.managementList": {
          const items = await chromeApi.management.getAll();
          return items.map((item) => ({
            id: item.id,
            name: item.name,
            enabled: item.enabled,
            type: item.type,
            version: item.version,
            installType: item.installType,
          }));
        }
        case "Raw.clearBrowsingData": {
          const requested = params.dataTypes ?? {};
          const cleared = Object.keys(requested).filter((key) => requested[key] === true);
          // destructive: never remove anything the caller did not name
          if (cleared.length === 0) {
            throw new Error("Raw.clearBrowsingData requires at least one explicit dataTypes flag; it clears nothing by default");
          }
          const options = params.options ?? {};
          await chromeApi.browsingData.remove(options, requested);
          return { ok: true, cleared, options };
        }
        case "Raw.cookiesAll":
          return (await chromeApi.cookies.getAll(params.details ?? {})).map(cookieView);
        case "Raw.cookiesGet":
          return cookieView(await chromeApi.cookies.get(params.details ?? {}));
        case "Raw.cookiesSet": {
          const details = params.details ?? {};
          if (!details.url || !details.name) throw new Error("Raw.cookiesSet needs at least { url, name }");
          return cookieView(await chromeApi.cookies.set(details));
        }
        case "Raw.cookiesRemove": {
          const details = params.details ?? {};
          if (!details.url || !details.name) throw new Error("Raw.cookiesRemove needs { url, name }");
          return await chromeApi.cookies.remove(details);
        }
        case "Raw.updateTab": {
          const tab = await tabFor(params);
          const update = params.update ?? {};
          if (Object.keys(update).length === 0) {
            throw new Error("Raw.updateTab needs an update object, e.g. { pinned: true } or { muted: true }");
          }
          return serializableTab(await chromeApi.tabs.update(tab.id, update));
        }
        case "Raw.download": {
          const options = params.options ?? {};
          if (!options.url) throw new Error("Raw.download needs { url }");
          return { id: await chromeApi.downloads.download(options) };
        }
        case "Raw.cancelDownload": {
          if (params.id === undefined || params.id === null) throw new Error("Raw.cancelDownload needs a download id");
          await chromeApi.downloads.cancel(params.id);
          return { ok: true, id: params.id };
        }
        case "Raw.setExtensionEnabled": {
          if (!params.id) throw new Error("Raw.setExtensionEnabled needs an extension id");
          const enabled = params.enabled !== false;
          await chromeApi.management.setEnabled(params.id, enabled);
          return { ok: true, id: params.id, enabled };
        }
        case "Raw.frames": {
          const tab = await tabFor(params);
          const frames = await chromeApi.webNavigation.getAllFrames({ tabId: tab.id });
          return (frames ?? []).map((frame) => ({
            frameId: frame.frameId,
            parentFrameId: frame.parentFrameId,
            url: frame.url,
            errorOccurred: frame.errorOccurred === true,
          }));
        }
        case "Raw.insertCSS": {
          const tab = await tabFor(params);
          await chromeApi.scripting.insertCSS({
            target: { tabId: tab.id, allFrames: params.allFrames === true },
            css: String(params.css ?? ""),
          });
          return { ok: true, tabId: tab.id };
        }
        case "Raw.removeCSS": {
          const tab = await tabFor(params);
          await chromeApi.scripting.removeCSS({
            target: { tabId: tab.id, allFrames: params.allFrames === true },
            css: String(params.css ?? ""),
          });
          return { ok: true, tabId: tab.id };
        }
        case "Browser.close": {
          const windows = await chromeApi.windows.getAll({ windowTypes: ["normal"] });
          for (const win of windows) await chromeApi.windows.remove(win.id);
          return {};
        }
        default:
          // chrome.debugger exposes all protocol domains supported by the
          // attached Edge build. Forward without a technical allow/deny list;
          // the calling prompt remains the authority for permitted actions.
          return await sendTabCommand({ ...payload, params });
      }
    }

    async function execute(request) {
      const payload = request.payload ?? {};
      switch (request.op) {
        case "listTabs":
          return await listTabs();
        case "createTab":
          return serializableTab(await chromeApi.tabs.create({ url: payload.url || "about:blank", active: payload.active !== false }));
        case "closeTab":
          await chromeApi.tabs.remove(tabIdFrom(payload.tabId));
          attachedTabs.delete(tabIdFrom(payload.tabId));
          return {};
        case "activateTab":
          await activate(payload.tabId);
          return {};
        case "restoreClosedTab":
          return await browserCommand({ method: "Raw.restoreClosedTab", params: payload });
        case "detachTab":
          await detach(payload.tabId);
          return {};
        case "cdp":
          return await sendTabCommand(payload);
        case "browserCdp":
          return await browserCommand(payload);
        default:
          throw new Error(`unsupported bridge operation: ${request.op}`);
      }
    }

    return {
      execute,
      ensureAttached,
      noteDetached(value) {
        attachedTabs.delete(tabIdFrom(value));
      },
      isAttached(value) {
        return attachedTabs.has(tabIdFrom(value));
      },
      shouldEmitTargetEvents() {
        return discoverTargets;
      },
      shouldAutoAttach() {
        return autoAttachTargets;
      },
    };
  }

  root.RawEdgeBridgeCore = { createBridgeExecutor, serializableTab, sessionIdFor, tabIdFrom, targetInfo };
})(globalThis);
