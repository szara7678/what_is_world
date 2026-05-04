import { promises as fs } from "node:fs";
import type { Actor, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import type { BrainConfig } from "../config/brainConfig";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { BrainDecision, RecentDecision } from "./prompt";
import { parseDecision } from "./openrouter";
import { enqueueLlmRequest } from "./llmQueue";

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

interface DecideArgs {
  world: WorldState;
  me: Actor;
  soul: Soul;
  thought: Thought;
  memories: Observation[];
  invalidAction?: { reason: string; options: string[] };
  lastDecisions?: RecentDecision[];
}

export async function decideWithChatgptDirect(cfg: BrainConfig, args: DecideArgs): Promise<BrainDecision | null> {
  const auth = await readAuth();
  if (!auth) {
    console.warn("[brain] chatgpt-direct: auth.json 읽기 실패");
    return null;
  }
  const body = {
    model: cfg.model || "gpt-5.4-mini",
    instructions: buildSystemPrompt(),
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: buildUserPrompt(args) }],
      },
    ],
    store: false,
    stream: true,
  };

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

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[brain] chatgpt-direct ${res.status}: ${text.slice(0, 200)}`);
      if (res.status === 401) cache = null; // 토큰 만료 → 다음 호출 시 reload
      return null;
    }
    const text = await readStreamText(res);
    return parseDecision(text);
  } catch (e) {
    console.warn(`[brain] chatgpt-direct error:`, e);
    return null;
  }
}

async function readStreamText(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let buf = "";
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
      } catch {
        // ignore
      }
    }
  }
  return parts.join("");
}
