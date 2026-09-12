import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "raw-provider-smoke-"));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const seen = { responses: [], anthropic: [] };

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  // Deliberately split JSON and SSE line boundaries.
  for (let offset = 0; offset < wire.length; offset += 7) res.write(wire.slice(offset, offset + 7));
  res.end();
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(Object.hasOwn(body, "system"), false);

  if (req.url === "/responses") {
    seen.responses.push(body);
    if (seen.responses.length === 1) {
      sse(res, [
        { type: "response.output_item.added", item: { type: "reasoning", id: "r1", summary: [], encrypted_content: "opaque" } },
        { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "resp-call", name: "write", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"path":"responses.txt",' },
        { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '"content":"responses tool ran"}' },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
      ]);
    } else {
      assert.ok(body.input.some((item) => item.type === "reasoning" && item.encrypted_content === "opaque"));
      assert.ok(body.input.some((item) => item.type === "function_call_output" && item.call_id === "resp-call"));
      sse(res, [
        { type: "response.output_text.delta", delta: "responses complete" },
        { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } } },
      ]);
    }
    return;
  }

  if (req.url === "/v1/messages") {
    seen.anthropic.push(body);
    if (seen.anthropic.length === 1) {
      sse(res, [
        { type: "message_start", message: { usage: { input_tokens: 8 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "consider" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "anth-call", name: "write", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"anthropic.txt","content":"anthropic tool ran"}' } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
      ]);
    } else {
      const assistant = body.messages.find((message) => message.role === "assistant");
      assert.deepEqual(assistant.content.map((item) => item.type), ["thinking", "tool_use"]);
      assert.equal(assistant.content[0].signature, "signed");
      const result = body.messages.find((message) => message.role === "user" && message.content?.[0]?.type === "tool_result");
      assert.equal(result.content[0].tool_use_id, "anth-call");
      sse(res, [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "anthropic complete" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      ]);
    }
    return;
  }

  res.writeHead(404).end();
});

function run(args, cwd, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not start provider smoke server");
  const base = `http://127.0.0.1:${address.port}`;

  for (const spec of [
    { api: "openai-responses", endpoint: base, file: "responses.txt", output: /responses complete/ },
    { api: "anthropic-messages", endpoint: base, file: "anthropic.txt", output: /anthropic complete/ },
  ]) {
    const workspace = path.join(root, spec.api);
    const home = path.join(root, `${spec.api}-home`);
    fs.mkdirSync(workspace, { recursive: true });
    const result = await run([
      "-p", "run the provider smoke test",
      "--provider", "smoke", "--model", spec.api === "anthropic-messages" ? "claude-sonnet-5" : "gpt-test",
      "--base-url", spec.endpoint, "--api-key", "test-key", "--api", spec.api, "--max-turns", "3",
    ], workspace, home);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, spec.output);
    assert.ok(fs.readFileSync(path.join(workspace, spec.file), "utf8").includes("tool ran"));
  }

  assert.equal(seen.responses.length, 2);
  assert.equal(seen.anthropic.length, 2);
  console.log("Responses and Anthropic streaming CLI tool loops passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
