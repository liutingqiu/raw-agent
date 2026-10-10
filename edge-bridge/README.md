# Raw Edge Bridge

Raw Edge Bridge lets Raw drive ordinary tabs in the user's real Microsoft Edge
Default profile. Authentication remains inside Edge; the bridge does not copy,
decrypt, export, or log cookies.

## Components

- `extension/`: an unpacked Manifest V3 Edge extension. It uses
  `chrome.debugger` for page-level CDP and connects to the local native host.
- `host/`: a .NET native-messaging host. It exposes a token-protected CDP facade
  on `127.0.0.1:9333` for the existing Raw browser runtime.
- `scripts/install-edge-bridge.ps1`: builds a versioned host, generates a local
  random token, and registers the native host for the current Windows user.

The extension exposes tabs across Edge windows. Page-scoped CDP commands are
forwarded without a method allowlist, including Network and Storage commands.
Browser- and Target-domain commands are routed through extension APIs when a
tab-scoped `chrome.debugger` session cannot perform them directly. The user's
prompt and permission mode govern which actions an agent may take.

## Install

Run the installer:

```powershell
& .\scripts\install-edge-bridge.ps1
```

Open `edge://extensions`, enable Developer mode, choose **Load unpacked**, and
select `edge-bridge\extension`. The extension ID must be
`gfpadofoapicldopjkghnfbnbkljihmk`.

Load unpacked is the only install that survives an Edge restart. Both
`--load-extension=...` and the CDP `Extensions.loadUnpacked` call load the
extension for the current browser session only: the profile keeps no record of
it, so the next ordinary Edge launch has no bridge and port 9333 stays closed.
Loading it once through `edge://extensions` takes effect immediately, without a
restart, and every later launch picks it up.

Set `mode` to `edge-extension` in
`~/.raw/browser-profiles/current.json`. The installed `raw-browser.mjs` wrapper
then reads `~/.raw/edge-bridge.json`, authenticates to the local facade, and
uses the real Edge profile.

## Troubleshooting

A `fetch failed` from the bridge, or nothing listening on `127.0.0.1:9333`,
means the extension is not running in this Edge session. Check
`edge://extensions` for **Raw Edge Bridge**; if it is missing, load
`edge-bridge\extension` again. The same symptom appears if Edge is running a
different profile from the one the extension was loaded into.

The host process is started by the extension, not by the installer, and it
exits when the extension detaches. Only one host serves the port: a host that
is launched through native messaging retires older instances, and the extension
therefore keeps a single native port. If the port flaps between samples, look
for repeated `connect()` calls in `service-worker.js`; every extra port starts
another host that kills the previous one.

Ephemeral Raw Spaces remain unavailable because Edge extensions cannot create
an incognito browser context equivalent to CDP `Target.createBrowserContext`.
Closing a Raw session only detaches the debugger; it does not close Edge.

The bridge supports `/json/list`, `/json/new`, `/json/activate/{tabId}`, and
`/json/close/{tabId}` plus page and browser WebSocket endpoints. The browser
endpoint accepts general CDP methods, flattened Target sessions, and target
lifecycle events. Edge still decides whether a particular protocol command is
valid for privileged `edge://` pages, file URLs without extension file access,
and other protected targets.

## Rollback

Remove `mode: "edge-extension"` from `current.json` to return to the selected
dedicated profile. Disable or remove **Raw Edge Bridge** from
`edge://extensions` and remove the per-user registry key:

```text
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.raw.edge_bridge
```
