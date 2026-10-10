import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Browser-runtime storage locations. The model/agent config store was removed. */
export const APP_NAME = "raw";
export const CONFIG_DIR = process.env.RAW_HOME || path.join(os.homedir(), `.${APP_NAME}`);
export const DOWNLOAD_DIR = process.env.RAW_DOWNLOAD_DIR || path.join(CONFIG_DIR, "downloads");
export const BROWSER_PROFILE = process.env.RAW_BROWSER_PROFILE || path.join(CONFIG_DIR, "browser-profile");

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}
