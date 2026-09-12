import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "raw-permission-smoke-"));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const outcomes = new Map();

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(body.messages.some((message) => message.role === "system"), false);
  const prompt = body.messages.find((message) => message.role === "user")?.content;
  const caseName = String(prompt).split(" ")[0];
  const tool = body.messages.find((message) => message.role === "tool");
  let message;
  if (!tool) {
    message = {
      content: "",
      tool_calls: [{
        id: `${caseName}-call`,
        type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: `${caseName}.txt`, content: caseName }) },
      }],
    };
  } else {
    outcomes.set(caseName, tool.content);
    message = { content: `${caseName} complete` };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }));
});

function run(caseName, permission, input, base) {
  const workspace = path.join(root, caseName);
  const home = path.join(root, `${caseName}-home`);
  fs.mkdirSync(workspace, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cli, "-p", `${caseName} permission test`, "--permission", permission,
      "--provider", "smoke", "--model", "smoke-model", "--base-url", base,
      "--api-key", "test-key", "--api", "openai-completions", "--max-turns", "3",
    ], {
      cwd: workspace,
      env: { ...process.env, RAW_HOME: home, RAW_NO_PROXY: "1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr, workspace }));
    child.stdin.end(input);
  });
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not start permission smoke server");
  const base = `http://127.0.0.1:${address.port}`;

  const readonly = await run("readonly", "readonly", "", base);
  assert.equal(readonly.code, 0, readonly.stderr || readonly.stdout);
  assert.equal(fs.existsSync(path.join(readonly.workspace, "readonly.txt")), false);
  assert.match(outcomes.get("readonly"), /permission mode is "readonly"/);

  const rejected = await run("rejected", "ask", "n\n", base);
  assert.equal(rejected.code, 0, rejected.stderr || rejected.stdout);
  assert.equal(fs.existsSync(path.join(rejected.workspace, "rejected.txt")), false);
  assert.match(outcomes.get("rejected"), /^Rejected by user/);

  const accepted = await run("accepted", "ask", "yes\n", base);
  assert.equal(accepted.code, 0, accepted.stderr || accepted.stdout);
  assert.equal(fs.readFileSync(path.join(accepted.workspace, "accepted.txt"), "utf8"), "accepted");
  assert.match(outcomes.get("accepted"), /^Created accepted\.txt/);

  console.log("readonly, rejected ask, and accepted ask CLI permission paths passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
