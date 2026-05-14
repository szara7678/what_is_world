import type { BrainDecision, GoalDecisionKind, GoalProposal, RecentDecision } from "./prompt";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import type { Actor, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import type { BrainConfig } from "../config/brainConfig";
import { enqueueLlmRequest } from "./llmQueue";
import { appendMetric, estimateLlmCostUsd } from "../logging/metricsStore";

type LlmUsage = { tokensIn?: number; tokensOut?: number };

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
    provider: `${cfg.provider}/${cfg.model}`,
    action: "LLM_CALL",
    success,
    failReason,
    llmCalled: true,
    llm_model: cfg.model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    duration_ms: Math.round(durationMs),
    llm_cost_usd: estimateLlmCostUsd(tokensIn, tokensOut)
  }).catch(() => undefined);
};

export async function decideWithOpenRouter(
  cfg: BrainConfig,
  args: { world: WorldState; me: Actor; soul: Soul; thought: Thought; memories: Observation[]; invalidAction?: { reason: string; options: string[] }; lastDecisions?: RecentDecision[]; trustByActor?: Record<string, number>; relationships?: Array<{ from: string; to: string; affinity: number; lastInteractionTick: number; trust?: number }> }
): Promise<BrainDecision | null> {
  if (!cfg.apiKey) return null;
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(args);
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 400,
    response_format: { type: "json_object" }
  };
  const started = Date.now();
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
    const durationMs = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[brain] openrouter ${res.status}: ${text.slice(0, 200)}`);
      recordLlmCall(cfg, args, { tokensIn: estimateTokens(`${systemPrompt}\n${userPrompt}`), tokensOut: 0 }, durationMs, false, `http_${res.status}`);
      return null;
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    recordLlmCall(cfg, args, {
      tokensIn: json.usage?.prompt_tokens ?? json.usage?.input_tokens ?? estimateTokens(`${systemPrompt}\n${userPrompt}`),
      tokensOut: json.usage?.completion_tokens ?? json.usage?.output_tokens ?? estimateTokens(raw)
    }, durationMs, true);
    return parseDecision(raw);
  } catch (e) {
    console.warn(`[brain] openrouter error:`, e);
    recordLlmCall(cfg, args, { tokensIn: estimateTokens(`${systemPrompt}\n${userPrompt}`), tokensOut: 0 }, Date.now() - started, false, "request_error");
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
        offerGold: action.offerGold === undefined ? undefined : Number(action.offerGold),
        tradeId: action.tradeId ? String(action.tradeId).slice(0, 96) : undefined,
        // P0-2: MOVE.to / GATHER / ATTACK until 통과
        to: isObject(action.to) ? {
          placeId: action.to.placeId ? String(action.to.placeId).slice(0, 64) : undefined,
          xy: isObject(action.to.xy) && Number.isFinite(Number(action.to.xy.x)) && Number.isFinite(Number(action.to.xy.y)) ? { x: Math.trunc(Number(action.to.xy.x)), y: Math.trunc(Number(action.to.xy.y)) } : undefined,
          towardItem: action.to.towardItem ? String(action.to.towardItem).slice(0, 32) : undefined,
          towardActor: action.to.towardActor ? String(action.to.towardActor).slice(0, 64) : undefined
        } : undefined,
        maxTicks: action.maxTicks ? Math.max(1, Math.min(500, Math.floor(Number(action.maxTicks)))) : undefined,
        gatherItem: action.gatherItem ? String(action.gatherItem).slice(0, 32) : (actType === "GATHER" && action.item ? String(action.item).slice(0, 32) : undefined),
        gatherCount: action.gatherCount ? Math.max(1, Math.min(32, Math.floor(Number(action.gatherCount)))) : (actType === "GATHER" && action.count ? Math.max(1, Math.min(32, Math.floor(Number(action.count)))) : undefined),
        gatherArea: normalizeGatherArea(actType, action.area, action.gatherArea),
        allowWaitSpawn: action.allowWaitSpawn === true,
        attackUntil: Array.isArray(action.attackUntil) ? action.attackUntil.filter(isObject).slice(0, 6) as never : undefined,
        attackMaxTicks: action.attackMaxTicks ? Math.max(1, Math.min(500, Math.floor(Number(action.attackMaxTicks)))) : undefined
      },
      // goal 생략 시 KEEP 으로 자동 채움 (gpt-5.5 가이드: 매 박자 강제 X)
      goalDecision: parseGoalDecision(parsed.goal ?? parsed.goalDecision) ?? { kind: "KEEP" },
      plan: parsePlan(parsed.plan)
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
const ALLOWED = new Set(["MOVE","ATTACK","SPEAK","USE","PICKUP","DROP","GIVE","GATHER","OFFER_TRADE","ACCEPT_TRADE","REJECT_TRADE","PRAY","THINK","OPTIONS","SLEEP","WAIT"]);
function normalizeType(t: string): "MOVE"|"ATTACK"|"SPEAK"|"USE"|"PICKUP"|"DROP"|"GIVE"|"GATHER"|"OFFER_TRADE"|"ACCEPT_TRADE"|"REJECT_TRADE"|"PRAY"|"THINK"|"OPTIONS"|"SLEEP"|"WAIT" {
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

const normalizeGatherRadius = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.max(1, Math.min(20, n));
  return clamped <= 2 ? 12 : clamped;
};

function normalizeGatherArea(
  actType: string,
  rawArea: unknown,
  rawLegacyArea?: unknown
): { placeId?: string; radius?: number } | undefined {
  const src = isObject(rawArea) ? rawArea : isObject(rawLegacyArea) ? rawLegacyArea : undefined;
  if (!src) return actType === "GATHER" ? { radius: 12 } : undefined;
  const placeId = src.placeId ? String(src.placeId).slice(0, 64) : undefined;
  const radius = normalizeGatherRadius(src.radius);
  if (placeId || radius !== undefined) return { placeId, radius };
  return actType === "GATHER" ? { radius: 12 } : undefined;
}

const GOAL_KINDS = new Set<GoalDecisionKind>(["KEEP", "COMPLETE", "CHANGE", "ABANDON"]);

function parsePlan(raw: unknown): import("@wiw/shared").Plan | undefined {
  if (!isObject(raw)) return undefined;
  const id = String(raw.id ?? "").slice(0, 64);
  const goal = String(raw.goal ?? "").slice(0, 240);
  const reason = raw.reason ? String(raw.reason).slice(0, 240) : undefined;
  const ttl = Number(raw.ttlTicks ?? raw.ttl ?? 600);
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!id || !goal || steps.length === 0 || steps.length > 12) return undefined;
  if (!Number.isFinite(ttl) || ttl < 50 || ttl > 1500) return undefined;
  const parsedSteps: import("@wiw/shared").PlanStep[] = [];
  for (const s of steps) {
    if (!isObject(s)) return undefined;
    const k = String(s.kind ?? "").toUpperCase();
    if (k === "GO_TO") {
      parsedSteps.push({
        kind: "GO_TO",
        placeId: s.placeId ? String(s.placeId).slice(0, 64) : undefined,
        xy: isObject(s.xy) && Number.isFinite(Number(s.xy.x)) && Number.isFinite(Number(s.xy.y)) ? { x: Math.trunc(Number(s.xy.x)), y: Math.trunc(Number(s.xy.y)) } : undefined,
        nearItem: s.nearItem ? String(s.nearItem).slice(0, 32) : undefined,
        nearActor: s.nearActor ? String(s.nearActor).slice(0, 64) : undefined
      });
    } else if (k === "GATHER") {
      const item = s.item ? String(s.item).slice(0, 32) : "";
      const count = Math.max(1, Math.min(32, Math.floor(Number(s.count ?? 1))));
      if (!item) return undefined;
      const normalizedLocation = normalizeGatherArea("GATHER", s.location);
      const loc = isObject(s.location) ? {
        placeId: normalizedLocation?.placeId,
        xy: isObject(s.location.xy) ? { x: Math.trunc(Number(s.location.xy.x)), y: Math.trunc(Number(s.location.xy.y)) } : undefined,
        radius: normalizedLocation?.radius
      } : normalizedLocation;
      parsedSteps.push({ kind: "GATHER", item, count, location: loc, allowWaitSpawn: Boolean(s.allowWaitSpawn), maxTicks: s.maxTicks ? Math.min(500, Math.max(10, Math.floor(Number(s.maxTicks)))) : undefined });
    } else if (k === "CRAFT") {
      const output = s.output ? String(s.output).slice(0, 32) : "";
      if (!output) return undefined;
      const station = isObject(s.station) ? {
        objectId: s.station.objectId ? String(s.station.objectId).slice(0, 64) : undefined,
        stationType: s.station.stationType ? String(s.station.stationType).slice(0, 32) : undefined,
        placeId: s.station.placeId ? String(s.station.placeId).slice(0, 64) : undefined
      } : undefined;
      parsedSteps.push({ kind: "CRAFT", output, count: s.count ? Math.max(1, Math.min(8, Math.floor(Number(s.count)))) : undefined, station });
    } else if (k === "TALK_TO") {
      parsedSteps.push({
        kind: "TALK_TO",
        actorId: s.actorId ? String(s.actorId).slice(0, 64) : undefined,
        topic: s.topic ? String(s.topic).slice(0, 120) : undefined,
        intent: ["request","inform","greet","trade","apologize"].includes(String(s.intent)) ? String(s.intent) as never : undefined,
        message: s.message ? String(s.message).slice(0, 200) : undefined
      });
    } else if (k === "USE") {
      parsedSteps.push({
        kind: "USE",
        item: s.item ? String(s.item).slice(0, 64) : undefined,
        objectId: s.objectId ? String(s.objectId).slice(0, 64) : undefined,
        targetItemId: s.targetItemId ? String(s.targetItemId).slice(0, 32) : undefined
      });
    } else if (k === "WAIT_UNTIL") {
      const cond = isObject(s.condition) ? s.condition : null;
      if (!cond) return undefined;
      const ck = String(cond.kind ?? "").toLowerCase();
      let parsedCond: import("@wiw/shared").WaitCondition | null = null;
      if (ck === "tick_at") parsedCond = { kind: "tick_at", tick: Math.max(0, Math.floor(Number(cond.tick))) };
      else if (ck === "tick_after") parsedCond = { kind: "tick_after", ticks: Math.max(1, Math.floor(Number(cond.ticks))) };
      else if (ck === "time_of_day") parsedCond = { kind: "time_of_day", hour: Math.max(0, Math.min(23, Math.floor(Number(cond.hour)))) };
      else if (ck === "actor_within" && cond.actorId) parsedCond = { kind: "actor_within", actorId: String(cond.actorId), distance: Math.max(1, Math.floor(Number(cond.distance ?? 1))) };
      else if (ck === "crop_mature") parsedCond = { kind: "crop_mature", cropId: cond.cropId ? String(cond.cropId) : undefined };
      else if (ck === "weather" && cond.weather) parsedCond = { kind: "weather", weather: String(cond.weather) };
      else if (ck === "inventory_has" && cond.item) parsedCond = { kind: "inventory_has", item: String(cond.item), count: Math.max(1, Math.floor(Number(cond.count ?? 1))) };
      else if (ck === "idle") parsedCond = { kind: "idle", ticks: Math.max(1, Math.floor(Number(cond.ticks))) };
      if (!parsedCond) return undefined;
      const maxTicks = Math.max(1, Math.min(1500, Math.floor(Number(s.maxTicks ?? 100))));
      parsedSteps.push({ kind: "WAIT_UNTIL", condition: parsedCond, maxTicks });
    } else {
      return undefined;
    }
  }
  return {
    id, goal, reason, ttlTicks: ttl,
    startedAtTick: 0, // caller 가 설정
    steps: parsedSteps,
    stepRuntimes: parsedSteps.map(() => ({ status: "pending" })),
    currentStep: 0,
    status: "active",
    failureCount: 0,
    failureBudget: 3
  };
}

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
