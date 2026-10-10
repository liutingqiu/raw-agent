/**
 * Zero-dependency build: strip TypeScript types with Node's own API and write
 * plain ESM to dist/, so the published package runs without any experimental
 * type-stripping support and without a bundler.
 */
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const SRC = new URL("../src/", import.meta.url);
const FINAL_OUT = new URL("../dist/", import.meta.url);
const OUT = new URL(`../.dist-build-${process.pid}-${Date.now()}/`, import.meta.url);
const LOCK = new URL("../.dist-build-lock/", import.meta.url);
const BACKUP = new URL(`../.dist-build-backup-${process.pid}-${Date.now()}/`, import.meta.url);

fs.mkdirSync(OUT, { recursive: true });

let compiled = 0;
let copied = 0;

/** walk src/ recursively so nested modules (src/tui/*) are built too */
function walk(dir, relative = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      fs.mkdirSync(new URL(rel + "/", OUT), { recursive: true });
      walk(new URL(entry.name + "/", dir), rel);
      continue;
    }
    const from = new URL(entry.name, dir);
    const to = new URL(rel.replace(/\.ts$/, ".js"), OUT);

    if (entry.name.endsWith(".ts")) {
      const source = fs.readFileSync(from, "utf8");
      const js = stripTypeScriptTypes(source, { mode: "strip" })
        // relative imports must point at the compiled .js files
        .replace(/(from\s+["'])(\.[^"']+)\.ts(["'])/g, "$1$2.js$3")
        .replace(/(import\(\s*["'])(\.[^"']+)\.ts(["']\s*\))/g, "$1$2.js$3");
      fs.writeFileSync(to, js);
      compiled++;
    } else if (entry.name.endsWith(".js")) {
      fs.copyFileSync(from, to);
      copied++;
    }
  }
}

try {
  walk(SRC);

// a stray .ts import left in the output is a build bug, not a runtime surprise
function verify(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      verify(new URL(entry.name + "/", dir));
      continue;
    }
    const file = new URL(entry.name, dir);
    const text = fs.readFileSync(file, "utf8");
    const leftover = /from\s+["']\.[^"']+\.ts["']/.exec(text);
    if (leftover) throw new Error(`${entry.name} still imports ${leftover[0]} — build is broken`);
    const imports = text.matchAll(/(?:from\s+|import\(\s*)["'](\.[^"']+)["']/g);
    for (const match of imports) {
      const target = new URL(match[1], file);
      if (!fs.existsSync(target)) throw new Error(`${file.pathname} imports missing module ${match[1]}`);
    }
  }
}
  verify(OUT);

// every module the entry point needs must exist
  for (const required of ["browser-cli.js", "browser.js", "paths.js", "util.js", "page-helpers.js"]) {
    if (!fs.existsSync(new URL(required, OUT))) throw new Error(`dist/${required} is missing`);
  }

  // Build privately, then serialize only the final directory swap. npm hooks,
  // tests, and local shells can otherwise delete files another build is writing.
  let locked = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      fs.mkdirSync(LOCK);
      locked = true;
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 120_000) {
          fs.rmSync(LOCK, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          continue;
        }
      } catch (statErr) {
        if (statErr?.code !== "ENOENT") throw statErr;
      }
      await delay(50);
    }
  }
  if (!locked) throw new Error("timed out waiting for another build to finish");

  try {
    if (fs.existsSync(FINAL_OUT)) fs.renameSync(FINAL_OUT, BACKUP);
    try {
      fs.renameSync(OUT, FINAL_OUT);
    } catch (err) {
      if (!fs.existsSync(FINAL_OUT) && fs.existsSync(BACKUP)) fs.renameSync(BACKUP, FINAL_OUT);
      throw err;
    }
    fs.rmSync(BACKUP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  console.log(`built dist/ — ${compiled} compiled, ${copied} copied`);
} finally {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.rmSync(BACKUP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
