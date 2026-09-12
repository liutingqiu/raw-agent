/**
 * Provider setup: pick a preset, paste a key, pick a model from the live
 * /models list, done. Everything lands in the platform config directory
 * (0600 on POSIX; inherited user-directory ACLs on Windows).
 */
import { bold, cyan, dim, green, red, yellow } from "./util.ts";
import { PRESETS, findPreset, type Preset } from "./presets.ts";
import { maskKey, readConfig, removeProvider, setActive, setProvider, CONFIG_FILE } from "./paths.ts";
import { makeAsker, choose, type Asker } from "./input.ts";
import { isLocalEndpoint, parseTokenCount, type ApiKind } from "./api.ts";

export type Endpoint = { baseUrl: string; api: ApiKind; apiKey: string };

/**
 * The upstream wire formats raw can speak. Anything else (Gemini's native
 * generateContent, for example) has to go through the provider's OpenAI- or
 * Anthropic-compatible endpoint.
 */
export const API_CHOICES: { id: ApiKind; label: string; note: string }[] = [
  {
    id: "openai-completions",
    label: "OpenAI Chat Completions",
    note: "the lingua franca — most gateways and most providers",
  },
  { id: "openai-responses", label: "OpenAI Responses API", note: "OpenAI's newer API" },
  { id: "anthropic-messages", label: "Anthropic Messages (native)", note: "Claude models, raw Anthropic API" },
];

export function apiLabel(api: ApiKind): string {
  return API_CHOICES.find((c) => c.id === api)?.label ?? api;
}

async function readModelListBody(res: Response): Promise<string> {
  const limit = 8 * 1024 * 1024;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("model list exceeds 8 MiB");
  if (!res.body) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) throw new Error("model list exceeds 8 MiB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Ask a provider for the models it serves. Falls back to nothing on failure. */
export async function fetchModels(ep: Endpoint): Promise<string[]> {
  const base = ep.baseUrl.replace(/\/+$/, "");
  const url = ep.api === "anthropic-messages"
    ? `${base}${base.endsWith("/v1") ? "" : "/v1"}/models`
    : `${base}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (ep.api === "anthropic-messages") {
    headers["x-api-key"] = ep.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (ep.apiKey) {
    headers.authorization = `Bearer ${ep.apiKey}`;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  let text: string;
  try {
    text = await readModelListBody(res);
  } catch (err) {
    throw new Error(`${url} → ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`${url} → HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`.trim());
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${url} → invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rows = json?.data ?? json?.models ?? (Array.isArray(json) ? json : []);
  return rows
    .map((m: any) => (typeof m === "string" ? m : (m?.id ?? m?.name)))
    .filter((x: any): x is string => typeof x === "string" && x.length > 0)
    .sort();
}

/* ------------------------------------------------------------------ *
 * `raw providers`
 * ------------------------------------------------------------------ */

export function printProviders(verbose = false) {
  const cfg = readConfig();
  const configured = Object.keys(cfg.providers ?? {});

  console.log(bold("\nconfigured"));
  if (!configured.length) {
    console.log(dim("  (none yet — run: raw setup)"));
  } else {
    for (const name of configured) {
      const p = cfg.providers![name]!;
      const active = cfg.active?.provider === name;
      const preset = findPreset(name);
      const models = p.models?.length ? p.models : preset?.models.map((m) => m.id) ?? [];
      console.log(
        `  ${active ? green("●") : " "} ${cyan(name.padEnd(12))} ${dim(maskKey(p.apiKey))} ${dim(p.baseUrl ?? preset?.baseUrl ?? "")}`,
      );
      if (models.length) console.log(dim(`      ${models.slice(0, 4).join(", ")}${models.length > 4 ? " …" : ""}`));
    }
  }

  if (verbose) {
    console.log(bold("\nbuilt-in presets"));
    for (const p of PRESETS) {
      const mark = cfg.providers?.[p.id] ? green("*") : " ";
      console.log(`  ${mark} ${cyan(p.id.padEnd(12))} ${p.name.padEnd(28)} ${dim(p.baseUrl)}`);
    }
    console.log(dim("\n  * = already configured"));
  }
  console.log(dim(`\n  config: ${CONFIG_FILE}`));
  console.log(dim(`  set up:  raw setup        switch: /provider <name>  (inside the CLI)`));
}

/* ------------------------------------------------------------------ *
 * `raw setup [provider] [--key ..] [--model ..] [--base-url ..]`
 * ------------------------------------------------------------------ */

function parseSetupArgs(argv: string[]) {
  const o: { provider?: string; key?: string; model?: string; baseUrl?: string; api?: string; contextWindow?: string; list?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`missing value for ${a}`);
      return next;
    };
    if (a === "--key" || a === "-k") o.key = value();
    else if (a === "--model" || a === "-m") o.model = value();
    else if (a === "--base-url") o.baseUrl = value();
    else if (a === "--api") o.api = value();
    else if (a === "--context-window") o.contextWindow = value();
    else if (a === "--list") o.list = true;
    else if (!a.startsWith("-")) o.provider ??= a;
    else throw new Error(`unknown setup option: ${a}`);
  }
  return o;
}

export async function runSetup(argv: string[]): Promise<void> {
  let opts: ReturnType<typeof parseSetupArgs>;
  try {
    opts = parseSetupArgs(argv);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 2;
    return;
  }
  const requestedContextWindow = parseTokenCount(opts.contextWindow);
  if (opts.contextWindow !== undefined && requestedContextWindow === undefined) {
    console.error(red("--context-window must be between 1024 and 100m tokens (for example 128k or 1m)"));
    process.exitCode = 2;
    return;
  }
  if (opts.list) {
    printProviders(true);
    return;
  }

  const interactive = process.stdin.isTTY === true;
  if (!interactive && !opts.provider) {
    console.error(red("a provider is required in non-interactive setup"));
    process.exitCode = 2;
    return;
  }
  const ask: Asker = makeAsker();
  try {
    let preset: Preset | undefined;
    let name: string;
    let custom: { baseUrl: string; api: ApiKind } | null = null;

    if (opts.provider) {
      preset = findPreset(opts.provider);
      name = preset?.id ?? opts.provider.trim();
      if (!name) {
        console.error(red("provider name cannot be empty"));
        process.exitCode = 2;
        return;
      }
      if (!preset && !opts.baseUrl) {
        console.error(red(`unknown provider "${opts.provider}". Known: ${PRESETS.map((p) => p.id).join(", ")}`));
        console.error(dim("pass --base-url and --api to define a custom one"));
        process.exitCode = 2;
        return;
      }
    } else {
      console.log(bold("\nwhich provider?"));
      PRESETS.forEach((p, i) => {
        console.log(`  ${String(i + 1).padStart(3)}. ${cyan(p.id.padEnd(12))} ${p.name}`);
      });
      const answer = (await ask.question(`\n  number or id (or "custom"): `)).trim();
      const asNumber = Number(answer);
      preset = Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= PRESETS.length ? PRESETS[asNumber - 1] : findPreset(answer);
      if (preset) {
        name = preset.id;
      } else {
        name = (answer && answer !== "custom" ? answer.trim() : (await ask.question("  name for this provider: ")).trim()) || "custom";
        console.log(bold(`\n  custom provider ${cyan(name)}`));
        const baseUrl = (await ask.question("  base URL (e.g. https://api.example.com/v1): ")).trim();
        if (!baseUrl) {
          console.error(red("  a base URL is required"));
          return;
        }
        console.log(bold("\n  upstream API format"));
        API_CHOICES.forEach((c, i) => {
          console.log(`  ${String(i + 1).padStart(3)}. ${cyan(c.id.padEnd(20))} ${c.label}
       ${dim(c.note)}`);
        });
        const picked = (await ask.question(`  select [1-${API_CHOICES.length}] (default 1): `)).trim();
        const n = Number(picked);
        const chosen = API_CHOICES[Number.isInteger(n) && n >= 1 && n <= API_CHOICES.length ? n - 1 : 0];
        custom = { baseUrl, api: chosen.id };
        console.log(dim(`  → speaking ${apiLabel(chosen.id)}`));
      }
    }

    const baseUrl = (opts.baseUrl ?? custom?.baseUrl ?? preset?.baseUrl ?? "").trim();
    if (!baseUrl) {
      console.error(red("no base URL"));
      process.exitCode = 2;
      return;
    }
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      console.error(red(`invalid base URL "${baseUrl}" (expected http:// or https://)`));
      process.exitCode = 2;
      return;
    }
    const api = normalizeApi(opts.api ?? custom?.api ?? preset?.api ?? "openai-completions");
    if (opts.api && !API_CHOICES.some((c) => c.id === opts.api)) {
      console.error(red(`unsupported --api "${opts.api}"`));
      for (const c of API_CHOICES) console.error(dim(`  ${c.id.padEnd(20)} ${c.label}`));
      process.exitCode = 2;
      return;
    }

    const storedProvider = readConfig().providers?.[name];
    let keyFromEnv = !opts.key && Boolean(preset?.env && process.env[preset.env]);
    let apiKey = opts.key ?? (preset?.env ? process.env[preset.env] : undefined) ?? storedProvider?.apiKey ?? "";
    if (!isLocalEndpoint(baseUrl) && !apiKey) {
      if (!interactive) {
        console.error(red("no API key (pass --key or set the provider's env var)"));
        process.exitCode = 2;
        return;
      }
      if (preset?.keyUrl) console.log(dim(`\n  get one at ${preset.keyUrl}`));
      apiKey = (await ask.secret(`  API key for ${name}: `)).trim();
      keyFromEnv = false;
      if (!apiKey) {
        console.error(red("no API key — aborted"));
        process.exitCode = 2;
        return;
      }
    }

    console.log(dim(`\n  verifying ${baseUrl} …`));
    let live: string[] = [];
    try {
      live = await fetchModels({ baseUrl, api, apiKey });
      console.log(green(`  ok — ${live.length} models available`));
    } catch (err) {
      console.log(yellow(`  could not list models: ${err instanceof Error ? err.message : String(err)}`));
      console.log(dim(interactive ? "  (choose or enter a model id to continue)" : "  (the explicit --model value will still be saved)"));
    }

    const fallback = preset?.models.map((m) => m.id) ?? [];
    const candidates = live.length ? live : fallback;
    let model = opts.model ?? "";

    if (!model && candidates.length) {
      if (interactive) {
        console.log(bold("\npick a default model"));
        const shown = candidates.slice(0, 40);
        const picked = await choose(ask, shown, (m) => m);
        model = picked ?? (await ask.question("  model id: ")).trim();
      } else {
        console.error(red("no model selected (pass --model <id> in non-interactive setup)"));
        process.exitCode = 2;
        return;
      }
    } else if (!model) {
      if (interactive) model = (await ask.question("  model id: ")).trim();
      else {
        console.error(red("no model selected (pass --model <id> in non-interactive setup)"));
        process.exitCode = 2;
        return;
      }
    }

    if (!model) {
      console.error(red("no model selected — aborted"));
      process.exitCode = 2;
      return;
    }
    const existing = storedProvider?.models ?? [];
    const models = [model, ...existing.filter((m) => m !== model), ...fallback.filter((m) => m !== model)].slice(0, 12);
    const contextWindow = requestedContextWindow ?? storedProvider?.contextWindow;

    setProvider(name, { apiKey: keyFromEnv ? storedProvider?.apiKey : (apiKey || undefined), baseUrl, api, models, contextWindow });
    setActive(name, model);

    console.log(`\n${green("✔")} saved ${cyan(name)} → ${cyan(model)}`);
    if (contextWindow) console.log(dim(`  context window: ${contextWindow.toLocaleString("en-US")} tokens`));
    console.log(dim(`  ${CONFIG_FILE}`));
    console.log(dim(`  run:  raw            (or)  raw -m ${model}`));
    if (preset?.env && !process.env[preset.env]) {
      console.log(dim(`  tip: some tools read ${preset.env}; you can also export it instead of storing the key`));
    }
  } finally {
    ask.close();
  }
}

function normalizeApi(s: string): ApiKind {
  if (s === "openai-responses") return "openai-responses";
  if (s === "anthropic-messages" || s === "anthropic") return "anthropic-messages";
  return "openai-completions";
}

/* ------------------------------------------------------------------ *
 * `/provider` + `/connect` inside the CLI
 * ------------------------------------------------------------------ */

export function listConfigured(): { name: string; active: boolean; models: string[] }[] {
  const cfg = readConfig();
  return Object.entries(cfg.providers ?? {}).map(([name, p]) => ({
    name,
    active: cfg.active?.provider === name,
    models: p.models ?? findPreset(name)?.models.map((m) => m.id) ?? [],
  }));
}

export function forgetProvider(name: string): boolean {
  const cfg = readConfig();
  if (!cfg.providers || !Object.hasOwn(cfg.providers, name)) return false;
  removeProvider(name);
  return true;
}
