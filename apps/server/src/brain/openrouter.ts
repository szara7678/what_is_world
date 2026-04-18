import type { BrainDecision } from "./prompt";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { Actor, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import type { BrainConfig } from "../config/brainConfig";

export async function decideWithOpenRouter(
  cfg: BrainConfig,
  args: { world: WorldState; me: Actor; soul: Soul; thought: Thought; memories: Observation[] }
): Promise<BrainDecision | null> {
  if (!cfg.apiKey) return null;
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user",   content: buildUserPrompt(args) }
    ],
    temperature: 0.7,
    max_tokens: 400,
    response_format: { type: "json_object" }
  };
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
        "HTTP-Referer": "https://what-is-world.local",
        "X-Title": "what-is-world"
      },
      body: JSON.stringify(body),
      // 20초 타임아웃
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[brain] openrouter ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    return parseDecision(raw);
  } catch (e) {
    console.warn(`[brain] openrouter error:`, e);
    return null;
  }
}

export function parseDecision(raw: string): BrainDecision | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    const parsed = JSON.parse(objMatch[0]);
    if (!parsed || typeof parsed !== "object") return null;
    const action = parsed.action ?? {};
    const thought = parsed.thought ?? {};
    const clean: BrainDecision = {
      thought: {
        priority: String(thought.priority ?? "-"),
        emotion: String(thought.emotion ?? "평온"),
        nextIntent: String(thought.nextIntent ?? action.type ?? "WAIT"),
        beliefs: Array.isArray(thought.beliefs) ? thought.beliefs.map(String).slice(0, 5) : [],
        recentEvents: Array.isArray(thought.recentEvents) ? thought.recentEvents.map(String).slice(0, 5) : []
      },
      action: {
        type: normalizeType(String(action.type ?? "WAIT")),
        dx: clampDelta(action.dx),
        dy: clampDelta(action.dy),
        targetId: action.targetId ? String(action.targetId) : undefined,
        message: action.message ? String(action.message).slice(0, 120) : undefined,
        itemId: action.itemId ? String(action.itemId) : undefined
      }
    };
    return clean;
  } catch {
    return null;
  }
}

const ALLOWED = new Set(["MOVE","ATTACK","SPEAK","USE","WAIT"]);
function normalizeType(t: string): "MOVE"|"ATTACK"|"SPEAK"|"USE"|"WAIT" {
  const up = t.toUpperCase();
  return ALLOWED.has(up) ? up as never : "WAIT";
}
function clampDelta(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}
