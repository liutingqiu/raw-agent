import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "raw-browser-smoke-"));
const profile = path.join(root, "profile");
const downloads = path.join(root, "downloads");

// Pick an unused dedicated port before importing browser.ts, which reads the
// setting once. The smoke test never attaches to a user's persistent browser.
const probe = http.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const probeAddress = probe.address();
if (!probeAddress || typeof probeAddress === "string") throw new Error("could not reserve a browser debug port");
const debugPort = probeAddress.port;
await new Promise((resolve) => probe.close(resolve));

process.env.RAW_HOME = root;
process.env.RAW_BROWSER_PORT = String(debugPort);
process.env.RAW_BROWSER_PROFILE = profile;
process.env.RAW_DOWNLOAD_DIR = downloads;
process.env.RAW_BROWSER_HEADLESS = "1";
const { closeBrowser, runBrowserScript } = await import("../dist/browser.js");

const html = `<!doctype html>
<input id="name" aria-label="Name">
<select id="choice"><option value="a">A</option><option value="b">B</option></select>
<a id="download" href="/download" download="fixture.txt">Download</a>
<iframe srcdoc="<button id='b' onclick='document.body.dataset.hit=1'>Go</button>"></iframe>`;
const server = http.createServer((req, res) => {
  if (req.url === "/download") {
    res.setHeader("content-type", "text/plain");
    res.setHeader("content-disposition", 'attachment; filename="fixture.txt"');
    res.end("download fixture");
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("could not start smoke-test server");
const url = `http://127.0.0.1:${address.port}`;
const script = `
  await page.goto(${JSON.stringify(url)});
  await page.fill("#name", "raw user");
  await page.selectOption("#choice", "b");
  if (await page.eval("document.querySelector('#name').value") !== "raw user") throw new Error("fill did not land");
  if (await page.eval("document.querySelector('#choice').value") !== "b") throw new Error("select did not land");
  await page.waitForSelector("role=button[name=Go]");
  const found = await page.find("role=button[name=Go]");
  if (!found || found.tag !== "button") throw new Error("button in iframe was not found");
  await page.click("role=button[name=Go]");
  const hit = await page.eval("document.querySelector('iframe').contentDocument.body.dataset.hit");
  if (hit !== "1") throw new Error("iframe click did not land");
  const waiting = page.waitForDownload({ timeoutMs: 10000 });
  await page.click("#download");
  const downloaded = await waiting;
  if (downloaded.bytes !== 16) throw new Error("download size mismatch: " + downloaded.bytes);
  const shot = await page.screenshot();
  if (!shot.attached || !shot.bytes) throw new Error("screenshot was not attached");
  const first = await space("first");
  const firstPage = await first.newPage(${JSON.stringify(url)});
  await firstPage.eval("document.cookie='isolated=first'");
  const second = await space("second");
  const secondPage = await second.newPage(${JSON.stringify(url)});
  if (await secondPage.eval("document.cookie") !== "") throw new Error("browser spaces shared cookies");
  await first.close();
  await second.close();
  console.log("browser interaction, download, screenshot, iframe, and space isolation passed");
`;

async function terminateOwnedBrowser() {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(profile, ".raw-browser.json"), "utf8"));
    if (typeof marker.webSocketDebuggerUrl === "string") {
      await new Promise((resolve) => {
        const ws = new WebSocket(marker.webSocketDebuggerUrl);
        const timer = setTimeout(resolve, 2_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" })));
        ws.addEventListener("close", done, { once: true });
        ws.addEventListener("error", done, { once: true });
      });
    }
    if (!Number.isInteger(marker.pid)) return;
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/pid", String(marker.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-marker.pid, "SIGTERM"); } catch { process.kill(marker.pid, "SIGTERM"); }
    }
  } catch {
    // The browser may have exited by itself or failed before writing a marker.
  }
  await delay(200);
}

async function removeTempRoot() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 29) throw err;
      await delay(100);
    }
  }
}

try {
  const result = await runBrowserScript(script, { timeoutMs: 30_000 });
  console.log(result.text);
  assert.equal(result.text.startsWith("Error:"), false, result.text);
  assert.equal(result.images?.length, 1);
  assert.equal(fs.readFileSync(path.join(downloads, "fixture.txt"), "utf8"), "download fixture");

  const started = Date.now();
  const timed = await runBrowserScript("while (true) {}", { timeoutMs: 100 });
  assert.match(timed.text, /terminated/);
  assert.ok(Date.now() - started < 2500, timed.text);
  console.log("browser timeout isolation passed");
} finally {
  await closeBrowser();
  await terminateOwnedBrowser();
  await new Promise((resolve) => server.close(resolve));
  await removeTempRoot();
}
