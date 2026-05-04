import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";

const file = resolve(process.cwd(), "data/brain-config.json");

export type BrainProvider = "mock" | "openrouter" | "local-proxy" | "chatgpt-direct";

export interface BrainConfig {
  provider: BrainProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  tickIntervalMs: number;
  maxActorsPerTick: number;
  enabled: boolean;
  /** @deprecated NPC LLM failures now use activePath/INVENTORY/WAIT fallback; monsters still use mock. */
  fallbackToMock: boolean;
  reflectIntervalMs: number;
  /** actor 별 모델 override. 예: { "npc-2": "gpt-5.5", "player-1": "gpt-5.4" }. 없으면 글로벌 model. */
  modelOverrides?: Record<string, string>;
  updatedAt: number;
}

export const MODEL_PRESETS: { label: string; value: string; note: string }[] = [
  { label: "Claude Haiku 4.5 (local)",  value: "claude-haiku-4-5",            note: "로컬 프록시 고속 기본" },
  { label: "GPT-5.4 nano (local)",      value: "gpt-5.4-nano",                note: "로컬 프록시 초경량" },
  { label: "GPT-5.4 mini (local)",      value: "gpt-5.4-mini",                note: "로컬 프록시 baseline" },
  { label: "GLM-4.5 Air (free)",        value: "z-ai/glm-4.5-air:free",       note: "무료 · 경량 · 대화 위주" },
  { label: "GLM-4.6",                   value: "z-ai/glm-4.6",                note: "가성비 · 추론 강함" },
  { label: "GPT-5 mini",                value: "openai/gpt-5-mini",           note: "빠름 · 안정적" },
  { label: "GPT-4o mini",               value: "openai/gpt-4o-mini",          note: "저렴 · 안정" },
  { label: "Qwen3 VL 235B (A22B) Think",value: "qwen/qwen3-vl-235b-a22b-thinking", note: "Qwen3 계열 thinking" },
  { label: "Qwen3 Next 80B A3B",        value: "qwen/qwen3-next-80b-a3b-instruct", note: "Qwen3 가성비" }
];

export const LOCAL_PROXY_DEFAULTS = {
  baseUrl: "http://127.0.0.1:18796/v1",
  apiKey: "claude-code-local",
  model: "claude-haiku-4-5"
};

const DEFAULT: BrainConfig = {
  provider: "local-proxy",
  apiKey: LOCAL_PROXY_DEFAULTS.apiKey,
  model: LOCAL_PROXY_DEFAULTS.model,
  baseUrl: LOCAL_PROXY_DEFAULTS.baseUrl,
  tickIntervalMs: 2000,
  maxActorsPerTick: 2,
  enabled: false,
  fallbackToMock: false,
  reflectIntervalMs: 90000,
  updatedAt: 0
};

let current: BrainConfig = { ...DEFAULT };
const listeners: Array<(c: BrainConfig) => void> = [];

const withProviderDefaults = (
  next: BrainConfig,
  options: { useLocalDefaults?: boolean } = {}
): BrainConfig => {
  if (next.provider !== "local-proxy") return next;
  return {
    ...next,
    baseUrl: options.useLocalDefaults || !next.baseUrl ? LOCAL_PROXY_DEFAULTS.baseUrl : next.baseUrl,
    apiKey: options.useLocalDefaults || !next.apiKey ? LOCAL_PROXY_DEFAULTS.apiKey : next.apiKey,
    model: options.useLocalDefaults || !next.model ? LOCAL_PROXY_DEFAULTS.model : next.model
  };
};

export const loadBrainConfig = async (): Promise<BrainConfig> => {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BrainConfig>;
    current = withProviderDefaults(
      { ...DEFAULT, ...parsed },
      { useLocalDefaults: parsed.provider === "local-proxy" && (!parsed.baseUrl || !parsed.model) }
    );
  } catch {
    current = { ...DEFAULT };
  }
  return current;
};

export const getBrainConfig = (): BrainConfig => current;

export const updateBrainConfig = async (patch: Partial<BrainConfig>): Promise<BrainConfig> => {
  const prevProvider = current.provider;
  current = withProviderDefaults(
    { ...current, ...patch, updatedAt: Date.now() },
    { useLocalDefaults: patch.provider === "local-proxy" && prevProvider !== "local-proxy" }
  );
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(current, null, 2), "utf-8");
  for (const l of listeners) l(current);
  return current;
};

export const publicBrainConfig = (c: BrainConfig = current) => ({
  provider: c.provider,
  model: c.model,
  baseUrl: c.baseUrl,
  tickIntervalMs: c.tickIntervalMs,
  maxActorsPerTick: c.maxActorsPerTick,
  enabled: c.enabled,
  fallbackToMock: c.fallbackToMock,
  reflectIntervalMs: c.reflectIntervalMs,
  modelOverrides: c.modelOverrides ?? {},
  hasApiKey: Boolean(c.apiKey),
  updatedAt: c.updatedAt
});

export const onBrainConfigChange = (fn: (c: BrainConfig) => void) => {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
};
