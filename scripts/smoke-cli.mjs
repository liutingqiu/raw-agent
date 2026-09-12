import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "raw-cli-smoke-"));
const home = path.join(root, "home");
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);

const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push(body);
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(body.messages.some((message) => message.role === "system"), false);
  if (body.messages.at(-1)?.content === "force failure") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "forced failure" } }));
    return;
  }
  if (body.messages.at(-1)?.content === "force incomplete") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "partial answer" }, finish_reason: "length" }] }));
    return;
  }

  let message;
  if (requests.length === 1) {
    message = {
      content: "",
      tool_calls: [{ id: "bad", type: "function", function: { name: "read", arguments: '{"path":' } }],
    };
  } else if (requests.length === 2) {
    const result = body.messages.at(-1);
    assert.equal(result.role, "tool");
    assert.match(result.content, /^Error: could not parse arguments as JSON/);
    message = {
      content: "",
      tool_calls: [{
        id: "write",
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: "result.txt", content: "created by smoke" }) },
      }],
    };
  } else if (requests.length === 3) {
    const result = body.messages.at(-1);
    assert.equal(result.role, "tool");
    assert.match(result.content, /^Created result\.txt/);
    message = { content: "smoke complete" };
  } else {
    message = { content: "resumed cleanly" };
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }));
});

function run(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not start mock provider");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    active: { provider: "unavailable", model: "wrong-model" },
    providers: {
      smoke: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test-key",
        api: "openai-completions",
        models: ["smoke-model"],
      },
    },
  }));
  const childOptions = (cwd) => ({
    cwd,
    env: { ...process.env, RAW_HOME: home, RAW_NO_PROXY: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await run(
    process.execPath,
    [
      cli,
      "-p", "complete the smoke test",
      "--provider", "smoke",
      "--model", "smoke-model",
      "--base-url", `http://127.0.0.1:${address.port}/v1`,
      "--api-key", "test-key",
      "--api", "openai-completions",
      "--max-turns", "4",
    ],
    childOptions(workspace),
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /smoke complete/);
  assert.equal(fs.readFileSync(path.join(workspace, "result.txt"), "utf8"), "created by smoke");
  assert.equal(requests.length, 3);
  const sessions = fs.readdirSync(path.join(home, "sessions")).filter((name) => name.endsWith(".json"));
  assert.equal(sessions.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "sessions", sessions[0]), "utf8"));
  assert.equal(saved.messages.at(-1).content, "smoke complete");

  const resumed = await run(process.execPath, [cli, "-c", "-p", "resume this session"], childOptions(workspace));
  assert.equal(resumed.code, 0, resumed.stderr || resumed.stdout);
  assert.match(resumed.stdout, /resumed cleanly/);
  assert.equal(requests[3].model, "smoke-model");
  assert.ok(requests[3].messages.some((message) => message.content === "smoke complete"));

  const otherWorkspace = path.join(root, "other-workspace");
  fs.mkdirSync(otherWorkspace);
  const isolated = await run(
    process.execPath,
    [cli, "-c", "-p", "fresh workspace", "--provider", "smoke", "--model", "smoke-model"],
    childOptions(otherWorkspace),
  );
  assert.equal(isolated.code, 0, isolated.stderr || isolated.stdout);
  assert.deepEqual(requests[4].messages.map((message) => message.content), ["fresh workspace"]);

  const corruptSession = path.join(root, "corrupt-session.json");
  fs.writeFileSync(corruptSession, JSON.stringify({ messages: [{ role: "assistant", content: "x", toolCalls: "broken" }] }));
  const beforeCorrupt = requests.length;
  const corrupt = await run(
    process.execPath,
    [
      cli, "--session", corruptSession, "-p", "must not be sent",
      "--provider", "smoke", "--model", "smoke-model",
    ],
    childOptions(workspace),
  );
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.stderr, /could not load session.*invalid toolCalls/);
  assert.equal(requests.length, beforeCorrupt);

  const failed = await run(
    process.execPath,
    [cli, "-p", "force failure", "--provider", "smoke", "--model", "smoke-model"],
    childOptions(otherWorkspace),
  );
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /request failed: HTTP 503/);

  const incomplete = await run(
    process.execPath,
    [cli, "-p", "force incomplete", "--provider", "smoke", "--model", "smoke-model"],
    childOptions(otherWorkspace),
  );
  assert.equal(incomplete.code, 1);
  assert.match(incomplete.stdout, /partial answer\r?\nrequest failed: provider stopped before completing/);

  const beforeEmpty = requests.length;
  const empty = await run(
    process.execPath,
    [cli, "-p", "", "--provider", "smoke", "--model", "smoke-model"],
    childOptions(otherWorkspace),
  );
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /--print requires a non-empty prompt/);
  assert.equal(requests.length, beforeEmpty);

  const pipedOptions = { ...childOptions(otherWorkspace), stdio: ["pipe", "pipe", "pipe"] };
  const piped = await run(
    process.execPath,
    [cli, "--provider", "smoke", "--model", "smoke-model"],
    pipedOptions,
    "piped prompt\n",
  );
  assert.equal(piped.code, 0, piped.stderr || piped.stdout);
  assert.match(piped.stdout, /resumed cleanly/);
  assert.equal(requests.at(-1).messages.at(-1).content, "piped prompt");
  console.log("cli tool-loop, session restore, workspace isolation, and failure-exit smoke test passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
