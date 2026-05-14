import type { Actor, WorldState } from "@wiw/shared";
import { getWorld } from "../state/worldStore";
import { readAllRelationships, readObservations, readSoul } from "../persistence/soulStore";
import type { BrainDecision } from "./prompt";

export const ORACLE_FULFILLED = 0.9;
export const ORACLE_BROADCAST = 0.95;
export const THREAT_AUTO = 0.95;
export const DEATH = 0.9;
export const OBSERVATION_ATTACK_TARGET_HIGH = 1.0;
export const OBSERVATION_ATTACK_TARGET_LIVE = 0.75;
export const OBSERVATION_SPEAK_VISITOR = 0.9;
export const OBSERVATION_SPEAK_NEW_ACTOR = 0.6;
export const OBSERVATION_SPEAK_DEFAULT = 0.4;
export const OBSERVATION_USE_HUNGRY_OR_ORACLE = 0.8;
export const OBSERVATION_USE_DEFAULT = 0.2;
export const OBSERVATION_GIVE_TRADE_CLOSED = 0.8;
export const OBSERVATION_GIVE_FOLLOWER_QUEST = 0.9;
export const OBSERVATION_GIVE_DEFAULT = 0.7;
export const OBSERVATION_PRAY = 0.6;
export const OBSERVATION_THINK = 0.3;
export const OBSERVATION_FAILURE = 0.2;
export const OBSERVATION_BASELINE = 0.2;
export const REASON_IMPORTANCE_BOOST = 0.15;
export const SUCCESS_EXPERIENCE_PROMOTION = 0.78;
export const FAILURE_INVARIANT = 0.65;
export const FAILURE_TRANSIENT = 0.45;
export const REFLECTION_SUMMARY = 0.7;
export const REFLECTION_BELIEF = 0.6;
export const REFLECTION_LESSON_FLOOR = 0.55;
export const REFLECTION_LESSON_CEILING = 0.75;
export const REFLECTION_LLM_GATE = 0.55;
export const AGENDA_COMPLETED = 0.7;
export const AGENDA_ABANDONED = 0.5;
export const AGENDA_PATH_UNREACHABLE = 0.6;
export const AGENDA_FAILURE_PATTERN = 0.45;
export const AGENDA_REACHED_PLACE = 0.6;
export const AGENDA_BLOCKED = 0.55;
export const AGENDA_EXPIRED = 0.55;
export const AGENDA_STARTED = 0.6;
export const BOOTSTRAP_PERSONAL_SEED = 0.78;
// Relationship moments use min(0.85, base + 0.04 * abs(delta)).
export const RELATIONSHIP_MOMENT_BASE = 0.55;
export const RELATIONSHIP_MOMENT_DELTA_STEP = 0.04;
export const RELATIONSHIP_MOMENT_CEILING = 0.85;
export const LIFE_EVENT_GATE_DEFAULT = 0.7;
export const LIFE_EVENT_GATE_HIGH_RISK = 0.9;

export const RECOVERY_FACT = 0.3;
export const GIFT_TRINKET = 0.7;
export const GIFT_DEFAULT = 0.55;
export const SELF_THINK_REFLECTION = 0.78;
export const APPRAISE_OBSERVATION = 0.4;
export const LETTER_BELIEF = 0.65;
export const OPTIONS_OBSERVATION = 0.3;
export const INEFFECTIVE_OBSERVATION = 0.7;
export const SPEECH_TARGET_DIALOGUE = 0.55;
export const SPEECH_TARGET_TRADE = 0.6;
export const ATTACK_RECEIVED_HIGH = 1.0;
export const ATTACK_RECEIVED_LIVE = 0.9;
export const GIVE_RECEIVED_HIGH = 0.8;
export const GIVE_RECEIVED_DEFAULT = 0.65;
export const HEARD_CLAIM_CEILING = 0.95;
export const HEARD_CLAIM_BASE = 0.7;
export const HEARD_CLAIM_DIPLOMACY_STEP = 0.03;
export const TRADE_EXPIRED = 0.45;
export const VISITOR_DIALOGUE = 0.85;

export const BOOTSTRAP_SEED_0_35 = 0.35;
export const BOOTSTRAP_SEED_0_40 = 0.4;
export const BOOTSTRAP_SEED_0_45 = 0.45;
export const BOOTSTRAP_SEED_0_50 = 0.5;
export const BOOTSTRAP_SEED_0_55 = 0.55;
export const BOOTSTRAP_SEED_0_58 = 0.58;
export const BOOTSTRAP_SEED_0_60 = 0.6;
export const BOOTSTRAP_SEED_0_62 = 0.62;
export const BOOTSTRAP_SEED_0_65 = 0.65;
export const BOOTSTRAP_SEED_0_66 = 0.66;
export const BOOTSTRAP_SEED_0_68 = 0.68;
export const BOOTSTRAP_SEED_0_70 = 0.7;
export const BOOTSTRAP_SEED_0_72 = 0.72;
export const BOOTSTRAP_SEED_0_74 = 0.74;
export const BOOTSTRAP_SEED_0_75 = 0.75;
export const BOOTSTRAP_SEED_0_76 = 0.76;
export const BOOTSTRAP_SEED_0_80 = 0.8;
export const BOOTSTRAP_SEED_0_85 = 0.85;
export const BOOTSTRAP_SEED_0_90 = 0.9;
export const BOOTSTRAP_SEED_0_92 = 0.92;

export function clampImportance(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * impl-K: per-outcome magnitude (0..1). Same action with bigger physical/social impact gets bigger importance.
 * magnitude = 0.40*|Δhp|/maxHp + 0.20*|Δhunger|/100 + 0.15*|Δstamina|/maxStamina + 0.20*min(1,|Δaffinity|/10) + 0.05*min(1,|Δgold|/50)
 */
export type OutcomeMagnitude = {
  hpDelta?: number;
  hungerDelta?: number;
  staminaDelta?: number;
  affinityDelta?: number;
  goldDelta?: number;
};

export function computeOutcomeMagnitude(delta: OutcomeMagnitude, me: Actor): number {
  const hp = Math.abs(delta.hpDelta ?? 0) / Math.max(1, me.maxHp);
  const hg = Math.abs(delta.hungerDelta ?? 0) / 100;
  const st = Math.abs(delta.staminaDelta ?? 0) / Math.max(1, me.maxStamina);
  const af = Math.min(1, Math.abs(delta.affinityDelta ?? 0) / 10);
  const gd = Math.min(1, Math.abs(delta.goldDelta ?? 0) / 50);
  return clampImportance(0.4 * hp + 0.2 * hg + 0.15 * st + 0.2 * af + 0.05 * gd);
}

export const MILESTONE_TAG_BONUS = 0.15;

export function applyMagnitudeShape(base: number, magnitude: number, milestoneTags: string[] = []): number {
  const m = clampImportance(magnitude);
  const tagBonus = milestoneTags.length > 0 ? MILESTONE_TAG_BONUS : 0;
  return clampImportance(base + 0.55 * Math.sqrt(m) + tagBonus);
}

function nearestNeighborId(world: WorldState, me: Actor): string | null {
  let best: { id: string; dist: number } | null = null;
  for (const a of Object.values(world.actors)) {
    if (a.id === me.id || !a.alive) continue;
    const d = Math.abs(a.x - me.x) + Math.abs(a.y - me.y);
    if (d > 6) continue;
    if (!best || d < best.dist) best = { id: a.id, dist: d };
  }
  return best?.id ?? null;
}

export async function computeImportance(
  action: BrainDecision["action"],
  ok: boolean,
  resultMsg: string,
  me: Actor,
  reason?: string,
  outcomeDelta?: OutcomeMagnitude,
  milestoneTags?: string[]
): Promise<number> {
  if (!ok) {
    const base = OBSERVATION_FAILURE;
    if (outcomeDelta || (milestoneTags && milestoneTags.length > 0)) {
      const mag = outcomeDelta ? computeOutcomeMagnitude(outcomeDelta, me) : 0;
      return applyMagnitudeShape(base, mag, milestoneTags ?? []);
    }
    return base;
  }
  const reasonBoost = computeReasonImportanceBoost(reason);
  const world = getWorld();
  if (action.type === "ATTACK" && action.targetId) {
    const target = world.actors[action.targetId];
    return clampImportance((!target || !target.alive || target.hp <= 10 ? OBSERVATION_ATTACK_TARGET_HIGH : OBSERVATION_ATTACK_TARGET_LIVE) + reasonBoost);
  }
  if (action.type === "SPEAK") {
    const recent = await readObservations(me.id, 8);
    if (recent.some((obs) => obs.kind === "dialogue" && obs.tags.includes("visitor"))) return clampImportance(OBSERVATION_SPEAK_VISITOR + reasonBoost);
    const targetId = action.targetId ?? nearestNeighborId(world, me);
    if (targetId) {
      const rels = await readAllRelationships();
      if (!rels.some((rel) => rel.from === me.id && rel.to === targetId)) return clampImportance(OBSERVATION_SPEAK_NEW_ACTOR + reasonBoost);
    }
    return clampImportance(OBSERVATION_SPEAK_DEFAULT + reasonBoost);
  }
  if (action.type === "USE") {
    if (me.hunger > 80 || resultMsg.includes("oracle")) return clampImportance(OBSERVATION_USE_HUNGRY_OR_ORACLE + reasonBoost);
    return clampImportance(OBSERVATION_USE_DEFAULT + reasonBoost);
  }
  if (action.type === "GIVE") {
    if (resultMsg.includes("trade_closed")) return clampImportance(OBSERVATION_GIVE_TRADE_CLOSED + reasonBoost);
    const soul = await readSoul(me.id, me.name);
    return clampImportance((soul.isFollower && soul.activeQuest?.status === "active" ? OBSERVATION_GIVE_FOLLOWER_QUEST : OBSERVATION_GIVE_DEFAULT) + reasonBoost);
  }
  if (action.type === "THINK") return clampImportance(OBSERVATION_THINK + reasonBoost);
  if (action.type === "PRAY") return clampImportance(OBSERVATION_PRAY + reasonBoost);
  const base = clampImportance(OBSERVATION_BASELINE + reasonBoost);
  if (outcomeDelta || (milestoneTags && milestoneTags.length > 0)) {
    const mag = outcomeDelta ? computeOutcomeMagnitude(outcomeDelta, me) : 0;
    return applyMagnitudeShape(base, mag, milestoneTags ?? []);
  }
  return base;
}

// Allow loop.ts to layer magnitude/milestone on top of the existing anchor return.
export function shapeImportanceForOutcome(anchor: number, delta: OutcomeMagnitude | undefined, milestoneTags: string[] | undefined, me: Actor): number {
  if (!delta && (!milestoneTags || milestoneTags.length === 0)) return clampImportance(anchor);
  const mag = delta ? computeOutcomeMagnitude(delta, me) : 0;
  return applyMagnitudeShape(anchor, mag, milestoneTags ?? []);
}

export function computeReasonImportanceBoost(reason: string | undefined): number {
  if (!reason) return 0;
  return /(신탁|신의 명|명령|기도|사당|위험|공격|도움|나누|거래|굶|배고|기억|떠올)/.test(reason)
    ? REASON_IMPORTANCE_BOOST
    : 0;
}

type ImportanceEntry = {
  value: number;
  bucket: number;
  kind: string;
};

type ImportanceSeries = {
  buckets: number[];
  entries: ImportanceEntry[];
};

const MAX_IMPORTANCE_OBSERVATIONS_PER_ACTOR = 500;
const importanceByActor = new Map<string, ImportanceSeries>();

function bucketForImportance(value: number): number {
  return Math.min(9, Math.floor(clampImportance(value) * 10));
}

function emptySeries(): ImportanceSeries {
  return { buckets: Array.from({ length: 10 }, () => 0), entries: [] };
}

export function recordImportanceObservation(actorId: string, value: number, kind: string): void {
  try {
    if (!actorId || !Number.isFinite(value)) return;
    const clamped = clampImportance(value);
    const bucket = bucketForImportance(clamped);
    const series = importanceByActor.get(actorId) ?? emptySeries();
    series.entries.push({ value: clamped, bucket, kind });
    series.buckets[bucket] += 1;
    while (series.entries.length > MAX_IMPORTANCE_OBSERVATIONS_PER_ACTOR) {
      const removed = series.entries.shift();
      if (removed) series.buckets[removed.bucket] = Math.max(0, series.buckets[removed.bucket] - 1);
    }
    importanceByActor.set(actorId, series);
  } catch {
    // Observability must never affect observation persistence.
  }
}

export function getImportanceHistogram(actorId?: string): { actorId: string | "all"; total: number; buckets: number[]; mean: number; p50: number; p95: number } {
  const entries = actorId
    ? [...(importanceByActor.get(actorId)?.entries ?? [])]
    : [...importanceByActor.values()].flatMap((series) => series.entries);
  const buckets = Array.from({ length: 10 }, () => 0);
  for (const entry of entries) buckets[entry.bucket] += 1;
  const values = entries.map((entry) => entry.value).sort((a, b) => a - b);
  const total = values.length;
  const mean = total > 0 ? values.reduce((sum, value) => sum + value, 0) / total : 0;
  const percentile = (p: number): number => {
    if (total === 0) return 0;
    const idx = Math.min(total - 1, Math.max(0, Math.ceil((p / 100) * total) - 1));
    return values[idx];
  };
  return {
    actorId: actorId ?? "all",
    total,
    buckets,
    mean,
    p50: percentile(50),
    p95: percentile(95)
  };
}
