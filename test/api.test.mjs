import "./_setup.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { streamTurn } = await import("../src/api.ts");

const image = { mime: "image/png", data: "QUJD" };
const messages = [{ role: "user", content: "describe", images: [image] }];
const baseConfig = {
  provider: "test", model: "test-model", apiKey: "secret", reasoning: false,
  contextWindow: 10_000, maxTokens: 2_000,
};

async function withServer(response, run, contentType = "application/json") {
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    res.writeHead(200, { "content-type": contentType });
    res.end(typeof response === "string" ? response : JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const value = await run(`http://127.0.0.1:${address.port}`);
    return { value, received };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Chat Completions sends user images and accepts a non-streaming response", async () => {
  const response = { choices: [{ message: { content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] }, finish_reason: "tool_calls" }] };
  const { value, received } = await withServer(response, (baseUrl) =>
    streamTurn({ ...baseConfig, baseUrl, api: "openai-completions" }, messages, [], {}));
  assert.equal(value.text, "ok");
  assert.equal(value.toolCalls[0].name, "read");
  assert.equal(received.body.messages[0].content[1].image_url.url, "data:image/png;base64,QUJD");
  assert.equal(received.body.messages.some((m) => m.role === "system"), false);
});

test("Chat Completions keeps tool responses valid while forwarding tool images", async () => {
  const history = [
    { role: "user", content: "inspect" },
    { role: "assistant", content: "", toolCalls: [
      { id: "a", name: "browser", arguments: "{}" },
      { id: "b", name: "browser", arguments: "{}" },
    ] },
    { role: "tool", toolCallId: "a", content: "first", images: [image] },
    { role: "tool", toolCallId: "b", content: "second", images: [image] },
  ];
  const { received } = await withServer({ choices: [{ message: { content: "ok" } }] }, (baseUrl) =>
    streamTurn({ ...baseConfig, baseUrl, api: "openai-completions" }, history, [], {}));
  assert.deepEqual(received.body.messages.map((message) => message.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.equal(received.body.messages[2].content, "first");
  assert.equal(received.body.messages[4].content.length, 2);
  assert.equal(received.body.messages[4].content[0].type, "image_url");
});

test("Responses API sends user images without a system instruction", async () => {
  const response = { output: [
    { type: "reasoning", id: "r1", summary: [], encrypted_content: "opaque" },
    { type: "message", content: [{ type: "output_text", text: "ok" }] },
  ] };
  const { value, received } = await withServer(response, (baseUrl) =>
    streamTurn({ ...baseConfig, baseUrl, api: "openai-responses", reasoning: true }, messages, [], {}));
  assert.equal(value.text, "ok");
  assert.equal(received.body.input[0].content[1].type, "input_image");
  assert.equal(received.body.instructions, undefined);
  assert.deepEqual(received.body.include, ["reasoning.encrypted_content"]);
  assert.equal(value.providerItems[0].encrypted_content, "opaque");
});

test("Responses API replays opaque reasoning state on the next tool turn", async () => {
  const history = [
    { role: "user", content: "work" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }], providerItems: [{ type: "reasoning", id: "r1", summary: [], encrypted_content: "opaque" }] },
    { role: "tool", toolCallId: "c1", content: "done" },
  ];
  const response = { output: [{ type: "message", content: [{ type: "output_text", text: "finished" }] }] };
  const { received } = await withServer(response, (baseUrl) =>
    streamTurn({ ...baseConfig, baseUrl, api: "openai-responses", reasoning: true }, history, [], {}));
  assert.equal(received.body.input[1].type, "reasoning");
  assert.equal(received.body.input[1].encrypted_content, "opaque");
});

test("Anthropic sends user images and parses native JSON", async () => {
  const response = { content: [
    { type: "thinking", thinking: "consider", signature: "signed" },
    { type: "text", text: "ok" },
  ], stop_reason: "end_turn" };
  const { value, received } = await withServer(response, (baseUrl) =>
    streamTurn({ ...baseConfig, model: "claude-sonnet-5", reasoningEffort: "high", baseUrl: `${baseUrl}/v1`, api: "anthropic-messages" }, messages, [], {}));
  assert.equal(value.text, "ok");
  assert.equal(received.url, "/v1/messages");
  assert.equal(received.body.messages[0].content[0].type, "image");
  assert.equal(received.body.system, undefined);
  assert.equal(received.body.output_config.effort, "high");
  assert.equal(value.providerItems[0].signature, "signed");
});

test("Anthropic maps the cross-provider minimal effort to its lowest level", async () => {
  const response = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
  const { received } = await withServer(response, (baseUrl) =>
    streamTurn({ ...baseConfig, model: "claude-sonnet-5", reasoningEffort: "minimal", baseUrl, api: "anthropic-messages" }, messages, [], {}));
  assert.equal(received.body.output_config.effort, "low");
});

test("Anthropic replays signed thinking blocks without changing their order", async () => {
  const history = [
    { role: "user", content: "work" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", arguments: "{}" }], providerItems: [
      { type: "thinking", thinking: "consider", signature: "signed" },
      { type: "tool_use", id: "t1", name: "read", input: {} },
    ] },
    { role: "tool", toolCallId: "t1", content: "done" },
  ];
  const response = { content: [{ type: "text", text: "finished" }], stop_reason: "end_turn" };
  const { received } = await withServer(response, (baseUrl) =>
    streamTurn({ ...baseConfig, model: "claude-sonnet-5", baseUrl, api: "anthropic-messages" }, history, [], {}));
  assert.deepEqual(received.body.messages[1].content, history[1].providerItems);
});

test("SSE responses are parsed across event boundaries", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\n\n';
  const { value } = await withServer(sse, (baseUrl) =>
    streamTurn({ ...baseConfig, baseUrl, api: "openai-completions" }, [{ role: "user", content: "hi" }], [], {}),
    "text/event-stream");
  assert.equal(value.text, "ab");
});

test("empty and HTML provider responses fail instead of ending silently", async () => {
  await assert.rejects(
    withServer({ choices: [] }, (baseUrl) =>
      streamTurn({ ...baseConfig, baseUrl, api: "openai-completions" }, messages, [], {})),
    /no text or tool calls/,
  );
  await assert.rejects(
    withServer("<html><body>gateway login</body></html>", (baseUrl) =>
      streamTurn({ ...baseConfig, baseUrl, api: "openai-completions" }, messages, [], {}), "text/html"),
    /returned HTML.*gateway login/,
  );
});

test("early provider termination is reported instead of accepting partial output", async () => {
  await assert.rejects(
    withServer({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }, (baseUrl) =>
      streamTurn({ ...baseConfig, baseUrl, api: "openai-completions" }, messages, [], {})),
    /stopped before completing.*length/,
  );

  const events = [
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  await assert.rejects(
    withServer(events, (baseUrl) =>
      streamTurn({ ...baseConfig, baseUrl, api: "openai-responses" }, messages, [], {}), "text/event-stream"),
    /stopped before completing.*max_output_tokens/,
  );
});

test("model requests obey RAW_API_TIMEOUT_MS", async () => {
  const server = http.createServer((_req, _res) => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const old = process.env.RAW_API_TIMEOUT_MS;
  process.env.RAW_API_TIMEOUT_MS = "1000";
  try {
    const address = server.address();
    await assert.rejects(
      streamTurn({ ...baseConfig, baseUrl: `http://127.0.0.1:${address.port}`, api: "openai-completions" }, messages, [], {}),
      /timeout|aborted/i,
    );
  } finally {
    if (old === undefined) delete process.env.RAW_API_TIMEOUT_MS;
    else process.env.RAW_API_TIMEOUT_MS = old;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
