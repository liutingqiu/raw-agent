# Changelog

All notable changes to `raw` are documented here. The format follows Keep a Changelog and versions
follow Semantic Versioning.

## [Unreleased]

### Added

- Prompts can be supplied through piped stdin, including multiline input.
- An F2 `/settings` panel provides clickable and keyboard-accessible controls for context, permission, reasoning effort, and reasoning display.
- `page.setValue()` writes into Monaco, CodeMirror 5/6, contenteditable and React-controlled fields, and reports which strategy actually ran; `fill()` routes through it, so code nodes and canvases stop silently dropping text.
- `page.waitForMutation()` waits on an in-page MutationObserver rather than a polling loop, and `page.waitForResponse()` resolves on a matching network response with optional resource-type and status filters.
- `dragAndDrop()` accepts raw `{x, y}` viewport coordinates alongside selectors and takes `steps`, `delay`, modifier keys and `dropDelay`; `page.mouseMove/mouseDown/mouseUp` expose the individual pointer steps.
- `scripts/verify-browser-input.mjs` verifies the input layer against a real browser on an isolated throwaway profile, and reaps the instance it started.
- Extension bridge surfaces that CDP cannot reach, ported from `reasonix-browser-bridge` (MIT): `page.proxy()` / `setProxy()` / `clearProxy()` for the network identity, `page.notify()` for system notifications, `page.history()` / `bookmarks()` / `extensions()` for profile reads, `page.insertCSS()` / `removeCSS()` for hiding page clutter, and `page.clearBrowsingData()`. The Edge extension declares the matching `bookmarks`, `browsingData`, `history`, `management`, `notifications`, `proxy` and `scripting` permissions; reloading it once in `edge://extensions` is required.
- Cookie control (`page.cookies()` / `cookie()` / `setCookie()` / `removeCookie()`), tab properties (`page.updateTab()`), the browser's own downloader (`page.download()` / `cancelDownload()`), extension toggles (`page.setExtensionEnabled()`) and iframe enumeration including cross-origin frames (`page.frames()`).
- Extension icons, without which `chrome.notifications` refuses to create anything and `page.notify()` could never have worked; `Raw.notify` now resolves whatever icon the manifest declares instead of a fixed path.
- `scripts/raw-bridge.mjs`, a dependency-free client for the bridge so any session, script or human can drive the user's own browser without starting an agent run. It covers tabs, navigation, evaluation, snapshots, clicking, filling, screenshots, cookies, proxy, history, bookmarks, extensions, iframes and notifications, plus a `call` escape hatch for any `Raw.*` or CDP method. Everything prints JSON and exits non-zero on failure.

### Fixed

- Mouse tracking is scoped to the settings panel so normal terminal selection and copying remain available.
- Slash-command menus now execute the highlighted command with one Enter; Up and Down selection is covered end to end.
- Context windows can be set per command, CLI invocation, environment, setup profile, or resumed session instead of relying on fallback constants.
- Terminal editing now treats emoji, combining marks, and wrapped rows as complete visual units.
- Modified Enter, Tab, Backspace, and arrow keys are decoded consistently across xterm and Kitty keyboard protocols.
- Narrow and short terminals keep prompts, completion menus, status lines, and permission questions inside the viewport.
- Slash commands retain existing image attachments, quoted image paths work, and invalid images remain visible as file references.
- Input can no longer mutate or submit the editor while a turn is streaming.
- Escape and Ctrl+C now cancel model retries and long-running shell, browser, and web tools without wedging the session.
- Timed prompts clear their state, cancelled browser handoffs are reported accurately, and terminal modes restore only once on exit.
- Setup menus accept exact item names, and already-ended non-interactive stdin no longer hangs setup.
- Extension bridge mode dialled the default 9222 debug port instead of the bridge's own 9333, so it failed or attached to the wrong browser unless `RAW_BROWSER_PORT` was set by hand; the token and port are now read from `~/.raw/edge-bridge.json`, making `RAW_BROWSER_EXTERNAL_BRIDGE=1` sufficient on its own.
- A page holding a single Monaco instance swallowed every `setValue` call, including writes aimed at plain inputs and contenteditable regions that had nothing to do with the editor. The single-editor fallback now requires the target to be part of an editor.
- The `browser` tool advertised `page.mouse.click/down/up/wheel`, none of which existed on `PageHandle`; the description now matches the real surface.
- `Raw.insertCSS` and every cookie call silently required a host permission the extension never declared, so they would have failed at runtime. The manifest now lists `<all_urls>` plus the `activeTab`, `cookies` and `webNavigation` permissions those surfaces need.
- Reloading the extension left the previous bridge host still holding port 9333, so the replacement could not bind while the old one had no extension attached any more — every request then timed out with no visible cause. A browser-launched host now retires earlier instances before binding; running the executable by hand still leaves a working bridge alone.

## [0.4.0] - 2026-09-12

### Added

- OpenAI Responses and Anthropic Messages adapters with native reasoning-state replay.
- Image input from file paths and the clipboard across all three provider protocols.
- Standing goals, context inspection, manual compaction, permission modes, and durable notes.
- Chrome/Edge automation with same-origin iframe locators, isolated spaces, downloads, and screenshots.
- A worker-isolated browser script runtime whose timeout can terminate CPU-bound scripts.

### Fixed

- Concurrent builds now publish a complete `dist` directory instead of racing over partial files.
- File writes and edits replace their targets atomically, and large overwritten files are not loaded solely for diffs.
- Web fetches now enforce output and response-size limits and honor `maxChars`.
- Context pruning keeps tool exchanges intact and retries image-rejecting models without stale payloads.
- Oversized current tool turns are shortened without breaking their protocol structure.
- Workspace file boundaries reject symlink escapes.
- Config and session writes are atomic, and corrupt config/session files are reported.
- CLI and setup arguments fail clearly instead of silently accepting invalid values.
- Interactive API keys no longer echo; malformed tool arguments and empty/HTML API responses fail clearly.
- Tool arguments are checked against their schemas before permission prompts or execution.
- Provider overrides no longer inherit credentials or endpoints from a different provider.
- Chat Completions image follow-ups retain standard string tool messages for broad API compatibility.
- Session resume is workspace-scoped and restores its provider, model, and reasoning effort.
- Session loading, model responses, file reads, and grep fallbacks enforce memory limits.
- One-shot failures and exhausted tool loops now return a non-zero exit status.
- Truncated Chat Completions, Anthropic, and Responses API results are reported as incomplete instead of being saved as successful answers.
- Legacy Unicode note filenames migrate without overwriting a colliding note.
- TUI dynamic imports resolve correctly in the published directory layout.

### Security

- Browser attachment refuses an unknown process on the default debug port.
- Browser ownership markers are bound to the current debugger instance rather than only its port.
- Clipboard images have a configurable size limit and temporary files are removed after reading.
- Proxy URLs reject unsupported protocols and mask embedded credentials in terminal output.
- Timed-out shell commands terminate their process tree.

### Engineering

- Strict TypeScript checking, a locked development toolchain, and full CLI protocol, setup, and permission smoke tests now gate publication.
- Browser smoke testing uses a disposable profile and covers forms, iframes, downloads, screenshots, isolated spaces, cleanup, and CPU timeouts.

[Unreleased]: https://github.com/liutingqiu/raw-agent/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/liutingqiu/raw-agent/releases/tag/v0.4.0
