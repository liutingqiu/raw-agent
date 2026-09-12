import "./_setup.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { readImageFile } = await import("../src/clipboard.ts");

test("local images are identified by bytes rather than filename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-image-test-"));
  try {
    const disguised = path.join(dir, "actually-png.jpg");
    fs.writeFileSync(disguised, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32),
    ]));
    const image = readImageFile(disguised);
    assert.equal(image.ok, true);
    assert.equal(image.image.mime, "image/png");

    const fake = path.join(dir, "fake.png");
    fs.writeFileSync(fake, "this is plain text padded beyond thirty-two bytes");
    assert.equal(readImageFile(fake).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("quoted image paths are accepted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-quoted-image-test-"));
  try {
    const file = path.join(dir, "image with spaces.png");
    fs.writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1DEAAAAALUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    assert.equal(readImageFile(`"${file}"`).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
