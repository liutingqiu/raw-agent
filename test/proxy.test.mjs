import { test } from "node:test";
import assert from "node:assert/strict";

const { maskProxyUrl, resolveProxy } = await import("../src/proxy.ts");

async function withRawProxy(value, run) {
  const previous = process.env.RAW_PROXY;
  process.env.RAW_PROXY = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.RAW_PROXY;
    else process.env.RAW_PROXY = previous;
  }
}

test("explicit proxy settings are normalized and disable values are case insensitive", async () => {
  assert.equal(await withRawProxy(" OFF ", () => resolveProxy()), null);
  assert.deepEqual(
    await withRawProxy("127.0.0.1:7890", () => resolveProxy()),
    { url: "http://127.0.0.1:7890", source: "env" },
  );
});

test("unsupported proxy protocols fail clearly", async () => {
  await assert.rejects(withRawProxy("socks5://127.0.0.1:1080", () => resolveProxy()), /unsupported proxy protocol/);
});

test("proxy credentials are masked for status output", () => {
  const shown = maskProxyUrl("http://alice:secret@127.0.0.1:7890");
  assert.doesNotMatch(shown, /alice|secret/);
  assert.match(shown, /127\.0\.0\.1:7890/);
});
