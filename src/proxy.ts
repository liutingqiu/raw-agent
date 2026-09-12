/**
 * Proxy support.
 *
 * Node's built-in fetch only honours HTTP(S)_PROXY when the process is started
 * with --use-env-proxy, so when a proxy applies we re-exec once with that flag.
 *
 * Resolution order:
 *   1. RAW_PROXY (or HTTPS_PROXY / ALL_PROXY), unless set to "off"
 *   2. in an interactive terminal only: a proxy listening on a well-known
 *      local port — announced, and disabled with RAW_PROXY=off
 * Set RAW_NO_PROXY=1 to skip both.
 */
import net from "node:net";
import { spawnSync } from "node:child_process";

// Only ports commonly used for HTTP proxy listeners. A SOCKS-only 1080 socket
// cannot be consumed by Node's environment proxy agent and must not be guessed.
const COMMON_PORTS = [7890, 7897, 10809, 10808];
const FLAG = "--use-env-proxy";

function portOpen(port: number, host = "127.0.0.1", timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export type ProxyChoice = { url: string; source: "env" | "detected" };

export async function resolveProxy(): Promise<ProxyChoice | null> {
  const explicit =
    process.env.RAW_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy;

  if (explicit) {
    const value = explicit.trim();
    if (["off", "0", "none"].includes(value.toLowerCase())) return null;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`invalid proxy URL "${value}"`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`unsupported proxy protocol "${parsed.protocol}" (use http:// or https://)`);
    }
    return { url: parsed.href.replace(/\/$/, ""), source: "env" };
  }

  // Sniff only when a human is plausibly watching (a one-shot `raw -p "..."` from
  // a shell still counts); CI and pipes get no surprises.
  if (!process.stdin.isTTY && !process.stdout.isTTY) return null;

  for (const port of COMMON_PORTS) {
    if (await portOpen(port)) return { url: `http://127.0.0.1:${port}`, source: "detected" };
  }
  return null;
}

/**
 * Returns whether this process already has proxy support. Never returns when it
 * re-execs: the parent exits and the child takes over.
 */
export async function ensureProxy(): Promise<boolean> {
  if (process.execArgv.includes(FLAG)) return true;
  if (process.env.RAW_NO_PROXY === "1") return false;

  const choice = await resolveProxy();
  if (!choice) return false;

  const script = process.argv[1];
  if (!script) return false;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTP_PROXY: choice.url,
    HTTPS_PROXY: choice.url,
    ALL_PROXY: choice.url,
    NO_PROXY: process.env.NO_PROXY ?? "localhost,127.0.0.1,::1",
    RAW_PROXY: choice.url,
    RAW_PROXY_SOURCE: choice.source,
  };

  // --use-env-proxy drags in undici's experimental EnvHttpProxyAgent, whose warning
  // would otherwise print on every single start
  const child = spawnSync(
    process.execPath,
    [FLAG, "--disable-warning=UNDICI-EHPA", ...process.execArgv, script, ...process.argv.slice(2)],
    {
      env,
      stdio: "inherit",
    },
  );
  if (child.error) throw new Error(`could not restart raw with proxy support: ${child.error.message}`);
  process.exit(child.status ?? 1);
}

export function proxyInUse(): string | null {
  if (!process.execArgv.includes(FLAG)) return null;
  const value = process.env.HTTPS_PROXY ?? process.env.ALL_PROXY;
  return value ? maskProxyUrl(value) : null;
}

export function maskProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    return url.href.replace(/\/$/, "");
  } catch {
    return "(configured)";
  }
}
