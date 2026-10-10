/**
 * End-to-end verification of the browser input layer against a real browser.
 *
 * The unit tests in `test/browser-input.test.mjs` drive a mock DOM. This runs
 * the real thing: Chromium's own event pipeline, a controlled field that
 * behaves like React, a canvas that refuses a drag when the pointer never
 * moves, and a genuinely event-driven MutationObserver wait.
 *
 * Everything is isolated: a throwaway RAW_HOME profile, headless by default,
 * and a loopback HTTP server for the network wait. The user's own Edge
 * profile and logins are never touched.
 *
 *   node scripts/verify-browser-input.mjs
 *   RAW_BROWSER_HEADLESS=0 node scripts/verify-browser-input.mjs   # watch it
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.RAW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "raw-verify-"));
if (process.env.RAW_BROWSER_HEADLESS === undefined) process.env.RAW_BROWSER_HEADLESS = "1";

/** the developer's own browser may already hold 9222, so claim a fresh port */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

if (!process.env.RAW_BROWSER_PORT) {
  process.env.RAW_BROWSER_PORT = String(await freePort());
}

const { runBrowserScript, closeBrowser } = await import("../src/browser.ts");

const probeHtml = fs.readFileSync(path.join(repo, "test", "fixtures", "input-probe.html"), "utf8");

const server = http.createServer((request, response) => {
  const url = request.url ?? "/";
  if (url.startsWith("/probe-input")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(probeHtml);
    return;
  }
  if (url.startsWith("/probe")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404);
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const probePort = server.address().port;
const probeUrl = `http://127.0.0.1:${probePort}/probe-input`;

const script = `
const results = {};
await page.goto(${JSON.stringify(probeUrl)});
await page.waitForLoadState("domcontentloaded");

// 1. a controlled field: only the native prototype setter makes React notice
await page.setValue("#field", "hello controlled");
results.field = await page.eval(
  "(() => { const el = document.getElementById('field'); return { value: el.value, onChange: window.__probe.reactOnChange, input: window.__probe.reactInput }; })()",
);

// 2. contenteditable
await page.setValue("#editor", "draft text");
results.editor = await page.eval(
  "(() => ({ text: document.getElementById('editor').textContent, input: window.__probe.editorInput }))()",
);

// 3. Monaco stand-in, resolved through getDomNode() ownership
await page.setValue("#monaco", "print(1)");
results.monaco = await page.eval("window.__probe.monacoWritten");

// 4. CodeMirror 5 stand-in
await page.setValue(".CodeMirror", "cm5 text");
results.codeMirror = await page.eval("window.__probe.codeMirrorWritten");

// 5. drag onto raw viewport coordinates inside the canvas
const target = await page.eval(
  "(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: Math.round(r.right - 40), y: Math.round(r.bottom - 24) }; })()",
);
await page.dragAndDrop("#node", target, { steps: 14, delay: 4 });
results.drag = await page.eval("window.__probe.drag");

// 6. waitForMutation must resolve on the mutation, not after a fixed sleep
const mutationPending = page.waitForMutation("#late", { state: "visible", timeout: 5000 });
await page.eval("setTimeout(() => window.revealLate(), 250)");
const mutationStart = Date.now();
results.mutation = await mutationPending;
results.mutationLatencyMs = Date.now() - mutationStart;

// 7. waitForResponse driven by a real HTTP response
const responsePending = page.waitForResponse(
  (r) => r.url.includes("/probe") && r.status === 200,
  { timeout: 10000 },
);
await page.eval(
  ${JSON.stringify(`fetch("http://127.0.0.1:${probePort}/probe").then((r) => r.text()).then((t) => { window.__fetched = t; })`)},
);
results.response = await responsePending;

console.log(JSON.stringify(results, null, 2));
`;

/**
 * closeBrowser() only drops the CDP connections — the browser is launched
 * detached on purpose so a session survives across runs. A verification run
 * must therefore reap the instance it started, or it leaves a headless
 * browser holding the profile directory and the debug port.
 */
function shutdownOwnBrowser() {
  if (process.platform !== "win32") return;
  const marker = path.basename(process.env.RAW_HOME);
  const command = [
    'Get-CimInstance Win32_Process -Filter "Name like \'%chrome%\' or Name like \'%msedge%\'"',
    `| Where-Object { $_.CommandLine -like '*${marker}*' }`,
    "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore" });
  } catch {
    // best effort: the profile directory is disposable either way
  }
}

let exitCode = 0;
try {
  const { text } = await runBrowserScript(script, { timeoutMs: 150_000 });
  process.stdout.write(`${text}\n`);
  if (text.includes("Error:")) exitCode = 1;
} catch (error) {
  process.stdout.write(`verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  await closeBrowser().catch(() => {});
  server.close();
  shutdownOwnBrowser();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  try {
    fs.rmSync(process.env.RAW_HOME, { recursive: true, force: true });
  } catch {
    process.stdout.write(`note: could not remove ${process.env.RAW_HOME}, safe to delete later\n`);
  }
}

process.exit(exitCode);
