import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "raw-setup-smoke-"));
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const secret = "setup-secret-123456789";
let modelRequests = 0;
let chatRequests = 0;

const server = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${secret}`);
  if (req.url === "/v1/models") {
    modelRequests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
    return;
  }
  if (req.url === "/v1/chat/completions") {
    chatRequests++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "model-b");
    assert.equal(body.messages.some((message) => message.role === "system"), false);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "configured provider works" }, finish_reason: "stop" }] }));
    return;
  }
  res.writeHead(404).end();
});

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: workspace,
      env: { ...process.env, RAW_HOME: home, RAW_NO_PROXY: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  fs.mkdirSync(workspace, { recursive: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not start setup smoke server");
  const base = `http://127.0.0.1:${address.port}/v1`;

  const setup = await run(["setup", "custom-smoke", "--base-url", base, "--api", "openai-completions", "--key", secret, "--model", "model-b", "--context-window", "512k"]);
  assert.equal(setup.code, 0, setup.stderr || setup.stdout);
  assert.match(setup.stdout, /2 models available/);
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(config.active.provider, "custom-smoke");
  assert.equal(config.active.model, "model-b");
  assert.equal(config.providers["custom-smoke"].apiKey, secret);
  assert.equal(config.providers["custom-smoke"].contextWindow, 512_000);

  const listed = await run(["providers"]);
  assert.equal(listed.code, 0, listed.stderr || listed.stdout);
  assert.match(listed.stdout, /custom-smoke/);
  assert.equal(listed.stdout.includes(secret), false, "provider listing leaked the API key");

  const chat = await run(["-p", "use the saved provider"]);
  assert.equal(chat.code, 0, chat.stderr || chat.stdout);
  assert.match(chat.stdout, /configured provider works/);
  assert.equal(modelRequests, 1);
  assert.equal(chatRequests, 1);
  console.log("setup, persisted provider selection, masked listing, and configured CLI run passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
