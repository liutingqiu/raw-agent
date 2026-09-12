# raw

**English** | [中文](./README.zh-CN.md)

**A bare model + tools loop in your terminal.** No system prompt, no runtime dependencies, no scaffolding.

```bash
git clone https://github.com/liutingqiu/raw-agent && cd raw
npm install && npm run build && npm link  # zero-dep build, links the `raw` command
raw setup                   # pick a provider, paste a key
raw                         # start talking to your model
```

Once published it will also be `npm i -g raw-agent` / `npx raw-agent`.

`raw` gives a model exactly three things: your message, a small set of tools, and the transcript so far.
Nothing else is injected — no persona, no "you are a helpful coding agent", no hidden instructions.
The first message the model ever sees is the one you typed.

```
you ──▶ model ──▶ tool calls ──▶ tools ──▶ model ──▶ …
```

- **Zero runtime dependencies.** Production code uses Node's built-in `fetch`, `WebSocket`, and `readline`; TypeScript is a development-only check.
  The published package is under 1 MB installed.
- **Zero config to try.** `raw setup` has 17 built-in providers; paste a key and go.
- **No scaffolding.** No memory files, no auto-injected context, no opinionated workflow.

---

## Why no system prompt

Every agent framework adds instructions. They steer the model toward the framework author's idea of
good behaviour, and they crowd out the context you actually care about. `raw` sends none of that.

During a normal turn, the only extra text a model receives is each tool's JSON Schema — part of the
API protocol, not a prompt. Everything else is your words, the model's words, and tool output.
Two explicit commands add user-role context: `/goal` repeats the goal you entered, and `/compact`
makes a separate summarization request before replacing older turns. Neither uses a system role.

You can verify it:

```bash
RAW_DEBUG=1 raw -p "say ok"
# [debug] POST https://api.deepseek.com/v1/chat/completions
# [debug] {"model":"...","messages":[{"role":"user","content":"say ok"}],"stream":true,...}
```

There is no `system` role in the payload. If you want to give the model instructions, type them —
they will be *your* instructions in the conversation, rather than a hidden startup preamble.

---

## Install

```bash
npm i -g raw-agent      # provides the `raw` command
npx raw-agent --help    # or run without installing
```

Requires **Node >= 22.21** (for global `WebSocket`, built-in TypeScript support in dev mode, and
the startup proxy flag used by `raw`).
The published package ships plain JavaScript built with Node's own type-stripping API, so there is
no build step and no bundler for you to run.

From a checkout:

```bash
git clone https://github.com/liutingqiu/raw-agent && cd raw
npm install
npm run typecheck
npm run build    # zero-dependency build
npm link         # makes `raw` available globally
npm test
```

---

## Setting up a model

```bash
raw setup                     # interactive: choose provider → paste key → pick a model
raw setup deepseek            # start from a specific provider
raw setup deepseek --key sk-… --model deepseek-chat    # fully non-interactive
raw providers                 # what is configured (keys masked)
raw presets                   # every built-in provider
```

Setup first tries the provider's `/models` endpoint to verify the key and discover current models.
If discovery fails, interactive setup offers the preset hints or accepts any model id you enter.
Non-interactive setup requires an explicit `--model`. Keys are stored in `~/.raw/config.json`;
the file is mode `0600` on POSIX systems and protected by the user's directory ACL on Windows.

| Provider | API flavour |
| --- | --- |
| `openai` | Responses API |
| `anthropic` | native Messages API |
| `gemini` `deepseek` `kimi` `qwen` `grok` `glm` `doubao` `minimax` `mistral` `groq` `openrouter` `siliconflow` `together` | OpenAI-compatible |
| `ollama` `lmstudio` | local, no key needed |

Anything else: `raw setup <name> --base-url <url> --api <kind>`, or choose `custom` in the wizard.

### Precedence

```
CLI flags  >  RAW_* env vars  >  ~/.raw/config.json  >  built-in preset
           >  pi's models.json (if you use pi)  >  OPENAI_* env vars
```

Your saved setup intentionally wins over ambient `PI_PROVIDER`/`PI_MODEL`, so configuring `raw`
can't be silently overridden by another tool's environment.

---

## Tools

Ten tools. All local, all inspectable.

| Tool | Reads only | What it does |
| --- | --- | --- |
| `read` | ✅ | Read a file with line numbers, `offset`/`limit`, binary detection |
| `ls` | ✅ | List a directory, optional recursion depth |
| `grep` | ✅ | ripgrep search (falls back to a JS walk when `rg` is missing) |
| `web_search` | ✅ | Multi-backend search with automatic fallback |
| `web_fetch` | ✅ | Fetch a URL and convert HTML to readable text |
| `browser` | | Drive a real Chrome/Edge over CDP — the model writes a script |
| `write` | | Create or overwrite a file (makes parent directories) |
| `edit` | | Exact-text replacement: must match uniquely, must not overlap, returns a diff |
| `bash` | | Run a shell command, returns merged output and exit code |
| `notes` | | Durable notes that survive across runs |

Consecutive **read-only** calls run in parallel; `browser`/`write`/`edit`/`bash` run in order.
Every result is truncated head-and-tail (24 KB) so a chatty command can't blow up the context.

### `web_search`

Tries each backend in order and falls through on error or zero results:

| Backend | Key | Notes |
| --- | --- | --- |
| `tavily` | `TAVILY_API_KEY` | Best quality — returns page content, not just snippets |
| `exa` | `EXA_API_KEY` | Semantic search |
| `serper` | `SERPER_API_KEY` | Google results |
| `searxng` | `SEARXNG_URL` | Your own instance |
| `bing` | none | Scrapes `cn.bing.com` — the only key-less engine that still works reliably |
| `360` | none | Scrapes `so.com` |

Key-less scraping is a losing battle: DuckDuckGo serves anti-bot pages, Google redirects to a consent
wall, most public SearXNG instances have disabled the JSON API. Bing and 360 work; **for anything
serious, set `TAVILY_API_KEY`** (there's a free tier).

### `browser`

Drives a real Chrome or Edge over the Chrome DevTools Protocol using only Node's built-in
`fetch` and `WebSocket`. It uses its own profile (`~/.raw/browser-profile`), so your logins persist
between runs and your own browser windows are never touched.

The design follows [ego-lite](https://github.com/citrolabs/ego-lite)'s insight — **expose an API, not
commands** — so the model composes a whole task in one script instead of a call/look/call loop:

```js
// the `script` argument of the browser tool (top-level await works)
await page.goto("https://cn.bing.com/");
await page.fill("role=textbox", "tabula rasa");     // locators: css, xpath=, text=, role=
await page.press("Enter");
await page.waitForLoadState("networkidle");
console.log("results:", await page.count("#b_results .b_algo"));
await page.click("css=#b_results .b_algo h2 a");
const tab = await page.followPopup();               // a click that opened a new tab
console.log(await (tab ?? page).url());
console.log(await page.screenshot());               // the image goes to the model
```

**Locators** work everywhere: a snapshot number, raw CSS, `css=`, `xpath=`, `text=Sign in`,
`:has-text("…")`, `role=button[name=Save]`. Use `page.find(sel)` / `page.findAll(sel)` to get
`{tag, text, value, href, visible, box}` when you need to know why a selector didn't match.

| Area | API |
| --- | --- |
| Navigate | `goto` `reload` `back` `url` `title` |
| Read | `snapshot({scope:'full'\|'viewport', root, max})` `text` `html` `count` `find` `findAll` `eval` |
| Interact | `click` `dblclick` `hover` `dragAndDrop` `fill` `type` `typeText` `press` `selectOption` `setInputFiles` `mouseMove` `scroll` |
| Input fidelity | real CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` — works on canvas and JS widgets, not just `element.click()` |
| Wait | `waitForSelector({state})` `waitForFunction` `waitForURL` `waitForLoadState` `sleep` |
| Tabs & spaces | `newTab` `followPopup` `tabs` `space(name)` → isolated browser context |
| Artifacts | `screenshot` (also attached to the tool result as an image) `fetch` (uses the profile's cookies) `waitForDownload` `downloads` `waitForFileChooser` |
| Escape hatches | `cdpSend(method, params)`, `setDialogPolicy`, `dialog()`, `handoff(message)` |

Snapshots include the text of the page and reach into same-origin iframes. When a script throws, the
tool result keeps everything it logged and any screenshots it took, so the model can see how far it got.

**Isolated spaces.** `space("name")` returns an isolated browser context with its own cookies and
storage — run parallel jobs without them contaminating each other or your real profile.
Browser scripts run in a worker that is terminated at the requested timeout, including CPU-bound
loops. `page.fetch` runs in the page and therefore follows that page's CORS policy.

Example:

```js
const jobs = await space("jobs");
const p = await jobs.newPage("https://example.com");
```

**Human in the loop.** Some things only you can do — a login, a captcha, 2FA:

```js
await page.handoff("log into the staging dashboard");
```

The agent pauses, tells you what it needs, and waits for you to press Enter. Nobody is ever
locked out of their own browser.

| Env var | Meaning |
| --- | --- |
| `RAW_BROWSER_HEADLESS=1` | No window (default shows one, which makes manual steps possible) |
| `RAW_BROWSER_PORT` | Debug port, default 9222; explicitly setting it permits attaching to an existing debug browser |
| `RAW_BROWSER_PROFILE` | Profile directory |
| `RAW_BROWSER_PATH` | Explicit Chrome/Edge executable |
| `RAW_DOWNLOAD_DIR` | Where downloads land (default `~/.raw/downloads`) |

### `notes`

Durable text the agent writes for its future self — a site's quirks, a project's conventions.
It is **not** injected automatically (that would be a system prompt by another name); the model has
to ask for it. Files live in `~/.raw/notes/`.

---

## Design decisions

- **Nothing is hidden from the model.** Tool output is returned verbatim, only length-truncated —
  no "tool succeeded" wrappers, no summarisation, no rewriting.
- **The model is not second-guessed.** Tools are not auto-retried, no "you should first…" hints are
  injected, no planning scaffold is imposed.
- **The request body contains only protocol-required state.** Besides the conversation and tools,
  a provider may receive its native reasoning controls and opaque reasoning state so tool turns
  remain valid. No hidden instruction or sampling preference is added.
- **Context is managed predictably.** Budget is `contextWindow * 0.6`; when it is exceeded, whole
  turns are dropped from the oldest **user-message boundary** so `tool_calls` and their `tool`
  results are never separated. Images are dropped from all but the last few turns. If the newest
  tool turn alone is oversized, its text outputs are shortened while call ids and structure remain intact.
- **Transient failures retry.** `overloaded`/`429`/`5xx` retry twice when nothing has been streamed
  yet. Errors delivered as a `{"error": …}` frame inside an HTTP 200 stream (some gateways do this)
  are raised properly instead of being swallowed.
- **Ctrl+C** aborts the request and returns you to the prompt; when idle it exits.

---

## Safety

Be clear-eyed about what this is: **an agent that can run shell commands and drive a browser that is
logged into your accounts.** That is the point, and it is also the risk.

- `raw` runs commands and browser scripts as you, with your permissions.
- The dedicated file tools stay inside the workspace by default and reject symlink escapes.
  `RAW_ALLOW_OUTSIDE=1` removes that boundary. Shell commands and browser scripts have the same
  access as the `raw` process.
- The browser uses a dedicated profile. It starts empty; anything you log into is stored locally in
  `~/.raw/browser-profile` and is readable by anything running as you.
- Model requests go only to the provider you configured. Network tools contact the URLs and search
  services they are asked to use. Keys and notes stay on disk.
- `--permission ask` (or `--confirm`) asks before every state-changing tool call.
  `--permission readonly` refuses them.
- `raw` executes code the model wrote. Do not run it on a machine you would not give a shell to a
  language model on.

---

## CLI

| Flag | |
| --- | --- |
| `-p, --print <text>` | One-shot: run and exit |
| `-m, --model <id>` | Model id |
| `--provider <name>` | Configured provider or built-in preset |
| `--base-url` `--api-key` `--api` | Override connection details (`openai-completions`, `openai-responses`, `anthropic-messages`) |
| `--effort <level>` | `minimal` / `low` / `medium` / `high` / `xhigh` / `max` (provider support varies) |
| `--show-reasoning` | Stream the model's thinking (hidden by default; `/reasoning` toggles it live) |
| `--confirm` | Ask before every side effect |
| `--permission <mode>` | `auto` / `ask` / `readonly` (default `auto`) |
| `--readonly` | Shortcut for `--permission readonly` |
| `-c, --continue` | Resume the most recent session for the current workspace |
| `--session <file>` | Session file to use |
| `--max-turns <n>` | Tool-loop turns per message (default 64) |

In-session: `/help` `/goal` `/context` `/compact` `/model` `/provider` `/effort` `/reasoning`
`/permission` `/paste` `/image` `/tools` `/notes` `/session` `/new` `/exit`

### Environment

| Variable | |
| --- | --- |
| `RAW_PROXY` | Route web traffic through a proxy (also reads `HTTPS_PROXY`/`ALL_PROXY`; set to `off` to disable) |
| `RAW_NO_PROXY=1` | Disable the local-proxy auto-detection |
| `RAW_HOME` | Move the data directory |
| `RAW_MODEL` `RAW_API_KEY` `RAW_BASE_URL` `RAW_API` `RAW_PROVIDER` | Per-run overrides |
| `RAW_ALLOW_OUTSIDE=1` | Allow file paths outside the workspace |
| `RAW_DEBUG=1` | Print the outgoing request body |
| `RAW_REASONING_EFFORT` | Override reasoning effort |
| `RAW_API_TIMEOUT_MS` | Maximum duration of one model request in milliseconds (default 300000) |
| `RAW_MAX_API_RESPONSE_BYTES` | Maximum model response body size (default 64 MiB) |
| `RAW_PERMISSION` | Initial permission mode: `auto`, `ask`, or `readonly` |
| `RAW_SHOW_REASONING=1` | Show reasoning output initially |
| `RAW_NO_IMAGES=1` | Do not attach images to model requests |
| `RAW_MAX_IMAGE_BYTES` | Maximum bytes accepted for one local/clipboard image (default 20 MiB) |
| `RAW_MAX_FILE_BYTES` | Maximum file size for in-memory read/edit operations (default 16 MiB) |
| `NO_COLOR=1` | Plain output |

---

## Proxy

Node's built-in `fetch` honours `HTTP(S)_PROXY` when the process starts with `--use-env-proxy`.
`raw` checks its proxy settings (or, in an interactive terminal only, a proxy listening on
7890/7897/10809/10808), and re-executes itself once with that flag when needed. The banner shows
when a proxy is in use. Scripts and CI never get port-sniffed.

---

## Project layout

```
src/cli.ts          argument parsing, REPL, streaming renderer, sessions, parallel tool dispatch
src/api.ts          provider resolution + three protocol adapters + SSE parsing
src/context.ts      context budgeting, goal injection, image pruning, compaction boundaries
src/clipboard.ts    clipboard and local image ingestion
src/tools.ts        the ten tools: schemas and implementations
src/presets.ts      built-in provider catalogue
src/setup.ts        the setup wizard and live /models discovery
src/paths.ts        data directory, config store, legacy migration
src/input.ts        TTY readline / piped-stdin line queue
src/tui/            terminal editor, commands, rendering, themes
src/proxy.ts        proxy detection and self re-exec
src/web.ts          web_search backends and HTML→text
src/browser.ts      CDP client, Page API, tabs, spaces, downloads
src/page-helpers.js injected page-side locators and snapshot (a real .js file, so regex escapes survive)
src/util.ts         colours, truncation, paths, diff, token estimate
test/               node:test unit tests, no framework
scripts/build.mjs   zero-dependency build via node:module
```

## Adding things

- **A tool**: add a schema to `toolSpecs` and a branch to `runTool` in `src/tools.ts`.
  Mark it `readOnly: true` to have it run in parallel with its neighbours.
- **A provider**: add one entry to `src/presets.ts`.
- **A protocol**: write `streamXxx` in `src/api.ts` and dispatch it from `streamTurn`.

## Troubleshooting

**PowerShell: "cannot be loaded because running scripts is disabled on this system"**

npm installs three launchers — `raw` (sh), `raw.cmd` (cmd) and `raw.ps1` (PowerShell).
A default Windows execution policy blocks the `.ps1` one. Either call `raw.cmd`, or allow
signed local scripts for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

**Box-drawing characters look like `?` or blocks**

Your console font lacks them. Switch to Consolas / Cascadia Mono, or force plain ASCII:

```bash
RAW_ASCII=1 raw
```

**Colours look wrong or the screen flickers**

`raw` detects 16-colour, 256-colour and truecolor terminals and degrades automatically.
Set `NO_COLOR=1` for no colour at all. If your terminal reflows on resize, the input block is
redrawn — resize handling is best-effort on legacy Windows consoles.

**The status bar's right-hand side is invisible on Windows**

Some Windows consoles have a screen *buffer* wider than the window. `raw` asks the terminal
for its real text area (the `CSI 18 t` query) and uses the smaller of that and
`process.stdout.columns`, so content stays inside the visible window. If your terminal does not
answer the query, `raw` assumes at most 100 columns on Windows.

**`raw` starts with a proxy you did not configure**

`raw` sniffs for a local HTTP proxy on the usual ports (7890, 7897, 10809, 10808) **only in an
interactive terminal**, and prints what it found. Stop it with `RAW_PROXY=off` or `RAW_NO_PROXY=1`.

**A model rejects screenshots**

Some models have no vision. `raw` notices, drops the images and retries the turn automatically.
Set `RAW_NO_IMAGES=1` to skip them from the start.

## License

MIT
