import "./_setup.mjs"; // must come first: sets RAW_HOME before paths.ts is imported

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTool, toolSpecs, isReadOnly, normalizeOutput, parseToolArguments } from "../src/tools.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "raw-tools-"));
fs.writeFileSync(path.join(root, "hello.txt"), "alpha\nbeta\ngamma\n");
const ctx = { root, allowOutside: false };

test("every tool has a schema and a description", () => {
  const names = toolSpecs.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of toolSpecs) {
    assert.ok(t.description.length > 10, `${t.name} needs a description`);
    assert.equal(t.parameters.type, "object", `${t.name} parameters`);
  }
  assert.ok(names.includes("read") && names.includes("bash") && names.includes("browser"));
});

test("malformed tool arguments are rejected instead of becoming an empty object", () => {
  assert.match(parseToolArguments('{"path":').error, /could not parse arguments/);
  assert.match(parseToolArguments('["file.txt"]').error, /must be a JSON object/);
  assert.deepEqual(parseToolArguments('{}'), { args: {} });
});

test("read returns numbered lines and honours offset/limit", async () => {
  const out = await runTool("read", { path: "hello.txt" }, ctx);
  assert.match(String(out), /1\| alpha/);
  const sliced = await runTool("read", { path: "hello.txt", offset: 2, limit: 1 }, ctx);
  assert.match(String(sliced), /2\| beta/);
  assert.ok(!String(sliced).includes("gamma"));
});

test("grep reports an invalid regular expression as an error", async () => {
  const out = await runTool("grep", { pattern: "[", path: "." }, ctx);
  assert.match(String(out), /^Error:/);
});

test("large files are refused before an in-memory read", async () => {
  const file = path.join(root, "too-large.txt");
  const handle = fs.openSync(file, "w");
  try {
    fs.ftruncateSync(handle, 16 * 1024 * 1024 + 1);
  } finally {
    fs.closeSync(handle);
  }
  const out = await runTool("read", { path: "too-large.txt" }, ctx);
  assert.match(String(out), /^Error: file is too large/);
});

test("paths outside the workspace are refused, not thrown", async () => {
  // a rejection here would escape runTool's catch and kill the process
  for (const tool of ["read", "ls", "grep"]) {
    const args = tool === "grep" ? { pattern: "x", path: "../../../etc" } : { path: "../../../etc" };
    const out = await runTool(tool, args, ctx);
    assert.equal(typeof out, "string", `${tool} should resolve to a string`);
    assert.match(String(out), /^Error: .*outside the workspace/, `${tool} should be refused`);
  }
});

test("workspace symlinks cannot bypass the outside-path restriction", async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "raw-outside-"));
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "outside");
  const link = path.join(root, "outside-link.txt");
  try {
    fs.symlinkSync(secret, link, "file");
  } catch (err) {
    t.skip(`symlinks unavailable: ${err.message}`);
    return;
  }
  const result = await runTool("read", { path: link }, ctx);
  assert.match(result, /^Error: .*resolves outside the workspace/);
});

test("unknown tools and missing arguments come back as errors", async () => {
  assert.match(String(await runTool("nope", {}, ctx)), /^Error: unknown tool/);
  assert.match(String(await runTool("read", { path: "definitely-missing.txt" }, ctx)), /^Error:/);
  const protectedFile = path.join(root, "must-not-empty.txt");
  fs.writeFileSync(protectedFile, "keep me");
  assert.match(String(await runTool("write", { path: "must-not-empty.txt" }, ctx)), /content is required/);
  assert.equal(fs.readFileSync(protectedFile, "utf8"), "keep me");
  assert.match(String(await runTool("notes", { action: "erase" }, ctx)), /must be one of/);
  assert.match(String(await runTool("ls", { depth: "two" }, ctx)), /must be an integer/);
  assert.match(String(await runTool("ls", { depth: 7 }, ctx)), /must be at most 6/);
  assert.match(String(await runTool("bash", { command: "echo no", timeout: 1 }, ctx)), /must be at least 1000/);
  assert.match(String(await runTool("browser", { status: true, close: true }, ctx)), /exactly one/);
});

test("edit requires a unique match and refuses overlaps", async () => {
  const file = path.join(root, "dup.txt");
  fs.writeFileSync(file, "same\nsame\n");
  const ambiguous = await runTool("edit", { path: "dup.txt", edits: [{ oldText: "same", newText: "x" }] }, ctx);
  assert.match(String(ambiguous), /ambiguous/);

  const ok = await runTool("edit", { path: "dup.txt", edits: [{ oldText: "same\nsame", newText: "only" }] }, ctx);
  assert.match(String(ok), /Edited/);
  assert.equal(fs.readFileSync(file, "utf8"), "only\n");
});

test("write then read round-trips, and edit reports a diff", async () => {
  await runTool("write", { path: "made/up/deep.txt", content: "one\ntwo\n" }, ctx);
  const edited = await runTool("edit", { path: "made/up/deep.txt", edits: [{ oldText: "two", newText: "TWO" }] }, ctx);
  assert.match(String(edited), /- two/);
  assert.match(String(edited), /\+ TWO/);
});

test("write atomically replaces a file and leaves no temporary sibling", async () => {
  const file = path.join(root, "atomic.txt");
  fs.writeFileSync(file, "before");
  const result = await runTool("write", { path: "atomic.txt", content: "after" }, ctx);
  assert.match(result, /^Overwrote atomic\.txt/);
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith("atomic.txt.") && name.endsWith(".tmp")), []);
});

test("bash reports stdout, stderr, and a non-zero exit status", async () => {
  const command = `node -e "console.log('stdout-ok');console.error('stderr-ok');process.exit(7)"`;
  const result = String(await runTool("bash", { command, timeout: 10_000 }, ctx));
  assert.match(result, /stdout-ok/);
  assert.match(result, /stderr-ok/);
  assert.match(result, /\[exit 7,/);
});

test("bash timeout terminates a long-running process", async () => {
  const command = `node -e "setTimeout(()=>{},10000)"`;
  const started = Date.now();
  const result = String(await runTool("bash", { command, timeout: 1_000 }, ctx));
  assert.match(result, /\[TIMEOUT after 1000ms,/);
  assert.ok(Date.now() - started < 5_000, result);
});

test("bash cancellation terminates a long-running process", async () => {
  const command = `node -e "setTimeout(()=>{},10000)"`;
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 100);
  const result = String(await runTool("bash", { command, timeout: 10_000 }, { ...ctx, signal: ac.signal }));
  assert.match(result, /\[CANCELLED,/);
  assert.ok(Date.now() - started < 5_000, result);
});

test("notes round-trip inside the configured data directory", async () => {
  const written = await runTool("notes", { action: "append", key: "Test Site", content: "iframe 里是登录框" }, ctx);
  assert.match(String(written), /Appended/);
  const read = await runTool("notes", { action: "read", key: "Test Site" }, ctx);
  assert.match(String(read), /iframe/);
  const listed = await runTool("notes", { action: "list" }, ctx);
  assert.match(String(listed), /Test Site/);
  assert.match(String(await runTool("notes", { action: "read", key: "never-written" }, ctx)), /No note stored/);
});

test("non-ASCII note keys remain distinct and discoverable", async () => {
  await runTool("notes", { action: "write", key: "项目甲", content: "alpha" }, ctx);
  await runTool("notes", { action: "write", key: "项目乙", content: "beta" }, ctx);
  assert.match(String(await runTool("notes", { action: "read", key: "项目甲" }, ctx)), /alpha/);
  assert.match(String(await runTool("notes", { action: "read", key: "项目乙" }, ctx)), /beta/);
  const listed = String(await runTool("notes", { action: "list" }, ctx));
  assert.match(listed, /项目甲/);
  assert.match(listed, /项目乙/);
});

test("a colliding legacy note is reused only for its matching heading", async () => {
  fs.writeFileSync(path.join(process.env.RAW_HOME, "notes", "legacy-note.md"), "# Legacy Note\n\nold content\n");
  assert.match(String(await runTool("notes", { action: "read", key: "Legacy Note" }, ctx)), /old content/);
  assert.match(String(await runTool("notes", { action: "read", key: "Legacy@Note" }, ctx)), /No note stored/);
  await runTool("notes", { action: "write", key: "Legacy Note", content: "new content" }, ctx);
  assert.match(String(await runTool("notes", { action: "read", key: "Legacy Note" }, ctx)), /^# Legacy Note/);
});

test("read-only classification drives parallel dispatch", () => {
  for (const name of ["read", "ls", "grep", "web_search", "web_fetch"]) {
    assert.equal(isReadOnly(name), true, `${name} should be read-only`);
  }
  for (const name of ["write", "edit", "bash", "browser"]) {
    assert.equal(isReadOnly(name), false, `${name} must not run in parallel`);
  }
  assert.equal(isReadOnly("notes", { action: "read" }), true);
  assert.equal(isReadOnly("notes", { action: "write" }), false);
  assert.equal(isReadOnly("browser", { status: true }), true);
});

test("normalizeOutput flattens both tool result shapes", () => {
  assert.deepEqual(normalizeOutput("plain"), { text: "plain" });
  const withImage = normalizeOutput({ text: "shot", images: [{ mime: "image/png", data: "AAA" }] });
  assert.equal(withImage.text, "shot");
  assert.equal(withImage.images.length, 1);
  assert.equal(normalizeOutput({ text: "none", images: [] }).images, undefined);
});
