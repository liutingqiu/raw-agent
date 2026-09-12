#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  isRetryable,
  parseTokenCount,
  resolveConfig,
  streamTurn,
  type AgentConfig,
  type Msg,
  type ToolCall,
  type TurnResult,
} from "./api.ts";
import { closeBrowser } from "./browser.ts";
import { extractImagePaths, readClipboardImage } from "./clipboard.ts";
import { compactionBoundary, estimateMessages, prune, stripImages } from "./context.ts";
import { isYes, makeAsker } from "./input.ts";
import { CONFIG_DIR, SESSION_DIR, migrateLegacyDir, writeJsonAtomic } from "./paths.ts";
import { ensureProxy, proxyInUse } from "./proxy.ts";
import { printProviders, runSetup } from "./setup.ts";
import { PRESETS } from "./presets.ts";
import { isReadOnly, normalizeOutput, parseToolArguments, runTool, toolSpecs, validateToolArguments, type ToolContext, type ToolOutput } from "./tools.ts";
import { Editor } from "./tui/editor.ts";
import {
  commandCompletions,
  findCommand,
  keyReference,
  PERMISSION_ORDER,
  permissionBlurb,
  type PermissionMode,
} from "./tui/commands.ts";
import { clip, out, parseKeys, screen, type Key } from "./tui/term.ts";
import {
  bold,
  dim,
  glyph,
  isMac,
  keyLabel,
  paint,
  platformName,
  theme,
} from "./tui/theme.ts";
import { Block, fitViewport, humanTokens, rule, Spinner, startupLines, statusLine, toolCallLine, toolResultLine } from "./tui/ui.ts";
import { renderSettings, type SettingsHit, type SettingRow } from "./tui/settings.ts";
import { firstLine, isInside, red, truncate, yellow } from "./util.ts";

/** gateway errors arrive as pretty-printed JSON; collapse them onto one line */
function compactError(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  // gateways answer with JSON; the useful part is the message field
  const json = /("message"|"error_description")\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(flat);
  if (json) {
    const status = /\b(HTTP\s*\d{3})\b/.exec(flat)?.[1];
    const detail = json[2].replace(/\\"/g, '"');
    return truncate(status ? status + " " + detail : detail, 220);
  }
  return truncate(flat, 220);
}

const VERSION = String(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
const PRESET_IDS = PRESETS.map((p) => p.id).join(", ");
const TITLE = "raw";

/* ------------------------------------------------------------------ *
 * arguments
 * ------------------------------------------------------------------ */

type Options = {
  print?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  reasoningEffort?: string;
  contextWindow?: number;
  permission?: PermissionMode;
  cont: boolean;
  session?: string;
  maxTurns: number;
  showReasoning: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Options {
  const o: Options = { cont: false, maxTurns: 64, showReasoning: process.env.RAW_SHOW_REASONING === "1", help: false };
  const fail = (message: string): never => {
    console.error(`${message} (try --help)`);
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`missing value for ${a}`);
      return value;
    };
    switch (a) {
      case "-p":
      case "--print":
        o.print = next();
        break;
      case "--provider":
        o.provider = next();
        break;
      case "-m":
      case "--model":
        o.model = next();
        break;
      case "--base-url":
        o.baseUrl = next();
        break;
      case "--api-key":
        o.apiKey = next();
        break;
      case "--api":
        o.api = next();
        break;
      case "--effort":
      case "--reasoning-effort":
        o.reasoningEffort = next();
        break;
      case "--context-window": {
        const value = next();
        o.contextWindow = parseTokenCount(value);
        if (o.contextWindow === undefined) fail("--context-window must be between 1024 and 100m tokens (for example 128k or 1m)");
        break;
      }
      case "--confirm":
        o.permission = "ask";
        break;
      case "--readonly":
      case "--read-only":
        o.permission = "readonly";
        break;
      case "--permission":
        o.permission = (next() as PermissionMode) ?? "auto";
        break;
      case "-c":
      case "--continue":
        o.cont = true;
        break;
      case "--session":
        o.session = next();
        break;
      case "--max-turns":
        o.maxTurns = Number(next());
        break;
      case "--no-reasoning":
        o.showReasoning = false;
        break;
      case "--show-reasoning":
        o.showReasoning = true;
        break;
      case "-h":
      case "--help":
        o.help = true;
        break;
      default:
        fail(a.startsWith("-") ? `unknown flag: ${a}` : `unexpected argument: ${a}`);
    }
  }
  if (!Number.isInteger(o.maxTurns) || o.maxTurns < 1) fail("--max-turns must be a positive integer");
  if (o.print !== undefined && !o.print.trim()) fail("--print requires a non-empty prompt");
  if (o.permission && !PERMISSION_ORDER.includes(o.permission)) fail(`invalid permission mode: ${o.permission}`);
  if (o.reasoningEffort && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(o.reasoningEffort)) {
    fail(`invalid reasoning effort: ${o.reasoningEffort}`);
  }
  if (o.api && !["openai-completions", "openai-responses", "anthropic-messages", "anthropic"].includes(o.api)) {
    fail(`invalid API format: ${o.api}`);
  }
  return o;
}

function helpText(): string {
  const label = (s: string) => paint(s.padEnd(18), theme.accent);
  const lines = [
    `${paint(TITLE, bold, theme.brand)} ${dim(`v${VERSION}`)} — a bare model + tools loop, with no system prompt.`,
    "",
    paint("usage", bold, theme.info),
    `  ${label("raw")}start an interactive session`,
    `  ${label("raw -p <text>")}one-shot: run and exit`,
    `  ${label("raw setup")}add a provider and API key`,
    `  ${label("raw providers")}what is configured`,
    "",
    paint("options", bold, theme.info),
    `  ${label("-m, --model")}model id`,
    `  ${label("--provider")}configured provider or built-in preset`,
    `  ${label("--base-url")}${dim("--api-key  --api   override connection details")}`,
    `  ${label("--effort")}minimal | low | medium | high | xhigh | max`,
    `  ${label("--context-window")}model context size, e.g. 128k or 1m`,
    `  ${label("--permission")}auto | ask | readonly (default auto)`,
    `  ${label("--show-reasoning")}stream the model's thinking (hidden by default)`,
    `  ${label("-c, --continue")}resume this workspace's most recent session`,
    `  ${label("--max-turns")}tool-loop turns per message (default 64)`,
    "",
    keyReference(),
    "",
    paint("commands", bold, theme.info),
    ...["help", "settings", "goal", "context", "compact", "model", "provider", "effort", "reasoning", "permission", "paste", "image", "tools", "notes", "session", "new", "exit"].map(
      (c) => `  ${paint("/" + c, theme.accent)}`,
    ),
    "",
    paint("environment", bold, theme.info),
    `  ${label("RAW_PROXY")}proxy for web tools (or HTTPS_PROXY; "off" disables)`,
    `  ${label("RAW_HOME")}data directory (default ~/.raw)`,
    `  ${label("RAW_DEBUG")}print the outgoing request body`,
    `  ${label("RAW_ALLOW_OUTSIDE")}allow file paths outside the workspace`,
    `  ${label("RAW_NO_IMAGES")}never attach screenshots to the model`,
    `  ${label("RAW_CONTEXT_WINDOW ")}override the model context size`,
    "",
    dim(`  data: ${CONFIG_DIR}`),
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * session persistence
 * ------------------------------------------------------------------ */

type SessionFile = {
  goal?: string | null;
  messages: Msg[];
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  contextWindow?: number;
  cwd?: string;
};

function saveSession(file: string, messages: Msg[], goal: string | null, cfg: AgentConfig) {
  try {
    const compacted = stripImages(messages, 4);
    messages.splice(0, messages.length, ...compacted);
    const payload: SessionFile = {
      goal,
      messages,
      model: cfg.model,
      provider: cfg.provider,
      reasoningEffort: cfg.reasoningEffort,
      contextWindow: cfg.contextWindow,
      cwd: process.cwd(),
    };
    writeJsonAtomic(file, payload);
  } catch (err) {
    process.exitCode = 1;
    console.error(red(`could not save session ${file}: ${err instanceof Error ? err.message : String(err)}`));
  }
}

async function readPipedPrompt(): Promise<string> {
  const limit = 8 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) throw new Error(`stdin prompt exceeds ${limit} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString("utf8").trim();
}

function loadSession(file: string): SessionFile {
  try {
    const size = fs.statSync(file).size;
    if (size > 256 * 1024 * 1024) throw new Error(`session exceeds 256 MiB (${size} bytes)`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const messages = Array.isArray(raw) ? raw : raw?.messages;
    if (!Array.isArray(messages)) throw new Error("session does not contain a messages array");
    for (const [index, message] of messages.entries()) {
      if (!message || !["user", "assistant", "tool"].includes(message.role) || typeof message.content !== "string") {
        throw new Error(`invalid message at index ${index}`);
      }
      if (message.images !== undefined) {
        if (!Array.isArray(message.images) || message.images.some((image: any) =>
          !image || typeof image.mime !== "string" || typeof image.data !== "string")) {
          throw new Error(`invalid images at message ${index}`);
        }
      }
      if (message.role === "assistant") {
        // Early versions omitted this field for plain-text assistant turns.
        message.toolCalls ??= [];
        if (!Array.isArray(message.toolCalls) || message.toolCalls.some((call: any) =>
          !call || typeof call.id !== "string" || typeof call.name !== "string" || typeof call.arguments !== "string")) {
          throw new Error(`invalid toolCalls at message ${index}`);
        }
        if (message.providerItems !== undefined && !Array.isArray(message.providerItems)) {
          throw new Error(`invalid providerItems at message ${index}`);
        }
      }
      if (message.role === "tool" && typeof message.toolCallId !== "string") {
        throw new Error(`invalid toolCallId at message ${index}`);
      }
    }
    if (!Array.isArray(raw)) {
      if (raw.goal !== undefined && raw.goal !== null && typeof raw.goal !== "string") throw new Error("goal must be a string or null");
      for (const field of ["model", "provider", "reasoningEffort", "cwd"] as const) {
        if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error(`${field} must be a string`);
      }
      if (raw.contextWindow !== undefined && parseTokenCount(raw.contextWindow) === undefined) {
        throw new Error("contextWindow must be an integer between 1024 and 100000000");
      }
    }
    return Array.isArray(raw)
      ? { messages, goal: null }
      : {
          messages,
          goal: raw.goal ?? null,
          model: raw.model,
          provider: raw.provider,
          reasoningEffort: raw.reasoningEffort,
          contextWindow: raw.contextWindow,
          cwd: raw.cwd,
        };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { messages: [], goal: null };
    throw new Error(`could not load session ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function workspaceId(cwd: string): string {
  const normalized = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function latestSession(cwd: string): string | null {
  try {
    const all = fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(SESSION_DIR, f))
      .map((f) => {
        const stat = fs.statSync(f);
        return { f, t: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.t - a.t);
    const prefix = `${workspaceId(cwd)}-`;
    const current = all.find(({ f }) => path.basename(f).startsWith(prefix));
    if (current) return current.f;

    // Compatibility with pre-0.4 sessions, which had no workspace prefix.
    const expected = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    for (const { f, size } of all) {
      try {
        if (size > 256 * 1024 * 1024) continue;
        const raw = JSON.parse(fs.readFileSync(f, "utf8"));
        if (typeof raw?.cwd !== "string") continue;
        const saved = process.platform === "win32" ? path.resolve(raw.cwd).toLowerCase() : path.resolve(raw.cwd);
        if (saved === expected) return f;
      } catch {
        /* an explicit --session still reports corruption; auto-resume skips unrelated files */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * tool execution
 * ------------------------------------------------------------------ */

type Runner = {
  /** print a standalone line above the input block */
  line: (s: string) => void;
  spinner: Spinner | null;
  permission: PermissionMode;
  confirm: (what: string) => Promise<boolean>;
};

async function executeCalls(calls: ToolCall[], ctx: ToolContext, runner: Runner): Promise<ToolOutput[]> {
  const results = new Array<ToolOutput>(calls.length).fill("");
  const clamp = (o: ToolOutput): ToolOutput =>
    typeof o === "string" ? truncate(o, 60_000) : { ...o, text: truncate(o.text, 60_000) };
  const parsed = calls.map((c) => {
    const result = parseToolArguments(c.arguments);
    if (!toolSpecs.some((tool) => tool.name === c.name)) return { error: `unknown tool "${c.name}"` };
    if (result.args) {
      const invalid = validateToolArguments(c.name, result.args);
      if (invalid) return { error: `invalid arguments for ${c.name}: ${invalid}` };
    }
    return result;
  });
  const readOnly = (index: number) => isReadOnly(calls[index].name, parsed[index].args!);

  const gate = async (call: ToolCall, index: number): Promise<boolean> => {
    if (readOnly(index)) return true;

    if (runner.permission === "readonly") {
      results[index] = `Error: permission mode is "readonly" — ${call.name} is not allowed. The user can switch modes with Shift+Tab or /permission.`;
      return false;
    }
    // `auto` means auto: no prompting. Asking here as well as inside the tool was
    // the bug that made auto mode stop and wait for a human.
    if (runner.permission !== "ask") return true;

    if (!(await runner.confirm(`${call.name} ${firstLine(call.arguments, 80)}`))) {
      results[index] =
        `Rejected by user. Do not retry ${call.name} for this; either propose a different approach or tell the user what you need and why.`;
      return false;
    }
    return true;
  };

  let i = 0;
  while (i < calls.length) {
    if (ctx.signal?.aborted) break;
    if (parsed[i].error) {
      results[i] = `Error: ${parsed[i].error}`;
      i++;
      continue;
    }
    if (readOnly(i)) {
      const batch: number[] = [];
      while (i < calls.length && !parsed[i].error && readOnly(i)) batch.push(i++);
      const done = await Promise.all(
        batch.map(async (idx) => clamp(await runTool(calls[idx].name, parsed[idx].args!, ctx))),
      );
      batch.forEach((idx, k) => (results[idx] = done[k]));
    } else {
      const idx = i++;
      if (!(await gate(calls[idx], idx))) continue;
      results[idx] = clamp(await runTool(calls[idx].name, parsed[idx].args!, ctx));
    }
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * key reader: raw bytes in, Key objects out
 * ------------------------------------------------------------------ */

class KeyReader {
  private buf = "";
  private decoder = new StringDecoder("utf8");
  private escTimer: NodeJS.Timeout | null = null;
  private onKey: (k: Key) => void;

  constructor(onKey: (k: Key) => void) {
    this.onKey = onKey;
  }

  feed(chunk: string | Buffer) {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const { keys, rest } = parseKeys(this.buf);
    this.buf = rest;

    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    for (const k of keys) this.onKey(k);

    // a lone ESC is ambiguous: wait briefly for a sequence to complete
    if (this.buf === "\x1b") {
      this.escTimer = setTimeout(() => {
        this.buf = "";
        this.onKey({ name: "escape", id: "escape" });
      }, 35);
    }
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  await ensureProxy();
  migrateLegacyDir();

  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (sub === "setup" || sub === "connect" || sub === "login") {
    await runSetup(argv.slice(1));
    return;
  }
  if (sub === "providers" || sub === "presets") {
    printProviders(sub === "presets");
    return;
  }
  if (sub === "version" || sub === "--version" || sub === "-v") {
    console.log(`${TITLE} ${VERSION}`);
    return;
  }

  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(helpText());
    return;
  }

  const stdinTTY = process.stdin.isTTY === true;
  const stdoutTTY = process.stdout.isTTY === true;
  if (opts.print === undefined && stdinTTY && !stdoutTTY) {
    console.error("interactive mode requires terminal stdout; use raw -p <text> when redirecting output");
    process.exitCode = 2;
    return;
  }
  let oneShotPrompt = opts.print;
  if (oneShotPrompt === undefined && !stdinTTY) {
    try {
      oneShotPrompt = await readPipedPrompt();
    } catch (err) {
      console.error(red(err instanceof Error ? err.message : String(err)));
      process.exitCode = 2;
      return;
    }
    if (!oneShotPrompt) {
      console.error("no prompt received on stdin (use raw -p <text>)");
      process.exitCode = 2;
      return;
    }
  }

  const resolveForSession = (session?: SessionFile) => resolveConfig({
    provider: opts.provider ?? (!process.env.RAW_PROVIDER ? session?.provider : undefined),
    model: opts.model ?? (!process.env.RAW_MODEL ? session?.model : undefined),
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    api: opts.api,
    reasoningEffort: opts.reasoningEffort ?? (!process.env.RAW_REASONING_EFFORT ? session?.reasoningEffort : undefined),
    contextWindow: opts.contextWindow ?? (!process.env.RAW_CONTEXT_WINDOW ? session?.contextWindow : undefined),
  });
  let cfg = resolveForSession();
  let showReasoning = opts.showReasoning;
  let permission: PermissionMode = opts.permission ?? (process.env.RAW_PERMISSION as PermissionMode) ?? "auto";
  if (!PERMISSION_ORDER.includes(permission)) permission = "auto";

  const interactive = opts.print === undefined && stdinTTY && stdoutTTY;
  const root = process.cwd();

  /* ------------------------------ state ------------------------------ */

  let sessionFile = opts.session ?? (opts.cont ? (latestSession(root) ?? newSessionPath()) : newSessionPath());
  let messages: Msg[] = [];
  let goal: string | null = null;
  let loadedSession: SessionFile | undefined;
  if (opts.cont || opts.session) {
    loadedSession = loadSession(sessionFile);
    messages = loadedSession.messages;
    goal = loadedSession.goal ?? null;
    cfg = resolveForSession(loadedSession);
  }

  // raw deliberately does not pick a provider or a model. If the user has not
  // configured one, ask — before entering the TUI, so the wizard can use plain
  // line input.
  if (!cfg.configured && !opts.help) {
    if (!interactive) {
      console.error(red("no model configured."));
      console.error(dim("  interactive:   raw setup"));
      console.error(dim("  one-liner:     raw setup <provider> --key <key> --model <id>"));
      console.error(dim("  per-run:       raw --provider <name> --model <id> --api-key <key>"));
      console.error(dim(`  presets:       ${PRESET_IDS}`));
      process.exit(1);
    }
    console.log("");
    console.log(dim("  nothing configured yet — let's pick a provider and a model."));
    console.log("");
    await runSetup(opts.provider ? [opts.provider] : (loadedSession?.provider ? [loadedSession.provider] : []));
    cfg = resolveForSession(loadedSession);
    if (!cfg.configured) {
      console.error(red("  still not configured — exiting."));
      process.exit(1);
    }
    console.log("");
  }

  const allowOutside = process.env.RAW_ALLOW_OUTSIDE === "1";

  /* ------------------------------ input ------------------------------ */

  // NB: no readline in interactive mode — raw mode owns stdin
  const block = interactive ? new Block() : null;
  const spinner = interactive ? new Spinner() : null;
  const editor = new Editor();
  editor.completer = (token, kind) => {
    if (kind === "command") return commandCompletions(token);
    return completeFiles(token, root);
  };

  let busy = false;
  const CANCELLED_ANSWER = "\u0000cancelled";
  let asking: { editor: Editor; question: string; resolve: (s: string | null) => void; timer?: NodeJS.Timeout } | null = null;
  let lastResultText = "";
  let settingsOpen = false;
  let settingsRow = 0;
  let settingsHits: SettingsHit[] = [];
  let settingsRows: SettingRow[] = [];
  let settingsCloseY = 0;

  const currentEditor = () => asking?.editor ?? editor;

  const printLine = (s = "") => {
    // erase, not finish: leaving the old prompt/hint/status on screen made every
    // turn append another stale copy of it
    block?.erase();
    process.stdout.write(s + "\n");
  };

  const drawSettings = () => {
    if (!settingsOpen) return;
    const frame = renderSettings(
      { contextWindow: cfg.contextWindow, permission, effort: cfg.reasoningEffort, showReasoning },
      settingsRow,
      screen.width(),
      screen.height(),
    );
    settingsHits = frame.hits;
    settingsRows = frame.rows;
    settingsCloseY = frame.closeY;
    screen.hideCursor();
    screen.clear();
    out(frame.lines.join("\n"));
  };

  const applySetting = (rowIndex: number, value: string) => {
    const row = settingsRows[rowIndex];
    if (!row) return;
    settingsRow = rowIndex;
    if (row.key === "permission") permission = value as PermissionMode;
    else if (row.key === "context") cfg = { ...cfg, contextWindow: Number(value) };
    else if (row.key === "effort") cfg = { ...cfg, reasoningEffort: value === "default" ? undefined : value };
    else if (row.key === "reasoning") showReasoning = value === "shown";
    saveSession(sessionFile, messages, goal, cfg);
    drawSettings();
  };

  const stepSetting = (delta: number) => {
    const row = settingsRows[settingsRow];
    if (!row?.choices.length) return;
    const current = Math.max(0, row.choices.findIndex((choice) => choice.active));
    const next = (current + delta + row.choices.length) % row.choices.length;
    applySetting(settingsRow, row.choices[next].value);
  };

  const openSettings = () => {
    if (settingsOpen) return;
    block?.erase();
    settingsOpen = true;
    settingsRow = 0;
    screen.enterAltScreen();
    screen.enableMouse();
    drawSettings();
  };

  const closeSettings = () => {
    if (!settingsOpen) return;
    screen.disableMouse();
    screen.showCursor();
    screen.leaveAltScreen();
    settingsOpen = false;
    settingsHits = [];
    draw();
  };

  /* --------------------------- the prompt --------------------------- */

  /** one column short of the terminal: filling the last cell triggers wrap */
  const usableWidth = () => Math.max(8, screen.width() - 1);

  const draw = () => {
    if (!block) return;
    const width = usableWidth();
    const ed = currentEditor();
    const promptPrefix = asking
      ? paint("? ", theme.warn) + paint(clip(asking.question, Math.max(1, Math.min(width - 5, Math.floor(width * 0.55)))), bold) + " "
      : paint(glyph.arrow, theme.brand) + " ";
    const rendered = ed.render(width, promptPrefix);

    const maxBlockRows = Math.max(3, screen.height() - 1);
    const allChips = ed.attachmentChips();
    const chips = allChips.length && maxBlockRows >= 4
      ? [clip("  " + allChips.map((c) => paint(c, theme.info)).join("  "), width)]
      : [];
    const available = Math.max(1, maxBlockRows - 2 - chips.length);
    const menuLimit = Math.min(6, Math.max(0, available - 1));
    const menuRows = ed
      .menuView(menuLimit)
      .map((m, i) =>
        clip(
          `  ${m.selected ? paint(glyph.arrow, theme.ok) : " "} ${m.selected ? paint(m.label, theme.accent) : dim(m.label)}${
            m.hint ? dim("  " + m.hint) : ""
          }`,
          width,
        ),
      );

    const inputLimit = Math.max(1, available - menuRows.length);
    const viewport = fitViewport(rendered.rows, rendered.cursorRow, inputLimit);

    const hint = busy
      ? `${dim(keyLabel("interrupt"))} stop`
      : `${dim("F2 settings")}  ${dim("/ commands")}  ${dim("@ files")}  ${dim(`${keyLabel("permission")} mode`)}`;

    const status = statusLine(
      {
        provider: cfg.provider,
        model: cfg.model || "(no model)",
        effort: cfg.reasoningEffort ?? "",
        permission,
        used: estimateMessages(messages),
        total: cfg.contextWindow,
        streaming: busy,
        turns: messages.filter((m) => m.role === "assistant").length,
      },
      width,
    );

    // the hint rule stays short: it must look right even if the width is a lie
    const lines = [...menuRows, ...viewport.lines, ...chips, rule(Math.min(width, 72), hint), status];
    block.render(lines, menuRows.length + viewport.cursorRow, rendered.cursorCol);
  };


  /* ------------------------------ asking ------------------------------ */

  const readAnswer = (question: string, timeoutMs?: number): Promise<string | null> => {
    return new Promise((resolve) => {
      const ed = new Editor();
      asking = { editor: ed, question, resolve };
      if (timeoutMs !== undefined) {
        const current = asking;
        current.timer = setTimeout(() => {
          if (asking !== current) return;
          asking = null;
          block?.erase();
          current.resolve(null);
        }, timeoutMs);
      }
      draw();
    });
  };

  const finishAsk = (value: string) => {
    const current = asking;
    asking = null;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    block?.erase();
    current.resolve(value);
  };

  /* ---------------------------- run a turn ---------------------------- */

  const runTurns = async () => {
    let imagesOff = process.env.RAW_NO_IMAGES === "1";

    for (let turn = 0; turn < opts.maxTurns; turn++) {
      let { messages: wire, dropped } = prune(messages, cfg, goal, imagesOff);
      if (dropped) printLine(dim(`  ${glyph.dot} dropped ${dropped} older messages to fit the window`));

      busy = true;
      spinner?.start(paint(`${cfg.model}`, theme.accentDim) + dim(" is thinking"));

      let wroteText = false;
      let reasoningOpen = false;
      let result: TurnResult | undefined;
      let lastErr: unknown;

      let reasoningChars = 0;
      let reasoningMs = 0;
      const reasoningStarted = Date.now();
      const flushReasoning = () => {
        if (!reasoningChars || showReasoning) return;
        const secs = Math.max(1, Math.round((reasoningMs || Date.now() - reasoningStarted) / 1000));
        printLine(dim(`  ${glyph.dot} thought for ${secs}s (${humanTokens(reasoningChars)} chars) ${dim("· /reasoning to show")}`));
        reasoningChars = 0;
      };

      const handlers = {
        onReasoning: (t: string) => {
          reasoningChars += t.length;
          reasoningMs = Date.now() - reasoningStarted;
          if (!showReasoning) return; // hidden: never put it on screen
          spinner?.stop();
          if (!reasoningOpen) {
            block?.erase();
            out(dim(glyph.dot + " "));
            reasoningOpen = true;
          }
          out(dim(t));
        },
        onText: (t: string) => {
          spinner?.stop();
          flushReasoning();
          if (reasoningOpen) {
            out("\n\n");
            reasoningOpen = false;
          }
          if (!wroteText) block?.erase();
          wroteText = true;
          out(t);
        },
      };

      const wrapped = handlers;
      for (let attempt = 0; attempt <= 2; attempt++) {
        const ac = new AbortController();
        abort = () => ac.abort();
        try {
          result = await streamTurn(cfg, wire, toolSpecs, wrapped, ac.signal);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          abort = null;
          const msg = err instanceof Error ? err.message : String(err);
          if (/aborted|AbortError/i.test(msg)) {
            flushReasoning();
            spinner?.stop();
            if (reasoningOpen) out("\n");
            if (wroteText) out("\n");
            printLine(paint("  interrupted", theme.warn));
            busy = false;
            return;
          }
          const hasImages = messages.some((m) => m.role !== "assistant" && m.images?.length);
          if (!imagesOff && hasImages && !wroteText && !reasoningOpen && /image|vision|multimodal|content type/i.test(msg) && attempt < 2) {
            imagesOff = true;
            wire = prune(messages, cfg, goal, true).messages;
            spinner?.stop();
            printLine(yellow("  this model rejected the images — retrying without them"));
            continue;
          }
          if (isRetryable(err) && attempt < 2 && !wroteText && !reasoningOpen) {
            spinner?.stop();
            printLine(yellow(`  retrying: ${firstLine(msg, 100)}`));
            const retry = await new Promise<boolean>((resolve) => {
              let settled = false;
              const finishWait = (continueRetry: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                abort = null;
                resolve(continueRetry);
              };
              const timer = setTimeout(() => finishWait(true), 1200 * (attempt + 1));
              abort = () => finishWait(false);
            });
            if (!retry) {
              printLine(paint("  interrupted", theme.warn));
              busy = false;
              return;
            }
            spinner?.start(dim("retrying"));
            continue;
          }
          break;
        }
      }

      flushReasoning();
      abort = null;
      spinner?.stop();
      if (reasoningOpen) out("\n");
      if (wroteText) out("\n");

      if (!result) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        printLine(red(`  request failed: ${compactError(msg)}`));
        busy = false;
        return;
      }

      messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls, providerItems: result.providerItems });
      if (!result.toolCalls.length) {
        if (!wroteText) printLine(dim("  (empty response)"));
        saveSession(sessionFile, messages, goal, cfg);
        busy = false;
        return;
      }

      for (const call of result.toolCalls) {
        printLine(toolCallLine(call.name, firstLine(call.arguments, 120), usableWidth()));
      }

      const started = Date.now();
      spinner?.start(dim("running tools"));
      const toolAbort = new AbortController();
      abort = () => toolAbort.abort();
      const runner: Runner = {
        line: printLine,
        spinner,
        permission,
        confirm: async (what: string) => {
          spinner?.stop();
          const answer = await readAnswer(`allow ${what}? [y/N]`);
          spinner?.start(dim("running tools"));
          return isYes(answer ?? "");
        },
      };
      const toolCtx: ToolContext = {
        root,
        allowOutside,
        signal: toolAbort.signal,
        // deliberately no confirm hook: executeCalls owns that decision
        confirm: undefined,
        handoff: async (message: string, timeoutMs: number) => {
          spinner?.stop();
          printLine("");
          printLine(`  ${paint("needs you", theme.warn)} ${bold(message)}`);
          printLine(dim(`  do it in the browser, then press Enter (auto-continues in ${Math.round(timeoutMs / 1000)}s)`));
          const answer = await readAnswer("press Enter when done", timeoutMs);
          spinner?.start(dim("running tools"));
          return answer === null
            ? "user did not respond in time"
            : answer === CANCELLED_ANSWER
              ? "user cancelled the handoff"
              : "user confirmed they finished";
        },
      };

      const results = await executeCalls(result.toolCalls, toolCtx, runner);
      abort = null;
      spinner?.stop();
      if (toolAbort.signal.aborted) {
        printLine(paint("  interrupted", theme.warn));
        busy = false;
        return;
      }
      const ms = Date.now() - started;

      results.forEach((r, i) => {
        const c = result!.toolCalls[i];
        const normalized = normalizeOutput(r);
        messages.push({ role: "tool", toolCallId: c.id, content: normalized.text, images: normalized.images });
        const bad = normalized.text.startsWith("Error:") || normalized.text.startsWith("Rejected") ||
          /\[(?:TIMEOUT|exit\s+(?!0\b)-?\d+)/.test(normalized.text);
        lastResultText = normalized.text;
        printLine(toolResultLine(normalized.text, ms, !bad, usableWidth()) + (normalized.images?.length ? dim(` [+${normalized.images.length} image]`) : ""));
      });

      saveSession(sessionFile, messages, goal, cfg);
      busy = false;
    }
    busy = false;
    printLine(yellow(`  stopped after ${opts.maxTurns} turns`));
  };

  let abort: (() => void) | null = null;

  /* --------------------------- one-shot mode --------------------------- */

  if (!interactive) {
    const asker = makeAsker();
    const runner: Runner = {
      line: (s) => console.log(s),
      spinner: null,
      permission,
      confirm: async (what: string) => isYes(await asker.question(`  allow ${what}? [y/N] `)),
    };
    const toolCtx: ToolContext = {
      root,
      allowOutside,
      // no confirm hook: executeCalls is the single place that decides
      confirm: undefined,
      handoff: async (message: string) => {
        console.log(yellow(`\n  needs you: ${message}`));
        if (asker.atEof()) return "no interactive user available — continuing without help";
        await asker.question("  press Enter when done ");
        return "user confirmed they finished";
      },
    };

    await runOneShot(oneShotPrompt ?? "", messages, cfg, goal, toolCtx, runner, printLine, sessionFile, showReasoning, opts.maxTurns);
    asker.close();
    return;
  }

  /* -------------------------- interactive mode -------------------------- */

  console.log("");
  for (const line of startupLines(
    {
      version: VERSION,
      provider: cfg.provider,
      model: cfg.model,
      effort: cfg.reasoningEffort ?? "-",
      permission,
      workspace: root,
      proxy: proxyInUse(),
      toolCount: toolSpecs.length,
      configured: cfg.configured,
    },
    Math.min(usableWidth(), 78),
  )) {
    console.log("  " + line);
  }
  console.log("");
  console.log(dim(`  ${platformName()} · ${keyLabel("commands")} commands · ${keyLabel("paste-image")} image · ? for help`));
  console.log("");

  screen.raw(true);
  screen.enableBracketedPaste();
  screen.enableModifiedKeys();

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    spinner?.stop();
    if (settingsOpen) {
      screen.disableMouse();
      screen.leaveAltScreen();
      settingsOpen = false;
    }
    block?.erase();
    screen.restore();
  };
  process.on("exit", () => {
    restore();
    void closeBrowser();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      restore();
      process.exit(130);
    });
  }

  let exiting = false;
  const finish = () => {
    if (exiting) return;
    exiting = true;
    restore();
    process.exit(0);
  };

  const reader = new KeyReader((key) => {
    if (key.name === "resize" && key.cols && key.rows) {
      screen.noteReportedSize(key.cols, key.rows);
      if (settingsOpen) drawSettings();
      else if (!busy || asking) {
        block?.erase();
        draw();
      }
      return;
    }

    if (settingsOpen) {
      if (key.name === "escape" || key.name === "f2") closeSettings();
      else if (key.name === "up") {
        settingsRow = (settingsRow - 1 + settingsRows.length) % settingsRows.length;
        drawSettings();
      } else if (key.name === "down" || key.name === "tab") {
        settingsRow = (settingsRow + 1) % settingsRows.length;
        drawSettings();
      } else if (key.name === "left") stepSetting(-1);
      else if (key.name === "right") stepSetting(1);
      else if (key.name === "enter") stepSetting(1);
      else if (key.name === "mouse" && key.mouseAction === "press") {
        if (key.y === settingsCloseY) closeSettings();
        else {
          const hit = settingsHits.find((candidate) => candidate.y === key.y && key.x! >= candidate.x1 && key.x! <= candidate.x2);
          if (hit) applySetting(hit.row, hit.value);
        }
      }
      return;
    }

    if (asking) {
      const ed = asking.editor;
      const action = ed.handle(key);
      if (action?.type === "submit") finishAsk(action.text);
      else if (key.name === "escape" || action?.type === "interrupt") finishAsk(CANCELLED_ANSWER);
      else if (key.name === "enter") finishAsk(""); // empty answer = decline
      else draw();
      return;
    }

    // The spinner/stream owns the terminal while a turn is running. Letting
    // normal input repaint here corrupts streamed output and creates duplicate
    // submissions. Escape and Ctrl+C remain responsive.
    if (busy) {
      if (key.id === "escape" || key.id === "ctrl+c") abort?.();
      return;
    }

    if (key.name === "f2") {
      openSettings();
      return;
    }

    const ed = editor;
    const action = ed.handle(key);

    if (!action) {
      // keep the block in sync after every keystroke
      draw();
      return;
    }

    switch (action.type) {
      case "interrupt":
        block?.erase();
        draw();
        break;
      case "exit":
        finish();
        break;
      case "permission-cycle": {
        const next = PERMISSION_ORDER[(PERMISSION_ORDER.indexOf(permission) + 1) % PERMISSION_ORDER.length];
        permission = next;
        printLine(`  ${glyph.check} permission ${dim("→")} ${paint(next, theme.warn)} ${dim(permissionBlurb[next])}`);
        draw();
        break;
      }
      case "expand": {
        printLine("");
        printLine(sectionTitleLocal("last tool output"));
        printLine(lastResultText ? truncate(lastResultText, 8000) : dim("(nothing yet)"));
        draw();
        break;
      }
      case "paste-image": {
        const res = readClipboardImage();
        if (res.ok) {
          ed.attach(res.image, res.label);
          printLine(`  ${glyph.check} attached ${paint(res.label, theme.accent)}`);
        } else {
          printLine(paint(`  no image: ${res.reason}`, theme.warn) + (res.hint ? dim(`  ${res.hint}`) : ""));
        }
        draw();
        break;
      }
      case "submit": {
        void handleSubmit(action.text, ed);
        break;
      }
    }
  });

  // a resize reflows the terminal; without this the old block lingers
  process.stdout.on("resize", () => {
    const repaint = () => {
      screen.querySize(); // re-ask: the visible window may differ from the buffer
      if (settingsOpen) drawSettings();
      else {
        block?.erase();
        draw();
      }
    };
    repaint();
    // some terminals report the new column count a tick later
    setTimeout(repaint, 80);
  });

  process.stdin.on("data", (chunk) => reader.feed(chunk));
  process.stdin.resume();
  screen.querySize(); // adopt the real window width before the first paint
  draw();
  setTimeout(() => {
    block?.erase();
    draw();
  }, 200);

  async function handleSubmit(rawText: string, ed: Editor) {
    if (busy) return;
    busy = true;
    let text = rawText;
    const attachments = [...ed.attachments];
    const attachmentLabels = [...ed.attachmentLabels];
    ed.clear();

    // Commands must be parsed before image extraction. Otherwise an existing
    // path in `/image shot.png` is removed as a message attachment and the
    // command receives no argument.
    if (text.startsWith("/")) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      const command = findCommand(name);
      ed.remember(text);
      if (name !== "new") attachments.forEach((image, i) => ed.attach(image, attachmentLabels[i] ?? `image-${i + 1}`));
      try {
        if (!command) {
          printLine(paint(`  unknown command /${name} — try /help`, theme.warn));
          return;
        }
        block?.erase();
        await command.run(
          {
            cfg,
            setConfig: (c) => (cfg = c),
            messages,
            setMessages: (m) => (messages = m),
            permission,
            setPermission: (p) => (permission = p),
            showReasoning,
            setShowReasoning: (v) => (showReasoning = v),
            goal,
            setGoal: (g) => (goal = g),
            sessionFile,
            newSession: () => {
              messages = [];
              goal = null;
              sessionFile = newSessionPath();
              return sessionFile;
            },
            print: printLine,
            width: () => usableWidth(),
            attach: (image, label) => ed.attach(image, label),
            compact: (instructions) => compact(sessionFile, instructions),
            usage: () => ({
              used: estimateMessages(messages),
              total: cfg.contextWindow,
              images: messages.reduce((n, m) => n + (m.role !== "assistant" ? (m.images?.length ?? 0) : 0), 0),
              turns: messages.filter((m) => m.role === "assistant").length,
            }),
            openSettings,
            exit: finish,
          },
          arg,
        );
        if (["goal", "new", "model", "provider", "effort", "context"].includes(name)) saveSession(sessionFile, messages, goal, cfg);
      } catch (err) {
        printLine(red(`  /${name} failed: ${err instanceof Error ? err.message : String(err)}`));
      } finally {
        busy = false;
        if (settingsOpen) drawSettings();
        else draw();
      }
      return;
    }

    try {
      // @image.png in a normal message becomes an attachment. If a file has an
      // image extension but invalid bytes, keep the reference in the message
      // and tell the user instead of silently deleting it.
      const { paths, cleaned } = extractImagePaths(text);
      const rejectedPaths: string[] = [];
      for (const p of paths) {
        const { readImageFile } = await import("./clipboard.ts");
        const res = readImageFile(p);
        if (res.ok) attachments.push(res.image);
        else {
          rejectedPaths.push(`@${p}`);
          printLine(paint(`  cannot attach ${p}: ${res.reason}`, theme.warn));
        }
      }
      text = [cleaned, ...rejectedPaths].filter(Boolean).join(" ");

      if (!text.trim() && !attachments.length) return;

      ed.remember(text);
      messages.push({ role: "user", content: text, images: attachments.length ? attachments : undefined });
      block?.erase();
      printLine(`${paint(glyph.arrow, theme.brand)} ${bold(firstLine(text, usableWidth() - 4) || "(image)")}${attachments.length ? dim(` [+${attachments.length} image]`) : ""}`);
      await runTurns();
    } catch (err) {
      spinner?.stop();
      printLine(red(`  turn failed: ${compactError(err instanceof Error ? err.message : String(err))}`));
    } finally {
      busy = false;
      draw();
    }
  }

  /* ------------------------------ /compact ------------------------------ */

  async function compact(file: string, instructions?: string) {
    const boundary = compactionBoundary(messages);
    if (boundary === 0) {
      printLine(dim("  nothing worth compacting yet"));
      return;
    }
    const older = messages.slice(0, boundary);
    const recent = messages.slice(boundary);
    const transcript = older
      .map((m) => {
        if (m.role === "user") return `USER: ${m.content}`;
        if (m.role === "tool") return `TOOL RESULT: ${truncate(m.content, 1500)}`;
        return `ASSISTANT: ${m.content}${m.toolCalls.length ? ` [called ${m.toolCalls.map((c) => c.name).join(", ")}]` : ""}`;
      })
      .join("\n\n");

    printLine(dim(`  compacting ${older.length} messages…`));
    spinner?.start(dim("summarising"));
    const ask: Msg[] = [
      {
        role: "user",
        content:
          `Summarise the conversation below so it can replace the original in a context window. Keep every decision, file path, ` +
          `command, error and open question. Drop pleasantries. Be dense and factual.${instructions ? ` Extra instructions: ${instructions}` : ""}\n\n` +
          transcript.slice(0, 200_000),
      },
    ];
    try {
      const res = await streamTurn(cfg, ask, [], {}, new AbortController().signal);
      spinner?.stop();
      const summary = res.text.trim();
      if (!summary) {
        printLine(yellow("  model returned an empty summary — nothing changed"));
        return;
      }
      messages = [{ role: "user", content: `Earlier context (compacted):\n\n${summary}` }, ...recent];
      saveSession(file, messages, goal, cfg);
      printLine(`${glyph.check} compacted to ${messages.length} messages ${dim(`(${humanTokens(estimateMessages(messages))} tokens)`)}`);
    } catch (err) {
      spinner?.stop();
      printLine(red(`  compaction failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}

/* ------------------------------------------------------------------ *
 * helpers used above
 * ------------------------------------------------------------------ */

function newSessionPath(): string {
  return path.join(
    SESSION_DIR,
    `${workspaceId(process.cwd())}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`,
  );
}

function sectionTitleLocal(text: string): string {
  return paint(text, bold, theme.info);
}

/** @-mentions: complete paths relative to the workspace */
function completeFiles(token: string, root: string): { value: string; hint?: string }[] {
  try {
    const dir = token.includes("/") || token.includes("\\") ? path.dirname(token) : ".";
    const base = token.includes("/") || token.includes("\\") ? path.basename(token) : token;
    const abs = path.resolve(root, dir);
    if (!isInside(path.resolve(root), abs)) return [];
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return entries
      .filter((e) => e.name.toLowerCase().startsWith(base.toLowerCase()))
      .slice(0, 40)
      .map((e) => {
        const prefix = dir === "." ? "" : dir.replace(/\/?$/, "/");
        const relative = `${prefix}${e.name}${e.isDirectory() ? "/" : ""}`;
        const value = /\s/.test(relative)
          ? `@"${relative}${e.isDirectory() ? "" : "\""}`
          : `@${relative}`;
        return { value, hint: e.isDirectory() ? "dir" : "" };
      });
  } catch {
    return [];
  }
}

/** the non-interactive turn loop: plain text, no cursor work */
async function runOneShot(
  prompt: string,
  messages: Msg[],
  cfg: AgentConfig,
  goal: string | null,
  toolCtx: ToolContext,
  runner: Runner,
  printLine: (s: string) => void,
  sessionFile: string,
  showReasoning: boolean,
  maxTurns: number,
): Promise<void> {
  let imagesOff = process.env.RAW_NO_IMAGES === "1";

  if (prompt.trim()) {
    const { paths, cleaned } = extractImagePaths(prompt);
    const images = [];
    const rejectedPaths: string[] = [];
    for (const p of paths) {
      const { readImageFile } = await import("./clipboard.ts");
      const res = readImageFile(p);
      if (res.ok) images.push(res.image);
      else rejectedPaths.push(`@${p}`);
    }
    const content = [cleaned, ...rejectedPaths].filter(Boolean).join(" ").trim() || prompt;
    messages.push({ role: "user", content, images: images.length ? images : undefined });
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    let { messages: wire } = prune(messages, cfg, goal, imagesOff);
    let result: TurnResult | undefined;
    let reasoned = 0;
    let wroteText = false;
    let reasoningOpen = false;
    const reasonedFrom = Date.now();
    let announced = false;
    const announceReasoning = () => {
      if (announced || !reasoned) return;
      announced = true;
      if (showReasoning) return;
      const secs = Math.max(1, Math.round((Date.now() - reasonedFrom) / 1000));
      printLine(dim(`  ${glyph.dot} thought for ${secs}s (${humanTokens(reasoned)} chars) ${dim("· --show-reasoning to see it")}`));
    };

    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        result = await streamTurn(cfg, wire, toolSpecs, {
          onText: (t) => {
            if (reasoningOpen) {
              out("\n\n");
              reasoningOpen = false;
            }
            wroteText = true;
            announceReasoning();
            out(t);
          },
          onReasoning: (t) => {
            reasoned += t.length;
            if (showReasoning) {
              reasoningOpen = true;
              out(dim(t));
            }
          },
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hasImages = messages.some((m) => m.role !== "assistant" && m.images?.length);
        const visibleOutput = wroteText || (showReasoning && reasoned > 0);
        if (!imagesOff && hasImages && !visibleOutput && /image|vision|multimodal|content type/i.test(msg) && attempt < 2) {
          imagesOff = true;
          wire = prune(messages, cfg, goal, true).messages;
          printLine(yellow("  this model rejected the images — retrying without them"));
          continue;
        }
        if (isRetryable(err) && attempt < 2 && !visibleOutput) {
          printLine(yellow(`  retrying: ${firstLine(msg, 100)}`));
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        if (wroteText || reasoningOpen) out("\n");
        printLine(red(`request failed: ${compactError(msg)}`));
        process.exitCode = 1;
        return;
      }
    }
    if (!result) {
      process.exitCode = 1;
      return;
    }
    announceReasoning();

    messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls, providerItems: result.providerItems });
    if (result.text || reasoningOpen) out("\n");
    if (!result.toolCalls.length) {
      saveSession(sessionFile, messages, goal, cfg);
      return;
    }

    for (const call of result.toolCalls) {
      printLine(`\n${paint(glyph.arrow, theme.brand)} ${bold(call.name)} ${dim(firstLine(call.arguments, 140))}`);
    }
    const results = await executeCalls(result.toolCalls, toolCtx, runner);
    results.forEach((r, i) => {
      const normalized = normalizeOutput(r);
      messages.push({ role: "tool", toolCallId: result!.toolCalls[i].id, content: normalized.text, images: normalized.images });
      const bad = normalized.text.startsWith("Error:") || normalized.text.startsWith("Rejected") ||
        /\[(?:TIMEOUT|exit\s+(?!0\b)-?\d+)/.test(normalized.text);
      printLine(
        toolResultLine(normalized.text, 0, !bad, screen.width()) + (normalized.images?.length ? dim(` [+${normalized.images.length} image]`) : ""),
      );
    });
    saveSession(sessionFile, messages, goal, cfg);
  }
  printLine(yellow(`stopped after ${maxTurns} turns`));
  process.exitCode = 1;
}

main().catch((err) => {
  try {
    screen.restore();
  } catch {
    /* ignore */
  }
  const detail = err instanceof Error ? (process.env.RAW_DEBUG ? (err.stack ?? err.message) : err.message) : String(err);
  console.error(red(detail));
  process.exit(1);
});
