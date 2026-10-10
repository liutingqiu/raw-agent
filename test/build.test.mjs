import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const build = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", build], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

test("parallel builds publish one complete dist directory", async () => {
  const results = await Promise.all([runBuild(), runBuild(), runBuild(), runBuild()]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  for (const required of ["browser-cli.js", "browser.js", "paths.js", "util.js", "page-helpers.js"]) {
    assert.equal(fs.existsSync(new URL(`../dist/${required}`, import.meta.url)), true, required);
  }
});
