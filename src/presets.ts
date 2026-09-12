/**
 * Built-in provider catalogue: base URLs and API flavours for the services
 * people actually use, so a new user only has to paste a key.
 *
 * `models` entries are hints used before the live /models list is available.
 */
import type { ApiKind } from "./api.ts";

export type PresetModel = { id: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number };

export type Preset = {
  id: string;
  name: string;
  baseUrl: string;
  api: ApiKind;
  /** environment variable checked as a fallback for the key */
  env?: string;
  /** where the user gets a key */
  keyUrl?: string;
  /** set when the service runs locally and needs no key */
  noKey?: boolean;
  models: PresetModel[];
  note?: string;
};

export const PRESETS: Preset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    env: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-5.6-sol", reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000 },
      { id: "gpt-5.6-terra", reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000 },
      { id: "gpt-5.6-luna", reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000 },
      { id: "gpt-4.1", contextWindow: 1_000_000, maxTokens: 32_000 },
      { id: "gpt-4o", contextWindow: 128_000, maxTokens: 16_000 },
      { id: "o4-mini", reasoning: true, contextWindow: 200_000, maxTokens: 100_000 },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    env: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-fable-5", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: "claude-opus-5", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: "claude-sonnet-5", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
      { id: "claude-haiku-4-5", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    api: "openai-completions",
    env: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.5-pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_000 },
      { id: "gemini-2.5-flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_000 },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    env: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", contextWindow: 128_000, maxTokens: 8_000 },
      { id: "deepseek-reasoner", reasoning: true, contextWindow: 128_000, maxTokens: 64_000 },
    ],
  },
  {
    id: "kimi",
    name: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    env: "MOONSHOT_API_KEY",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    models: [
      { id: "kimi-k2-turbo-preview", contextWindow: 256_000, maxTokens: 32_000 },
      { id: "moonshot-v1-128k", contextWindow: 128_000, maxTokens: 8_000 },
    ],
  },
  {
    id: "qwen",
    name: "Alibaba Qwen (DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    env: "DASHSCOPE_API_KEY",
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    models: [
      { id: "qwen3-max", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 },
      { id: "qwen3-coder-plus", contextWindow: 1_000_000, maxTokens: 65_000 },
      { id: "qwen-plus", contextWindow: 128_000, maxTokens: 16_000 },
    ],
  },
  {
    id: "grok",
    name: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    api: "openai-completions",
    env: "XAI_API_KEY",
    keyUrl: "https://console.x.ai/",
    models: [
      { id: "grok-4", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 },
      { id: "grok-3-mini", reasoning: true, contextWindow: 131_000, maxTokens: 32_000 },
    ],
  },
  {
    id: "glm",
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    env: "ZHIPUAI_API_KEY",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: [
      { id: "glm-4.6", reasoning: true, contextWindow: 200_000, maxTokens: 128_000 },
      { id: "glm-4.5-air", contextWindow: 128_000, maxTokens: 96_000 },
    ],
  },
  {
    id: "doubao",
    name: "ByteDance Doubao (Volcengine Ark)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    env: "ARK_API_KEY",
    keyUrl: "https://console.volcengine.com/ark",
    models: [{ id: "doubao-seed-1-6", reasoning: true, contextWindow: 256_000, maxTokens: 32_000 }],
    note: "model ids are endpoint ids like ep-2024... — create one in the console",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    api: "openai-completions",
    env: "MINIMAX_API_KEY",
    keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    models: [{ id: "MiniMax-M2", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 }],
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions",
    env: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai/api-keys/",
    models: [{ id: "mistral-large-latest", contextWindow: 128_000, maxTokens: 32_000 }],
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions",
    env: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
    models: [{ id: "moonshotai/kimi-k2-instruct", contextWindow: 256_000, maxTokens: 16_000 }],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    env: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    models: [{ id: "anthropic/claude-sonnet-4.5", contextWindow: 200_000, maxTokens: 64_000 }],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    api: "openai-completions",
    env: "SILICONFLOW_API_KEY",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    models: [{ id: "deepseek-ai/DeepSeek-V3.2-Exp", contextWindow: 128_000, maxTokens: 32_000 }],
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    api: "openai-completions",
    env: "TOGETHER_API_KEY",
    keyUrl: "https://api.together.ai/settings/api-keys",
    models: [{ id: "Qwen/Qwen3-Coder-480B-A35B-Instruct", contextWindow: 256_000, maxTokens: 32_000 }],
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    noKey: true,
    models: [{ id: "qwen3-coder", contextWindow: 128_000, maxTokens: 32_000 }],
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    api: "openai-completions",
    noKey: true,
    models: [{ id: "local-model", contextWindow: 128_000, maxTokens: 32_000 }],
  },
];

export function findPreset(id: string): Preset | undefined {
  const key = id.trim().toLowerCase();
  return PRESETS.find((p) => p.id === key || p.name.toLowerCase() === key);
}

export function presetChoices(): string {
  return PRESETS.map((p) => p.id).join(", ");
}
