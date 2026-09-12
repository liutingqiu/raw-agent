import "./_setup.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

const { runSetup } = await import("../src/setup.ts");
const { choose } = await import("../src/input.ts");

test("numbered menus accept an exact item name", async () => {
  const ask = {
    question: async () => "model-beta",
    secret: async () => "",
    atEof: () => false,
    close() {},
  };
  const picked = await choose(ask, ["model-alpha", "model-beta"], (item) => item);
  assert.equal(picked, "model-beta");
});

async function captureSetup(argv) {
  const lines = [];
  const oldError = console.error;
  const oldLog = console.log;
  const oldExitCode = process.exitCode;
  console.error = (...args) => lines.push(args.join(" "));
  console.log = (...args) => lines.push(args.join(" "));
  process.exitCode = undefined;
  try {
    await runSetup(argv);
    return { output: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    console.error = oldError;
    console.log = oldLog;
    process.exitCode = oldExitCode;
  }
}

test("a local preset overridden with a remote URL still requires a key", async () => {
  const result = await captureSetup(["ollama", "--base-url", "https://example.invalid/v1", "--model", "model"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /no API key/);
});

test("setup rejects an invalid URL before attempting model discovery", async () => {
  const result = await captureSetup(["custom", "--base-url", "not-a-url", "--api", "openai-completions", "--key", "secret", "--model", "model"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /invalid base URL/);
  assert.doesNotMatch(result.output, /verifying/);
});
