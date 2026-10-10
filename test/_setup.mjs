/** Keep browser tests isolated from the user's real ~/.raw profile. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RAW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "raw-browser-test-home-"));
