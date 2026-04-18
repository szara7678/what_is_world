import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";

const file = resolve(process.cwd(), "apps/server/data/brain-config.json");

export type BrainProvider = "openrouter" | "mock";

export interface BrainConfig {
  provider: BrainProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  tickIntervalMs: number;
  maxActorsPerTick: number;
  enabled: boolean;
  reflectIntervalMs: number;
  updatedAt: number;
}

export const MODEL_PRESETS: { label: string; value: string; note: string }[] = [
  { label: "GLM-4.5 Air (free)",        value: "z-ai/glm-4.5-air:free",       note: "무료 · 경량 · 대화 위주" },
  { label: "GLM-4.6",                   value: "z-ai/glm-4.6",                note: "가성비 · 추론 강함" },
  { label: "GPT-5 mini",                value: "openai/gpt-5-mini",           note: "빠름 · 안정적" },
  { label: "GPT-4o mini",               value: "openai/gpt-4o-mini",          note: "저렴 · 안정" },
  { label: "Qwen3 VL 235B (A22B) Think",value: "qwen/qwen3-vl-235b-a22b-thinking", note: "Qwen3 계열 thinking" },
  { label: "Qwen3 Next 80B A3B",        value: "qwen/qwen3-next-80b-a3b-instruct", note: "Qwen3 가성비" }
];

const DEFAULT: BrainConfig = {
  provider: "mock",
  apiKey: "",
  model: "z-ai/glm-4.5-air:free",
  baseUrl: "https://openrouter.ai/api/v1",
  tickIntervalMs: 8000,
  maxActorsPerTick: 2,
  enabled: false,
  reflectIntervalMs: 45000,
  updatedAt: 0
};

let current: BrainConfig = { ...DEFAULT };
const listeners: Array<(c: BrainConfig) => void> = [];

export const loadBrainConfig = async (): Promise<BrainConfig> => {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BrainConfig>;
    current = { ...DEFAULT, ...parsed };
  } catch {
    current = { ...DEFAULT };
  }
  return current;
};

export const getBrainConfig = (): BrainConfig => current;

export const updateBrainConfig = async (patch: Partial<BrainConfig>): Promise<BrainConfig> => {
  current = { ...current, ...patch, updatedAt: Date.now() };
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
  reflectIntervalMs: c.reflectIntervalMs,
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
