/**
 * Imported first by every test file that touches the filesystem.
 *
 * `src/paths.ts` reads RAW_HOME when it is first imported, so this module has to
 * run before anything else — ESM evaluates imports in order, which is why the
 * assignment lives here instead of in the test file itself.
 *
 * The rule this enforces: tests must never read or write the real ~/.raw.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RAW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "raw-test-home-"));

// ambient configuration from the developer's machine must not leak in
for (const key of ["RAW_PROVIDER", "RAW_MODEL", "RAW_BASE_URL", "RAW_API_KEY", "RAW_API", "RAW_PROXY", "RAW_NO_PROXY"]) {
  delete process.env[key];
}
