import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One place for every on-disk location.
 *
 * Data layout (all under ~/.raw unless RAW_HOME is set):
 *   config.json      providers + API keys (0600 on POSIX)
 *   sessions/        saved conversations
 *   notes/           things the agent learned, reusable across runs
 *   downloads/       files the browser downloaded
 *   browser-profile/ persistent Chrome/Edge profile (keeps you logged in)
 */
export const APP_NAME = "raw";
export const CONFIG_DIR = process.env.RAW_HOME || path.join(os.homedir(), `.${APP_NAME}`);
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const SESSION_DIR = path.join(CONFIG_DIR, "sessions");
export const NOTES_DIR = path.join(CONFIG_DIR, "notes");
export const DOWNLOAD_DIR = process.env.RAW_DOWNLOAD_DIR || path.join(CONFIG_DIR, "downloads");
export const BROWSER_PROFILE = process.env.RAW_BROWSER_PROFILE || path.join(CONFIG_DIR, "browser-profile");

/** directories used by earlier names of this tool */
const LEGACY_DIRS = [".tabula", ".mini-agent"].map((d) => path.join(os.homedir(), d));

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Replace a JSON file atomically so interruption cannot leave half a document. */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode });
    fs.renameSync(temp, file);
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* Windows does not implement POSIX permission bits */
    }
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      /* best effort cleanup */
    }
  }
}

/** move an old data directory into place on first run */
export function migrateLegacyDir(): boolean {
  try {
    if (fs.existsSync(CONFIG_DIR)) return false;
    for (const legacy of LEGACY_DIRS) {
      if (fs.existsSync(legacy)) {
        fs.renameSync(legacy, CONFIG_DIR);
        return true;
      }
    }
  } catch {
    /* best effort */
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * config store
 * ------------------------------------------------------------------ */

export type StoredProvider = {
  apiKey?: string;
  baseUrl?: string;
  api?: string;
  label?: string;
  /** model ids the user picked, most-preferred first */
  models?: string[];
  /** user override for the model's context window */
  contextWindow?: number;
};

export type StoredConfig = {
  active?: { provider?: string; model?: string };
  providers?: Record<string, StoredProvider>;
};

export function readConfig(): StoredConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as any;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("root must be an object");
    if (raw.active !== undefined) {
      if (!raw.active || typeof raw.active !== "object" || Array.isArray(raw.active)) throw new Error("active must be an object");
      if (raw.active.provider !== undefined && typeof raw.active.provider !== "string") throw new Error("active.provider must be a string");
      if (raw.active.model !== undefined && typeof raw.active.model !== "string") throw new Error("active.model must be a string");
    }
    if (raw.providers !== undefined && (!raw.providers || typeof raw.providers !== "object" || Array.isArray(raw.providers))) {
      throw new Error("providers must be an object");
    }
    for (const [name, provider] of Object.entries(raw.providers ?? {}) as [string, any][]) {
      if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error(`provider ${name} must be an object`);
      for (const field of ["apiKey", "baseUrl", "api", "label"] as const) {
        if (provider[field] !== undefined && typeof provider[field] !== "string") throw new Error(`provider ${name}.${field} must be a string`);
      }
      if (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some((m: unknown) => typeof m !== "string"))) {
        throw new Error(`provider ${name}.models must be an array of strings`);
      }
      if (provider.contextWindow !== undefined &&
          (!Number.isSafeInteger(provider.contextWindow) || provider.contextWindow < 1_024 || provider.contextWindow > 100_000_000)) {
        throw new Error(`provider ${name}.contextWindow must be an integer between 1024 and 100000000`);
      }
    }
    raw.providers = Object.assign(Object.create(null), raw.providers ?? {});
    return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read config ${CONFIG_FILE}: ${detail}`);
  }
}

export function writeConfig(cfg: StoredConfig) {
  writeJsonAtomic(CONFIG_FILE, cfg);
}

export function setProvider(name: string, provider: StoredProvider) {
  const cfg = readConfig();
  const providers = Object.assign(Object.create(null), cfg.providers ?? {});
  const previous = Object.hasOwn(providers, name) ? providers[name] : undefined;
  providers[name] = { ...previous, ...provider };
  cfg.providers = providers;
  writeConfig(cfg);
}

export function setActive(provider: string, model?: string) {
  const cfg = readConfig();
  cfg.active = { provider, model };
  writeConfig(cfg);
}

export function removeProvider(name: string) {
  const cfg = readConfig();
  if (cfg.providers && Object.hasOwn(cfg.providers, name)) delete cfg.providers[name];
  if (cfg.active?.provider === name) cfg.active = undefined;
  writeConfig(cfg);
}

/** hide everything but the ends of a secret */
export function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 12) return key.slice(0, 3) + "…";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
