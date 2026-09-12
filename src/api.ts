import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { truncate } from "./util.ts";
import { readConfig } from "./paths.ts";
import { findPreset } from "./presets.ts";
import type { ToolSpec, ImagePart } from "./tools.ts";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type ToolCall = { id: string; name: string; arguments: string };

export type Msg =
  | { role: "user"; content: string; images?: ImagePart[] }
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; providerItems?: unknown[] }
  | { role: "tool"; toolCallId: string; content: string; images?: ImagePart[] };

export type ApiKind = "openai-completions" | "openai-responses" | "anthropic-messages";
export type ConfigSource = "flags" | "env" | "config" | "pi" | "preset" | "none";

export type AgentConfig = {
  provider: string;
  model: string;
  configured: boolean;
  source: ConfigSource;
  baseUrl: string;
  apiKey: string;
  api: ApiKind;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  reasoningEffort?: string;
};

export type StreamHandlers = {
  onText?: (t: string) => void;
  onReasoning?: (t: string) => void;
  onToolCallStart?: (name: string) => void;
};

export type TurnResult = {
  text: string;
  toolCalls: ToolCall[];
  /** Opaque protocol state that must be replayed on the next Responses API turn. */
  providerItems?: unknown[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  finishReason?: string;
};

/* ------------------------------------------------------------------ *
 * Provider config: read the same models.json that pi uses
 * ------------------------------------------------------------------ */

type ProviderEntry = {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: { id: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }[];
};

export function loadProviders(file = path.join(os.homedir(), ".pi", "agent", "models.json")): Record<string, ProviderEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { providers?: Record<string, ProviderEntry> };
    return raw.providers ?? {};
  } catch {
    return {};
  }
}

function normalizeApi(s: string | undefined): ApiKind {
  if (s === "openai-responses") return "openai-responses";
  if (s === "anthropic-messages" || s === "anthropic") return "anthropic-messages";
  return "openai-completions";
}

export type ResolveOptions = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  reasoningEffort?: string;
};

const configuredApiResponseBytes = Number(process.env.RAW_MAX_API_RESPONSE_BYTES);
const MAX_API_RESPONSE_BYTES = Number.isFinite(configuredApiResponseBytes) && configuredApiResponseBytes > 0
  ? Math.max(1024, Math.floor(configuredApiResponseBytes))
  : 64 * 1024 * 1024;

export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Config precedence (highest first):
 *   CLI flags > RAW_* env vars > ~/.raw/config.json > built-in preset
 *   > pi's models.json > OPENAI_ env vars
 * Notes: the user's saved setup wins over pi's injected PI_PROVIDER/PI_MODEL,
 * and key-based env vars are only consulted for their own provider.
 */
export function resolveConfig(opts: ResolveOptions): AgentConfig {
  const stored = readConfig();
  const piProviders = loadProviders();
  const configured = Object.keys(stored.providers ?? {});

  const providerName =
    opts.provider ??
    process.env.RAW_PROVIDER ??
    stored.active?.provider ??
    (configured.length === 1 ? configured[0] : undefined) ??
    process.env.PI_PROVIDER ??
    "openai";

  const preset = findPreset(providerName);
  const storedP = stored.providers?.[providerName];
  const piP = piProviders[providerName];

  const baseUrl = (
    opts.baseUrl ??
    process.env.RAW_BASE_URL ??
    storedP?.baseUrl ??
    preset?.baseUrl ??
    piP?.baseUrl ??
    (providerName === "openai" ? (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1") : "")
  ).replace(/\/+$/, "");

  const api = normalizeApi(opts.api ?? process.env.RAW_API ?? storedP?.api ?? preset?.api ?? piP?.api);

  const apiKey =
    opts.apiKey ??
    process.env.RAW_API_KEY ??
    storedP?.apiKey ??
    (preset?.env ? process.env[preset.env] : undefined) ??
    piP?.apiKey ??
    (providerName === "openai" ? process.env.OPENAI_API_KEY : undefined) ??
    "";

  // pi's model belongs to pi's provider: if the user named a different provider
  // explicitly, borrowing PI_MODEL would silently pick the wrong model
  const providerWasExplicit = Boolean(opts.provider ?? process.env.RAW_PROVIDER);
  const model =
    opts.model ??
    process.env.RAW_MODEL ??
    (stored.active?.provider === providerName ? stored.active?.model : undefined) ??
    (providerWasExplicit ? undefined : process.env.PI_MODEL) ??
    storedP?.models?.[0] ??
    // deliberately NOT preset.models[0]: a preset's list is a menu for the setup
    // wizard, never a default. Showing a model the user never chose is exactly
    // the kind of opinion this project refuses to have.
    piP?.models?.[0]?.id ??
    "";

  const meta = preset?.models.find((m) => m.id === model) ?? piP?.models?.find((m) => m.id === model);

  const effort = opts.reasoningEffort ?? process.env.RAW_REASONING_EFFORT ?? mapEffort(process.env.PI_REASONING_LEVEL);

  const isAnthropic = api === "anthropic-messages";
  const isLocal = isLocalEndpoint(baseUrl);
  const usable = Boolean(providerName && model && baseUrl && (apiKey || isLocal));

  const source: ConfigSource = opts.provider || opts.model
    ? "flags"
    : process.env.RAW_PROVIDER || process.env.RAW_MODEL
      ? "env"
      : storedP
        ? "config"
        : piP
          ? "pi"
          : preset
            ? "preset"
            : "none";

  return {
    provider: providerName,
    model,
    configured: usable,
    source,
    baseUrl,
    apiKey,
    api,
    reasoning: meta?.reasoning ?? !isAnthropic,
    contextWindow: meta?.contextWindow ?? (isAnthropic ? 200_000 : 128_000),
    maxTokens: meta?.maxTokens ?? (isAnthropic ? 32_000 : 32_000),
    reasoningEffort: effort,
  };
}

function mapEffort(level: string | undefined): string | undefined {
  if (!level) return undefined;
  if (level === "minimal" || level === "none") return "low";
  if (level === "low" || level === "medium" || level === "high") return level;
  if (level === "max" || level === "xhigh") return "high";
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Wire format helpers
 * ------------------------------------------------------------------ */

function endpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const clean = suffix.replace(/^\/+/, "");
  if (base.endsWith("/" + clean)) return base;
  if (base.endsWith("/v1") && clean.startsWith("v1/")) return `${base}/${clean.slice(3)}`;
  return `${base}/${clean}`;
}

function headers(cfg: AgentConfig): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
  };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

function toCompletionsMessages(messages: Msg[]) {
  const out: any[] = [];
  let toolImages: ImagePart[] = [];
  const flushToolImages = () => {
    if (!toolImages.length) return;
    out.push({
      role: "user",
      content: toolImages.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mime};base64,${image.data}` },
      })),
    });
    toolImages = [];
  };

  for (const m of messages) {
    if (m.role === "user") {
      flushToolImages();
      if (!m.images?.length) {
        out.push({ role: "user", content: m.content });
        continue;
      }
      out.push({
        role: "user",
        content: [
          { type: "text", text: m.content },
          ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
        ],
      });
      continue;
    }
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      toolImages.push(...(m.images ?? []));
      continue;
    }
    flushToolImages();
    out.push({
      role: "assistant",
      content: m.content || null,
      ...(m.toolCalls.length
        ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
    });
  }
  flushToolImages();
  return out;
}

function toResponsesInput(messages: Msg[]) {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({
        role: "user",
        content: [
          { type: "input_text", text: m.content },
          ...(m.images ?? []).map((i) => ({ type: "input_image", image_url: `data:${i.mime};base64,${i.data}` })),
        ],
      });
    } else if (m.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: m.images?.length
          ? [
              { type: "input_text", text: m.content },
              ...m.images.map((i) => ({ type: "input_image", image_url: `data:${i.mime};base64,${i.data}` })),
            ]
          : m.content,
      });
    } else {
      if (m.providerItems?.length) {
        items.push(...m.providerItems.filter((item: any) => item?.type === "reasoning"));
      }
      if (m.content) {
        items.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      }
      for (const c of m.toolCalls) {
        items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments });
      }
    }
  }
  return items;
}

function toolPayload(cfg: AgentConfig, tools: ToolSpec[]) {
  if (cfg.api === "anthropic-messages") {
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  if (cfg.api === "openai-responses") {
    return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  }
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/* ------------------------------------------------------------------ *
 * SSE reader
 * ------------------------------------------------------------------ */

async function readSSE(res: Response, onEvent: (data: string) => void): Promise<void> {
  const body = res.body;
  if (!body) return;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_API_RESPONSE_BYTES) {
    throw new Error(`API response is too large (${declared} bytes; limit ${MAX_API_RESPONSE_BYTES})`);
  }
  const decoder = new TextDecoder();
  let buf = "";
  let total = 0;
  let dataLines: string[] = [];
  const dispatch = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data !== "[DONE]") onEvent(data);
  };
  const consume = (line: string) => {
    const clean = line.replace(/\r$/, "");
    if (!clean) return dispatch();
    if (clean.startsWith(":")) return;
    if (clean === "data") dataLines.push("");
    else if (clean.startsWith("data:")) dataLines.push(clean.slice(5).replace(/^ /, ""));
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_API_RESPONSE_BYTES) throw new Error(`API response exceeded ${MAX_API_RESPONSE_BYTES} bytes`);
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      consume(line);
    }
  }
  buf += decoder.decode();
  if (buf) consume(buf);
  dispatch();
}

function debugBody(body: Record<string, unknown>, url: string) {
  if (!process.env.RAW_DEBUG) return;
  console.error(`[debug] POST ${url}`);
  console.error(`[debug] ${JSON.stringify(body).slice(0, 4000)}`);
}

async function readApiText(res: Response, limit = MAX_API_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`API response is too large (${declared} bytes; limit ${limit})`);
  }
  if (!res.body) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) throw new Error(`API response exceeded ${limit} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readApiJson(res: Response): Promise<any> {
  const text = await readApiText(res);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`provider returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const configured = Number(process.env.RAW_API_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 300_000;
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    detail = await readApiText(res, 1024 * 1024);
  } catch {
    detail = "(error response body exceeded 1 MiB)";
  }
  throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? `\n${truncate(detail, 2000)}` : ""}`);
}

/* ------------------------------------------------------------------ *
 * Public: one streaming turn
 * ------------------------------------------------------------------ */

export function isRetryable(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /overloaded|rate.?limit|too many requests|429|500|502|503|504|timeout|timed out|fetch failed|network error|terminated|econnreset|econnrefused|enotfound|etimedout|socket hang up|other side closed|upstream/.test(
    m,
  );
}

export async function streamTurn(
  cfg: AgentConfig,
  messages: Msg[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<TurnResult> {
  const result = cfg.api === "anthropic-messages"
    ? await streamAnthropic(cfg, messages, tools, handlers, signal)
    : cfg.api === "openai-responses"
      ? await streamResponses(cfg, messages, tools, handlers, signal)
      : await streamCompletions(cfg, messages, tools, handlers, signal);
  if (result.finishReason === "length" || result.finishReason === "max_tokens" || result.finishReason === "model_context_window_exceeded") {
    throw new Error(`provider stopped before completing the response (finish reason: ${result.finishReason})`);
  }
  if (!result.text && !result.toolCalls.length) {
    throw new Error(`provider returned no text or tool calls${result.finishReason ? ` (finish reason: ${result.finishReason})` : ""}`);
  }
  return result;
}

async function rejectHtmlResponse(res: Response, contentType: string): Promise<void> {
  if (!contentType.toLowerCase().includes("text/html")) return;
  const detail = truncate(await readApiText(res, 1024 * 1024), 500);
  throw new Error(`provider returned HTML instead of an API response${detail ? `: ${detail}` : ""}`);
}

/* ---------------------------- Anthropic Messages ---------------------------- */

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

/** Anthropic puts tool results in user messages, so consecutive results merge. */
function toAnthropicMessages(messages: Msg[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: [
          ...(m.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
          { type: "text", text: m.content },
        ],
      });
    } else if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.images?.length
          ? [
              { type: "text", text: m.content },
              ...m.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
            ]
          : m.content,
      };
      const last = out[out.length - 1];
      const onlyResults =
        last?.role === "user" && Array.isArray(last.content) && last.content.every((c: any) => c.type === "tool_result");
      if (onlyResults) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else {
      const content: any[] = [];
      const native = (m.providerItems ?? []).filter((item: any) =>
        ["text", "tool_use", "thinking", "redacted_thinking"].includes(item?.type),
      ) as any[];
      if (native.some((item) => item.type === "text" || item.type === "tool_use")) {
        content.push(...native);
      } else {
        content.push(...native);
        if (m.content) content.push({ type: "text", text: m.content });
        for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: safeJson(c.arguments) });
      }
      if (content.length) out.push({ role: "assistant", content });
    }
  }
  return out;
}

async function streamAnthropic(
  cfg: AgentConfig,
  messages: Msg[],
  tools: ToolSpec[],
  h: StreamHandlers,
  signal?: AbortSignal,
): Promise<TurnResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: Math.max(1024, cfg.maxTokens),
    messages: toAnthropicMessages(messages),
    stream: true,
  };
  if (tools.length) {
    body.tools = toolPayload(cfg, tools);
    body.tool_choice = { type: "auto" };
  }
  if (cfg.reasoningEffort && /claude-(?:fable|mythos|opus|sonnet)-(?:5|4-[6-9])/.test(cfg.model)) {
    body.output_config = { effort: cfg.reasoningEffort === "minimal" ? "low" : cfg.reasoningEffort };
    if (/claude-(?:opus|sonnet)-4-[6-9]/.test(cfg.model)) body.thinking = { type: "adaptive" };
  }

  const url = endpoint(cfg.baseUrl, "v1/messages");
  debugBody(body, url);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  });
  await ensureOk(res);

  let text = "";
  let stopReason: string | undefined;
  let usage: TurnResult["usage"];
  const blocks = new Map<number, { id: string; name: string; args: string }>();
  const order: number[] = [];
  const thinking = new Map<number, any>();
  const textBlocks = new Map<number, string>();
  let nativeContent: any[] | undefined;

  const absorb = (ev: any) => {
    switch (ev?.type) {
      case "error":
        throw new Error(ev.error?.message ?? JSON.stringify(ev).slice(0, 400));
      case "message_start":
        if (ev.message?.usage?.input_tokens) usage = { prompt_tokens: ev.message.usage.input_tokens };
        break;
      case "content_block_start": {
        const b = ev.content_block;
        if (b?.type === "tool_use") {
          blocks.set(ev.index, { id: b.id, name: b.name, args: b.input && Object.keys(b.input).length ? JSON.stringify(b.input) : "" });
          order.push(ev.index);
          h.onToolCallStart?.(b.name);
        } else if (b?.type === "text" && b.text) {
          textBlocks.set(ev.index, b.text);
          text += b.text;
          h.onText?.(b.text);
        } else if (b?.type === "thinking" && b.thinking) {
          thinking.set(ev.index, { type: "thinking", thinking: b.thinking, signature: b.signature ?? "" });
          h.onReasoning?.(b.thinking);
        } else if (b?.type === "redacted_thinking") {
          thinking.set(ev.index, b);
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && d.text) {
          textBlocks.set(ev.index, (textBlocks.get(ev.index) ?? "") + d.text);
          text += d.text;
          h.onText?.(d.text);
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
          const b = blocks.get(ev.index);
          if (b) b.args += d.partial_json;
        } else if (d.type === "thinking_delta" && d.thinking) {
          const item = thinking.get(ev.index) ?? { type: "thinking", thinking: "", signature: "" };
          item.thinking += d.thinking;
          thinking.set(ev.index, item);
          h.onReasoning?.(d.thinking);
        } else if (d.type === "signature_delta" && d.signature) {
          const item = thinking.get(ev.index) ?? { type: "thinking", thinking: "", signature: "" };
          item.signature = d.signature;
          thinking.set(ev.index, item);
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens) usage = { ...usage, completion_tokens: ev.usage.output_tokens };
        break;
    }
  };

  const ctype = res.headers.get("content-type") ?? "";
  await rejectHtmlResponse(res, ctype);
  if (ctype.includes("json")) {
    const json: any = await readApiJson(res);
    if (json?.error) throw new Error(json.error.message ?? JSON.stringify(json.error).slice(0, 400));
    nativeContent = Array.isArray(json?.content) ? json.content : undefined;
    for (const b of json?.content ?? []) {
      if (b.type === "text") {
        text += b.text;
        h.onText?.(b.text);
      } else if (b.type === "tool_use") {
        blocks.set(order.length, { id: b.id, name: b.name, args: JSON.stringify(b.input ?? {}) });
        order.push(order.length);
        h.onToolCallStart?.(b.name);
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        thinking.set(thinking.size, b);
        if (b.type === "thinking" && b.thinking) h.onReasoning?.(b.thinking);
      }
    }
    if (json?.usage) usage = { prompt_tokens: json.usage.input_tokens, completion_tokens: json.usage.output_tokens };
    stopReason = json?.stop_reason ?? stopReason;
  } else {
    await readSSE(res, (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      absorb(json);
    });
  }

  const toolCalls: ToolCall[] = order
    .map((k, i) => {
      const b = blocks.get(k)!;
      return { id: b.id || `call_${Date.now()}_${i}`, name: b.name, arguments: b.args || "{}" };
    })
    .filter((c) => c.name);

  const providerItems = nativeContent ?? [...new Set([...textBlocks.keys(), ...thinking.keys(), ...blocks.keys()])]
    .sort((a, b) => a - b)
    .map((index) => {
      if (thinking.has(index)) return thinking.get(index);
      if (blocks.has(index)) {
        const block = blocks.get(index)!;
        return { type: "tool_use", id: block.id, name: block.name, input: safeJson(block.args) };
      }
      return { type: "text", text: textBlocks.get(index) ?? "" };
    });
  return { text, toolCalls, usage, finishReason: stopReason, providerItems: providerItems.length ? providerItems : undefined };
}

/* ---------------------------- Chat Completions ---------------------------- */

async function streamCompletions(
  cfg: AgentConfig,
  messages: Msg[],
  tools: ToolSpec[],
  h: StreamHandlers,
  signal?: AbortSignal,
): Promise<TurnResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: toCompletionsMessages(messages),
    stream: true,
  };
  if (tools.length) {
    body.tools = toolPayload(cfg, tools);
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  if (cfg.reasoning && cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;

  debugBody(body, endpoint(cfg.baseUrl, "chat/completions"));

  const res = await fetch(endpoint(cfg.baseUrl, "chat/completions"), {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  });
  await ensureOk(res);

  let text = "";
  let finishReason: string | undefined;
  let usage: TurnResult["usage"];
  const partial = new Map<number, { id: string; name: string; args: string }>();
  const seenStart = new Set<number>();

  const absorb = (json: any) => {
    if (json?.error) {
      const e = json.error;
      throw new Error(typeof e === "string" ? e : (e?.message ?? JSON.stringify(e)));
    }
    if (json?.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? choice.message ?? {};
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === "string" && r) h.onReasoning?.(r);

    const content = d.content;
    if (typeof content === "string" && content) {
      text += content;
      h.onText?.(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const t = typeof part?.text === "string" ? part.text : "";
        if (t) {
          text += t;
          h.onText?.(t);
        }
      }
    }

    const dcs = d.tool_calls;
    if (Array.isArray(dcs)) {
      for (const dc of dcs) {
        const index = typeof dc.index === "number" ? dc.index : 0;
        const cur = partial.get(index) ?? { id: "", name: "", args: "" };
        if (dc.id) cur.id = dc.id;
        if (dc.function?.name) {
          cur.name = dc.function.name;
          if (!seenStart.has(index)) {
            seenStart.add(index);
            h.onToolCallStart?.(cur.name);
          }
        }
        if (typeof dc.function?.arguments === "string") cur.args += dc.function.arguments;
        partial.set(index, cur);
      }
    }
  };

  const ctype = res.headers.get("content-type") ?? "";
  await rejectHtmlResponse(res, ctype);
  if (ctype.includes("json")) {
    // provider ignored stream:true and answered with a single JSON object
    absorb(await readApiJson(res));
  } else {
    await readSSE(res, (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return; // keep-alive / partial frame
      }
      absorb(json);
    });
  }

  const toolCalls: ToolCall[] = [...partial.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.args || "{}" }))
    .filter((c) => c.name);

  return { text, toolCalls, usage, finishReason };
}

/* ------------------------------ Responses API ----------------------------- */

async function streamResponses(
  cfg: AgentConfig,
  messages: Msg[],
  tools: ToolSpec[],
  h: StreamHandlers,
  signal?: AbortSignal,
): Promise<TurnResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    input: toResponsesInput(messages),
    stream: true,
    store: false,
  };
  if (tools.length) {
    body.tools = toolPayload(cfg, tools);
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  if (cfg.reasoning && cfg.reasoningEffort) body.reasoning = { effort: cfg.reasoningEffort };
  if (cfg.reasoning) body.include = ["reasoning.encrypted_content"];

  debugBody(body, endpoint(cfg.baseUrl, "responses"));

  const res = await fetch(endpoint(cfg.baseUrl, "responses"), {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  });
  await ensureOk(res);

  let text = "";
  let usage: TurnResult["usage"];
  const reasoningItems = new Map<string, any>();
  const reasoningOrder: string[] = [];
  const byItem = new Map<string, { id: string; name: string; args: string }>();
  const order: string[] = [];

  const absorb = (ev: any) => {
    const type = ev?.type as string | undefined;
    if (!type) return;
    if (type === "error" || type === "response.failed") {
      throw new Error(ev?.error?.message ?? ev?.response?.error?.message ?? JSON.stringify(ev).slice(0, 1000));
    }
    if (type === "response.incomplete") {
      const reason = ev?.response?.incomplete_details?.reason ?? ev?.response?.status ?? "unknown reason";
      throw new Error(`provider stopped before completing the response (${reason})`);
    }
    switch (type) {
      case "response.output_text.delta":
        if (ev.delta) {
          text += ev.delta;
          h.onText?.(ev.delta);
        }
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (ev.delta) h.onReasoning?.(ev.delta);
        break;
      case "response.output_item.added": {
        const item = ev.item;
        if (item?.type === "reasoning") {
          const key = item.id ?? `reasoning_${reasoningOrder.length}`;
          reasoningItems.set(key, item);
          reasoningOrder.push(key);
        } else if (item?.type === "function_call") {
          byItem.set(item.id ?? item.call_id, { id: item.call_id ?? item.id, name: item.name ?? "", args: item.arguments ?? "" });
          order.push(item.id ?? item.call_id);
          h.onToolCallStart?.(item.name ?? "");
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const key = ev.item_id;
        const cur = byItem.get(key);
        if (cur && typeof ev.delta === "string") cur.args += ev.delta;
        break;
      }
      case "response.output_item.done": {
        const item = ev.item;
        if (item?.type === "reasoning") {
          const key = item.id ?? `reasoning_${reasoningOrder.length}`;
          if (!reasoningItems.has(key)) reasoningOrder.push(key);
          reasoningItems.set(key, item);
        } else if (item?.type === "function_call") {
          const key = item.id ?? item.call_id;
          if (!byItem.has(key)) {
            byItem.set(key, { id: item.call_id ?? item.id, name: item.name ?? "", args: item.arguments ?? "" });
            order.push(key);
          } else {
            const cur = byItem.get(key)!;
            if (item.name) cur.name = item.name;
            if (item.arguments) cur.args = item.arguments;
            if (item.call_id) cur.id = item.call_id;
          }
        }
        break;
      }
      case "response.completed":
        if (ev.response?.usage) {
          usage = {
            prompt_tokens: ev.response.usage.input_tokens,
            completion_tokens: ev.response.usage.output_tokens,
            total_tokens: ev.response.usage.total_tokens,
          };
        }
        break;
    }
  };

  const ctype = res.headers.get("content-type") ?? "";
  await rejectHtmlResponse(res, ctype);
  if (ctype.includes("json")) {
    const json: any = await readApiJson(res);
    if (json?.error) throw new Error(JSON.stringify(json.error).slice(0, 1000));
    if (json?.status && json.status !== "completed") {
      const reason = json?.incomplete_details?.reason ?? json.status;
      throw new Error(`provider stopped before completing the response (${reason})`);
    }
    for (const item of json?.output ?? []) {
      if (item.type === "reasoning") {
        const key = item.id ?? `reasoning_${reasoningOrder.length}`;
        reasoningItems.set(key, item);
        reasoningOrder.push(key);
      } else if (item.type === "message") {
        for (const p of item.content ?? []) {
          if (p.type === "output_text" && p.text) {
            text += p.text;
            h.onText?.(p.text);
          }
        }
      } else if (item.type === "function_call") {
        byItem.set(item.id ?? item.call_id, { id: item.call_id ?? item.id, name: item.name, args: item.arguments ?? "" });
        order.push(item.id ?? item.call_id);
        h.onToolCallStart?.(item.name);
      }
    }
    if (json?.usage) {
      usage = {
        prompt_tokens: json.usage.input_tokens,
        completion_tokens: json.usage.output_tokens,
        total_tokens: json.usage.total_tokens,
      };
    }
  } else {
    await readSSE(res, (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return; // keep-alive / partial frame
      }
      absorb(json);
    });
  }

  const toolCalls: ToolCall[] = order
    .map((k, i) => {
      const c = byItem.get(k)!;
      return { id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.args || "{}" };
    })
    .filter((c) => c.name);

  const providerItems = reasoningOrder.map((key) => reasoningItems.get(key)).filter(Boolean);
  return { text, toolCalls, usage, providerItems: providerItems.length ? providerItems : undefined };
}
