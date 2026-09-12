import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { diffPreview, isInside, rel, resolvePath, truncate } from "./util.ts";
import { webSearch, webFetch, availableBackends, BACKENDS } from "./web.ts";
import { runBrowserScript, browserStatus, closeBrowser, setHandoffHook } from "./browser.ts";
import { NOTES_DIR, ensureDir } from "./paths.ts";

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** safe to run concurrently with other read-only tools */
  readOnly?: boolean;
};

/** a base64 image produced by a tool (screenshots, charts, …) */
export type ImagePart = { mime: string; data: string };

/** tools return text, or text plus images the model should actually look at */
export type ToolOutput = string | { text: string; images?: ImagePart[] };

export function normalizeOutput(out: ToolOutput): { text: string; images?: ImagePart[] } {
  if (typeof out === "string") return { text: out };
  return { text: String(out.text ?? ""), images: out.images?.length ? out.images : undefined };
}

/** Parse a model-authored tool argument payload without silently changing it. */
export function parseToolArguments(raw: string): { args?: Record<string, any>; error?: string } {
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: `arguments must be a JSON object: ${truncate(raw, 500)}` };
    }
    return { args: value };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `could not parse arguments as JSON: ${truncate(raw, 500)} (${detail})` };
  }
}

function validateSchema(value: unknown, schema: any, at: string): string | null {
  if (schema?.enum && !schema.enum.includes(value)) return `${at} must be one of: ${schema.enum.join(", ")}`;
  switch (schema?.type) {
    case "string":
      return typeof value === "string" ? null : `${at} must be a string`;
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return `${at} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be a boolean`;
    case "array": {
      if (!Array.isArray(value)) return `${at} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const error = validateSchema(value[i], schema.items, `${at}[${i}]`);
        if (error) return error;
      }
      return null;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${at} must be an object`;
      const object = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in object)) return `${at}.${key} is required`;
      }
      if (schema.additionalProperties === false) {
        const unknown = Object.keys(object).find((key) => !(key in (schema.properties ?? {})));
        if (unknown) return `${at}.${unknown} is not allowed`;
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (key in object) {
          const error = validateSchema(object[key], child, `${at}.${key}`);
          if (error) return error;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export function validateToolArguments(name: string, args: Record<string, any>): string | null {
  const spec = toolSpecs.find((tool) => tool.name === name);
  const structural = spec ? validateSchema(args, spec.parameters, "arguments") : null;
  if (structural) return structural;
  if (name === "browser") {
    const actions = [typeof args.script === "string" && args.script.trim().length > 0, args.status === true, args.close === true]
      .filter(Boolean).length;
    if (actions !== 1) return "arguments must select exactly one of script, status:true, or close:true";
  }
  return null;
}

export type ToolContext = {
  root: string;
  allowOutside: boolean;
  signal?: AbortSignal;
  confirm?: (what: string) => Promise<boolean>;
  /** ask the human to do something in the real browser, then continue */
  handoff?: (message: string, timeoutMs: number) => Promise<string>;
};

const MAX_OUT = 24_000;
const configuredMaxFileBytes = Number(process.env.RAW_MAX_FILE_BYTES);
const MAX_FILE_BYTES = Number.isFinite(configuredMaxFileBytes) && configuredMaxFileBytes > 0
  ? Math.floor(configuredMaxFileBytes)
  : 16 * 1024 * 1024;

function tooLarge(abs: string): string | null {
  const size = fs.statSync(abs).size;
  return size > MAX_FILE_BYTES
    ? `Error: file is too large for an in-memory text operation (${size} bytes; limit ${MAX_FILE_BYTES}). Use grep or a shell command to inspect it in chunks, or set RAW_MAX_FILE_BYTES.`
    : null;
}

/** Write beside the destination, then replace it so interruption cannot leave a partial file. */
function writeTextAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o666;
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode });
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

function firstTextLine(file: string, maxBytes = 4096): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/).find((line) => line.trim()) ?? "";
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ *
 * Specs — these are the model's only guidance (no system prompt)
 * ------------------------------------------------------------------ */

export const toolSpecs: ToolSpec[] = [
  {
    name: "read",
    description:
      "Read a text file. Returns line-numbered content. Use offset/limit for large files. Paths are relative to the workspace root.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative or absolute)" },
        offset: { type: "integer", minimum: 1, description: "1-based first line to read" },
        limit: { type: "integer", minimum: 1, maximum: 100_000, description: "Max lines to read (default 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "ls",
    description: "List directory entries. Directories are suffixed with '/'. Paths are relative to the workspace root.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default '.')" },
        depth: { type: "integer", minimum: 1, maximum: 6, description: "Recursion depth, 1 = only this directory (default 1)" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with a regular expression (ripgrep). Returns 'path:line:text' matches. Use glob to filter files, e.g. '*.ts'.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "File or directory to search (default '.')" },
        glob: { type: "string", description: "Glob filter, e.g. '*.ts' or '!node_modules'" },
        ignoreCase: { type: "boolean", description: "Case-insensitive search" },
        maxResults: { type: "integer", minimum: 1, maximum: 2000, description: "Max matches (default 200)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description:
      "Search the web. Returns ranked {title, url, snippet}. Backends with automatic fallback; key-less engines work out of the box.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "integer", minimum: 1, maximum: 30, description: "Number of results (default 8, max 30)" },
        engine: {
          type: "string",
          description: "Force one engine instead of the fallback chain",
          enum: [...BACKENDS],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return readable text (HTML is converted to markdown-ish text). Use it to read a page found with web_search.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL (https:// is assumed if missing)" },
        maxChars: { type: "integer", minimum: 1, maximum: 200_000, description: "Max characters returned (default 20000)" },
        raw: { type: "boolean", description: "Return the raw body instead of converted text" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser",
    description: [
      "Drive a real Chrome/Edge browser. Pass a JavaScript snippet that runs in Node with a ready `page` object; top-level await works.",
      "Compose a whole multi-step task in one script instead of one tool call per step.",
      "Selectors: a snapshot number, raw CSS, or 'css=', 'xpath=', 'text=Sign in', 'role=button[name=Save]'.",
      "Navigation: page.goto(url) reload() back() url() title().",
      "Reading: page.snapshot() (numbered elements) text(sel?) html(sel?) count(sel) eval(js).",
      "Input: page.click(sel) dblclick(sel) hover(sel) dragAndDrop(a,b) fill(sel,text) type(sel,text) typeText(s,{delay})",
      "press('Control+A') selectOption(sel,v) setInputFiles(sel,path) mouseMove(x,y) mouse.click/down/up/wheel scroll(dy).",
      "Waiting: page.waitForSelector(sel,{state:'visible'|'hidden'|'attached'|'detached'}) waitForFunction(fn) waitForURL(p) waitForLoadState('load'|'domcontentloaded'|'networkidle') sleep(ms). snapshot({scope:'full'|'viewport', root:sel}).",
      "Extras: page.screenshot({path?,fullPage?}) — the image is attached to the tool result so you can actually see the page. page.fetch(url,{...}) (uses the profile's cookies) page.cdpSend(m,params) page.setDialogPolicy('accept'|'dismiss') page.dialog() page.handoff('log in manually', {timeoutMs}) to ask the human.",
      "Downloads: page.waitForDownload({timeout}) page.downloads() — saved under the raw downloads dir. File upload: page.setInputFiles(sel,path) page.waitForFileChooser() then chooser.setFiles([paths]).",
      "Parallel work: space(name) gives an isolated browser context with its own cookies/storage; const sp = await space('jobs'); const p = await sp.newPage(); await sp.close(). Pass {space:'jobs'} to this tool to reuse one across calls.",
      "Use console.log() to report results. {status:true} inspects the browser, {close:true} disconnects.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            'JavaScript, e.g. `await page.goto("https://example.com"); await page.waitForLoadState("networkidle"); console.log(await page.snapshot());`',
        },
        space: { type: "string", description: "Run in an isolated browser context (own cookies/storage). Same name reuses the same context." },
        status: { type: "boolean", description: "Report browser status instead of running a script" },
        close: { type: "boolean", description: "Disconnect from the browser" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 1_800_000, description: "Script timeout in ms (default 180000)" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "notes",
    description:
      "Durable notes that survive across runs, for things you figured out the hard way (a site's quirks, a project's conventions). Read them before rediscovering something; append when you learn a reusable fact. Keys are free-form, e.g. a domain or a topic.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "append", "write"] },
        key: { type: "string", description: "Note key, e.g. 'github.com' or 'build-setup'" },
        content: { type: "string", description: "Text to store (append adds a bullet, write replaces)" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "write",
    description: "Create or overwrite a file with the given content. Creates parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative or absolute)" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description:
      "Replace exact text in a file. Every oldText must occur exactly once and must not overlap another edit. Prefer several small edits over rewriting a whole file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative or absolute)" },
        edits: {
          type: "array",
          description: "List of replacements",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace (must be unique)" },
              newText: { type: "string", description: "Replacement text (empty string deletes)" },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the workspace root and return its combined output and exit code. Use for builds, tests, git, package managers and anything the other tools cannot do.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command" },
        timeout: { type: "integer", minimum: 1000, maximum: 3_600_000, description: "Timeout in milliseconds (default 120000)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export function isReadOnly(name: string, args: Record<string, any> = {}): boolean {
  if (name === "notes") return args.action === "list" || args.action === "read";
  if (name === "browser") return args.status === true && !args.close && !args.script;
  return toolSpecs.find((t) => t.name === name)?.readOnly === true;
}

export async function runTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<ToolOutput> {
  try {
    const invalid = validateToolArguments(name, args);
    if (invalid) return `Error: invalid arguments for ${name}: ${invalid}`;
    // every branch is awaited: returning a promise from inside `try` would let a
    // rejection escape the catch and take the whole process down.
    switch (name) {
      case "read":
        return toolRead(args, ctx);
      case "ls":
        return toolLs(args, ctx);
      case "grep":
        return await toolGrep(args, ctx);
      case "web_search":
        return await toolWebSearch(args, ctx);
      case "web_fetch":
        return await toolWebFetch(args, ctx);
      case "browser":
        return await toolBrowser(args, ctx);
      case "notes":
        return await toolNotes(args, ctx);
      case "write":
        return await toolWrite(args, ctx);
      case "edit":
        return await toolEdit(args, ctx);
      case "bash":
        return await toolBash(args, ctx);
      default:
        return `Error: unknown tool "${name}". Available: ${toolSpecs.map((t) => t.name).join(", ")}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function target(p: string | undefined, ctx: ToolContext): string {
  const abs = resolvePath(p && p.length ? p : ".", ctx.root);
  if (!ctx.allowOutside) {
    const root = fs.realpathSync(ctx.root);
    if (!isInside(path.resolve(ctx.root), abs)) {
      throw new Error(`path "${p}" is outside the workspace (${ctx.root}). Set RAW_ALLOW_OUTSIDE=1 to allow.`);
    }
    let existing = abs;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const resolved = fs.realpathSync(existing);
    if (!isInside(root, resolved)) {
      throw new Error(`path "${p}" resolves outside the workspace (${ctx.root}). Set RAW_ALLOW_OUTSIDE=1 to allow.`);
    }
  }
  return abs;
}

function findOnPath(bin: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, bin + ext);
      try {
        fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * read
 * ------------------------------------------------------------------ */

function toolRead(args: Record<string, any>, ctx: ToolContext): string {
  const abs = target(args.path, ctx);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return toolLs({ path: args.path }, ctx);
  const sizeError = tooLarge(abs);
  if (sizeError) return sizeError;

  const buf = fs.readFileSync(abs);
  const probe = buf.subarray(0, 8000);
  if (probe.includes(0)) return `Error: ${rel(ctx.root, abs)} looks like a binary file (${buf.length} bytes).`;

  const all = buf.toString("utf8").split(/\r?\n/);
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.max(1, Number(args.limit) || 2000);
  const slice = all.slice(offset - 1, offset - 1 + limit);
  if (!slice.length) return `(no lines: file has ${all.length} lines)`;

  const width = String(offset + slice.length - 1).length;
  let out = slice
    .map((line, i) => `${String(offset + i).padStart(width, " ")}| ${line}`)
    .join("\n");
  const note: string[] = [];
  if (offset > 1) note.push(`started at line ${offset}`);
  if (offset - 1 + limit < all.length) note.push(`file has ${all.length} lines, read ${slice.length}`);
  if (note.length) out += `\n\n[${note.join("; ")}]`;
  return truncate(out, MAX_OUT);
}

/* ------------------------------------------------------------------ *
 * ls
 * ------------------------------------------------------------------ */

function toolLs(args: Record<string, any>, ctx: ToolContext): string {
  const abs = target(args.path, ctx);
  const depth = Math.max(1, Math.min(Number(args.depth) || 1, 6));
  const lines: string[] = [];
  const skipped = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      lines.push(`  ! ${rel(ctx.root, dir)}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const indent = "  ".repeat(level - 1);
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        if (level < depth && !skipped.has(e.name)) walk(full, level + 1);
      } else {
        let size = "";
        try {
          size = e.isSymbolicLink() ? " (symlink)" : ` (${fs.statSync(full).size}b)`;
        } catch {
          /* ignore */
        }
        lines.push(`${indent}${e.name}${size}`);
      }
    }
  };

  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) return `${rel(ctx.root, abs)} is a file (${stat.size} bytes). Use read.`;
  walk(abs, 1);
  if (!lines.length) return "(empty directory)";
  return truncate(`${rel(ctx.root, abs)}/\n` + lines.join("\n"), MAX_OUT);
}

/* ------------------------------------------------------------------ *
 * grep
 * ------------------------------------------------------------------ */

async function toolGrep(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return "Error: pattern is required";
  const abs = target(args.path, ctx);
  const max = Math.max(1, Math.min(Number(args.maxResults) || 200, 2000));
  const rg = findOnPath("rg");

  if (rg) {
    const argv = ["--line-number", "--no-heading", "--color=never", "--with-filename", "--max-columns", "400", "--max-columns-preview"];
    if (args.ignoreCase) argv.push("--ignore-case");
    if (args.glob) argv.push("--glob", String(args.glob));
    argv.push("--regexp", pattern, abs);
    const r = await exec(rg, argv, ctx.root, 60_000);
    if (r.timedOut) return "Error: grep timed out after 60000ms";
    if (r.code > 1 || r.code < 0) return `Error: grep failed (exit ${r.code}): ${truncate(r.stderr || r.stdout, 2000)}`;
    const lines = r.stdout.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return `No matches for /${pattern}/ in ${rel(ctx.root, abs)}`;
    const shown = lines.slice(0, max).map((l) => l.replace(abs + path.sep, "").replace(abs, "."));
    const more = lines.length > max ? `\n... ${lines.length - max} more matches` : "";
    return truncate(shown.join("\n") + more, MAX_OUT);
  }

  // fallback: naive JS walk
  const re = new RegExp(pattern, args.ignoreCase ? "i" : "");
  const hits: string[] = [];
  const glob = args.glob ? String(args.glob) : "";
  const accepts = (full: string) => {
    if (!glob) return true;
    const relative = rel(ctx.root, full).replace(/\\/g, "/");
    const negative = glob.startsWith("!");
    const matched = path.matchesGlob(relative, negative ? glob.slice(1) : glob) ||
      path.matchesGlob(path.basename(full), negative ? glob.slice(1) : glob);
    return negative ? !matched : matched;
  };
  const scan = (full: string) => {
    if (hits.length >= max || !accepts(full)) return;
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) return;
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("\u0000")) return;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) hits.push(`${rel(ctx.root, full)}:${i + 1}:${lines[i].slice(0, 300)}`);
      }
    } catch {
      /* ignore unreadable files */
    }
  };
  const walk = (dir: string) => {
    if (hits.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= max) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else scan(full);
    }
  };
  if (fs.statSync(abs).isDirectory()) walk(abs);
  else scan(abs);
  return hits.length ? truncate(hits.join("\n"), MAX_OUT) : `No matches for /${pattern}/`;
}

/* ------------------------------------------------------------------ *
 * web_search / web_fetch
 * ------------------------------------------------------------------ */

async function toolWebSearch(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "Error: query is required";
  const { engine, results, note } = await webSearch(query, { count: Number(args.count) || undefined, engine: args.engine, signal: ctx.signal });
  if (!results.length) {
    return `No results for "${query}". Tried: ${note ?? availableBackends().join(", ")}`;
  }
  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.title || "(untitled)"}`;
    const body = [r.url, r.snippet].filter(Boolean).join("\n   ");
    return body ? `${head}\n   ${body}` : head;
  });
  const header = `[${engine}] ${results.length} results for "${query}"${note ? `\nnote: ${note}` : ""}`;
  return truncate(`${header}\n\n${lines.join("\n\n")}`, MAX_OUT);
}

async function toolWebFetch(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const url = String(args.url ?? "").trim();
  if (!url) return "Error: url is required";
  const r = await webFetch(url, { maxChars: Number(args.maxChars) || undefined, raw: args.raw === true, signal: ctx.signal });
  const header = `${r.url} (${r.contentType.split(";")[0] || "unknown"})`;
  return truncate(`${header}\n\n${r.text}`, MAX_OUT);
}

async function toolBrowser(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutput> {
  if (args.status) return browserStatus();
  if (args.close) {
    await closeBrowser();
    return "disconnected (the browser keeps running; the next call reattaches)";
  }
  const script = String(args.script ?? "").trim();
  if (!script) return "Error: script is required (or pass status:true / close:true)";
  if (ctx.confirm && !(await ctx.confirm(`run a browser script (${script.length} chars)`))) return "Rejected by user.";
  setHandoffHook(ctx.handoff);
  return runBrowserScript(script, {
    timeoutMs: Number(args.timeoutMs) || undefined,
    space: args.space ? String(args.space) : undefined,
    signal: ctx.signal,
  });
}

/* ------------------------------------------------------------------ *
 * notes — durable, explicitly-addressed memory
 * ------------------------------------------------------------------ */

const legacyNoteSlug = (key: string) =>
  key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default";

function noteFile(key: string): string {
  const normalized = key.trim().normalize("NFKC").toLowerCase();
  const legacy = path.join(NOTES_DIR, `${legacyNoteSlug(key)}.md`);
  if (fs.existsSync(legacy)) {
    try {
      const first = fs.readFileSync(legacy, "utf8").split("\n", 1)[0];
      const heading = /^#\s+(.+)/.exec(first)?.[1]?.trim().normalize("NFKC").toLowerCase();
      // Heading-less legacy files remain reachable by their literal slug, but
      // must not capture every different key that happened to share that slug.
      if (heading === normalized || (!heading && normalized === legacyNoteSlug(key))) return legacy;
    } catch {
      /* an unreadable legacy note is handled as a normal tool error later */
    }
  }
  const readable = normalized
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/[. -]+$/g, "")
    .slice(0, 60) || "note";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return path.join(NOTES_DIR, `${readable}-${hash}.md`);
}

async function toolNotes(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const action = String(args.action ?? "read").toLowerCase();

  if (action === "list") {
    if (!fs.existsSync(NOTES_DIR)) return "No notes stored yet.";
    const files = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith(".md"));
    if (!files.length) return "No notes stored yet.";
    return files
      .map((f) => {
        const full = path.join(NOTES_DIR, f);
        const size = fs.statSync(full).size;
        const first = firstTextLine(full).slice(0, 90);
        const heading = /^#\s+(.+)/.exec(first)?.[1];
        return `${heading ?? f.replace(/\.md$/, "")} (${size}b) ${first}`;
      })
      .join("\n");
  }

  const key = String(args.key ?? "").trim();
  if (!key) return "Error: key is required";
  const file = noteFile(key);

  if (action === "read") {
    if (!fs.existsSync(file)) return `No note stored for "${key}".`;
    const sizeError = tooLarge(file);
    if (sizeError) return sizeError;
    return truncate(fs.readFileSync(file, "utf8"), MAX_OUT);
  }

  const content = String(args.content ?? "");
  if (!content.trim()) return "Error: content is required";
  ensureDir(NOTES_DIR);

  if (action === "append") {
    if (ctx.confirm && !(await ctx.confirm(`append to note "${key}"`))) return "Rejected by user.";
    const header = fs.existsSync(file) ? "" : `# ${key}\n`;
    fs.appendFileSync(file, `${header}\n- ${new Date().toISOString().slice(0, 10)}: ${content.trim()}\n`);
    return `Appended to note "${key}".`;
  }

  if (action === "write") {
    if (ctx.confirm && !(await ctx.confirm(`overwrite note "${key}"`))) return "Rejected by user.";
    const body = `# ${key}\n\n${content}`;
    writeTextAtomic(file, body.endsWith("\n") ? body : body + "\n");
    return `Wrote note "${key}".`;
  }

  return `Error: unknown action "${action}" (use list, read, append or write)`;
}

/* ------------------------------------------------------------------ *
 * write
 * ------------------------------------------------------------------ */

async function toolWrite(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const abs = target(args.path, ctx);
  const content = String(args.content ?? "");
  if (ctx.confirm && !(await ctx.confirm(`write ${rel(ctx.root, abs)} (${content.length} chars)`))) {
    return "Rejected by user.";
  }
  const existed = fs.existsSync(abs);
  const before = existed && fs.statSync(abs).size <= MAX_FILE_BYTES ? fs.readFileSync(abs, "utf8") : null;
  writeTextAtomic(abs, content);
  const diff = before !== null && before !== content ? `\n${diffPreview(before, content)}` : "";
  return `${existed ? "Overwrote" : "Created"} ${rel(ctx.root, abs)} (${Buffer.byteLength(content)} bytes, ${content.split("\n").length} lines)${diff}`;
}

/* ------------------------------------------------------------------ *
 * edit
 * ------------------------------------------------------------------ */

async function toolEdit(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const abs = target(args.path, ctx);
  if (!fs.existsSync(abs)) return `Error: file not found: ${rel(ctx.root, abs)}`;
  const sizeError = tooLarge(abs);
  if (sizeError) return sizeError;
  const original = fs.readFileSync(abs, "utf8");
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!edits.length) return "Error: edits must be a non-empty array";

  type Span = { start: number; end: number; newText: string; oldText: string };
  const spans: Span[] = [];

  for (const [i, e] of edits.entries()) {
    const oldText = String(e?.oldText ?? "");
    const newText = String(e?.newText ?? "");
    if (!oldText) return `Error: edit[${i}].oldText is empty`;
    const first = original.indexOf(oldText);
    if (first < 0) return `Error: edit[${i}].oldText not found in ${rel(ctx.root, abs)}`;
    const second = original.indexOf(oldText, first + 1);
    if (second >= 0) return `Error: edit[${i}].oldText is ambiguous (${original.split(oldText).length - 1} occurrences). Add more context.`;
    if (spans.some((s) => first < s.end && first + oldText.length > s.start)) return `Error: edit[${i}] overlaps another edit.`;
    spans.push({ start: first, end: first + oldText.length, newText, oldText });
  }

  if (ctx.confirm && !(await ctx.confirm(`edit ${rel(ctx.root, abs)} (${spans.length} change${spans.length > 1 ? "s" : ""})`))) {
    return "Rejected by user.";
  }

  let out = original;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.newText + out.slice(s.end);
  }
  writeTextAtomic(abs, out);
  return `Edited ${rel(ctx.root, abs)} (${spans.length} change${spans.length > 1 ? "s" : ""})\n${diffPreview(original, out)}`;
}

/* ------------------------------------------------------------------ *
 * bash
 * ------------------------------------------------------------------ */

async function toolBash(args: Record<string, any>, ctx: ToolContext): Promise<string> {
  const command = String(args.command ?? "");
  if (!command.trim()) return "Error: command is required";
  const timeout = Math.max(1000, Number(args.timeout) || 120_000);
  if (ctx.confirm && !(await ctx.confirm(`run: ${command}`))) return "Rejected by user.";

  const { file, argv } = shellInvocation(command);
  const started = Date.now();
  const r = await exec(file, argv, ctx.root, timeout, ctx.signal);
  const ms = Date.now() - started;
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(r.stderr);
  let body = parts.join(r.stdout && r.stderr ? "\n" : "") || "(no output)";
  body = truncate(body, MAX_OUT);
  const status = r.aborted ? "CANCELLED" : r.timedOut ? `TIMEOUT after ${timeout}ms` : `exit ${r.code}`;
  return `${body}\n\n[${status}, ${ms}ms]`;
}

function shellInvocation(command: string): { file: string; argv: string[] } {
  if (process.platform === "win32") {
    const bash = findOnPath("bash");
    if (bash) return { file: bash, argv: ["-lc", command] };
    return { file: process.env.ComSpec || "cmd.exe", argv: ["/d", "/s", "/c", command] };
  }
  return { file: process.env.SHELL || "/bin/sh", argv: ["-lc", command] };
}

type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean };

function exec(file: string, argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, argv, { cwd, windowsHide: true, env: process.env, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const terminate = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number, extraError = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr: stderr + extraError, timedOut, aborted });
    };

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUT * 2) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUT * 2) stderr += d.toString();
    });
    child.on("error", (err) => {
      finish(-1, String(err));
    });
    child.on("close", (code) => {
      finish(code ?? -1);
    });
  });
}
