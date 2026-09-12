import "./_setup.mjs"; // must come first: sets RAW_HOME before paths.ts is imported

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// RAW_HOME is read when paths.ts is first imported, so set it up front.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "raw-test-"));
process.env.RAW_HOME = home;
delete process.env.RAW_PROVIDER;
delete process.env.RAW_MODEL;
delete process.env.RAW_BASE_URL;
delete process.env.RAW_API_KEY;

const { writeConfig, readConfig, maskKey, removeProvider, setProvider } = await import("../src/paths.ts");
const { resolveConfig } = await import("../src/api.ts");

writeConfig({
  providers: {
    myprov: {
      apiKey: "sk-test-key-1234567890",
      baseUrl: "https://api.myprov.test/v1",
      api: "openai-completions",
      models: ["my-model-large", "my-model-small"],
    },
  },
  active: { provider: "myprov", model: "my-model-large" },
});

test("config file round-trips and is stored with 0600", () => {
  const cfg = readConfig();
  assert.equal(cfg.providers.myprov.baseUrl, "https://api.myprov.test/v1");
  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(home, "config.json")).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("a saved provider wins over the ambient PI_* variables", () => {
  process.env.PI_PROVIDER = "something-else";
  process.env.PI_MODEL = "some-other-model";
  const cfg = resolveConfig({});
  assert.equal(cfg.provider, "myprov");
  assert.equal(cfg.model, "my-model-large");
  assert.equal(cfg.baseUrl, "https://api.myprov.test/v1");
  assert.equal(cfg.api, "openai-completions");
  assert.equal(cfg.apiKey, "sk-test-key-1234567890");
});

test("explicit options beat everything", () => {
  const cfg = resolveConfig({ provider: "deepseek", model: "deepseek-chat" });
  assert.equal(cfg.provider, "deepseek");
  assert.equal(cfg.model, "deepseek-chat");
  assert.equal(cfg.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(cfg.api, "openai-completions");
});

test("RAW_* environment variables beat the saved config", () => {
  process.env.RAW_MODEL = "env-model";
  assert.equal(resolveConfig({}).model, "env-model");
  delete process.env.RAW_MODEL;
});

test("unknown providers still resolve to something usable", () => {
  const cfg = resolveConfig({ provider: "totally-unknown", baseUrl: "https://x.test/v1", apiKey: "k" });
  assert.equal(cfg.provider, "totally-unknown");
  assert.equal(cfg.baseUrl, "https://x.test/v1");
  assert.equal(cfg.apiKey, "k");
  assert.ok(cfg.contextWindow > 0);
});

test("anthropic preset selects the native messages api", () => {
  const cfg = resolveConfig({ provider: "anthropic" });
  assert.equal(cfg.api, "anthropic-messages");
  assert.equal(cfg.baseUrl, "https://api.anthropic.com");
});

test("api overrides normalise aliases", () => {
  assert.equal(resolveConfig({ api: "anthropic" }).api, "anthropic-messages");
  assert.equal(resolveConfig({ api: "openai-responses" }).api, "openai-responses");
  assert.equal(resolveConfig({ api: "nonsense" }).api, "openai-completions");
});

test("maskKey is used for display, not stored values", () => {
  assert.equal(maskKey(readConfig().providers.myprov.apiKey), "sk-tes…7890");
});

/* ------------------------------------------------------------------ *
 * raw must never choose a provider or a model on the user's behalf
 * ------------------------------------------------------------------ */

test("a preset's model list is a menu, not a default", () => {
  for (const provider of ["ollama", "lmstudio", "groq", "openai"]) {
    const cfg = resolveConfig({ provider });
    assert.equal(cfg.model, "", `${provider} must not pick a model for the user`);
    assert.equal(cfg.configured, false);
  }
});

test("naming a provider suppresses pi's PI_MODEL", () => {
  const previous = process.env.PI_MODEL;
  process.env.PI_MODEL = "pi-model-for-another-provider";
  try {
    assert.equal(resolveConfig({ provider: "groq" }).model, "");
    // …while a stored config still outranks an ambient PI_MODEL
    assert.equal(resolveConfig({}).model, "my-model-large");
  } finally {
    if (previous === undefined) delete process.env.PI_MODEL;
    else process.env.PI_MODEL = previous;
  }
});

test("a key is required unless the endpoint is local", () => {
  assert.equal(resolveConfig({ provider: "openai", model: "gpt-4o" }).configured, false);
  assert.equal(resolveConfig({ provider: "ollama", model: "qwen3-coder" }).configured, true);
  assert.equal(resolveConfig({ provider: "deepseek", model: "deepseek-chat", apiKey: "k" }).configured, true);
});

test("config source is reported honestly", () => {
  assert.equal(resolveConfig({ provider: "openai", model: "m", apiKey: "k" }).source, "flags");
  assert.equal(resolveConfig({}).source === "config" || resolveConfig({}).source === "pi", true);
});

test("provider names cannot collide with object prototype keys", () => {
  setProvider("__proto__", { baseUrl: "https://prototype.test/v1", apiKey: "k", models: ["m"] });
  setProvider("constructor", { baseUrl: "https://constructor.test/v1", apiKey: "k", models: ["m"] });
  const cfg = readConfig();
  assert.equal(Object.hasOwn(cfg.providers, "__proto__"), true);
  assert.equal(cfg.providers.__proto__.baseUrl, "https://prototype.test/v1");
  assert.equal(cfg.providers.constructor.baseUrl, "https://constructor.test/v1");
  removeProvider("__proto__");
  removeProvider("constructor");
});

test("an unknown provider never borrows OpenAI credentials or its endpoint", () => {
  const oldKey = process.env.OPENAI_API_KEY;
  const oldBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_API_KEY = "must-not-leak";
  process.env.OPENAI_BASE_URL = "https://openai-proxy.test/v1";
  try {
    const cfg = resolveConfig({ provider: "opneai", model: "some-model" });
    assert.equal(cfg.baseUrl, "");
    assert.equal(cfg.apiKey, "");
    assert.equal(cfg.configured, false);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = oldBase;
  }
});

test("a corrupt config is reported instead of being silently overwritten", () => {
  const file = path.join(home, "config.json");
  const valid = fs.readFileSync(file, "utf8");
  try {
    fs.writeFileSync(file, "{not valid json");
    assert.throws(() => readConfig(), /could not read config.*config\.json/i);
    fs.writeFileSync(file, "[]");
    assert.throws(() => readConfig(), /root must be an object/i);
    fs.writeFileSync(file, JSON.stringify({ providers: { broken: { models: "not-an-array" } } }));
    assert.throws(() => readConfig(), /models must be an array of strings/i);
  } finally {
    fs.writeFileSync(file, valid);
  }
});

test("model metadata belongs to the selected preset model", () => {
  const cfg = resolveConfig({ provider: "openai", model: "gpt-4.1", apiKey: "key" });
  assert.equal(cfg.contextWindow, 1_000_000);
  assert.equal(cfg.maxTokens, 32_000);
});

test("only actual loopback hosts are treated as keyless local endpoints", () => {
  const local = resolveConfig({ provider: "custom", model: "m", baseUrl: "http://127.0.0.2:1234/v1" });
  const lookalike = resolveConfig({ provider: "custom", model: "m", baseUrl: "https://localhost.example.com/v1" });
  assert.equal(local.configured, true);
  assert.equal(lookalike.configured, false);
});
