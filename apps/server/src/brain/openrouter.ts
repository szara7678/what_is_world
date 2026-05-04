import type { BrainDecision, GoalDecisionKind, GoalProposal, RecentDecision } from "./prompt";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { Actor, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import type { BrainConfig } from "../config/brainConfig";
import { enqueueLlmRequest } from "./llmQueue";

export async function decideWithOpenRouter(
  cfg: BrainConfig,
  args: { world: WorldState; me: Actor; soul: Soul; thought: Thought; memories: Observation[]; invalidAction?: { reason: string; options: string[] }; lastDecisions?: RecentDecision[] }
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
    const res = await enqueueLlmRequest({
      priority: "action",
      url: `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
      timeoutMs: 120000,
      init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
        "HTTP-Referer": "https://what-is-world.local",
        "X-Title": "what-is-world"
      },
      body: JSON.stringify(body)
      }
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
    const action = isObject(parsed.action)
      ? parsed.action
      : "type" in parsed
        ? parsed
        : {};
    const thought = parsed.thought ?? {};
    const reason = String(action.reason ?? parsed.reason ?? "").trim();
    const actType = normalizeType(String(action.type ?? "WAIT"));
    let message: string | undefined;
    if (action.message) {
      const m = String(action.message).slice(0, 120).trim();
      message = m || undefined;
    }
    // SPEAK 인데 message 가 비어있으면 reason 으로 채워서 "…" 침묵 방지.
    if (actType === "SPEAK" && !message && reason) {
      message = reason.slice(0, 120);
    }
    const clean: BrainDecision = {
      thought: {
        priority: String(thought.priority ?? "-"),
        emotion: String(thought.emotion ?? "평온"),
        nextIntent: String(thought.nextIntent ?? action.type ?? "WAIT"),
        beliefs: Array.isArray(thought.beliefs) ? thought.beliefs.map(String).slice(0, 5) : [],
        recentEvents: Array.isArray(thought.recentEvents) ? thought.recentEvents.map(String).slice(0, 5) : []
      },
      action: {
        type: actType,
        reason: reason ? reason.slice(0, 160) : undefined,
        dx: clampDelta(action.dx),
        dy: clampDelta(action.dy),
        targetId: action.targetId ? String(action.targetId) : undefined,
        message,
        itemId: action.itemId ? String(action.itemId) : undefined,
        objectId: action.objectId ? String(action.objectId) : undefined,
        targetItemId: action.targetItemId ? String(action.targetItemId) : undefined,
        skillId: action.skillId ? String(action.skillId) : undefined,
        count: action.count === undefined ? undefined : Number(action.count),
        itemType: action.itemType ? String(action.itemType) : undefined,
        currency: action.currency === "gold" ? "gold" : undefined,
        amount: action.amount === undefined ? undefined : Number(action.amount),
        query: action.query ? String(action.query).slice(0, 120) : undefined,
        x: optionalInt(action.x),
        y: optionalInt(action.y),
        wantItem: action.wantItem ? String(action.wantItem) : undefined,
        wantCount: action.wantCount === undefined ? undefined : Number(action.wantCount),
        offerItem: action.offerItem ? String(action.offerItem) : undefined,
        offerCount: action.offerCount === undefined ? undefined : Number(action.offerCount),
        offerGold: action.offerGold === undefined ? undefined : Number(action.offerGold)
      },
      // goal 생략 시 KEEP 으로 자동 채움 (gpt-5.5 가이드: 매 박자 강제 X)
      goalDecision: parseGoalDecision(parsed.goal ?? parsed.goalDecision) ?? { kind: "KEEP" }
    };
    return clean;
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object");
}

// PR6: INVENTORY 액션 제거. LLM 이 INVENTORY 보내면 normalizeType 에서 WAIT 으로 떨어짐.
const ALLOWED = new Set(["MOVE","ATTACK","SPEAK","USE","PICKUP","DROP","GIVE","OFFER_TRADE","BUY","SELL","PRAY","THINK","OPTIONS","WAIT"]);
function normalizeType(t: string): "MOVE"|"ATTACK"|"SPEAK"|"USE"|"PICKUP"|"DROP"|"GIVE"|"OFFER_TRADE"|"BUY"|"SELL"|"PRAY"|"THINK"|"OPTIONS"|"WAIT" {
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
function optionalInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

const GOAL_KINDS = new Set<GoalDecisionKind>(["KEEP", "COMPLETE", "CHANGE", "ABANDON"]);
function parseGoalDecision(raw: unknown): BrainDecision["goalDecision"] | undefined {
  if (!isObject(raw)) return undefined;
  const kindRaw = String(raw.kind ?? raw.decision ?? "").toUpperCase();
  const kind = (GOAL_KINDS.has(kindRaw as GoalDecisionKind) ? kindRaw : "KEEP") as GoalDecisionKind;
  const reason = raw.reason ? String(raw.reason).slice(0, 160) : undefined;
  let proposal: GoalProposal | undefined;
  if (isObject(raw.proposal)) {
    const p = raw.proposal;
    const intent = String(p.intent ?? "").trim();
    if (intent) {
      let targetXY: { x: number; y: number } | undefined;
      if (isObject(p.targetXY)) {
        const x = Number((p.targetXY as { x?: unknown }).x);
        const y = Number((p.targetXY as { y?: unknown }).y);
        if (Number.isFinite(x) && Number.isFinite(y)) targetXY = { x: Math.trunc(x), y: Math.trunc(y) };
      }
      proposal = {
        intent: intent.slice(0, 120),
        targetXY,
        targetActorId: p.targetActorId ? String(p.targetActorId).slice(0, 64) : undefined,
        targetItemPrefix: p.targetItemPrefix ? String(p.targetItemPrefix).slice(0, 32) : undefined,
        reason: String(p.reason ?? reason ?? "").slice(0, 160),
        ttlTicks: clampTtl(p.ttlTicks),
        nextActions: Array.isArray(p.nextActions) ? p.nextActions.map(String).slice(0, 5) : undefined
      };
    }
  }
  return { kind, proposal, reason };
}
function clampTtl(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(5, Math.min(60, Math.trunc(n)));
}
