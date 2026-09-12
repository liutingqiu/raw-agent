import { test } from "node:test";
import assert from "node:assert/strict";

import { compactionBoundary, estimateMessages, prune } from "../src/context.ts";

const cfg = { contextWindow: 100_000 };

test("a standing goal is sent as a user message and never mutates history", () => {
  const history = [{ role: "user", content: "hello", images: [{ mime: "image/png", data: "AAA" }] }];
  const result = prune(history, cfg, "finish the task", false);
  assert.deepEqual(result.messages[0], { role: "user", content: "goal: finish the task" });
  assert.equal(result.messages[1].images.length, 1);
  assert.equal(history.length, 1);
});

test("image fallback rebuilds context without base64 payloads", () => {
  const history = [{ role: "user", content: "look", images: [{ mime: "image/png", data: "SECRET_BASE64" }] }];
  const result = prune(history, cfg, null, true);
  assert.equal(result.messages[0].images, undefined);
  assert.match(result.messages[0].content, /1 image\(s\) omitted/);
  assert.doesNotMatch(JSON.stringify(result.messages), /SECRET_BASE64/);
});

test("manual compaction starts at a user boundary and keeps tool exchanges intact", () => {
  const messages = [
    { role: "user", content: "one" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", arguments: "{}" }] },
    { role: "tool", toolCallId: "1", content: "result" },
    { role: "assistant", content: "done", toolCalls: [] },
    { role: "user", content: "two" },
    { role: "assistant", content: "reply", toolCalls: [] },
    { role: "user", content: "three" },
  ];
  assert.equal(compactionBoundary(messages, 2), 4);
});

test("an oversized newest tool turn is compacted without breaking call structure", () => {
  const calls = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: "read", arguments: "{}" }));
  const history = [
    { role: "user", content: "inspect everything" },
    { role: "assistant", content: "", toolCalls: calls },
    ...calls.map((call) => ({ role: "tool", toolCallId: call.id, content: "x".repeat(24_000) })),
  ];
  const result = prune(history, { contextWindow: 16_000 }, null, false);
  assert.equal(result.messages.length, history.length);
  assert.deepEqual(result.messages[1].toolCalls, calls);
  assert.ok(estimateMessages(result.messages) <= 16_000 * 0.6);
});
