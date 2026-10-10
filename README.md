# raw-agent (raw)

A dedicated, lightweight browser automation runtime and CLI designed for direct Chrome and Edge orchestration via the Chrome DevTools Protocol (CDP) and native extension bridges.

[![Node.js: >=22.21.0](https://img.shields.io/badge/Node.js-%3E%3D22.21.0-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests: 41 Passed](https://img.shields.io/badge/Tests-41%20Passed-success.svg)]()

---

## 1. What is raw-agent?

`raw-agent` (`raw`) is an unopinionated, high-performance browser automation engine. It bridges programmatic agent workloads with real user browsers (Chrome and Microsoft Edge), offering deep DOM manipulation, accessibility snapshotting, robust cookie/storage control, proxy routing, and real mouse/keyboard emulation.

## 2. Supported Scopes & Core Focus

- **Browser Automation Only**: Focused exclusively on browser driver execution. The legacy terminal TUI, provider API setups, and general-purpose chat loops have been completely removed from this repository to preserve a pure, robust automation core.
- **Dual Bridge Architecture**:
  - **Direct Chrome/Edge CDP**: Connects directly to Chromium instances launched with `--remote-debugging-port` (default `9333`).
  - **Edge Extension Bridge (`edge-bridge/`)**: Orchestrates the user's authentic desktop Microsoft Edge profile through a Native Messaging host and dedicated extension, avoiding clean-slate profile limitations.

---

## 3. Chrome / Edge Bridge Architecture

### How the Native Extension Bridge Works

```text
Node.js (raw CLI / Agent)
       │
       ▼ (CDP / WebSocket :9333)
Native Host (edge-bridge/host/Program.cs - stdio)
       │
       ▼ (Native Messaging protocol)
Edge MV3 Extension (edge-bridge/extension/)
       │
       ▼ (chrome.debugger + chrome.cookies + chrome.tabs APIs)
Live Browser Profile (Microsoft Edge)
```

1. **Host Application**: A lightweight native host binary (`RawEdgeBridge.exe`) communicates with the browser via standard I/O (Native Messaging).
2. **Edge Extension**: Uses `chrome.debugger` to attach to target pages, translating CDP methods while leveraging full extension permissions (`tabs`, `cookies`, `proxy`, `downloads`, `scripting`).
3. **Loopback Server**: The native host exposes a loopback server bound strictly to `127.0.0.1:9333`, allowing `raw` CLI scripts to attach seamlessly with authentication token verification.

---

## 4. Permissions & Trust Model

- **Localhost Boundary**: All WebSocket, CDP, and bridge listeners bind strictly to `127.0.0.1`. Remote network connections are rejected by default.
- **Full Browser Authority**: The bridge operates with full permissions (`<all_urls>`, debugger, proxy, downloads, cookies). It has the capability to inspect and mutate any loaded tab.
- **Untrusted Web Content**: Any DOM content, network responses, and text extracted from web pages are considered **untrusted external data**. Callers should sanitize selectors and avoid passing unvalidated page output directly into system command executors.

---

## 5. Security Boundaries & Safeguards

- **Input Sanitization**: `setValue` automatically inspects Monaco Editor, CodeMirror 5/6, and React-controlled components to drive updates through verified native setters rather than raw script injection.
- **Context Isolation (`space`)**: Independent sessions and ephemeral contexts (`--space <name>`) isolate cookies, caches, and storage across concurrent tasks.
- **Credential Protection**: Bridge credentials, token configs, and profile paths are isolated under user-local data directories (`~/.raw/`) and are strictly excluded from source control.

---

## 6. Installation & Building

### Prerequisites
- Node.js >= 22.21.0
- .NET 9.0 SDK (required only if rebuilding the optional native bridge host under `edge-bridge/host/`)
- Google Chrome or Microsoft Edge

### Setup & Build
```bash
git clone https://github.com/liutingqiu/raw-agent.git
cd raw-agent

npm install
npm run typecheck
npm run build
```

---

## 7. CLI Usage

### Check Runtime Status
```bash
node dist/browser-cli.js status
# or if installed globally / linked
raw status
```

### Run Browser Automation Scripts
Execute inline JavaScript expressions:
```bash
raw run -e "console.log(await page.title())"
```

Pipe script pipelines via stdin:
```powershell
@'
await page.goto('https://example.com');
const snapshot = await page.snapshot({ scope: 'viewport' });
console.log(snapshot);
'@ | raw run
```

### Common CLI Flags
- `--headless`: Run browser without GUI.
- `--space <name>`: Run in an isolated session context.
- `--port <N>`: CDP port (default: `9333`).
- `--profile <path>`: Specify browser profile directory.
- `--timeout-ms <N>`: Script timeout in milliseconds.
- `--downloads <path>`: Designate custom download location.

---

## 8. Testing Commands

Run full verification suite (Typecheck, Unit tests, Build, and Browser Smoke Tests):
```bash
# 1. Typecheck
npm run typecheck

# 2. Run unit test suite (41 tests)
npm test

# 3. Build bundle
npm run build

# 4. Run browser smoke tests
node scripts/smoke-browser.mjs

# Or run comprehensive check
npm run check
```

---

## 9. Known Limitations

1. **Platform Support for Extension Bridge**: While standard CDP mode runs cross-platform (Windows, Linux, macOS), the automated Native Messaging registry installer is currently optimized for Windows PowerShell (`scripts/install-edge-bridge.ps1`).
2. **Single Debugger Attachment**: Chrome and Edge allow only one CDP debugger client attached to a specific tab at any given time. Attempting to attach secondary debuggers concurrently will yield detachment events.
3. **Browser Updates**: Major Chromium updates may occasionally invalidate native CDP internal signatures or permission prompts.

---

## License

Licensed under the [MIT License](LICENSE).
