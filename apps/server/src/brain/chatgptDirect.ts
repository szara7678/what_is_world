import { promises as fs } from "node:fs";
import type { Actor, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import type { BrainConfig } from "../config/brainConfig";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { BrainDecision, RecentDecision } from "./prompt";
import { parseDecision } from "./openrouter";
import { enqueueLlmRequest } from "./llmQueue";
import { appendMetric, estimateLlmCostUsd } from "../logging/metricsStore";

/**
 * ChatGPT Plus OAuth 직접 호출 (Responses API).
 * codex CLI 우회 → 진정한 동시 처리, 빠른 응답.
 *
 * auth.json: ~/.codex/auth.json 의 access_token + account_id 사용.
 * token 갱신은 codex CLI 가 background 처리 (auth.json 파일을 자동 갱신).
 */

const URL = "https://chatgpt.com/backend-api/codex/responses";
const AUTH_PATH = `${process.env.HOME}/.codex/auth.json`;

type AuthCache = { token: string; accountId: string; loadedAt: number };
let cache: AuthCache | null = null;
const CACHE_TTL_MS = 60_000; // 1분마다 reload (codex CLI 가 token 갱신했을 수 있음)

type LlmUsage = { tokensIn?: number; tokensOut?: number };
export type ChatgptDirectMessage = { role: "system" | "user" | "assistant"; content: string };

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const recordLlmCall = (
  cfg: BrainConfig,
  args: { world: WorldState; me: Actor },
  usage: LlmUsage,
  durationMs: number,
  success: boolean,
  failReason?: string
): void => {
  const tokensIn = Math.max(0, Math.floor(usage.tokensIn ?? 0));
  const tokensOut = Math.max(0, Math.floor(usage.tokensOut ?? 0));
  void appendMetric({
    tick: args.world.tick,
    ts: Date.now(),
    actor: args.me.id,
    provider: `chatgpt-direct/${cfg.model || "gpt-5.4-mini"}`,
    action: "LLM_CALL",
    success,
    failReason,
    llmCalled: true,
    llm_model: cfg.model || "gpt-5.4-mini",
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    duration_ms: Math.round(durationMs),
    llm_cost_usd: estimateLlmCostUsd(tokensIn, tokensOut)
  }).catch(() => undefined);
};

async function readAuth(): Promise<AuthCache | null> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  try {
    const raw = await fs.readFile(AUTH_PATH, "utf8");
    const data = JSON.parse(raw);
    const token = data?.tokens?.access_token;
    const accountId = data?.tokens?.account_id;
    if (typeof token !== "string" || typeof accountId !== "string") return null;
    cache = { token, accountId, loadedAt: Date.now() };
    return cache;
  } catch {
    return null;
  }
}

export async function callChatgptDirectJson(messages: ChatgptDirectMessage[], cfg: BrainConfig): Promise<string | null> {
  const auth = await readAuth();
  if (!auth) {
    console.warn("[brain] chatgpt-direct reflection: auth.json 읽기 실패");
    return null;
  }

  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      type: "message",
      role: message.role,
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }],
    }));

  try {
    const res = await enqueueLlmRequest({
      priority: "reflection",
      url: URL,
      timeoutMs: 120000,
      init: {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${auth.token}`,
          "chatgpt-account-id": auth.accountId,
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({
          model: cfg.model || "gpt-5.4-mini",
          instructions,
          input,
          store: false,
          stream: true,
        }),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[brain] chatgpt-direct reflection ${res.status}: ${text.slice(0, 200)}`);
      if (res.status === 401) cache = null;
      return null;
    }
    const result = await readStreamText(res);
    return result.text.trim() || null;
  } catch (e) {
    console.warn("[brain] chatgpt-direct reflection error:", e);
    return null;
  }
}

interface DecideArgs {
  world: WorldState;
  me: Actor;
  soul: Soul;
  thought: Thought;
  memories: Observation[];
  invalidAction?: { reason: string; options: string[] };
  lastDecisions?: RecentDecision[];
  trustByActor?: Record<string, number>;
  relationships?: Array<{ from: string; to: string; affinity: number; lastInteractionTick: number; trust?: number }>;
}

export async function decideWithChatgptDirect(cfg: BrainConfig, args: DecideArgs): Promise<BrainDecision | null> {
  const auth = await readAuth();
  if (!auth) {
    console.warn("[brain] chatgpt-direct: auth.json 읽기 실패");
    return null;
  }
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(args);
  const body = {
    model: cfg.model || "gpt-5.4-mini",
    instructions: systemPrompt,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userPrompt }],
      },
    ],
    store: false,
    stream: true,
  };

  const started = Date.now();
  try {
    const res = await enqueueLlmRequest({
      priority: "action",
      url: URL,
      timeoutMs: 120000,
      init: {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${auth.token}`,
          "chatgpt-account-id": auth.accountId,
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        body: JSON.stringify(body),
      },
    });
    const durationMs = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[brain] chatgpt-direct ${res.status}: ${text.slice(0, 200)}`);
      if (res.status === 401) cache = null; // 토큰 만료 → 다음 호출 시 reload
      recordLlmCall(cfg, args, { tokensIn: estimateTokens(`${systemPrompt}\n${userPrompt}`), tokensOut: 0 }, durationMs, false, `http_${res.status}`);
      return null;
    }
    const result = await readStreamText(res);
    recordLlmCall(cfg, args, {
      tokensIn: result.usage?.tokensIn ?? estimateTokens(`${systemPrompt}\n${userPrompt}`),
      tokensOut: result.usage?.tokensOut ?? estimateTokens(result.text)
    }, Date.now() - started, true);
    return parseDecision(result.text);
  } catch (e) {
    console.warn(`[brain] chatgpt-direct error:`, e);
    recordLlmCall(cfg, args, { tokensIn: estimateTokens(`${systemPrompt}\n${userPrompt}`), tokensOut: 0 }, Date.now() - started, false, "request_error");
    return null;
  }
}

async function readStreamText(res: Response): Promise<{ text: string; usage?: LlmUsage }> {
  const body = res.body;
  if (!body) return { text: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let buf = "";
  let usage: LlmUsage | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
          parts.push(evt.delta);
        }
        const rawUsage = evt.usage ?? evt.response?.usage;
        if (rawUsage && typeof rawUsage === "object") {
          const input = Number(rawUsage.input_tokens ?? rawUsage.prompt_tokens);
          const output = Number(rawUsage.output_tokens ?? rawUsage.completion_tokens);
          usage = {
            tokensIn: Number.isFinite(input) ? input : usage?.tokensIn,
            tokensOut: Number.isFinite(output) ? output : usage?.tokensOut
          };
        }
      } catch {
        // ignore
      }
    }
  }
  return { text: parts.join(""), usage };
}
