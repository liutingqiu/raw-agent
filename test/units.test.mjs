import { test } from "node:test";
import assert from "node:assert/strict";

import { diffPreview, estimateTokens, isInside, oneline, resolvePath, truncate } from "../src/util.ts";
import { decodeBingUrl, decodeEntities, htmlToText, webFetch } from "../src/web.ts";
import { maskKey } from "../src/paths.ts";
import { PRESETS, findPreset } from "../src/presets.ts";

/* ------------------------------- util ------------------------------- */

test("truncate keeps both ends and marks what it dropped", () => {
  assert.equal(truncate("short", 100), "short");
  const out = truncate("a".repeat(500), 100);
  assert.ok(out.startsWith("a".repeat(10)));
  assert.ok(out.endsWith("a".repeat(10)));
  assert.match(out, /400 chars omitted/);
});

test("diffPreview shows the changed lines and a hunk header", () => {
  const out = diffPreview("one\ntwo\nthree", "one\nTWO\nthree");
  assert.match(out, /- two/);
  assert.match(out, /\+ TWO/);
  assert.match(out, /@@ -2,1 \+2,1 @@/);
});

test("diffPreview handles pure insertions", () => {
  const out = diffPreview("a\nb", "a\nx\nb");
  assert.match(out, /\+ x/);
  assert.match(out, /@@ -2,0 \+2,1 @@/);
});

test("path helpers keep targets inside the root", () => {
  const root = process.platform === "win32" ? "C:\\work" : "/work";
  assert.ok(isInside(root, resolvePath("sub/file.txt", root)));
  assert.ok(!isInside(root, resolvePath("../escape.txt", root)));
  assert.ok(isInside(root, resolvePath(root, root)));
});

test("estimateTokens is roughly 4 characters per token", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("oneline flattens whitespace and clips", () => {
  assert.equal(oneline("  a\n\n b  "), "a b");
  assert.ok(oneline("x".repeat(50), 10).endsWith("…"));
});

/* -------------------------------- web -------------------------------- */

test("decodeEntities handles named, decimal and hex entities", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt;"), "a & b <c>");
  assert.equal(decodeEntities("&#65;&#x42;"), "AB");
  assert.equal(decodeEntities("&unknownthing;"), "&unknownthing;");
});

test("decodeBingUrl unwraps the /ck/a redirect and passes plain urls through", () => {
  assert.equal(decodeBingUrl("https://example.com/x"), "https://example.com/x");
  const wrapped = "https://www.bing.com/ck/a?!&&p=1&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9oZWxsbw";
  assert.equal(decodeBingUrl(wrapped), "https://example.com/hello");
});

test("htmlToText drops scripts, keeps links, headings and lists", () => {
  const html = `\n    <html><head><title>T</title><style>body{color:red}</style></head>
    <body>
      <script>var secret = 1;</script>
      <h1>Title</h1>
      <p>Hello <a href="/rel">world</a></p>
      <ul><li>one</li><li>two</li></ul>
    </body></html>`;
  const text = htmlToText(html, "https://site.test/page");
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("color:red"));
  assert.match(text, /# Title/);
  assert.match(text, /\[world\]\(https:\/\/site\.test\/rel\)/);
  assert.match(text, /- one/);
  assert.match(text, /- two/);
});

test("webFetch returns readable content and honours maxChars", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>Hello</h1><p>abcdefghijk</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const result = await webFetch(`http://127.0.0.1:${address.port}`, { maxChars: 8 });
    assert.match(result.text, /chars omitted/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("webFetch respects a legacy Chinese response charset", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=gbk" });
    res.end(Buffer.concat([Buffer.from("<p>"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from("</p>")]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const result = await webFetch(`http://127.0.0.1:${address.port}`);
    assert.equal(result.text, "中文");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ------------------------------ presets ------------------------------ */

test("every preset is well formed and uniquely named", () => {
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(p.id && !ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
    assert.match(p.baseUrl, /^https?:\/\//, `${p.id} baseUrl`);
    assert.ok(p.models.length > 0, `${p.id} has models`);
    assert.ok(p.name, `${p.id} has a name`);
  }
});

test("findPreset is case insensitive and tolerates unknown names", () => {
  assert.equal(findPreset("DeepSeek")?.id, "deepseek");
  assert.equal(findPreset("  ANTHROPIC ")?.id, "anthropic");
  assert.equal(findPreset("does-not-exist"), undefined);
});

/* ------------------------------- secret ------------------------------ */

test("maskKey never reveals the middle of a key", () => {
  assert.equal(maskKey(undefined), "(none)");
  assert.equal(maskKey("short"), "sho…");
  const masked = maskKey("sk-1234567890abcdefghij");
  assert.ok(masked.startsWith("sk-123"));
  assert.ok(masked.endsWith("ghij"));
  assert.ok(!masked.includes("4567890abc"));
});
