import type { ActionRequest, Actor, Observation, Place, Soul, Thought, WorldState } from "@wiw/shared";
import { inventoryCountOf, itemDef, itemKeyOf, levelForXp, ko } from "@wiw/shared";
import { checkSkillRequirements, dispatchAction, findPath, isHostileCreature, RECIPES } from "@wiw/world-core";
import { getBrainConfig, onBrainConfigChange } from "../config/brainConfig";
import { getWorld, setWorld } from "../state/worldStore";
import { appendRawEvent } from "../logging/eventLogStore";
import { appendMetric } from "../logging/metricsStore";
import { runPlanTick, ensureRuntimes, planProgress, validatePlan, FAILURE_BUDGET_DEFAULT, STEP_RETRY_MAX, SAME_REASON_COOLDOWN_TICKS } from "./planExecutor";
import type { Plan } from "@wiw/shared";
import {
  readSoul, readThought, writeThought,
  readObservations, appendObservation, writeSoul, readAllRelationships, writeRelationships
} from "../persistence/soulStore";
import { decideWithMock } from "./mock";
import { decideWithOpenRouter } from "./openrouter";
import { decideWithLocalProxy } from "./localproxy";
import { decideWithChatgptDirect } from "./chatgptDirect";
import type { BrainAction, BrainDecision, RecentDecision } from "./prompt";
import { getLastAffordanceKinds } from "./prompt";
import { MemoryStore } from "./memoryStore";
import { seedBootstrapMemories } from "./bootstrapSeed";
import { readRecentHistory, recordHistory, type HistoryEntry } from "../logging/historyLogStore";
import { recordFunnel } from "../metrics/funnel";
import { configureLlmQueue } from "./llmQueue";
import { enqueueSleepPersonaReflection } from "./reflect";
import { computeImportance, type OutcomeMagnitude } from "./importance";
import * as Importance from "./importance";

let timer: NodeJS.Timeout | null = null;
let rr = 0; // round-robin pointer
const inflightActor = new Set<string>();
const invalidActionByActor = new Map<string, { reason: string; options: string[] }>();
const lastDecisionsByActor = new Map<string, RecentDecision[]>();

// ── Codex v11 B: failure-recovery escalation ────────────────────────────────
// 평시 mini, 같은 actor 가 같은 recoverable failure 를 2회/120tick 밟으면 다음 1 decision 만 큰모델.
// actor cooldown 300 tick, global cap 10%. Soul 에 안 넣음 (정체성/운영 데이터 분리, runtime Map).
const RECOVERABLE_FAILURE_RE = /^(invalid_trade_id|trade_not_for_actor|trade_not_found|missing_want|missing_offer|pending_use_timeout|craft_inputs_short|use_inventory_missing|item_not_found)/;
const failureStreaks = new Map<string, Array<{ tick: number; sig: string }>>();
const lastEscalationTick = new Map<string, number>();
let escalationCount = 0;
let totalLlmDecisions = 0;

function normalizeFailureSig(resultMsg: string): string | null {
  if (!resultMsg) return null;
  const m = resultMsg.match(RECOVERABLE_FAILURE_RE);
  return m ? m[1] : null;
}
function recordFailureForEscalation(actorId: string, tick: number, resultOk: boolean, resultMsg: string): void {
  if (resultOk) {
    // 성공/다른 path 전환 시 streak 끊음 (recovery 성공).
    failureStreaks.delete(actorId);
    return;
  }
  const sig = normalizeFailureSig(resultMsg);
  if (!sig) return;
  const arr = (failureStreaks.get(actorId) ?? []).filter((e) => tick - e.tick <= 120);
  arr.push({ tick, sig });
  failureStreaks.set(actorId, arr.slice(-8));
}
function shouldEscalateDecision(actorId: string, tick: number): boolean {
  if (totalLlmDecisions > 20 && escalationCount / totalLlmDecisions >= 0.10) return false; // global hard cap 10%
  if (tick - (lastEscalationTick.get(actorId) ?? -Infinity) < 300) return false;           // actor cooldown 300t
  const arr = (failureStreaks.get(actorId) ?? []).filter((e) => tick - e.tick <= 120);
  const counts = new Map<string, number>();
  for (const e of arr) counts.set(e.sig, (counts.get(e.sig) ?? 0) + 1);
  return [...counts.values()].some((c) => c >= 2);
}
/** P0-2: 같은 (actor, sig) recovery_hint 30tick 내 1회만. 부정 강화 차단. */
const recoveryHintLast = new Map<string, number>();
/** P2: 같은 (actor, sig) 누적 카운트. 3회 도달 시 next-action hint 한 번 승격. */
const recoveryHintCount = new Map<string, number>();
const recoveryHintPromotedAt = new Map<string, number>();

/**
 * P0-2: 자연스러운 사후 자기관찰 톤. 강제 명령형 X.
 * 같은 sig 의 hint 는 retrieve 가 30tick 내 한 번만 떠올리도록 storage 단계에서 1건 캡.
 */
/**
 * P0-4: agenda failure 패턴 분류.
 * temporary(blocked) → KEEP retry / path_unreachable → CHANGE 권장 톤 / target invalid → ABANDON 톤 / inputs short → subgoal 톤.
 * 명령어 X, 자기관찰 톤. LLM이 자연스레 다음 행동 다르게 골라잡게.
 */
function classifyAgendaFail(decision: BrainDecision, resultMsg: string, world: WorldState, agenda: NonNullable<Soul["agenda"]>): { kind: string; text: string } | null {
  const intent = agenda.intent;
  // target actor 사망/제거
  if (agenda.targetActorId && !world.actors[agenda.targetActorId]?.alive) {
    return { kind: "target_invalid", text: `Goal '${intent}': the target is no longer reachable. A different path may be needed.` };
  }
  if (resultMsg.startsWith("craft_inputs_short") || resultMsg.startsWith("craft_failed_no_match")) {
    return { kind: "inputs_short", text: `Goal '${intent}': ingredients short. Gather materials first.` };
  }
  if (resultMsg === "blocked_actor" || resultMsg === "blocked_tile" || resultMsg.startsWith("no_path") || resultMsg === "out_of_bounds") {
    return { kind: "path_blocked", text: `Goal '${intent}': path keeps blocked. Reconsider the route.` };
  }
  return { kind: "temporary", text: `Goal '${intent}' has stumbled — a brief pause to re-look.` };
}

/**
 * P0-1: recovery_fact — 사실만. 명령형·유도 X.
 * 허용 톤: "밀이 부족하다." / "여기는 작업대다." / "씨앗은 흙 위에서만 쓸 수 있다."
 * 금지: "먼저 모아야 한다." / "USE를 쓰려면 ..." 같은 다음 행동 권유.
 */
function composeRecoveryFact(decision: BrainDecision, resultMsg: string, me: Actor, world: WorldState): string | null {
  const a = decision.action;
  if (a.type === "USE") {
    if (resultMsg === "use_target_required") return "USE: must fill one of itemId / objectId / skillId.";
    if (resultMsg === "material_only_for_craft") {
      const k = decision.action.itemId ? decision.action.itemId.split("-")[0] : "this material";
      return `${k} alone has no effect — use it as a craft input at the right station instead.`;
    }
    if (resultMsg === "use_inventory_missing" || resultMsg === "item_not_in_inventory") {
      const k = a.itemId ? a.itemId.split("-")[0] : "that item";
      return `Bag has no ${k}.`;
    }
    if (resultMsg.startsWith("craft_inputs_short")) {
      const m = resultMsg.match(/craft_inputs_short:(\w+)\s+(\d+)\/(\d+)/);
      if (m) return `Short on ${m[1]} (have ${m[2]}, need ${m[3]}).`;
      return "Ingredients short.";
    }
    if (resultMsg.startsWith("craft_skill_short")) {
      // craft_skill_short:smithing 1 → "Skill smithing needs level 1, currently level X"
      const m = resultMsg.match(/craft_skill_short:(\w+)\s+(\d+)/);
      if (m) {
        const skillId = m[1];
        const required = m[2];
        const currentSkill = me.skills?.find((s) => s.id === skillId);
        const currentLv = currentSkill?.level ?? 0;
        return `Skill ${skillId} needs level ${required} (current lv ${currentLv}). Practice ${skillId}-related work to build xp.`;
      }
      return "Skill level too low for this recipe.";
    }
    if (resultMsg.startsWith("craft_no_recipe")) {
      const m = resultMsg.match(/craft_no_recipe:(\w+)\/(\w+)/);
      if (m) return `No recipe at station=${m[1]} for output=${m[2]}.`;
      return "No matching recipe at this station.";
    }
    if (resultMsg.startsWith("craft_wrong_station")) {
      const m = resultMsg.match(/craft_wrong_station:(\w+)→(\w+) for=(\w+)/);
      if (m) return `${m[3]} is not crafted at ${m[1]} — try ${m[2]} instead.`;
      return "Wrong station for this recipe.";
    }
    if (resultMsg.startsWith("craft_not_adjacent")) {
      const m = resultMsg.match(/craft_not_adjacent:(\S+)\s+dist=(\d+)/);
      if (m) return `${m[1]} is ${m[2]} tiles away — step closer first.`;
      return "Stand next to the station first.";
    }
    if (resultMsg.startsWith("not_a_station")) {
      const m = resultMsg.match(/not_a_station:(\S+)/);
      if (m) return `${m[1]} is not a craft station.`;
      return "That object is not a craft station.";
    }
    if (resultMsg.startsWith("object_not_found")) return "No such object id here.";
    if (resultMsg.startsWith("confirmed_invalid")) {
      const m = resultMsg.match(/confirmed_invalid:(\w+)\/(\w+)/);
      if (m) return `Already confirmed: ${m[1]} does not produce ${m[2]}. Try a different output or station.`;
      return "Already confirmed this recipe is unavailable.";
    }
    if (resultMsg.startsWith("craft_failed_no_match")) return "No recipe matched at this station.";
    if (resultMsg === "object_not_usable") return "That is not a usable station, or you are not adjacent.";
    if (resultMsg === "seed_plant_at_field") return "Seeds plant only on field soil.";
    if (resultMsg === "tile_already_planted") return "Something already grows on this tile.";
    if (resultMsg === "seed_no_space") return "No empty soil within reach.";
    if (resultMsg === "not_at_shrine") return "Praying requires standing at a shrine.";
  }
  if (a.type === "PICKUP") {
    if (resultMsg === "inventory_full") return "Bag is full.";
    if (resultMsg === "item_too_far" && a.itemId) {
      const g = world.groundItems[a.itemId];
      if (g) {
        const dx = g.x - me.x; const dy = g.y - me.y;
        const dist = Math.abs(dx) + Math.abs(dy);
        const ns = dy < 0 ? "N" : dy > 0 ? "S" : "";
        const ew = dx < 0 ? "W" : dx > 0 ? "E" : "";
        const k = a.itemId.split("-")[0];
        return `${k} is ${ns}${ew} ${dist} tiles away.`;
      }
      return "That item is more than one tile away.";
    }
    if (resultMsg === "item_not_found") return "That item is not on this tile.";
  }
  if (a.type === "MOVE" && resultMsg === "blocked_actor") return "Someone stands on that tile.";
  if (a.type === "GIVE" && resultMsg === "target_inventory_full") return "Their bag is full.";
  return null;
}

function currentNeedHintForRetrieve(me: Actor, invalidAction?: { reason: string; options: string[] }): string {
  if (me.hp <= me.maxHp * 0.4) return "I am low on hp";
  if (me.hunger >= 80) return "I am very hungry";
  if (me.hunger >= 60) return "I am hungry";
  const craftShort = invalidAction?.reason.match(/craft_inputs_short:([^,]+(?:,[^,]+)*)/);
  if (craftShort?.[1]) {
    const item = craftShort[1].split(",")[0]?.trim().split(/\s+/)[0];
    if (item) return `I need ${item} for last craft`;
  }
  if (me.stamina <= 20) return "I am low on stamina";
  if (invalidAction?.reason) return `Last action failed: ${invalidAction.reason.slice(0, 80)}`;
  return "";
}

function goalTokensForRetrieve(goals: string[]): string[] {
  const tokens = new Set<string>();
  for (const goal of goals) {
    if (goal.startsWith("[oracle]") || goal.startsWith("[신탁]")) continue;
    for (const token of goal.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []) {
      tokens.add(token);
      if (tokens.size >= 16) return [...tokens];
    }
  }
  return [...tokens];
}

function composeRecoveryHint(decision: BrainDecision, resultMsg: string): string | null {
  const a = decision.action;
  if (a.type === "USE") {
    if (resultMsg === "use_target_required") {
      return "Tried USE without choosing a mode (itemId / objectId / skillId).";
    }
    if (resultMsg === "use_inventory_missing" || resultMsg === "item_not_in_inventory") {
      const k = a.itemId ? a.itemId.split("-")[0] : "the item";
      return `Tried to USE ${k} but the bag did not have it.`;
    }
    if (resultMsg.startsWith("craft_failed_no_match")) {
      return "At the station, no recipe matched current inventory.";
    }
    if (resultMsg.startsWith("craft_inputs_short")) {
      return "Tried to craft, but ingredients were short.";
    }
    if (resultMsg === "object_not_usable") {
      return "The pointed object was not a usable station, or out of reach.";
    }
    if (resultMsg === "seed_plant_at_field") {
      return "Seeds plant only on field soil.";
    }
  }
  if (a.type === "PICKUP") {
    if (resultMsg === "inventory_full") return "Bag is full; cannot pick up more.";
    if (resultMsg === "item_too_far") {
      return `Wanted to pick up ${a.itemId ? a.itemId.split("-")[0] : "that"}, but it was on another tile — one step closer is needed.`;
    }
    if (resultMsg === "item_not_found") return "The item is no longer here.";
  }
  if (a.type === "MOVE" && resultMsg === "blocked_actor") {
    return "Someone stood in the way and blocked the step.";
  }
  if (a.type === "GIVE" && resultMsg === "target_inventory_full") {
    return "Their bag was full; the gift could not pass.";
  }
  return null;
}

function isPendingUseResult(resultMsg: string): boolean {
  return resultMsg.startsWith("pending_use_approach:");
}
type SignatureEntry = { sig: string; tick: number; effective: boolean };
const recentSignaturesByActor = new Map<string, SignatureEntry[]>();
const lastIneffectiveObsTickByActor = new Map<string, Map<string, number>>();
const lastLlmTickByActor = new Map<string, number>();
const LLM_COOLDOWN_TICKS = 5;
// agenda path fail 반복 차단: key=actor:place:bucket 마지막 fail tick
const pathFailCooldown = new Map<string, number>();
const PATH_FAIL_COOLDOWN_TICKS = 10;
// unresolved semantic target (LLM 이 한국어/오타 보낸 경우) 같은 raw input 반복 차단
const unresolvedTargetCooldown = new Map<string, number>();
const UNRESOLVED_TARGET_COOLDOWN_TICKS = 30;
// 2026-05-07: ineffective hard mask 시스템 제거. 실패 이유는 failure_fact + failure_lesson + recovery hint 으로만 전달.

// 2026-05-07: Invalid Affordance Cache — dispatch 가 craft_no_recipe / craft_wrong_station / not_a_station 으로
// invariant 거절 한 (actor, station, target) 조합은 1500 tick TTL 동안 pre-dispatch 차단.
// 마스크와 다름: 휴리스틱 효과 추정 X, dispatch 확정 실패 기반 deterministic.
const invalidAffordanceCache = new Map<string, Map<string, number>>(); // actorId → "station:target" → tickAdded
const INVALID_AFFORDANCE_TTL = 1500;

function affordanceKey(station: string, target: string): string { return `${station}:${target}`; }

function isInvalidAffordance(actorId: string, station: string, target: string, tick: number): boolean {
  const m = invalidAffordanceCache.get(actorId);
  if (!m) return false;
  const t = m.get(affordanceKey(station, target));
  if (t === undefined) return false;
  if (tick - t > INVALID_AFFORDANCE_TTL) { m.delete(affordanceKey(station, target)); return false; }
  return true;
}

function recordInvalidAffordance(actorId: string, station: string, target: string, tick: number): void {
  let m = invalidAffordanceCache.get(actorId);
  if (!m) { m = new Map(); invalidAffordanceCache.set(actorId, m); }
  m.set(affordanceKey(station, target), tick);
}

function isActorAlive(targetId: string | undefined, world: WorldState): boolean {
  if (!targetId) return true;
  const actor = world.actors[targetId];
  return !!actor && actor.alive !== false;
}

function staleTargetIdForAction(action: BrainAction, world: WorldState): string | null {
  if (
    (action.type === "ATTACK" || action.type === "SPEAK" || action.type === "GIVE" || action.type === "OFFER_TRADE") &&
    action.targetId &&
    !isActorAlive(action.targetId, world)
  ) {
    return action.targetId;
  }
  return null;
}

const recentXpKeys = new Map<string, Map<string, { count: number; tick: number }>>();
const BRAIN_CONCURRENCY = 4;
const XP_DECAY_WINDOW_TICKS = 600; // 1min real-time
const XP_DECAY_FULL_COUNT = 2; // first 2 same-key gain full xp, after that 0

type AppliedSkillProgress = {
  skillId: string;
  delta: number;
  xp: number;
  levelUp?: { newLevel: number };
};

export function startBrainLoop(): void {
  configureLlmQueue({ concurrency: BRAIN_CONCURRENCY });
  const schedule = () => {
    const cfg = getBrainConfig();
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, Math.max(1000, cfg.tickIntervalMs));
  };

  onBrainConfigChange(() => schedule());

  const tick = () => {
    const cfg = getBrainConfig();
    if (!cfg.enabled) { schedule(); return; }
    try {
      runOne(cfg);
    } catch (e) {
      console.warn("[brain] tick error", e);
    }
    schedule();
  };

  schedule();
}

function runOne(cfg: ReturnType<typeof getBrainConfig>): void {
  const world = getWorld();
  const free: Actor[] = Object.values(world.actors)
    .filter((a) => a.alive && a.kind !== "monster" && !inflightActor.has(a.id));
  if (free.length === 0) return;

  const n = Math.max(1, Math.min(cfg.maxActorsPerTick, free.length));
  const recentlyAttacked = free.filter((a) =>
    a.kind !== "monster"
    && a.lastAttackedAtTick !== undefined
    && world.tick - a.lastAttackedAtTick <= 30
  );
  const seen = new Set<string>();
  const selected: Actor[] = [];
  for (const a of recentlyAttacked) {
    if (selected.length >= n) break;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    selected.push(a);
  }
  for (let i = 0; selected.length < n && i < free.length; i += 1) {
    const actor = free[(rr + i) % free.length];
    if (actor && !seen.has(actor.id)) {
      seen.add(actor.id);
      selected.push(actor);
    }
  }
  rr = (rr + Math.max(1, n - recentlyAttacked.length)) % free.length;

  for (const me of selected) {
    inflightActor.add(me.id);
    decideAndApply(me)
      .catch((e) => console.warn("[brain] decide error", me.id, e))
      .finally(() => inflightActor.delete(me.id));
  }
}

async function decideAndApply(me: Actor): Promise<void> {
  const cfg = getBrainConfig();
  const world = getWorld();
  const soul = await readSoul(me.id, me.name);
  const thought = await readThought(me.id, world.tick);
  await maybeExpireOracleQuest(me, soul);
  // P0-A: seededAt falsy 검사 (null/undefined/0 모두). 기존 === undefined 만은 re-seed 누락.
  if (!soul.seededAt && me.kind !== "monster") {
    await seedBootstrapMemories(me.id, soul, world.tick);
    await writeSoul({ ...soul, seededAt: world.tick });
    soul.seededAt = world.tick;
  }
  await maybeExpireAgenda(me, soul, world.tick);
  await maybeInjectThreatObservation(me, world);

  // Step 3: monster 가 아닌 NPC 는 actor별 always-on cooldown으로 LLM 호출.
  let triggerReason: string | null = null;
  if (me.kind !== "monster") {
    triggerReason = evaluateTrigger(me, soul, world);
    if (triggerReason === null) {
      const activeSticky = me.sleeping ? "sleep" : me.attackTargetId ? "attack" : me.gatherIntent ? "gather" : me.pendingUse ? "use" : me.movePath ? "move" : null;
      const sysResult = activeSticky
        ? { ok: true as const, fail: `current_action:${activeSticky}` }
        : await runSystemStep(me, soul, world);
      const cooldown = actorCooldown(me, world);
      const lastLlm = lastLlmTickByActor.get(me.id) ?? -Infinity;
      if (world.tick - lastLlm < cooldown) {
        await appendRawEvent({
          tick: world.tick,
          timestamp: Date.now(),
          actorId: me.id,
          category: "brain",
          type: "SYSTEM_SKIP",
          result: "info",
          reason: sysResult.fail ?? "cooldown",
          payload: { provider: "system", trigger: null, sysFail: sysResult.fail, cooldown, currentAction: activeSticky }
        });
        return;
      }
      triggerReason = activeSticky ? "current_action_reconsider" : (sysResult.ok ? "scheduled_reconsider" : "force_unstuck");
    }
    lastLlmTickByActor.set(me.id, world.tick);
  }

  const recentObservations = await readObservations(me.id, 8);
  const lastTwo = recentObservations.slice(-2);
  const currentPlace = nearestPlaceId(world, me, 0);
  const targetActorId = nearestNeighborId(world, me);
  const invalidAction = invalidActionByActor.get(me.id);
  const needs: ("hunger" | "fatigue" | "danger" | "social" | "food" | "work" | "oracle" | "isolation")[] = [];
  if (me.hunger >= 60) { needs.push("hunger"); needs.push("food"); }
  if (me.stamina <= 30) needs.push("fatigue");
  if (me.lastAttackedAtTick !== undefined && world.tick - me.lastAttackedAtTick <= 60) needs.push("danger");
  if (me.hp <= me.maxHp * 0.4) needs.push("danger");
  const nearbyHumanCount = Object.values(world.actors).filter((a) => a.id !== me.id && a.alive && a.kind !== "monster" && Math.abs(a.x - me.x) + Math.abs(a.y - me.y) <= 6).length;
  if (nearbyHumanCount === 0 && (me.hunger >= 50 || me.stamina <= 30)) needs.push("isolation");
  if (nearbyHumanCount > 0) needs.push("social");
  if (soul.activeQuest?.status === "active") needs.push("oracle");
  const agendaText = soul.agenda && soul.agenda.status === "active"
    ? `${soul.agenda.intent} ${soul.agenda.targetItemPrefix ?? ""} ${soul.agenda.lastFailureSig ?? ""}`
    : "";
  const currentNeedHint = currentNeedHintForRetrieve(me, invalidAction);
  const retrieveText = [agendaText, currentNeedHint].filter(Boolean).join(" ");
  // 상황 결합 retrieve — 인벤·인접 station·시야 식량 등 구체 신호 동반.
  const inventoryPrefixes = Array.from(new Set(me.inventory.map((s) => s.item)));
  const nearbyStationTypes = Array.from(new Set(
    Object.values(world.structures ?? {})
      .filter((s) => Math.abs(s.x - me.x) + Math.abs(s.y - me.y) <= 4)
      .map((s) => s.type)
  ));
  const adjacentCraftStation = Object.values(world.structures ?? {}).some((s) => {
    const dx = me.x < s.x ? s.x - me.x : me.x >= s.x + s.width ? me.x - (s.x + s.width - 1) : 0;
    const dy = me.y < s.y ? s.y - me.y : me.y >= s.y + s.height ? me.y - (s.y + s.height - 1) : 0;
    return dx + dy <= 1 && ["oven", "alchemy_table", "forge", "workbench"].includes(s.type);
  });
  const visibleFoodPrefixes = Array.from(new Set(
    Object.values(world.groundItems ?? {})
      .filter((g) => Math.abs(g.x - me.x) + Math.abs(g.y - me.y) <= 20)
      .map((g) => (g.id ?? "").split("-")[0])
      .filter((p) => ["berry","mushroom","herb","apple","pineapple","wheat","carrot","bread","fish","meat","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"].includes(p))
  ));
  const nearbyFieldDist = (() => {
    const fields = Object.values(world.places ?? {}).filter((p) => p.kind === "field");
    if (!fields.length) return Infinity;
    return Math.min(...fields.map((p) => distanceToPlaceLite(me, p)));
  })();
  const retrieveTags: string[] = [];
  if (me.lastAttackedAtTick !== undefined && world.tick - me.lastAttackedAtTick <= 60 || me.hp <= me.maxHp * 0.4) retrieveTags.push("danger");
  if (me.hunger >= 60) retrieveTags.push("food");
  if (nearbyHumanCount > 0) retrieveTags.push("social");
  if (me.pendingUse || adjacentCraftStation) retrieveTags.push("craft");
  if (soul.activeQuest?.status === "active") retrieveTags.push("oracle");
  const recentSpeechPartnerId = recentSpeechPartner(recentObservations);
  if (recentSpeechPartnerId) {
    retrieveTags.push(`from:${recentSpeechPartnerId}`, `to:${recentSpeechPartnerId}`, "speech.to_me", "speech.self");
  }
  const retrieved = await MemoryStore.retrieve({
    text: retrieveText,
    actorId: me.id,
    placeId: currentPlace ?? undefined,
    targetActorId: soul.agenda?.targetActorId ?? targetActorId ?? undefined,
    needs: needs.length ? needs : undefined,
    tags: retrieveTags.slice(0, 6),
    inventoryPrefixes,
    nearbyStationTypes,
    visibleFoodPrefixes,
    nearbyFieldDist,
    hunger: me.hunger,
    hp: me.hp,
    maxHp: me.maxHp,
    agenda: soul.agenda?.status === "active" ? {
      intent: soul.agenda.intent,
      targetItemPrefix: soul.agenda.targetItemPrefix,
      targetActorId: soul.agenda.targetActorId,
      failureSig: soul.agenda.lastFailureSig,
      failureCount: soul.agenda.failureCount
    } : undefined,
    goalTokens: goalTokensForRetrieve(soul.goals),
    limit: 24
  }, me, { tick: world.tick, ts: Date.now() });
  const memories = mergeObservations(retrieved, lastTwo);
  const nearbyActors = nearbyActorDebug(world, me);
  const lastDecisions = lastDecisionsByActor.get(me.id) ?? [];
  invalidActionByActor.delete(me.id);
  // 2026-05-09 PR-1: relationships 에서 me→speaker trust 추출 (heard_claim confidence 가중용).
  const allRels = await readAllRelationships();
  const trustByActor: Record<string, number> = {};
  for (const r of allRels) {
    if (r.from === me.id && typeof r.trust === "number") trustByActor[r.to] = r.trust;
  }
  // mentor (Aaron) 는 default 1.0 — relationships 없을 때.
  if (!trustByActor["player-1"]) trustByActor["player-1"] = 1.0;

  let decision: BrainDecision | null = null;
  let providerUsed: string = cfg.provider;
  let llmFailed = false;

  // 2026-05-08: Aaron (player-1) mentor hard prior — gpt-5.5 권고.
  // 일정 cooldown 마다 가까운 NPC 에게 SPEAK + recipe hint 직접 발화.
  // memory belief 4회 실패 → deterministic action override.
  const mentorDecision = me.id === "player-1" ? computeMentorAction(world, me) : null;
  if (mentorDecision) {
    decision = mentorDecision;
    providerUsed = "mentor";
  } else if (cfg.provider === "mock") {
    decision = decideWithMock({ world, me, soul, thought, memories });
    providerUsed = "mock";
  } else if (cfg.provider === "openrouter" && cfg.apiKey) {
    decision = await decideWithOpenRouter(cfg, { world, me, soul, thought, memories, invalidAction, lastDecisions, trustByActor, relationships: allRels });
    llmFailed = !decision;
  } else if (cfg.provider === "local-proxy") {
    decision = await decideWithLocalProxy(cfg, { world, me, soul, thought, memories, invalidAction, lastDecisions, trustByActor, relationships: allRels });
    llmFailed = !decision;
  } else if (cfg.provider === "chatgpt-direct") {
    // actor 별 model override (각 NPC 다른 모델로 살아있는 A/B)
    let actorModel = cfg.modelOverrides?.[me.id] ?? cfg.model;
    // Codex v11 B: failure-recovery escalation — 막힌 actor 가 같은 실패 반복 시 1 beat 만 큰모델.
    let escalated = false;
    if (cfg.reflectModel && shouldEscalateDecision(me.id, world.tick)) {
      actorModel = cfg.reflectModel;
      escalated = true;
      escalationCount += 1;
      lastEscalationTick.set(me.id, world.tick);
      failureStreaks.delete(me.id); // escalate 1회 소비 — streak 리셋
    }
    totalLlmDecisions += 1;
    const actorCfg = actorModel === cfg.model ? cfg : { ...cfg, model: actorModel };
    decision = await decideWithChatgptDirect(actorCfg, { world, me, soul, thought, memories, invalidAction, lastDecisions, trustByActor, relationships: allRels });
    llmFailed = !decision;
    providerUsed = `chatgpt-direct/${actorModel}${escalated ? "/recovery" : ""}`;
  } else {
    llmFailed = true;
  }
  if (!decision) {
    // NPC LLM 실패 시: fallback templating 없이 이번 박자 skip.
    // 메모리는 그대로 유지되어 다음 LLM 결정이 자기 흐름을 이어감.
    await appendRawEvent({
      tick: world.tick,
      timestamp: Date.now(),
      actorId: me.id,
      category: "brain",
      type: "LLM_skip",
      result: "info",
      reason: "llm_unavailable",
      payload: { provider: providerUsed, llmFailed: true, memoryUsed: memories.length, nearbyActors }
    });
    return;
  }
  if (providerUsed === "mock" || providerUsed === "mentor") {
    decision.thought = buildThoughtFromAction(me, soul, world, decision, thought, memories);
  }
  if (decision.action.type === "SPEAK" && providerUsed !== "mentor") {
    decision.action.claim = undefined;
  }

  // PR5: LLM plan 출력 처리 — planMode 가 shadow/assist/full 일 때 agenda 에 부착.
  const planMode2 = getBrainConfig().planMode ?? "off";
  if (decision.plan && planMode2 !== "off") {
    const validation = validatePlan(decision.plan, me, soul, world);
    if (!validation.ok) {
      await appendMetric({
        tick: world.tick, ts: Date.now(), actor: me.id, provider: providerUsed,
        action: "PLAN", success: false, llmCalled: true,
        planEvent: "plan.validation_failed", planId: decision.plan.id, planReason: validation.reason
      });
      // legacy atomic action 으로 fallback (action 은 LLM 이 보낸 그대로)
    } else {
      const plan = { ...decision.plan, startedAtTick: world.tick, createdBy: providerUsed };
      const newAgenda = soul.agenda
        ? { ...soul.agenda, plan }
        : {
            intent: plan.goal, reason: plan.reason ?? plan.goal,
            startedAtTick: world.tick, ttlTicks: plan.ttlTicks,
            progress: 0, status: "active" as const, failureCount: 0,
            plan
          };
      soul.agenda = newAgenda;
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      await appendMetric({
        tick: world.tick, ts: Date.now(), actor: me.id, provider: providerUsed,
        action: "PLAN", success: true, llmCalled: true,
        planEvent: "plan.created", planId: plan.id,
        planStepKind: plan.steps[0]?.kind, planProgress: 0
      });
      // shadow 모드면 plan 저장만, action 은 그대로 진행. assist/full 이면 action 을 WAIT 로 만들어 system_step 이 plan 진행.
      if (planMode2 !== "shadow") {
        decision.action = { ...decision.action, type: "WAIT" };
      }
    }
  }

  await coerceInvalidTradeIdToWait(world, me, decision, providerUsed);

  // dispatch 직전 final normalize — SPEAK message 빈 경우 reason fallback (parser fail-safe)
  if (decision.action.type === "SPEAK") {
    const m = decision.action.message?.trim();
    if (!m) {
      const r = decision.action.reason?.trim();
      if (r) decision.action.message = r.slice(0, 120);
    }
  }
  const actReq: ActionRequest | null = toActionRequest(me.id, decision);
  // normalized action: LLM 이 itemId 등 생략한 경우 toActionRequest 가 보완한 actual action.
  // events 와 narrative 는 normalized 를 사용 (사용자가 "어떤 물건 주웠는지" 알 수 있도록).
  if (actReq) {
    decision.action = { ...decision.action, ...actReq.action };
  }
  let resultOk = true;
  let resultMsg = "WAIT";
  let resultPending = false;
  let heardClaimWritten = false;
  let heardClaimSkippedReason: string | undefined;
  // actReq 가 null 이면 dispatch 가 안 일어남. WAIT/INVENTORY/OPTIONS/THINK 같은 meta action 외에는 fail 처리.
  // 특히 PICKUP 인데 발밑 ground 0개라 actReq=null 인 경우 fake success 방지.
  if (!actReq) {
    const metaTypes = new Set(["WAIT", "INVENTORY", "OPTIONS", "THINK"]);
    if (!metaTypes.has(decision.action.type)) {
      resultOk = false;
      resultMsg = decision.action.type === "PICKUP" ? "item_not_found" : "invalid_action";
    }
  }
  const actionTargetId = getActionTargetId(world, me, decision);
  const targetBeforeHp = actionTargetId ? world.actors[actionTargetId]?.hp : undefined;
  const targetBeforeHunger = actionTargetId ? world.actors[actionTargetId]?.hunger : undefined;
  const pickupItemId = decision.action.type === "PICKUP" ? decision.action.itemId : undefined;
  const pickupItemType = pickupItemId ? world.groundItems[pickupItemId]?.type : undefined;
  let skillProgress: AppliedSkillProgress[] = [];
  // delta 측정용 스냅샷
  // 2026-05-07 Bug A fix: invLen (slot count) 대신 invTotal (item quantity 합) 사용.
  // 빵 craft (wheat 2 → bread 1) 같은 경우 slot 수는 변동 없지만 총 quantity 는 -1 변동 → effective.
  const beforeSnap = {
    hp: me.hp, hunger: me.hunger, stamina: me.stamina,
    gold: me.gold ?? 0,
    invLen: me.inventory.length, invTotal: inventoryTotalCount(me), x: me.x, y: me.y
  };
  if (actReq) {
    // 2026-05-07: ineffective mask 시스템 제거. 정확한 실패 이유만 LLM 에 전달.
    // simulation invariant: USE itemId 인벤 없으면 즉시 fail (mask 없이 단순 reject).
    const staleTargetId = staleTargetIdForAction(decision.action, world);
    if (staleTargetId) {
      resultOk = false;
      resultMsg = "target_dead_or_missing";
      me.recentBlockers = [...(me.recentBlockers ?? []), { tick: world.tick, reason: `target_dead_or_missing:${staleTargetId}` }].slice(-5);
      invalidActionByActor.set(me.id, {
        reason: `target_dead_or_missing:${staleTargetId}`,
        options: invalidRecoveryOptions(decision.action.type, resultMsg)
      });
      console.warn(`[brain] ${me.id} skipped ${decision.action.type}: target ${staleTargetId} is dead or missing`);
      await appendRawEvent({
        tick: world.tick,
        timestamp: Date.now(),
        actorId: me.id,
        category: "brain",
        type: "INVALID_AFFORDANCE",
        result: "info",
        reason: "target_dead_or_missing",
        payload: { provider: providerUsed, action: decision.action, targetId: staleTargetId }
      });
      await appendObservation({
        id: `obs_target_missing_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: me.id,
        tick: world.tick,
        timestamp: Date.now(),
        kind: "memory",
        text: `target ${staleTargetId} is no longer here.`,
        tags: ["target_dead_or_missing", staleTargetId],
        importance: Importance.RECOVERY_FACT
      });
    } else if (decision.action.type === "USE" && decision.action.itemId && !inventoryHasItemPrefix(me, decision.action.itemId)) {
      resultOk = false;
      resultMsg = "use_inventory_missing";
      await appendRawEvent({
        tick: world.tick,
        timestamp: Date.now(),
        actorId: me.id,
        category: "brain",
        type: "USE_NO_INVENTORY",
        result: "info",
        reason: decision.action.itemId,
        payload: { provider: "system", action: decision.action }
      });
    } else if (decision.action.type === "USE" && decision.action.objectId && decision.action.targetItemId
              && isInvalidAffordance(me.id, decision.action.objectId.replace(/^structure-/, "").split("-")[0], decision.action.targetItemId, world.tick)) {
      // 2026-05-07 Invalid Affordance Cache — 이전에 craft_no_recipe / wrong_station / not_a_station 으로 거절된 (station, target) 재시도 차단.
      const station = decision.action.objectId.replace(/^structure-/, "").split("-")[0];
      resultOk = false;
      resultMsg = `confirmed_invalid:${station}/${decision.action.targetItemId}`;
      await appendRawEvent({
        tick: world.tick,
        timestamp: Date.now(),
        actorId: me.id,
        category: "brain",
        type: "INVALID_AFFORDANCE",
        result: "info",
        reason: `${station}/${decision.action.targetItemId}`,
        payload: { provider: "system", action: decision.action }
      });
    } else {
      const result = dispatchAction(world, actReq);
      setWorld(world);
      resultOk = result.ok;
      resultMsg = result.message;
      resultPending = isPendingUseResult(resultMsg);
      if (
        result.ok &&
        decision.action.type === "SLEEP" &&
        world.tick - (soul.lastPersonaShiftTick ?? 0) >= 43200 &&
        (soul.personaShifts?.length ?? 0) < 2
      ) {
        enqueueSleepPersonaReflection(me.id);
      }
    }
    // 2026-05-07: dispatch 가 invariant 실패 (no_recipe / wrong_station / not_a_station) 반환하면 affordance cache 에 적립.
    if (!resultOk && decision.action.type === "USE" && decision.action.objectId && decision.action.targetItemId) {
      const head = resultMsg.split(":")[0];
      if (head === "craft_no_recipe" || head === "craft_wrong_station" || head === "not_a_station") {
        const station = decision.action.objectId.replace(/^structure-/, "").split("-")[0];
        recordInvalidAffordance(me.id, station, decision.action.targetItemId, world.tick);
      }
    }
    // 2026-05-06: funnel tracking — Skill 별 단계 진행 카운트.
    await trackFunnel(me, decision, resultOk && !resultPending, resultMsg);
    // 2026-05-09 PR-1: trust 자동 조정 — craft 결과 vs heard_claim 매칭.
    if (decision.action.type === "USE" && decision.action.objectId && decision.action.targetItemId) {
      const station = decision.action.objectId.replace(/^structure-/, "").split("-")[0];
      const expectedClaimKey = `craft:${decision.action.targetItemId}|${station}`;
      // delta: 성공(crafted:) +0.05, no_recipe/wrong_station -0.15, inputs_short 0, partial_fail 0
      let trustDelta = 0;
      if (resultOk && resultMsg.startsWith("crafted:")) trustDelta = +0.05;
      else if (!resultOk) {
        const head = resultMsg.split(":")[0];
        if (head === "craft_no_recipe" || head === "craft_wrong_station") trustDelta = -0.15;
      }
      if (trustDelta !== 0) {
        await adjustTrustFromCraftResult(me.id, expectedClaimKey, trustDelta, world.tick);
      }
    }
    if (resultOk && !resultPending) {
      resultMsg = await applyMetaActionSideEffects(me, decision, resultMsg);
      skillProgress = await applyThinXp(me, decision, resultMsg);
      if (skillProgress.length) setWorld(world);
      if (resultMsg.includes("trade_closed")) {
        await recordHistory({
          tick: world.tick,
          ts: Date.now(),
          actorId: me.id,
          kind: "trade.done",
          text: "trade_done",
          meta: { actorId: me.id, action: decision.action }
        });
      }
      await recordEpicActionTriggers({
        world,
        me,
        decision,
        resultMsg,
        actionTargetId,
        targetBeforeHp,
        targetBeforeHunger,
        pickupItemId,
        pickupItemType
      });
    }
    // 2026-05-07: ineffective tracking/mask 제거. 실패 이유만 LLM 에 전달 (failure_fact + failure_lesson + recovery hint).
  }

  if (resultOk && !resultPending) {
    if (decision.action.type === "GIVE" && decision.action.targetId) {
      const itemId = "itemId" in decision.action ? decision.action.itemId : undefined;
      if (itemId) {
        const targetName = world.actors[decision.action.targetId]?.name ?? decision.action.targetId;
        await appendObservation({
          id: `obs_gift_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          actorId: me.id,
          tick: world.tick,
          timestamp: Date.now(),
          kind: "memory",
          text: `Gifted itemId=${itemId.split("-")[0]} to actorId=${decision.action.targetId} (${targetName}).`,
          tags: ["gift", itemId.split("-")[0] ?? "item", decision.action.targetId],
          importance: itemId.startsWith("trinket") ? Importance.GIFT_TRINKET : Importance.GIFT_DEFAULT
        });
      }
    } else if (decision.action.type === "PRAY" && soul.isFollower) {
      await writeSoul({ ...soul, faith: Math.min(1, (soul.faith ?? 0.05) + 0.05) });
    }
    await maybeFulfillOracleQuest(me, soul, decision, resultMsg);
  } else if (!resultOk) {
    // invalidAction reason 은 사실만. "이렇게 해라" 같은 명령형·강제 hint 금지 (사용자 의도).
    let factReason = resultMsg;
    if (decision.action.type === "USE" && (resultMsg === "item_not_in_inventory" || resultMsg === "use_inventory_missing")) {
      const itemId = decision.action.itemId;
      if (itemId) {
        const prefix = itemId.split("-")[0];
        factReason = `USE ${prefix} did not land — ${prefix} is not in the bag.`;
      }
    }
    invalidActionByActor.set(me.id, {
      reason: factReason,
      options: invalidRecoveryOptions(decision.action.type, resultMsg)
    });
    // P0-1: recovery_hint = fact-only. next_action_hint 승격 폐기. 사용자 톤: "밀이 부족하다." 정도만.
    const factText = composeRecoveryFact(decision, resultMsg, me, world);
    if (factText) {
      const sig = `${decision.action.type}:${resultMsg}`;
      const k = `${me.id}:${sig}`;
      const last = recoveryHintLast.get(k) ?? -Infinity;
      if (world.tick - last >= 30) {
        recoveryHintLast.set(k, world.tick);
        const failCls = classifyCraftFailure(resultMsg);
        const recovTags = ["failure_fact", "local_rule"];
        if (failCls) recovTags.push(`fail:${failCls.kind}`);
        await appendObservation({
          id: `obs_recov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          actorId: me.id,
          tick: world.tick,
          timestamp: Date.now(),
          kind: "memory",
          text: factText,
          tags: recovTags,
          importance: Importance.RECOVERY_FACT
        });
      }
    }
  }
  rememberDecision(me.id, { type: decision.action.type, result: resultMsg });
  recordFailureForEscalation(me.id, world.tick, resultOk && !resultPending, resultMsg);
  await recordActionSignature(me, decision, beforeSnap, resultOk && !resultPending, world);
  await applyGoalDecision(me, soul, world, decision, resultOk && !resultPending, resultMsg);
  await maybeSettleAgendaFromOutcome(me, soul, world, decision, resultOk && !resultPending);

  // write thought — recentEvents 는 시스템이 시간순으로 한 줄씩 누적 (LLM 출력 무시).
  const shouldRecordActionObservation = decision.action.type !== "WAIT" && decision.action.type !== "OPTIONS";
  const sysEvent = formatActionLog(world.tick, decision, resultOk, resultMsg);
  // F+G merged. beatHistory — one row per LLM beat: (thought-state) + (action with why and result).
  // Skip when this beat is a verbatim repeat of the last (same priority+nextIntent+action.type) so the
  // timeline stays meaningful instead of filling with copies during sticky stretches.
  const reasonText = (decision.action.reason ?? "").trim();
  const beatEntry = {
    tick: world.tick,
    priority: decision.thought.priority,
    emotion: decision.thought.emotion,
    nextIntent: decision.thought.nextIntent,
    action: shouldRecordActionObservation
      ? {
          type: decision.action.type,
          reason: reasonText || undefined,
          result: resultPending ? "pending" : resultOk ? "success" : resultMsg
        }
      : undefined
  };
  const lastBeat = (thought.beatHistory ?? []).at(-1);
  // dup-skip 4-key: priority + nextIntent + action.type + action.reason 모두 일치하면 같은 beat의 반복.
  // reason이 다르면 같은 행동이라도 의미가 달라 push 허용 (character voice 누적).
  const isDuplicate = lastBeat
    && lastBeat.priority === beatEntry.priority
    && lastBeat.nextIntent === beatEntry.nextIntent
    && (lastBeat.action?.type ?? "_") === (beatEntry.action?.type ?? "_")
    && (lastBeat.action?.reason ?? "") === (beatEntry.action?.reason ?? "");
  const nextBeatHistory = isDuplicate
    ? thought.beatHistory ?? []
    : [...(thought.beatHistory ?? []), beatEntry].slice(-6);
  // J. Agenda lifecycle recap — drain entries queued by applyGoalDecision (CHANGE/COMPLETE/ABANDON) into thought (cap 3).
  const queued = drainAgendaLifecycle(me.id);
  const nextAgendaHistory = queued.length > 0
    ? [...(thought.agendaHistory ?? []), ...queued].slice(-3)
    : thought.agendaHistory;
  const updatedThought = {
    ...thought,
    priority: decision.thought.priority,
    emotion: decision.thought.emotion,
    nextIntent: decision.thought.nextIntent,
    beliefs: mergeCap(thought.beliefs, decision.thought.beliefs, 8),
    recentEvents: shouldRecordActionObservation ? mergeCap(thought.recentEvents, [sysEvent], 8) : thought.recentEvents,
    beatHistory: nextBeatHistory,
    agendaHistory: nextAgendaHistory,
    activePath: resultOk || decision.action.type !== "MOVE" ? decision.thought.activePath : undefined,
    updatedAtTick: world.tick,
    updatedAtMs: Date.now()
  };
  await writeThought(updatedThought);

  const interactionObservation = buildInteractionObservation(
    world,
    me,
    decision,
    resultOk && !resultPending,
    resultMsg,
    actionTargetId,
    targetBeforeHp
  );

  // write observation (self-action) — text 에 행동 파라미터 (item, target, dir 등) 풍부하게 노출
  const selfText = interactionObservation?.selfText
    ?? formatActionLog(world.tick, decision, resultOk, resultMsg).replace(/^\[t\d+\]\s*/, "");
  const actionTags = [decision.action.type.toLowerCase(), providerUsed];
  if (!resultOk) {
    const failCls = classifyCraftFailure(resultMsg);
    if (failCls) actionTags.push(`fail:${failCls.kind}`);
  }
  if (shouldRecordActionObservation) {
    const isRecordedSpeak = decision.action.type === "SPEAK";
    const speakTargetId = isRecordedSpeak ? decision.action.targetId ?? actionTargetId : null;
    const outcomeDelta: OutcomeMagnitude = {
      hpDelta: me.hp - beforeSnap.hp,
      hungerDelta: me.hunger - beforeSnap.hunger,
      staminaDelta: me.stamina - beforeSnap.stamina,
      goldDelta: (me.gold ?? 0) - beforeSnap.gold
    };
    const target = actionTargetId ? world.actors[actionTargetId] : undefined;
    const targetWasAlive = (targetBeforeHp ?? 0) > 0;
    const targetNowDead = target ? !target.alive || target.hp <= 0 : false;
    const milestoneTagsRaw: string[] = [];
    if (decision.action.type === "ATTACK" && targetWasAlive && targetNowDead) {
      const isFirstKill = !(soul.milestonesAchieved ?? []).includes("first_kill");
      if (isFirstKill) {
        milestoneTagsRaw.push("milestone:first_kill");
        const next = { ...soul, milestonesAchieved: [...(soul.milestonesAchieved ?? []), "first_kill"] };
        await writeSoul(next);
      }
      milestoneTagsRaw.push("milestone:kill");
      outcomeDelta.hpDelta = Math.max(Math.abs(outcomeDelta.hpDelta ?? 0), targetBeforeHp ?? 0);
    }
    await appendObservation({
      id: `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: Date.now(),
      kind: isRecordedSpeak ? "dialogue" : "action",
      text: selfText,
      tags: isRecordedSpeak
        ? ["speech.self", "speak", ...(speakTargetId ? [`to:${speakTargetId}`] : []), providerUsed, ...milestoneTagsRaw]
        : [...actionTags, ...milestoneTagsRaw],
      importance: await computeImportance(decision.action, resultOk && !resultPending, resultMsg, me, decision.action.reason, outcomeDelta, milestoneTagsRaw)
    });
  }

  // 2026-05-07: auto-promote 성공 schema → experience tag 메모리 (RAG distilled 분류).
  // craft 성공 (objectId+targetItemId), edible USE 성공, ATTACK kill 등 — 학습 가치 높은 schema 만.
  if (resultOk && !resultPending) {
    const promoted = await maybePromoteExperience(me, decision, resultMsg, world.tick);
    if (promoted) {
      // promoted 자체는 maybePromoteExperience 가 appendObservation 처리.
    }
  } else if (!resultOk) {
    // 2026-05-07: P0 — 실패도 분류된 lesson 으로 자동 승격. dedupe 60 tick.
    await maybePromoteFailureLesson(me, decision, resultMsg, world.tick, world);
  }

  const speechObservation = interactionObservation ?? buildSpeechObservationFallback(world, me, decision, resultOk && !resultPending, resultMsg, actionTargetId);
  if (speechObservation?.targetId) {
    const sideEffect = await applySpeechSideEffects({
      from: me,
      to: world.actors[speechObservation.targetId],
      message: decision.action.type === "SPEAK" ? decision.action.message ?? "…" : "",
      claim: decision.action.type === "SPEAK" ? decision.action.claim : undefined,
      resultMsg,
      resultOk,
      interactionObservation: speechObservation
    });
    heardClaimWritten = sideEffect.heardClaimWritten;
    heardClaimSkippedReason = sideEffect.heardClaimSkippedReason;
    // 직접 사회 입력 → 다음 tick 에 trigger interrupt_social (청자 LLM 호출 받게 함; 응답할지는 자율)
    if (decision.action.type === "SPEAK" || decision.action.type === "GIVE" || decision.action.type === "ATTACK" || decision.action.type === "OFFER_TRADE") {
      noteSocialInput(speechObservation.targetId, world.tick);
    }
    // 2026-05-07: SPEAK 시 화자 success_memory 30% 자동 전파 메커니즘 폐지.
    // 사용자 의도: "speak는 그냥 필요·상황·교훈에 따라 자연스럽게 하고 싶은말 하게하자".
    // 전파가 필요하면 NPC LLM 이 자기 의지로 message 에 schema/내용 담아 SPEAK 하면 됨.
    // pickSpeakerSuccessMemory / heard_from_neighbor 적립 제거.
  }

  // raw event (shows up in feed via SSE)
  await appendRawEvent({
    tick: world.tick,
    timestamp: Date.now(),
    actorId: me.id,
    category: "brain",
    type: llmFailed && me.kind !== "monster"
      ? `LLM failed → ${decision.action.type}`
      : (() => {
          const a = decision.action;
          const t = a.type;
          if (t === "SPEAK" && a.message) return `${t}: ${a.message}`;
          if (t === "GATHER") {
            const what = a.gatherItem ?? (a as { item?: string }).item ?? "?";
            const cnt = a.gatherCount ?? a.count ?? 1;
            const area = a.gatherArea?.placeId ?? (a.gatherArea?.radius ? `r${a.gatherArea.radius}` : "");
            return `${t} ${what}×${cnt}${area ? ` @${area}` : ""}`;
          }
          if (t === "PICKUP" && a.itemId) return `${t} ${a.itemId}`;
          if (t === "DROP" && a.itemId) return `${t} ${a.itemId}`;
          if (t === "USE") {
            if (a.objectId && a.targetItemId) return `${t} ${a.objectId.replace(/^structure-/, "")}→${a.targetItemId}`;
            if (a.objectId) return `${t} ${a.objectId.replace(/^structure-/, "")}`;
            if (a.itemId) return `${t} ${a.itemId}`;
            if (a.skillId) return `${t} skill:${a.skillId}`;
            return t;
          }
          if (t === "GIVE" && a.targetId) return `${t} → ${a.targetId} ${a.itemId ?? (a.currency ? `${a.amount ?? 0}gold` : "")}`;
          if (t === "OFFER_TRADE" && a.targetId) return `${t} → ${a.targetId} ${a.wantItem ?? "?"}↔${a.offerItem ?? `${a.offerGold ?? 0}gold`}${a.message ? `: ${a.message}` : ""}`;
          if (t === "ATTACK" && a.targetId) return `${t} → ${a.targetId}`;
          if (t === "MOVE") {
            if (a.to?.placeId) return `${t} → placeId=${a.to.placeId}`;
            if (a.to?.xy) return `${t} → (${a.to.xy.x},${a.to.xy.y})`;
            if (a.to?.towardItem) return `${t} → ${a.to.towardItem}`;
            if (a.to?.towardActor) return `${t} → ${a.to.towardActor}`;
            if (typeof a.dx === "number" && typeof a.dy === "number") return `${t} (${a.dx},${a.dy})`;
            return t;
          }
          return `${t}${a.message ? `: ${a.message}` : ""}`;
        })(),
    result: resultPending ? "info" : resultOk ? "success" : "failed",
    reason: resultPending ? resultMsg : resultOk ? undefined : resultMsg,
    payload: {
      provider: providerUsed,
      llmFailed,
      memoryUsed: memories.length,
      skillProgress,
      nearbyActors,
      thought: decision.thought,
      resultMsg,
      action: decision.action
    }
  });

  // P0-1: 분석용 metric 적재 (분리된 관찰 레이어. 행동 로직에 침투 X)
  const useMode = decision.action.type === "USE"
    ? (decision.action.skillId ? "skillId"
      : decision.action.objectId && decision.action.targetItemId ? "objectId+target"
      : decision.action.objectId ? "objectId"
      : decision.action.itemId ? "itemId"
      : "empty")
    : null;
  const xpDelta: Record<string, number> = {};
  for (const sp of skillProgress) {
    xpDelta[sp.skillId] = (xpDelta[sp.skillId] ?? 0) + sp.delta;
  }
  // P2: affordance 노출 vs 행동 전환 — exposed kinds 와 이번 행동의 매칭 검사.
  const exposedKinds = getLastAffordanceKinds(me.id);
  const acted = matchAffordanceKind(decision.action, exposedKinds);
  await appendMetric({
    tick: world.tick,
    ts: Date.now(),
    actor: me.id,
    provider: providerUsed,
    action: decision.action.type,
    useMode,
    success: resultOk && !resultPending,
    failReason: resultOk ? undefined : resultMsg,
    cooldownBlocked: !resultOk && /cooldown/.test(resultMsg),
    staminaBlocked: !resultOk && resultMsg === "stamina_too_low",
    inventoryBlocked: !resultOk && (resultMsg === "inventory_full" || resultMsg === "target_inventory_full"),
    heard_claim_written: heardClaimWritten,
    heard_claim_skipped_reason: heardClaimSkippedReason,
    agendaState: soul.agenda?.status ?? "none",
    skillXp: Object.keys(xpDelta).length ? xpDelta : undefined,
    tradeOpened: decision.action.type === "OFFER_TRADE",
    tradeClosed: resultOk && (/trade_closed/.test(resultMsg) || decision.action.type === "ACCEPT_TRADE"),
    llmCalled: !!triggerReason || me.kind === "monster",
    affordancesExposed: exposedKinds.length ? exposedKinds : undefined,
    affordanceActed: acted ?? undefined
  });
}

/** P2: 결정한 action 이 노출된 affordance kind 중 하나에 부합하면 그 kind 반환. */
function matchAffordanceKind(action: BrainDecision["action"], kinds: string[]): string | null {
  if (kinds.length === 0) return null;
  if (action.type === "USE") {
    if (action.itemId?.endsWith("_seed") && kinds.includes("field+seed")) return "field+seed";
    if (action.objectId && action.targetItemId === "bread" && kinds.includes("oven+wheat")) return "oven+wheat";
    if (action.objectId && action.targetItemId === "healing_potion" && kinds.includes("alchemy+herb")) return "alchemy+herb";
    if (action.objectId && action.targetItemId === "pickaxe" && kinds.includes("forge+ore")) return "forge+ore";
    if (action.objectId && action.targetItemId === "workbench_blueprint" && kinds.includes("workbench+wood")) return "workbench+wood";
  }
  return null;
}

function buildThoughtFromAction(
  me: Actor,
  _soul: Soul,
  world: WorldState,
  decision: BrainDecision,
  prevThought: Thought,
  _retrievedMems: Observation[]
): Thought {
  const reason = decision.action.reason ?? "";
  const isNoop = decision.action.type === "WAIT" || decision.action.type === "OPTIONS";
  const intentMap: Record<string, string> = {
    MOVE: "한 칸 이동",
    SPEAK: "대화",
    USE: "물건 사용",
    PICKUP: "줍기",
    DROP: "내려놓기",
    GIVE: "건네기",
    ATTACK: "공격",
    PRAY: "기도",
    THINK: "기억 떠올리기",
    INVENTORY: "짐 정리",
    OPTIONS: "가능 행동 가늠",
    WAIT: "기다림"
  };
  const emotion = isNoop ? "calm"
    : me.hp < me.maxHp * 0.3 ? "afraid"
    : me.hunger > 80 ? "weary"
    : prevThought.emotion ?? "calm";
  return {
    actorId: me.id,
    updatedAtTick: world.tick,
    updatedAtMs: Date.now(),
    priority: isNoop ? "idle" : (reason || prevThought.priority),
    nextIntent: intentMap[decision.action.type] ?? decision.action.type,
    emotion,
    beliefs: mergeCap(prevThought.beliefs, decision.thought.beliefs, 8),
    recentEvents: isNoop
      ? (prevThought.recentEvents ?? []).slice(-8)
      : [
          ...(prevThought.recentEvents ?? []).slice(-7),
          `[t${world.tick}] ${decision.action.type}${reason ? ` "${reason.slice(0, 30)}"` : ""}`
        ].slice(-8),
    activePath: decision.thought.activePath
  };
}

function decideWithFallback(args: {
  world: WorldState;
  me: Actor;
  thought: Thought;
  lastDecisions: RecentDecision[];
}): BrainDecision {
  const activePathDecision = fallbackActivePathDecision(args.world, args.me, args.thought);
  if (activePathDecision) return activePathDecision;

  const last = args.lastDecisions.at(-1);
  if (last?.type === "MOVE" && args.thought.activePath?.remaining.length) {
    const retryPathDecision = fallbackActivePathDecision(args.world, args.me, args.thought);
    if (retryPathDecision) return retryPathDecision;
  }

  if (args.me.hunger >= 70) {
    return {
      thought: {
        priority: "I am hungry; I need to find food and eat",
        emotion: args.me.hp < args.me.maxHp * 0.5 ? "anxious" : "tense",
        nextIntent: "WAIT",
        beliefs: ["if hunger deepens, the body fails"],
        recentEvents: ["LLM decision failed"],
        activePath: args.thought.activePath
      },
      action: { type: "WAIT" }
    };
  }
  if (args.me.stamina <= 30) {
    return {
      thought: {
        priority: "body unstable — check what I have",
        emotion: args.me.hp < args.me.maxHp * 0.5 ? "anxious" : "tense",
        nextIntent: "WAIT",
        beliefs: ["pause briefly when LLM falters"],
        recentEvents: ["LLM decision failed"],
        activePath: args.thought.activePath
      },
      action: { type: "WAIT" }
    };
  }

  return {
    thought: {
      priority: "cannot decide — preserve the body briefly",
      emotion: "calm",
      nextIntent: "WAIT",
      beliefs: ["use a safe fallback instead of mock when LLM fails"],
      recentEvents: ["LLM decision failed"],
      activePath: args.thought.activePath
    },
    action: { type: "WAIT" }
  };
}

function fallbackActivePathDecision(world: WorldState, me: Actor, thought: Thought): BrainDecision | null {
  const activePath = thought.activePath;
  const [next, ...remaining] = activePath?.remaining ?? [];
  if (!activePath || !next) return null;
  if (!canStep(world, me, next.dx, next.dy)) return null;
  return {
    thought: {
      priority: "continue along the planned path",
      emotion: "calm",
      nextIntent: "MOVE",
      beliefs: [`destination xy=(${activePath.targetXY.x},${activePath.targetXY.y})`],
      recentEvents: ["follow activePath after LLM decision failed"],
      activePath: remaining.length > 0 ? { ...activePath, remaining } : undefined
    },
    action: { type: "MOVE", dx: clampStep(next.dx), dy: clampStep(next.dy) }
  };
}

function canStep(world: WorldState, me: Actor, dx: number, dy: number): boolean {
  const nx = me.x + dx;
  const ny = me.y + dy;
  if (nx < 0 || ny < 0 || nx >= world.map.width || ny >= world.map.height) return false;
  if (world.map.collision[ny]?.[nx] === 1) return false;
  return !Object.values(world.actors).some((actor) => actor.id !== me.id && actor.alive && actor.x === nx && actor.y === ny);
}

function clampStep(value: number): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function clampCount(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(32, n);
}

function clampTicks(v: unknown, max = 500): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(max, n);
}

async function coerceInvalidTradeIdToWait(
  world: WorldState,
  me: Actor,
  decision: BrainDecision,
  providerUsed: string
): Promise<void> {
  const actionType = decision.action.type;
  if (actionType !== "ACCEPT_TRADE" && actionType !== "REJECT_TRADE") return;
  const tradeId = decision.action.tradeId;
  const valid = Boolean(tradeId && (world.pendingTrades ?? []).some((trade) =>
    trade.id === tradeId
    && trade.to === me.id
    && (trade.status ?? "pending") === "pending"
    && trade.expiresAtTick > world.tick
  ));
  if (valid) return;

  await appendMetric({
    tick: world.tick,
    ts: Date.now(),
    actor: me.id,
    provider: providerUsed,
    action: actionType,
    success: false,
    failReason: "invalid_trade_id",
    trade_accept_invalid_id: actionType === "ACCEPT_TRADE",
    trade_reject_invalid_id: actionType === "REJECT_TRADE",
    llmCalled: providerUsed !== "mentor"
  });
  await appendRawEvent({
    tick: world.tick,
    timestamp: Date.now(),
    actorId: me.id,
    category: "brain",
    type: "TRADE_INVALID_ID_FILTER",
    result: "info",
    reason: "invalid_trade_id",
    payload: { provider: providerUsed, action: decision.action, tradeId }
  });
  // Codex v11 A2: invalid_trade_id 를 조용히 WAIT 으로 흡수하지 말고 recovery blocker 로 연결.
  // 안 그러면 actor prompt 에 "이전 시도 실패" 가 아니라 "기다림" 으로 남아 Lia/Mira WAIT 루프 발생.
  me.recentBlockers = [...(me.recentBlockers ?? []), { tick: world.tick, reason: `invalid_trade_id:${tradeId ?? "?"}` }].slice(-5);
  invalidActionByActor.set(me.id, {
    reason: `${actionType} failed: trade ${tradeId ?? "?"} is no longer valid (expired, not addressed to you, or already resolved)`,
    options: invalidRecoveryOptions(actionType, "invalid_trade_id")
  });
  decision.action = { type: "WAIT", reason: "invalid_trade_id" };
}

function toActionRequest(actorId: string, d: BrainDecision): ActionRequest | null {
  const a = d.action;
  switch (a.type) {
    case "MOVE":
      // P0-2: to 명시 시 path-driven. 둘 다 없으면 null.
      if (a.to) {
        return { actorId, action: { type: "MOVE", to: a.to, maxTicks: clampCount(a.maxTicks) } };
      }
      if ((a.dx ?? 0) === 0 && (a.dy ?? 0) === 0) return null;
      return { actorId, action: { type: "MOVE", dx: a.dx ?? 0, dy: a.dy ?? 0 } };
    case "ATTACK":
      if (!a.targetId) return null;
      return { actorId, action: { type: "ATTACK", targetId: a.targetId, until: a.attackUntil, maxTicks: clampCount(a.attackMaxTicks) } };
    case "GATHER":
      {
        const item = (a as { item?: string }).item ?? a.gatherItem; // gatherItem is deprecated compatibility.
        const count = clampCount(a.count ?? a.gatherCount) ?? 1;
        const area = (a as { area?: { placeId?: string; radius?: number } }).area ?? a.gatherArea; // gatherArea is deprecated compatibility.
        if (!item) return null;
        return { actorId, action: { type: "GATHER", item, count, area, maxTicks: clampCount(a.maxTicks), allowWaitSpawn: !!a.allowWaitSpawn } };
      }
    case "SPEAK":
      return { actorId, action: { type: "SPEAK", targetId: a.targetId, message: a.message ?? "…", intent: a.intent, claim: a.claim } };
    case "USE":
      return {
        actorId,
        action: {
          type: "USE",
          itemId: a.itemId,
          objectId: a.objectId,
          targetItemId: a.targetItemId,
          skillId: a.skillId,
          targetId: a.targetId,
          count: clampCount(a.count),
          x: a.x,
          y: a.y
        }
      };
    case "PICKUP": {
      // LLM 이 itemId 없이 PICKUP 보낸 경우: 발밑(같은 칸) 또는 prefix 매치 ground item 자동 매핑
      const world = getWorld();
      const me = world.actors[actorId];
      if (!me) return null;
      const candidates = Object.values(world.groundItems).filter((it) => it.x === me.x && it.y === me.y);
      let pickItemId = a.itemId;
      if (!pickItemId) {
        // 발밑 첫 ground item
        if (candidates.length === 0) return null;
        pickItemId = candidates[0].id;
      } else if (!world.groundItems[pickItemId]) {
        // 정확 ID 없으면 prefix 매치 (발밑 우선, 없으면 같은 prefix 어디든)
        const prefix = pickItemId.split("-")[0];
        const sameSpot = candidates.find((it) => (it.id.split("-")[0] === prefix));
        if (sameSpot) pickItemId = sameSpot.id;
        else {
          const anyPrefix = Object.values(world.groundItems).find((it) => it.id.split("-")[0] === prefix);
          if (anyPrefix) pickItemId = anyPrefix.id;
        }
      }
      return { actorId, action: { type: "PICKUP", itemId: pickItemId, count: clampCount(a.count) } };
    }
    case "DROP":
      if (!a.itemId) return null;
      return { actorId, action: { type: "DROP", itemId: a.itemId, count: clampCount(a.count), x: a.x, y: a.y } };
    case "GIVE":
      if (!a.targetId) return null;
      if (a.currency === "gold") return { actorId, action: { type: "GIVE", targetId: a.targetId, currency: "gold", amount: Number(a.amount ?? 0) } };
      if (!a.itemId) return null;
      return { actorId, action: { type: "GIVE", targetId: a.targetId, itemId: a.itemId, count: clampCount(a.count) } };
    case "OFFER_TRADE":
      if (!a.targetId) return null;
      return {
        actorId,
        action: {
          type: "OFFER_TRADE",
          targetId: a.targetId,
          wantItem: a.wantItem,
          wantCount: clampCount(a.wantCount),
          offerItem: a.offerItem,
          offerCount: clampCount(a.offerCount),
          offerGold: typeof a.offerGold === "number" ? Math.max(0, Math.floor(a.offerGold)) : undefined,
          message: a.message
        }
      };
    case "ACCEPT_TRADE":
      if (!a.tradeId) return null;
      return { actorId, action: { type: "ACCEPT_TRADE", tradeId: a.tradeId } };
    case "REJECT_TRADE":
      if (!a.tradeId) return null;
      return { actorId, action: { type: "REJECT_TRADE", tradeId: a.tradeId } };
    case "PRAY":
      return { actorId, action: { type: "PRAY" } };
    case "THINK":
      return { actorId, action: { type: "THINK", query: a.query ?? d.thought.priority } };
    case "OPTIONS":
      return { actorId, action: { type: "OPTIONS" } };
    case "WAIT":
      return { actorId, action: { type: "WAIT" } };
    case "SLEEP":
      return { actorId, action: { type: "SLEEP", maxTicks: clampTicks(a.maxTicks, 200) } };
    default:
      return null;
  }
}

async function maybeFulfillOracleQuest(
  me: Actor,
  soul: Soul,
  decision: BrainDecision,
  resultMsg: string
): Promise<void> {
  const quest = soul.activeQuest;
  const world = getWorld();
  if (!soul.isFollower || !quest || quest.status !== "active") return;
  if (quest.expiresAtTick <= world.tick) {
    await maybeExpireOracleQuest(me, soul);
    return;
  }
  const text = quest.text;
  const lower = text.toLowerCase();
  const atPlace = (placeId: string): boolean => {
    const place = world.places?.[placeId];
    return Boolean(place && me.x >= place.x && me.x < place.x + place.width && me.y >= place.y && me.y < place.y + place.height);
  };
  const isFoodSharing =
    isSharingQuest(text) &&
    decision.action.type === "GIVE" &&
    "itemId" in decision.action &&
    /^(carrot|wheat|herb)-/.test(decision.action.itemId ?? "");
  const progress = quest.progress && isFoodSharing
    ? { ...quest.progress, current: Math.min(quest.progress.target, quest.progress.current + 1) }
    : quest.progress;
  const fulfilled =
    (text.includes("광장") && atPlace("plaza")) ||
    (text.includes("사당") && atPlace("shrine")) ||
    (isFoodSharing && (!progress || progress.current >= progress.target)) ||
    (lower.includes("pray") && decision.action.type === "PRAY") ||
    resultMsg === "prayed";
  if (progress && !fulfilled) {
    await writeSoul({ ...soul, activeQuest: { ...quest, progress }, updatedAt: Date.now() });
    return;
  }
  if (!fulfilled) return;
  const next = {
    ...soul,
    activeQuest: { ...quest, progress, status: "fulfilled" as const },
    goals: soul.goals.filter((goal) => goal !== `[oracle] ${quest.text}`),
    updatedAt: Date.now()
  };
  await writeSoul(next);
  await appendObservation({
    id: `obs_oracle_done_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick: world.tick,
    timestamp: Date.now(),
    kind: "memory",
    text: `Fulfilled an oracle: ${quest.text}`,
    tags: ["oracle", "fulfilled"],
    importance: Importance.ORACLE_FULFILLED
  });
  await recordHistory({
    tick: world.tick,
    ts: Date.now(),
    actorId: me.id,
    kind: "oracle.fulfilled",
    text: "oracle fulfilled",
    meta: { quest: quest.text }
  });
}

async function maybeInjectThreatObservation(me: Actor, world: WorldState): Promise<void> {
  const lastAt = me.lastAttackedAtTick;
  if (lastAt === undefined) return;
  if (world.tick - lastAt > 30) return;
  const recent = await readObservations(me.id, 4);
  if (recent.some((obs) => obs.tags.includes("threat:auto"))) return;
  const attacker = me.lastAttackerId ? world.actors[me.lastAttackerId] : undefined;
  const text = attacker
    ? `Attacked by actorId=${attacker.id} (${attacker.name}); hp ${Math.round(me.hp)}/${me.maxHp}.`
    : `Took damage; hp ${Math.round(me.hp)}/${me.maxHp}.`;
  await appendObservation({
    id: `obs_threat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick: world.tick,
    timestamp: Date.now(),
    kind: "memory",
    text,
    tags: ["threat:auto", attacker?.id ?? "unknown"],
    importance: Importance.THREAT_AUTO
  });
}

async function maybeExpireOracleQuest(me: Actor, soul: Soul): Promise<void> {
  const quest = soul.activeQuest;
  const world = getWorld();
  if (!quest || quest.status !== "active" || quest.expiresAtTick > world.tick) return;
  await writeSoul({
    ...soul,
    activeQuest: { ...quest, status: "abandoned" },
    goals: soul.goals.filter((goal) => goal !== `[oracle] ${quest.text}`),
    updatedAt: Date.now()
  });
  await recordHistory({
    tick: world.tick,
    ts: Date.now(),
    actorId: me.id,
    kind: "oracle.abandoned",
    text: "oracle abandoned",
    meta: { quest: quest.text }
  });
}

const AGENDA_FAILURE_LIMIT = 5;

type Agenda = NonNullable<Soul["agenda"]>;

function placeAtForActor(world: WorldState, me: Actor, placeId: string): boolean {
  const place = world.places?.[placeId];
  if (!place) return false;
  return me.x >= place.x && me.x < place.x + place.width && me.y >= place.y && me.y < place.y + place.height;
}

function passableXY(world: WorldState, x: number, y: number, exceptActorId?: string): boolean {
  if (x < 0 || y < 0 || x >= world.map.width || y >= world.map.height) return false;
  if (world.map.collision[y]?.[x] === 1) return false;
  return !Object.values(world.actors).some((a) => a.alive && a.id !== exceptActorId && a.x === x && a.y === y);
}

function nearestPassableInPlace(world: WorldState, me: Actor, placeId: string): { x: number; y: number } | null {
  const place = world.places?.[placeId];
  if (!place) return null;
  let best: { x: number; y: number; dist: number } | null = null;
  for (let y = place.y; y < place.y + place.height; y++) {
    for (let x = place.x; x < place.x + place.width; x++) {
      if (!passableXY(world, x, y, me.id)) continue;
      const d = Math.abs(x - me.x) + Math.abs(y - me.y);
      if (!best || d < best.dist) best = { x, y, dist: d };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

function adjacentPassableToTarget(world: WorldState, me: Actor, target: { x: number; y: number }): { x: number; y: number } | null {
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  let best: { x: number; y: number; dist: number } | null = null;
  for (const [dx, dy] of dirs) {
    const nx = target.x + dx; const ny = target.y + dy;
    if (!passableXY(world, nx, ny, me.id)) continue;
    const d = Math.abs(nx - me.x) + Math.abs(ny - me.y);
    if (!best || d < best.dist) best = { x: nx, y: ny, dist: d };
  }
  return best ? { x: best.x, y: best.y } : null;
}

function actorDist(world: WorldState, me: Actor, actorId: string): number | null {
  const t = world.actors[actorId];
  if (!t || !t.alive) return null;
  return Math.abs(t.x - me.x) + Math.abs(t.y - me.y);
}

/**
 * LLM 이 한국어 이름 ("햇살 빵집(가게)") 또는 자유 텍스트로 보낸 place 식별자를
 * canonical world.places key 로 변환. ambiguous 매치는 null (강제 X).
 */
function resolvePlaceId(input: string | undefined, world: WorldState): string | null {
  if (!input) return null;
  const places = Object.values(world.places ?? {});
  if (places.length === 0) return null;
  const raw = input.trim();
  if (!raw) return null;
  // 1. exact id
  if (world.places?.[raw]) return raw;
  // 2. exact name
  const nameExact = places.filter((p) => p.name === raw);
  if (nameExact.length === 1) return nameExact[0].id;
  // 3. 괄호 suffix 제거 후 동일 검사 ("햇살 빵집(가게)" → "햇살 빵집")
  const stripped = raw.replace(/\s*\([^)]*\)\s*/g, "").trim();
  if (stripped !== raw) {
    if (world.places?.[stripped]) return stripped;
    const ne2 = places.filter((p) => p.name === stripped);
    if (ne2.length === 1) return ne2[0].id;
  }
  // 4. prefix/substring (단 ambiguous 면 fail)
  const lower = stripped.toLowerCase();
  const subs = places.filter((p) => p.name.toLowerCase().includes(lower) || p.id.toLowerCase().includes(lower));
  if (subs.length === 1) return subs[0].id;
  return null;
}

function nearestGroundItemWithPrefix(world: WorldState, me: Actor, prefix: string): { id: string; x: number; y: number; dist: number } | null {
  let best: { id: string; x: number; y: number; dist: number } | null = null;
  for (const it of Object.values(world.groundItems)) {
    const p = (it.id ?? "").split("-")[0] ?? "";
    if (!p.startsWith(prefix)) continue;
    const d = Math.abs(it.x - me.x) + Math.abs(it.y - me.y);
    if (!best || d < best.dist) best = { id: it.id, x: it.x, y: it.y, dist: d };
  }
  return best;
}

function atAgendaTarget(agenda: Agenda, me: Actor, world: WorldState): boolean {
  if (agenda.targetActorId) {
    const d = actorDist(world, me, agenda.targetActorId);
    if (d === null) return true;
    return d <= 1;
  }
  if (agenda.targetItemPrefix) {
    const found = nearestGroundItemWithPrefix(world, me, agenda.targetItemPrefix);
    if (!found) return false;
    return found.dist === 0; // 같은 칸이어야 도착 (PICKUP 가능)
  }
  if (agenda.targetXY) {
    return me.x === agenda.targetXY.x && me.y === agenda.targetXY.y;
  }
  return false;
}

function targetXYFor(agenda: Agenda, me: Actor, world: WorldState): { x: number; y: number } | null {
  // Priority: actor (현 위치) → 명시 좌표 → item ground 인접 passable
  if (agenda.targetActorId) {
    const t = world.actors[agenda.targetActorId];
    if (!t || !t.alive) return null;
    return adjacentPassableToTarget(world, me, { x: t.x, y: t.y }) ?? { x: t.x, y: t.y };
  }
  if (agenda.targetXY) {
    if (passableXY(world, agenda.targetXY.x, agenda.targetXY.y, me.id)) return agenda.targetXY;
    return adjacentPassableToTarget(world, me, agenda.targetXY);
  }
  if (agenda.targetItemPrefix) {
    const found = nearestGroundItemWithPrefix(world, me, agenda.targetItemPrefix);
    if (found) return adjacentPassableToTarget(world, me, { x: found.x, y: found.y }) ?? { x: found.x, y: found.y };
    return null;
  }
  return null;
}

// 모든 trigger 에 cooldown 적용. 같은 trigger 가 매 tick 재발해도 LLM 폭주 막기 위함.
// hp 0% 같은 지속 위기에서도 한 번 결정 후 N tick 동안은 system_step 으로 그 결정을 집행.
const COOLDOWN_TICKS: Record<string, number> = {
  no_agenda: 3,
  agenda_needs_llm_action: 3,
  agenda_no_path: 3,        // path 못 만들어도 즉시 LLM 폭주 방지 (3 tick)
  interrupt_threat: 5,
  interrupt_crisis: 5,
  interrupt_social: 4,
  pending_trade: 5,
  interrupt_place_exit: 8,  // P0-3: 자동 이동이 다른 place 로 넘어갈 때 1회
  target_invalidated: 8,
  agenda_blocked: 8,
  target_reached: 5,
  scheduled_reconsider: 60
};

function pathFailKey(actorId: string, agenda: Agenda, bucket: string): string {
  const xy = agenda.targetXY ? `${agenda.targetXY.x},${agenda.targetXY.y}` : "";
  const target = xy || agenda.targetActorId || agenda.targetItemPrefix || "?";
  return `${actorId}:${target}:${bucket}`;
}
function recordPathFail(actorId: string, agenda: Agenda, bucket: string, tick: number): void {
  pathFailCooldown.set(pathFailKey(actorId, agenda, bucket), tick);
}
function isPathFailCoolingDown(actorId: string, agenda: Agenda, bucket: string, tick: number): boolean {
  const last = pathFailCooldown.get(pathFailKey(actorId, agenda, bucket));
  return last !== undefined && tick - last < PATH_FAIL_COOLDOWN_TICKS;
}

function evaluateTrigger(me: Actor, soul: Soul, world: WorldState): string | null {
  const agenda = soul.agenda;
  const hasPendingTrade = (world.pendingTrades ?? []).some((trade) =>
    trade.to === me.id && (trade.status ?? "pending") === "pending" && trade.expiresAtTick > world.tick
  );
  if (hasPendingTrade) return cooldownGate(me, world.tick, "pending_trade");
  // 1. agenda boundary
  if (!agenda) return cooldownGate(me, world.tick, "no_agenda");
  if (agenda.status === "path_unreachable") {
    // 같은 actor + target + bucket 반복 시 LLM 즉시 호출 차단 (system_step 또는 wait)
    if (isPathFailCoolingDown(me.id, agenda, "path_unreachable", world.tick)) return null;
    return cooldownGate(me, world.tick, "agenda_no_path");
  }
  if (agenda.status !== "active" && agenda.status !== "settling") {
    return cooldownGate(me, world.tick, "no_agenda");
  }
  if (agenda.status === "active") {
    if (!agenda.plan && !agenda.targetXY && !agenda.targetActorId && !agenda.targetItemPrefix) {
      return cooldownGate(me, world.tick, "agenda_needs_llm_action");
    }
    if (atAgendaTarget(agenda, me, world)) return cooldownGate(me, world.tick, "target_reached");
    if (agenda.failureCount >= AGENDA_FAILURE_LIMIT - 1) return cooldownGate(me, world.tick, "agenda_blocked");
    // strict target invalidation 만 (구체 actor 사망/삭제). targetItemPrefix 는 unfulfilled condition 일 뿐, invalid 아님.
    if (agenda.targetActorId && actorDist(world, me, agenda.targetActorId) === null) {
      return cooldownGate(me, world.tick, "target_invalidated");
    }
  }

  // 2. interrupt: threat
  if (me.lastAttackedAtTick !== undefined && world.tick - me.lastAttackedAtTick <= 30) {
    return cooldownGate(me, world.tick, "interrupt_threat");
  }
  const adjMonster = Object.values(world.actors).some((a) =>
    isHostileCreature(a, world) && Math.abs(a.x - me.x) + Math.abs(a.y - me.y) <= 2
  );
  if (adjMonster) return cooldownGate(me, world.tick, "interrupt_threat");

  // 3. interrupt: crisis
  if (me.hp <= me.maxHp * 0.25 || me.hunger >= 90 || me.stamina <= 10) {
    return cooldownGate(me, world.tick, "interrupt_crisis");
  }

  // 4. interrupt: 직접 사회 입력
  if (recentSocialInput(me.id, world.tick)) return cooldownGate(me, world.tick, "interrupt_social");

  // P0-3: AutoMovePolicy place_exit_required — 자동 이동 중 다른 place 로 넘어가는 첫 박자에 한 번 LLM 재호출.
  if (me.movePathTarget) {
    const curPlace = Object.values(world.places ?? {}).find((p) =>
      me.x >= p.x && me.x < p.x + p.width && me.y >= p.y && me.y < p.y + p.height);
    const lastSeenPlace = lastPlaceByActor.get(me.id);
    if (curPlace && lastSeenPlace && lastSeenPlace !== curPlace.id) {
      lastPlaceByActor.set(me.id, curPlace.id);
      return cooldownGate(me, world.tick, "interrupt_place_exit");
    }
    if (curPlace && !lastSeenPlace) lastPlaceByActor.set(me.id, curPlace.id);
  }

  if (me.pendingUse) return null;

  // 5. scheduled reconsider
  const lastLlm = lastLlmTickByActor.get(me.id) ?? -Infinity;
  const ticksSinceLlm = world.tick - lastLlm;
  if (ticksSinceLlm >= 60) return "scheduled_reconsider";

  return null;
}

function cooldownGate(me: Actor, tick: number, trigger: string): string | null {
  const cd = COOLDOWN_TICKS[trigger] ?? 5;
  const lastLlm = lastLlmTickByActor.get(me.id) ?? -Infinity;
  if (tick - lastLlm < cd) return null; // cooldown — system_step 또는 wait
  return trigger;
}

// P0-3: AutoMovePolicy — place 진입 추적용
const lastPlaceByActor = new Map<string, string>();

const recentSocialInputTicks = new Map<string, number>();
export function noteSocialInput(actorId: string, tick: number): void {
  recentSocialInputTicks.set(actorId, tick);
}
function recentSocialInput(actorId: string, tick: number): boolean {
  const t = recentSocialInputTicks.get(actorId);
  return t !== undefined && tick - t <= 2;
}

function actorCooldown(actor: Actor, world: WorldState): number {
  if (actor.hp < actor.maxHp * 0.35) return 0;
  if (recentSocialInput(actor.id, world.tick)) return 0;
  if (actor.attackTargetId) return 5;
  if (actor.pendingUse) return 80;
  if (actor.gatherIntent || actor.movePath) return 20;
  return 80;
}

type PathPlan = { path: Array<{ dx: number; dy: number }> } | { fail: string };

function buildPathPlan(world: WorldState, me: Actor, agenda: Agenda): PathPlan {
  const target = targetXYFor(agenda, me, world);
  if (!target) {
    if (agenda.targetItemPrefix && !agenda.targetXY && !agenda.targetActorId) return { fail: "target_item_unfulfilled" };
    if (agenda.targetActorId) return { fail: "target_actor_missing" };
    if (agenda.targetXY) return { fail: "target_xy_unreachable" };
    return { fail: "target_xy_null" };
  }
  const path = findPath(world, { x: me.x, y: me.y }, target, 80);
  if (!path) return { fail: "bfs_no_path" };
  // path.length === 0 = 이미 target. fail 아니라 빈 path 로 active 등록 → 다음 tick target_reached trigger.
  return { path };
}

/**
 * ineffective signature: (action.type, target/item canonical id, key params) — result.message 는 안 넣음.
 * 같은 signature 가 3 회 이상 무효 (delta=0 또는 fail) 면 5 tick mask. mask 도중 dispatch 직전 차단.
 */
/**
 * target reached 시 시스템이 자동으로 agenda 를 COMPLETE 처리.
 * "시스템이 욕망을 만드는가" vs "이미 선택한 의제 상태 판정" — Codex 가이드 따름:
 * 도달 사실 인정은 강제 아니다 (master-plan v3.1 정수 유지).
 */
async function maybeAutoCompleteAgenda(me: Actor, soul: Soul, world: WorldState): Promise<void> {
  const agenda = soul.agenda;
  if (!agenda || agenda.status !== "active") return;
  if (!atAgendaTarget(agenda, me, world)) return;
  // 시스템이 그냥 도달 인정. LLM 다음 tick 호출 시 빈 agenda → 새 결정 자유.
  soul.agenda = { ...agenda, status: "completed", progress: agenda.progress + 1 };
  await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
  await appendObservation({
    id: `obs_agenda_done_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick: world.tick,
    timestamp: Date.now(),
    kind: "memory",
    text: `Reached the place for goal '${agenda.intent}'.`,
    tags: ["agenda", "completed", "auto", "lesson"],
    importance: Importance.AGENDA_REACHED_PLACE
  });
}

async function maybeSettleAgendaFromOutcome(
  me: Actor,
  soul: Soul,
  world: WorldState,
  _decision: BrainDecision,
  resultOk: boolean
): Promise<void> {
  if (!resultOk) return;
  const agenda = soul.agenda;
  if (!agenda || agenda.status !== "active") return;
  if (!atAgendaTarget(agenda, me, world)) return;
  await maybeAutoCompleteAgenda(me, soul, world);
}

/**
 * agenda 짧은 윈도우 (≤8 tick) 안에 같은 actor 가 같은 semantic target 으로 또 CHANGE 보내면
 * KEEP 으로 정규화 (churn 방지). 사용자 의도 ("강제 X") 와 충돌하지 않음:
 * 같은 의지를 표현만 살짝 바꿔서 보내는 LLM 변덕만 줄임. 다른 target/intent 는 그대로 CHANGE 허용.
 */
const lastAgendaChangeAtByActor = new Map<string, { tick: number; semanticKey: string }>();
const SAME_TARGET_WINDOW_TICKS = 8;
function semanticAgendaKey(p: { targetXY?: { x: number; y: number }; targetActorId?: string; targetItemPrefix?: string }): string {
  const xy = p.targetXY ? `${p.targetXY.x},${p.targetXY.y}` : "";
  return `${xy}|${p.targetActorId ?? ""}|${p.targetItemPrefix ?? ""}`;
}
function shouldNormalizeChangeToKeep(actorId: string, proposalKey: string, tick: number): boolean {
  const last = lastAgendaChangeAtByActor.get(actorId);
  if (!last) return false;
  return last.semanticKey === proposalKey && (tick - last.tick < SAME_TARGET_WINDOW_TICKS);
}
function noteAgendaChange(actorId: string, key: string, tick: number): void {
  lastAgendaChangeAtByActor.set(actorId, { tick, semanticKey: key });
}

function inventoryHasItemPrefix(actor: Actor, itemId: string): boolean {
  const key = itemId.split("-")[0];
  return actor.inventory.some((slot) => slot.item === key || (slot.kind === "instance" && slot.id === itemId));
}

/** 인벤 전체 item quantity 합. stack 슬롯은 count, instance 슬롯은 1로 카운트.
 *  Bug A fix: 빵 craft (wheat 2 → bread 1) 같이 slot 수는 같지만 quantity 변화 있을 때 detect.
 */
function inventoryTotalCount(actor: Actor): number {
  let total = 0;
  for (const slot of actor.inventory) {
    if (slot.kind === "stack") total += slot.count ?? 0;
    else total += 1;
  }
  return total;
}

// 2026-05-07: pickSpeakerSuccessMemory + heard_memory 30% 자동 전파 메커니즘 폐지.
// SPEAK 는 NPC 자율. message 내용에 schema/회상 담아 전달 여부도 LLM 결정.

/** admin/unstuck 용 — actor 의 recovery hint cache 청소 (mask 시스템 제거되어 노옵에 가까움). */
export function resetActorMasks(actorId: string): void {
  for (const k of [...recoveryHintLast.keys()]) {
    if (k.startsWith(`${actorId}:`)) recoveryHintLast.delete(k);
  }
  for (const k of [...recoveryHintCount.keys()]) {
    if (k.startsWith(`${actorId}:`)) recoveryHintCount.delete(k);
  }
  invalidActionByActor.delete(actorId);
  lastDecisionsByActor.delete(actorId);
  lastPlaceByActor.delete(actorId);
  invalidAffordanceCache.delete(actorId);
}

function buildPathStep(world: WorldState, me: Actor, agenda: Agenda): Array<{ dx: number; dy: number }> | null {
  const plan = buildPathPlan(world, me, agenda);
  return "path" in plan ? plan.path : null;
}

/**
 * PR1~4: plan executor 한 박자. soul.agenda.plan 활용.
 * outcome 별 plan 상태/runtime 업데이트, metric 기록.
 */
async function runPlanStepTick(me: Actor, soul: Soul, world: WorldState, mode: "assist" | "full"): Promise<{ handled: boolean; ok: boolean; fail?: string }> {
  const agenda = soul.agenda!;
  let plan = ensureRuntimes(agenda.plan!);
  // step 시작 시각 기록
  const idx = plan.currentStep;
  if (idx < plan.steps.length) {
    const rt = plan.stepRuntimes[idx];
    if (rt.status === "pending") {
      plan.stepRuntimes = [...plan.stepRuntimes];
      plan.stepRuntimes[idx] = { ...rt, status: "running", startedAtTick: world.tick, retryCount: rt.retryCount ?? 0 };
      await appendMetric({
        tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
        action: "PLAN_STEP", success: true, llmCalled: false,
        planEvent: "plan.step_started", planId: plan.id, planStepKind: plan.steps[idx].kind,
        planProgress: planProgress(plan)
      });
    }
  }
  // plan TTL 검사
  if (world.tick - plan.startedAtTick >= plan.ttlTicks) {
    plan = { ...plan, status: "abandoned" };
    soul.agenda = { ...agenda, plan };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    await appendMetric({
      tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
      action: "PLAN", success: false, llmCalled: false,
      planEvent: "plan.abandoned", planId: plan.id, planReason: "ttl_expired"
    });
    return { handled: true, ok: false, fail: "plan_ttl_expired" };
  }
  // executor 실행
  const outcome = await runPlanTick(world, me, plan, mode);
  switch (outcome.kind) {
    case "noop":
      return { handled: false, ok: false };
    case "ongoing":
      // 다음 tick 또 실행. movePath 자동 진행 등.
      soul.agenda = { ...agenda, plan };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      return { handled: true, ok: true };
    case "step_done": {
      plan.stepRuntimes = [...plan.stepRuntimes];
      plan.stepRuntimes[idx] = { ...plan.stepRuntimes[idx], status: "done", endedAtTick: world.tick };
      plan.currentStep = idx + 1;
      await appendMetric({
        tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
        action: "PLAN_STEP", success: true, llmCalled: false,
        planEvent: "plan.step_done", planId: plan.id, planStepKind: plan.steps[idx].kind,
        planProgress: planProgress(plan)
      });
      if (plan.currentStep >= plan.steps.length) {
        plan = { ...plan, status: "done" };
        await appendMetric({
          tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
          action: "PLAN", success: true, llmCalled: false,
          planEvent: "plan.completed", planId: plan.id, planProgress: 1
        });
      }
      soul.agenda = { ...agenda, plan };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      return { handled: true, ok: true };
    }
    case "step_failed": {
      plan.stepRuntimes = [...plan.stepRuntimes];
      const rt = plan.stepRuntimes[idx];
      const retry = (rt.retryCount ?? 0) + 1;
      const max = STEP_RETRY_MAX[plan.steps[idx].kind];
      if (retry > max) {
        plan.stepRuntimes[idx] = { ...rt, status: "failed", endedAtTick: world.tick, lastFailReason: outcome.reason };
        plan.failureCount += 1;
        await appendMetric({
          tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
          action: "PLAN_STEP", success: false, failReason: outcome.reason, llmCalled: false,
          planEvent: "plan.step_failed", planId: plan.id, planStepKind: plan.steps[idx].kind, planReason: outcome.reason
        });
        if (plan.failureCount >= plan.failureBudget) {
          plan = { ...plan, status: "abandoned" };
          await appendMetric({
            tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
            action: "PLAN", success: false, llmCalled: false,
            planEvent: "plan.abandoned", planId: plan.id, planReason: "failure_budget_exceeded"
          });
        } else {
          // step paused 처리 — LLM 다음 호출 때 결정
          plan = { ...plan, status: "paused", pauseReason: outcome.reason };
          await appendMetric({
            tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
            action: "PLAN", success: false, llmCalled: false,
            planEvent: "plan.paused", planId: plan.id, planReason: outcome.reason
          });
        }
      } else {
        plan.stepRuntimes[idx] = { ...rt, retryCount: retry, lastFailReason: outcome.reason };
      }
      soul.agenda = { ...agenda, plan };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      return { handled: true, ok: false, fail: outcome.reason };
    }
    case "plan_done":
      plan = { ...plan, status: "done" };
      soul.agenda = { ...agenda, plan };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      await appendMetric({
        tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
        action: "PLAN", success: true, llmCalled: false,
        planEvent: "plan.completed", planId: plan.id, planProgress: 1
      });
      return { handled: true, ok: true };
    case "plan_paused":
      plan = { ...plan, status: "paused", pauseReason: outcome.reason };
      soul.agenda = { ...agenda, plan };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      await appendMetric({
        tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
        action: "PLAN", success: false, llmCalled: false,
        planEvent: "plan.paused", planId: plan.id, planReason: outcome.reason
      });
      return { handled: true, ok: false, fail: outcome.reason };
    case "plan_abandoned":
      plan = { ...plan, status: "abandoned" };
      soul.agenda = { ...agenda, plan };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      await appendMetric({
        tick: world.tick, ts: Date.now(), actor: me.id, provider: "system",
        action: "PLAN", success: false, llmCalled: false,
        planEvent: "plan.abandoned", planId: plan.id, planReason: outcome.reason
      });
      return { handled: true, ok: false, fail: outcome.reason };
  }
}

void SAME_REASON_COOLDOWN_TICKS; void validatePlan; void FAILURE_BUDGET_DEFAULT; // PR5/PR6 에서 사용

function isTerminalAgendaStatus(status: Agenda["status"]): boolean {
  return status === "completed" || status === "abandoned" || status === "blocked";
}

async function seedAgendaFromPersonaGoal(soul: Soul, world: WorldState): Promise<Agenda | undefined> {
  const goals = soul.goals.filter((goal) => !goal.startsWith("[oracle]") && !goal.startsWith("[신탁]"));
  if (goals.length === 0) return undefined;
  const goal = goals[Math.floor(world.tick / 600) % goals.length];
  if (!goal) return undefined;
  const agenda: Agenda = {
    intent: goal,
    reason: "seed persona goal",
    startedAtTick: world.tick,
    ttlTicks: 120,
    progress: 0,
    status: "active",
    failureCount: 0
  };
  soul.agenda = agenda;
  await writeSoul({ ...soul, agenda, updatedAt: Date.now() });
  return agenda;
}

async function runSystemStep(me: Actor, soul: Soul, world: WorldState): Promise<{ ok: boolean; fail?: string }> {
  let agenda = soul.agenda;
  if (!agenda || isTerminalAgendaStatus(agenda.status)) {
    agenda = await seedAgendaFromPersonaGoal(soul, world);
    if (!agenda) return { ok: false, fail: "agenda_not_runnable" };
  }
  // PR1~4: plan-driven 우선. plan 이 active 이면 executor 한 박자.
  const planMode = getBrainConfig().planMode ?? "off";
  if (agenda?.plan && agenda.plan.status === "active" && (planMode === "assist" || planMode === "full")) {
    const r = await runPlanStepTick(me, soul, world, planMode);
    if (r.handled) return { ok: r.ok, fail: r.fail };
  }
  if (!agenda || (agenda.status !== "active" && agenda.status !== "settling")) {
    return { ok: false, fail: "agenda_not_runnable" };
  }
  if (!agenda.plan && !agenda.targetXY && !agenda.targetActorId && !agenda.targetItemPrefix) {
    return { ok: false, fail: "agenda_needs_llm_action" };
  }

  // path cache 가 없으면 1회 계산. 비었으면 (도착) 다음 tick trigger 가 처리.
  let path = agenda.path;
  if (!path) {
    const plan = buildPathPlan(world, me, agenda);
    if ("fail" in plan) {
      soul.agenda = { ...agenda, failureCount: agenda.failureCount + 2, lastFailureSig: `path_unreachable:${plan.fail}` };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      return { ok: false, fail: plan.fail };
    }
    path = plan.path;
    soul.agenda = { ...agenda, path, lastReplanTick: world.tick };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
  }
  if (path.length === 0) return { ok: false, fail: "already_at_target" };

  const next = path[0];
  const actReq: ActionRequest = { actorId: me.id, action: { type: "MOVE", dx: next.dx as 1 | 0 | -1, dy: next.dy as 1 | 0 | -1 } };
  const result = dispatchAction(world, actReq);
  setWorld(world);

  if (result.ok) {
    soul.agenda = { ...soul.agenda!, path: path.slice(1), progress: agenda.progress + 1 };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    await appendRawEvent({
      tick: world.tick,
      timestamp: Date.now(),
      actorId: me.id,
      category: "brain",
      type: "MOVE",
      result: "success",
      payload: {
        provider: "system",
        llmFailed: false,
        memoryUsed: 0,
        skillProgress: [],
        thought: { priority: agenda.intent, emotion: "calm", nextIntent: "MOVE", beliefs: [], recentEvents: [] },
        action: { type: "MOVE", dx: next.dx, dy: next.dy, reason: agenda.intent }
      }
    });
    return { ok: true };
  }

  // dispatch 실패 (다른 actor 막음 등). 1회 replan 시도. lastReplan cooldown 으로 폭주 방지.
  const lastReplan = agenda.lastReplanTick ?? -Infinity;
  let replanFail: string | undefined;
  if (world.tick - lastReplan >= 3) {
    const plan = buildPathPlan(world, me, agenda);
    if ("path" in plan) {
      soul.agenda = { ...agenda, path: plan.path, lastReplanTick: world.tick, failureCount: agenda.failureCount + 1 };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    } else {
      replanFail = plan.fail;
      soul.agenda = { ...agenda, failureCount: agenda.failureCount + 2, lastFailureSig: `path_unreachable:${plan.fail}` };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    }
  } else {
    soul.agenda = { ...agenda, failureCount: agenda.failureCount + 1, lastFailureSig: `MOVE|blocked|${result.message}` };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
  }
  await appendRawEvent({
    tick: world.tick,
    timestamp: Date.now(),
    actorId: me.id,
    category: "brain",
    type: "MOVE",
    result: "failed",
    reason: result.message,
    payload: { provider: "system", action: { type: "MOVE", dx: next.dx, dy: next.dy }, replanFail }
  });
  return { ok: false, fail: replanFail ?? `move_${result.message}` };
}


const SETTLING_GRACE_TICKS = 3;

async function maybeExpireAgenda(me: Actor, soul: Soul, tick: number): Promise<void> {
  const agenda = soul.agenda;
  if (!agenda) return;
  if (agenda.status === "active") {
    const elapsed = tick - agenda.startedAtTick;
    const ttlExpired = elapsed >= agenda.ttlTicks;
    const failureExceeded = agenda.failureCount >= AGENDA_FAILURE_LIMIT;
    if (!ttlExpired && !failureExceeded) return;
    if (failureExceeded) {
      // hard block — 즉시 blocked 로
      const next: Agenda = { ...agenda, status: "blocked" };
      await writeSoul({ ...soul, agenda: next, updatedAt: Date.now() });
      soul.agenda = next;
      await appendObservation({
        id: `obs_agenda_blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: me.id,
        tick,
        timestamp: Date.now(),
        kind: "memory",
        text: `Goal '${agenda.intent}' is blocked. Looking at another route for a beat.`,
        tags: ["agenda", "blocked", "lesson"],
        importance: Importance.AGENDA_EXPIRED
      });
    } else {
      // ttl 만료 → settling. 즉시 abandoned 금지 (NPC 가 이 자리에서 잠시 남는 시간).
      const next: Agenda = { ...agenda, status: "settling" };
      await writeSoul({ ...soul, agenda: next, updatedAt: Date.now() });
      soul.agenda = next;
    }
    return;
  }
  if (agenda.status === "settling") {
    // 일정 tick 후 abandoned 로 자연 전이 → 다음 tick 에 no_agenda trigger 로 LLM 호출.
    const elapsed = tick - agenda.startedAtTick;
    if (elapsed >= agenda.ttlTicks + SETTLING_GRACE_TICKS) {
      const next: Agenda = { ...agenda, status: "abandoned" };
      await writeSoul({ ...soul, agenda: next, updatedAt: Date.now() });
      soul.agenda = next;
      await appendObservation({
        id: `obs_agenda_exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: me.id,
        tick,
        timestamp: Date.now(),
        kind: "memory",
        text: `Time on goal '${agenda.intent}' ran out. Settling on what's next.`,
        tags: ["agenda", "expired", "lesson"],
        importance: Importance.AGENDA_BLOCKED
      });
    }
  }
}

type AgendaLifecycleEntry = { tick: number; kind: "CHANGE" | "COMPLETE" | "ABANDON"; intent: string; reason?: string };
const pendingAgendaHistory = new Map<string, AgendaLifecycleEntry[]>();

function queueAgendaLifecycle(actorId: string, entry: AgendaLifecycleEntry): void {
  const arr = pendingAgendaHistory.get(actorId) ?? [];
  arr.push(entry);
  pendingAgendaHistory.set(actorId, arr);
}

function drainAgendaLifecycle(actorId: string): AgendaLifecycleEntry[] {
  const arr = pendingAgendaHistory.get(actorId) ?? [];
  pendingAgendaHistory.delete(actorId);
  return arr;
}

async function applyGoalDecision(
  me: Actor,
  soul: Soul,
  world: WorldState,
  decision: BrainDecision,
  resultOk: boolean,
  resultMsg: string
): Promise<void> {
  const gd = decision.goalDecision;
  const tick = world.tick;
  const current = soul.agenda;

  // 결과 실패 시 현재 active agenda에 failure 누적 (KEEP 인지와 무관하게 시스템 책임)
  if (current && current.status === "active" && !resultOk) {
    const sig = `${decision.action.type}|${decision.action.targetId ?? decision.action.itemId ?? ""}|${resultMsg.split(":")[0]}`;
    soul.agenda = {
      ...current,
      failureCount: current.failureCount + 1,
      lastFailureSig: sig,
      progress: current.progress
    };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    // P0-4: failureCount 누적 시 차등 obs (target invalid / unreachable / inputs short / temporary)
    if (soul.agenda.failureCount === 3 || soul.agenda.failureCount === 5) {
      const cat = classifyAgendaFail(decision, resultMsg, world, soul.agenda);
      if (cat) {
        await appendObservation({
          id: `obs_agenda_fail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          actorId: me.id,
          tick,
          timestamp: Date.now(),
          kind: "memory",
          text: cat.text,
          tags: ["agenda", "failure_pattern", cat.kind],
          importance: Importance.AGENDA_FAILURE_PATTERN
        });
      }
    }
  } else if (current && current.status === "active" && resultOk) {
    soul.agenda = { ...current, progress: current.progress + 1 };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
  }

  if (!gd) return;

  if (gd.kind === "COMPLETE" && current && current.status === "active") {
    soul.agenda = { ...current, status: "completed" };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    queueAgendaLifecycle(me.id, { tick, kind: "COMPLETE", intent: current.intent, reason: gd.reason });
    await appendObservation({
      id: `obs_agenda_done_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick,
      timestamp: Date.now(),
      kind: "memory",
      text: `Completed agenda: '${current.intent}'.`,
      tags: ["agenda", "completed", "lesson", "milestone:agenda_completed"],
      importance: Importance.AGENDA_COMPLETED
    });
    return;
  }

  if (gd.kind === "ABANDON" && current && current.status === "active") {
    soul.agenda = { ...current, status: "abandoned" };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    queueAgendaLifecycle(me.id, { tick, kind: "ABANDON", intent: current.intent, reason: gd.reason });
    await appendObservation({
      id: `obs_agenda_aban_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick,
      timestamp: Date.now(),
      kind: "memory",
      text: `Abandoned agenda: '${current.intent}'. (${gd.reason ?? ""})`,
      tags: ["agenda", "abandoned", "lesson"],
      importance: Importance.AGENDA_ABANDONED
    });
    return;
  }

  if (gd.kind === "CHANGE" && gd.proposal && gd.proposal.intent.length >= 2) {
    const p = gd.proposal;
    const canonicalActorId = p.targetActorId && world.actors[p.targetActorId] ? p.targetActorId : undefined;
    // targetXY 검증: 맵 안 + 직접 도달 가능하거나 인접 접근 가능해야만 보존.
    let validXY: { x: number; y: number } | undefined;
    if (p.targetXY) {
      const x = Math.trunc(p.targetXY.x), y = Math.trunc(p.targetXY.y);
      if (x >= 0 && y >= 0 && x < world.map.width && y < world.map.height) {
        if (passableXY(world, x, y, me.id) || adjacentPassableToTarget(world, me, { x, y })) {
          validXY = { x, y };
        }
      }
    }
    // same-target churn 방지: 짧은 윈도우 안에 같은 semantic target 또 CHANGE → KEEP 정규화
    const semKey = semanticAgendaKey({
      targetXY: validXY,
      targetActorId: canonicalActorId,
      targetItemPrefix: p.targetItemPrefix
    });
    if (current && current.status === "active" && shouldNormalizeChangeToKeep(me.id, semKey, tick)) {
      soul.agenda = { ...current, ttlTicks: current.ttlTicks + 4 };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      return;
    }
    noteAgendaChange(me.id, semKey, tick);
    const draft: Agenda = {
      intent: p.intent,
      targetXY: validXY,
      targetActorId: canonicalActorId,
      targetItemPrefix: p.targetItemPrefix,
      reason: p.reason || gd.reason || "",
      startedAtTick: tick,
      ttlTicks: p.ttlTicks ?? 15,
      progress: 0,
      status: "active",
      failureCount: 0,
      nextActions: p.nextActions
    };
    const plan = buildPathPlan(world, me, draft);
    if ("path" in plan) {
      soul.agenda = { ...draft, path: plan.path, lastReplanTick: tick };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      // tickWorld 가 actor.movePath 를 따라 자동 진행. agenda.path 와 mirror.
      me.movePath = plan.path;
      if (draft.targetXY) me.movePathTarget = draft.targetXY;
    } else if (!draft.targetXY && !draft.targetActorId && !draft.targetItemPrefix) {
      soul.agenda = draft;
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    } else {
      // path 못 만들면 active 등록 거부. status="path_unreachable" 로 기록 → 다음 tick agenda_no_path trigger.
      soul.agenda = { ...draft, status: "path_unreachable", lastFailureSig: `no_path:${plan.fail}` };
      await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
      recordPathFail(me.id, draft, "path_unreachable", tick);
      await appendObservation({
        id: `obs_agenda_unreach_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: me.id,
        tick,
        timestamp: Date.now(),
        kind: "memory",
        text: `No path toward goal '${p.intent}' right now — must think of another way. (${plan.fail})`,
        tags: ["agenda", "path_unreachable", "lesson"],
        importance: Importance.AGENDA_PATH_UNREACHABLE
      });
      await appendRawEvent({
        tick,
        timestamp: Date.now(),
        actorId: me.id,
        category: "brain",
        type: "AGENDA_PATH_FAIL",
        result: "info",
        reason: plan.fail,
        payload: { provider: "system", agenda: draft, fail: plan.fail }
      });
    }
    queueAgendaLifecycle(me.id, { tick, kind: "CHANGE", intent: p.intent, reason: p.reason || gd.reason });
    await appendObservation({
      id: `obs_agenda_set_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick,
      timestamp: Date.now(),
      kind: "memory",
      text: `Set agenda: '${p.intent}'. (${p.reason || ""})`,
      tags: ["agenda", "started"],
      importance: Importance.AGENDA_STARTED
    });
    return;
  }
  // KEEP: 위에서 progress/failure 이미 갱신.
}

async function applyMetaActionSideEffects(me: Actor, decision: BrainDecision, resultMsg: string): Promise<string> {
  const world = getWorld();
  const now = Date.now();
  if (decision.action.type === "THINK") {
    const query = decision.action.query ?? decision.thought.priority;
    const thinkSoul = await readSoul(me.id, me.name);
    const goalsText = thinkSoul.goals
      .filter((goal) => !goal.startsWith("[oracle]") && !goal.startsWith("[신탁]"))
      .join(" ");
    // 2026-05-06: THINK 강화 — 본 결정 retrieve 와 동등 깊이.
    // limit 16 + situational signals 전달 → recall 만 아니라 합성 통찰 메모리 자동 생성.
    const inventoryPrefixes = Array.from(new Set(me.inventory.map((s) => s.item)));
    const nearbyStationTypes = Array.from(new Set(
      Object.values(world.structures ?? {})
        .filter((s) => Math.abs(s.x - me.x) + Math.abs(s.y - me.y) <= 4)
        .map((s) => s.type)
    ));
    const visibleFoodPrefixes = Array.from(new Set(
      Object.values(world.groundItems ?? {})
        .filter((g) => Math.abs(g.x - me.x) + Math.abs(g.y - me.y) <= 20)
        .map((g) => (g.id ?? "").split("-")[0])
        .filter((p) => ["berry","mushroom","herb","apple","pineapple","wheat","carrot","bread","fish","meat","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"].includes(p))
    ));
    const recalled = await MemoryStore.retrieve({
      text: `${query} ${goalsText}`,
      actorId: me.id,
      limit: 16,
      inventoryPrefixes,
      nearbyStationTypes,
      visibleFoodPrefixes,
      hunger: me.hunger,
      hp: me.hp,
      maxHp: me.maxHp
    }, me, { tick: world.tick, ts: now });
    // 2026-05-08: THINK synthesis 정제.
    // - 재귀 인용 차단: 이전 THINK 결과 ("Looked back on:" / "Paused a beat" 시작) 는 source 에서 제외.
    // - schema 라인 strip: "Executed:" / "Attempted:" 라인 제거.
    // - 단어 경계 truncation, 70자.
    const cleanFragment = (raw: string): string => {
      const noSchema = raw.split("\n")
        .filter((ln) => !/^(Executed|Attempted):/.test(ln.trim()))
        .filter((ln) => !/^\[t\d+\]/.test(ln.trim()))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (noSchema.length <= 70) return noSchema;
      const cut = noSchema.slice(0, 70);
      const lastSpace = cut.lastIndexOf(" ");
      return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + "…";
    };
    const isRecursiveThink = (txt: string): boolean =>
      /^Paused a beat to recall/.test(txt) || /^Looked back on:/.test(txt) || /^Reflecting on/.test(txt);
    const usable = recalled.filter((o) => !isRecursiveThink(o.text));
    const top = usable.slice(0, 3);
    if (top.length > 0) {
      const fragments = top.map((o) => cleanFragment(o.text)).filter((f) => f.length > 0);
      const queryShort = query.length > 60 ? query.slice(0, 57) + "…" : query;
      const synthesis = fragments.length > 0
        ? `Looked back on: ${queryShort} · Threads: ${fragments.join(" · ")}`
        : `Looked back on: ${queryShort} · Nothing relevant surfaced.`;
      await appendObservation({
        id: `obs_think_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: me.id,
        tick: world.tick,
        timestamp: now,
        kind: "reflection",
        text: synthesis,
        tags: ["self-think", "lesson", "reflection"],
        importance: Importance.SELF_THINK_REFLECTION
      });
    }
    const important = recalled.find((obs) => obs.importance >= 0.8);
    if (important && !(await hasHistory("memory.recalled_important", (entry) => entry.actorId === me.id))) {
      await recordHistory({
        tick: world.tick,
        ts: now,
        actorId: me.id,
        kind: "memory.recalled_important",
        text: `${me.name} recalled an important memory.`,
        meta: { observationId: important.id, importance: important.importance }
      });
    }
    return `recalled:${recalled.length}`;
  }
  // PR6: INVENTORY 액션 삭제됨. 인벤은 항상 컨텍스트에 노출되므로 별도 자기관찰 메모리 불필요.
  // Appraise 결과는 별도 분기 (USE skillId=appraise) 에서 메모리 추가.
  if (decision.action.type === "USE" && decision.action.skillId === "appraise" && resultMsg.startsWith("appraise:")) {
    await appendObservation({
      id: `obs_appraise_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: now,
      kind: "memory",
      text: resultMsg,
      tags: ["appraise", "observation"],
      importance: Importance.APPRAISE_OBSERVATION
    });
  }
  if (decision.action.type === "USE" && decision.action.itemId?.startsWith("letter")) {
    const text = "Letter belief: news and a message from another village have arrived.";
    await appendObservation({
      id: `obs_letter_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: now,
      kind: "memory",
      text,
      tags: ["letter", "belief"],
      importance: Importance.LETTER_BELIEF
    });
    return `${resultMsg} belief_added`;
  }
  if (decision.action.type === "OPTIONS") {
    await appendObservation({
      id: `obs_options_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: now,
      kind: "memory",
      text: resultMsg,
      tags: ["self-options"],
      importance: Importance.OPTIONS_OBSERVATION
    });
  }
  return resultMsg;
}

async function applyThinXp(me: Actor, decision: BrainDecision, resultMsg: string): Promise<AppliedSkillProgress[]> {
  const action = decision.action;
  type Change = { skillId: string; key: string; xp: number };
  const changes: Change[] = [];
  const itemKey = (action as { itemId?: string }).itemId?.split("-")[0] ?? "";
  const targetKey = (action as { targetId?: string }).targetId ?? "";
  if (action.type === "MOVE") changes.push({ skillId: "running", key: "MOVE", xp: 1 });
  if (action.type === "SPEAK" && getActionTargetId(getWorld(), me, decision)) changes.push({ skillId: "conversation", key: `SPEAK:${targetKey}`, xp: 2 });
  if (action.type === "SPEAK" && getActionTargetId(getWorld(), me, decision)) changes.push({ skillId: "diplomacy", key: `SPEAK:${targetKey}`, xp: action.claim ? 3 : 1 });
  if (action.type === "OFFER_TRADE") changes.push({ skillId: "trading", key: `OFFER_TRADE:${targetKey}`, xp: resultMsg.includes("accepted") ? 5 : 2 });
  if (action.type === "USE" && isFarmPractice(action.itemId, resultMsg)) changes.push({ skillId: "farming", key: `USE:${itemKey}`, xp: 3 });
  if (action.type === "PICKUP" && isFarmItem(action.itemId)) changes.push({ skillId: "farming", key: `PICKUP:${itemKey}`, xp: 2 });
  if (action.type === "USE" && isGatheringPractice(action.itemId, resultMsg)) changes.push({ skillId: "gathering", key: `USE:${itemKey}`, xp: 2 });
  if (action.type === "PICKUP" && isGatheringItem(action.itemId)) changes.push({ skillId: "gathering", key: `PICKUP:${itemKey}`, xp: 2 });
  if (action.type === "PICKUP" && isMiningItem(action.itemId)) changes.push({ skillId: "mining", key: `PICKUP:${itemKey}`, xp: 2 });
  if (action.type === "PICKUP" && isWoodcuttingItem(action.itemId)) changes.push({ skillId: "woodcutting", key: `PICKUP:${itemKey}`, xp: 2 });
  if (action.type === "PICKUP" && isForageItem(action.itemId)) changes.push({ skillId: "foraging", key: `PICKUP:${itemKey}`, xp: 3 });
  if (action.type === "USE" && action.itemId?.startsWith("fishing_rod")) changes.push({ skillId: "fishing", key: `USE:fishing_rod`, xp: resultMsg.includes("fish_caught") ? 5 : 1 });
  if (action.type === "ATTACK") changes.push({ skillId: "swordsmanship", key: `ATTACK:${targetKey}`, xp: 3 });
  if (action.type === "ATTACK") changes.push({ skillId: "hunting", key: `ATTACK:${targetKey}`, xp: resultMsg.includes("killed") || resultMsg.includes("dead") ? 5 : 2 });
  if (action.type === "PRAY") changes.push({ skillId: "meditation", key: "PRAY", xp: 2 });
  if (action.type === "WAIT") changes.push({ skillId: "meditation", key: "WAIT", xp: 1 });
  if (action.type === "THINK" && action.query && action.query.length >= 8) changes.push({ skillId: "meditation", key: `THINK:${(action.query ?? "").slice(0, 24)}`, xp: 1 });
  if (action.type === "USE" && action.itemId && isFoodItem(action.itemId)) changes.push({ skillId: "cooking", key: `USE_FOOD:${itemKey}`, xp: 2 });
  // 2026-05-06: station-based craft xp — skill block 의 actionTemplate 와 정합.
  if (action.type === "USE" && action.objectId) {
    const obj = action.objectId;
    if (obj.includes("oven") && resultMsg.includes("ok")) changes.push({ skillId: "cooking", key: `USE:oven`, xp: 5 });
    if (obj.includes("forge") && resultMsg.includes("ok")) changes.push({ skillId: "smithing", key: `USE:forge`, xp: 5 });
    if (obj.includes("alchemy") && resultMsg.includes("ok")) changes.push({ skillId: "alchemy", key: `USE:alchemy_table`, xp: 5 });
    if (obj.includes("workbench") && resultMsg.includes("ok")) changes.push({ skillId: "architecture", key: `USE:workbench`, xp: 5 });
    if (obj.includes("workbench") && /leather|hide|helmet|boots|armor|chainmail/.test(resultMsg)) changes.push({ skillId: "tailoring", key: `USE:tailoring`, xp: 5 });
  }
  if (action.type === "USE" && action.skillId === "appraise") changes.push({ skillId: "appraise", key: "USE:appraise", xp: 2 });

  const applied: AppliedSkillProgress[] = [];
  const world = getWorld();
  const memMap = recentXpKeys.get(me.id) ?? new Map<string, { count: number; tick: number }>();
  recentXpKeys.set(me.id, memMap);
  for (const [k, v] of memMap) if (world.tick - v.tick > XP_DECAY_WINDOW_TICKS) memMap.delete(k);

  let leveledUp = false;
  for (const change of dedupSkillChanges(changes)) {
    const skill = me.skills?.find((s) => s.id === change.skillId);
    if (!skill || skill.level >= 10) continue;
    const memKey = `${change.skillId}:${change.key}`;
    const prev = memMap.get(memKey);
    let xpGain = change.xp;
    if (prev && prev.count >= XP_DECAY_FULL_COUNT) xpGain = 0;
    memMap.set(memKey, { count: (prev?.count ?? 0) + 1, tick: world.tick });
    if (xpGain <= 0) continue;
    skill.lastPracticedTick = world.tick;
    skill.xp = (skill.xp ?? 0) + xpGain;
    const newLevel = levelForXp(skill.xp);
    const entry: AppliedSkillProgress = { skillId: change.skillId, delta: xpGain, xp: skill.xp };
    if (newLevel > skill.level) {
      const gain = Math.min(10, newLevel) - skill.level;
      skill.level = Math.min(10, newLevel);
      entry.levelUp = { newLevel: skill.level };
      // 2026-05-08: stat raise (grantSkillXp 와 동일 공식). active +0.5/lv, passive +0.25/lv.
      const primary = skill.primaryStat;
      if (primary && me.status && (primary in me.status)) {
        const inc = (skill.type === "active" ? 0.5 : 0.25) * gain;
        const key = primary as keyof typeof me.status;
        me.status[key] = (me.status[key] ?? 5) + inc;
        leveledUp = true;
      }
      await recordHistory({
        tick: world.tick,
        ts: Date.now(),
        actorId: me.id,
        kind: "skill.level_up",
        text: `${me.name}'s ${skill.name} skill reached level ${skill.level}.`,
        meta: { skillId: skill.id, newLevel: skill.level }
      });
    }
    applied.push(entry);
  }
  // 2026-05-08: stat 변동 시 max 재산정 (grantSkillXp 와 동일).
  if (leveledUp && me.status) {
    const con = me.status.constitution ?? 5;
    const intl = me.status.intelligence ?? 5;
    me.maxHp = 80 + con * 4;
    me.maxStamina = 50 + con * 5;
    me.maxMp = (me.kind === "monster" ? 0 : (10 + intl * 2));
    me.maxHunger = 80 + con * 4;
    if (me.hp > me.maxHp) me.hp = me.maxHp;
    if (me.stamina > me.maxStamina) me.stamina = me.maxStamina;
    if (me.mp > me.maxMp) me.mp = me.maxMp;
  }
  if (applied.length) world.revision += 1;
  return applied;
}

/**
 * Funnel 추적 (2026-05-06) — Skill 별 단계별 진행 카운트.
 * step1 (재료 첫 픽업) / step2 (재료 충족) / step3 (station 인접) / step4 (action 시도) / step5 (성공/실패).
 * step0 (활성화) 은 prompt 의 skill block surface 시 별도 trigger 충족 시점에서 기록 가능 (TODO).
 */
const funnelInventoryHistory = new Map<string, Map<string, boolean>>(); // actorId -> set of pickup-seen skill keys
const funnelStationHistory = new Map<string, Map<string, boolean>>();   // actorId -> set of station-adjacent skill keys

async function trackFunnel(me: Actor, decision: BrainDecision, resultOk: boolean, resultMsg: string): Promise<void> {
  const world = getWorld();
  const action = decision.action;
  const skills = me.skills ?? [];
  const tsNow = Date.now();
  const invHistory = funnelInventoryHistory.get(me.id) ?? new Map<string, boolean>();
  funnelInventoryHistory.set(me.id, invHistory);
  const stHistory = funnelStationHistory.get(me.id) ?? new Map<string, boolean>();
  funnelStationHistory.set(me.id, stHistory);

  const invMap = new Map<string, number>();
  for (const slot of me.inventory) invMap.set(slot.item, (invMap.get(slot.item) ?? 0) + (slot.kind === "stack" ? slot.count : 1));
  const nearbyStations = new Set<string>();
  for (const s of Object.values(world.structures ?? {})) {
    const d = Math.abs(s.x - me.x) + Math.abs(s.y - me.y);
    if (d <= 4) nearbyStations.add(s.type);
  }
  for (const skill of skills) {
    if (!skill.triggers || !skill.actionTemplate) continue;
    for (const t of skill.triggers) {
      if (t.always) continue;
      // step1: requiredItems 중 하나라도 인벤 첫 진입
      if (t.requiredItems?.length) {
        for (const req of t.requiredItems) {
          if ((invMap.get(req.item) ?? 0) > 0 && !invHistory.get(`${skill.id}:pickup:${req.item}`)) {
            invHistory.set(`${skill.id}:pickup:${req.item}`, true);
            await recordFunnel({ ts: tsNow, tick: world.tick, actorId: me.id, skillId: skill.id, step: "step1_first_pickup", detail: req.item });
          }
        }
        // step2: 모든 requiredItems 충족
        const allMet = t.requiredItems.every((req) => (invMap.get(req.item) ?? 0) >= req.count);
        const step2Key = `${skill.id}:complete`;
        if (allMet && !invHistory.get(step2Key)) {
          invHistory.set(step2Key, true);
          await recordFunnel({ ts: tsNow, tick: world.tick, actorId: me.id, skillId: skill.id, step: "step2_ingredients_complete" });
        }
        if (!allMet && invHistory.get(step2Key)) {
          // 다시 부족해지면 reset (다음 충족 시 기록되도록)
          invHistory.delete(step2Key);
        }
      }
      // step3: station 인접 첫 도달
      if (t.stationType && nearbyStations.has(t.stationType)) {
        const step3Key = `${skill.id}:station:${t.stationType}`;
        if (!stHistory.get(step3Key)) {
          stHistory.set(step3Key, true);
          await recordFunnel({ ts: tsNow, tick: world.tick, actorId: me.id, skillId: skill.id, step: "step3_station_adjacent", detail: t.stationType });
        }
      } else if (t.stationType) {
        const step3Key = `${skill.id}:station:${t.stationType}`;
        if (stHistory.get(step3Key)) stHistory.delete(step3Key);
      }
    }
    // step4 / step5: actionTemplate 매칭 시도/성공
    const tmpl = skill.actionTemplate;
    const matched = (() => {
      if (action.type !== tmpl.type) return false;
      if (tmpl.itemId && !(action.itemId ?? "").startsWith(tmpl.itemId.split("-")[0] ?? "")) return false;
      if (tmpl.objectId && !(action.objectId ?? "").includes(tmpl.objectId.split("-")[1] ?? tmpl.objectId)) return false;
      if (tmpl.targetItemId && action.targetItemId !== tmpl.targetItemId) return false;
      if (tmpl.skillId && action.skillId !== tmpl.skillId) return false;
      return true;
    })();
    if (matched) {
      await recordFunnel({ ts: tsNow, tick: world.tick, actorId: me.id, skillId: skill.id, step: "step4_attempt" });
      if (resultOk) {
        await recordFunnel({ ts: tsNow, tick: world.tick, actorId: me.id, skillId: skill.id, step: "step5_success" });
      } else {
        await recordFunnel({ ts: tsNow, tick: world.tick, actorId: me.id, skillId: skill.id, step: "step5_fail", detail: resultMsg.slice(0, 30) });
      }
    }
  }
}

function dedupSkillChanges<T extends { skillId: string }>(changes: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const change of changes) {
    if (seen.has(change.skillId)) continue;
    seen.add(change.skillId);
    out.push(change);
  }
  return out;
}

function isFarmPractice(itemId: string | undefined, resultMsg: string): boolean {
  return isFarmItem(itemId) || /field yielded|carrot|wheat|텃밭|수확/.test(resultMsg);
}

function isGatheringPractice(itemId: string | undefined, resultMsg: string): boolean {
  return isGatheringItem(itemId) || /wood|ore|광석|목재/.test(resultMsg);
}

function isFarmItem(itemId: string | undefined): boolean {
  return Boolean(itemId && /^(carrot|wheat)(-|$)/.test(itemId));
}

function isGatheringItem(itemId: string | undefined): boolean {
  return Boolean(itemId && /^(wood|ore|coal|clay)(-|$)/.test(itemId));
}

function isMiningItem(itemId: string | undefined): boolean {
  return Boolean(itemId && /^(ore|coal|iron_ingot)(-|$)/.test(itemId));
}

function isWoodcuttingItem(itemId: string | undefined): boolean {
  return Boolean(itemId && /^wood(-|$)/.test(itemId));
}

function isForageItem(itemId: string | undefined): boolean {
  return Boolean(itemId && /^(berry|mushroom)(-|$)/.test(itemId));
}

function isFoodItem(itemId: string): boolean {
  return /^(carrot|wheat|herb|bread|food|berry|mushroom|fish|cooked_meat|fish_stew)(-|$)/.test(itemId);
}

async function recordEpicActionTriggers(args: {
  world: WorldState;
  me: Actor;
  decision: BrainDecision;
  resultMsg: string;
  actionTargetId: string | null;
  targetBeforeHp: number | undefined;
  targetBeforeHunger: number | undefined;
  pickupItemId: string | undefined;
  pickupItemType: string | undefined;
}): Promise<void> {
  const { world, me, decision, resultMsg, actionTargetId } = args;
  if (decision.action.type === "SPEAK" && actionTargetId) {
    const pair = pairKey(me.id, actionTargetId);
    if (!(await hasHistory("relationship.first_contact", (entry) => entry.meta?.pair === pair))) {
      const targetName = world.actors[actionTargetId]?.name ?? actionTargetId;
      await recordHistory({
        tick: world.tick,
        ts: Date.now(),
        actorId: me.id,
        kind: "relationship.first_contact",
        text: `${me.name} and ${targetName} spoke for the first time.`,
        meta: { from: me.id, to: actionTargetId, pair }
      });
    }
  }

  if (decision.action.type === "GIVE" && actionTargetId) {
    const targetName = world.actors[actionTargetId]?.name ?? actionTargetId;
    const significantGold = decision.action.currency === "gold" && Number(decision.action.amount ?? 0) >= 10;
    const itemId = decision.action.itemId;
    const significantItem = Boolean(itemId?.startsWith("trinket")) || Boolean(itemId && isFoodItem(itemId) && (args.targetBeforeHunger ?? 0) >= 70);
    if (significantGold || significantItem) {
      const giftPretty = decision.action.currency === "gold"
        ? `${decision.action.amount}gold`
        : (itemId ? itemKorName(itemId) : "a gift");
      await recordHistory({
        tick: world.tick,
        ts: Date.now(),
        actorId: me.id,
        kind: "gift.significant",
        text: `${me.name} gave ${giftPretty} to ${targetName}.`,
        meta: { from: me.id, to: actionTargetId, itemId, currency: decision.action.currency, amount: decision.action.amount }
      });
    }
  }

  if (decision.action.type === "PICKUP" && args.pickupItemId && /^(carrot|wheat|wood|ore)-/.test(args.pickupItemId)) {
    const resource = args.pickupItemId.split("-")[0] ?? args.pickupItemType ?? "item";
    const day = Math.floor(world.tick / 1440) + 1;
    if (!(await hasHistory("harvest.first_of_day", (entry) => entry.meta?.day === day && entry.meta?.resource === resource))) {
      await recordHistory({
        tick: world.tick,
        ts: Date.now(),
        actorId: me.id,
        kind: "harvest.first_of_day",
        text: `${me.name} harvested the first ${resource} of the day.`,
        meta: { day, resource, itemId: args.pickupItemId }
      });
    }
  }

  if (decision.action.type === "ATTACK" && actionTargetId) {
    const target = world.actors[actionTargetId];
    const damage = Math.max(0, (args.targetBeforeHp ?? target?.hp ?? 0) - (target?.hp ?? 0));
    const pair = pairKey(me.id, actionTargetId);
    if (target?.alive && damage > 0 && !(await hasHistory("combat.first_blood", (entry) => entry.meta?.pair === pair))) {
      await recordHistory({
        tick: world.tick,
        ts: Date.now(),
        actorId: me.id,
        kind: "combat.first_blood",
        text: `${me.name} drew first blood on ${target.name}.`,
        meta: { attackerId: me.id, targetId: actionTargetId, pair, damage }
      });
    }
  }
}

async function hasHistory(kind: string, predicate: (entry: HistoryEntry) => boolean): Promise<boolean> {
  const history = await readRecentHistory(10000);
  return history.some((entry) => entry.kind === kind && predicate(entry));
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

type BeforeSnap = { hp: number; hunger: number; stamina: number; invLen: number; x: number; y: number };

function actionSignature(decision: BrainDecision): string {
  const a = decision.action;
  const target = (a as { targetId?: string }).targetId ?? "";
  const item = (a as { itemId?: string }).itemId?.split("-")[0] ?? "";
  return `${a.type}|${item}|${target}`;
}

async function recordActionSignature(
  me: Actor,
  decision: BrainDecision,
  before: BeforeSnap,
  resultOk: boolean,
  world: WorldState
): Promise<void> {
  const sig = actionSignature(decision);
  const dHp = Math.abs(me.hp - before.hp);
  const dHunger = Math.abs(me.hunger - before.hunger);
  const dStamina = Math.abs(me.stamina - before.stamina);
  const dInv = Math.abs(me.inventory.length - before.invLen);
  const dPos = Math.abs(me.x - before.x) + Math.abs(me.y - before.y);
  // "효과 있음" 판정: 결과 성공 + 인지 가능한 변화
  const effective =
    resultOk && (dHunger >= 0.5 || dHp >= 0.5 || dStamina >= 1 || dInv > 0 || dPos > 0);
  const list = recentSignaturesByActor.get(me.id) ?? [];
  list.push({ sig, tick: world.tick, effective });
  while (list.length > 6) list.shift();
  recentSignaturesByActor.set(me.id, list);

  // 같은 sig가 최근 5회 중 3+회 + 모두 ineffective → "효과 없음" 관찰 주입 (60초 cooldown)
  const recentSame = list.filter((e) => e.sig === sig).slice(-5);
  if (recentSame.length >= 3 && recentSame.every((e) => !e.effective)) {
    const cooldownMap = lastIneffectiveObsTickByActor.get(me.id) ?? new Map<string, number>();
    const lastTick = cooldownMap.get(sig);
    if (lastTick === undefined || world.tick - lastTick > 600) {
      cooldownMap.set(sig, world.tick);
      lastIneffectiveObsTickByActor.set(me.id, cooldownMap);
      const a = decision.action;
      const verb = a.type;
      const target = (a as { itemId?: string; targetId?: string }).itemId ?? (a as { targetId?: string }).targetId ?? "";
      await appendObservation({
        id: `obs_ineff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: me.id,
        tick: world.tick,
        timestamp: Date.now(),
        kind: "memory",
        text: `Recent attempts of ${verb}${target ? ` ${target}` : ""} (${recentSame.length} times) produced no change. A different approach is needed.`,
        tags: ["ineffective", "self-observation"],
        importance: Importance.INEFFECTIVE_OBSERVATION
      });
    }
  }
}

function rememberDecision(actorId: string, decision: RecentDecision): void {
  const prev = lastDecisionsByActor.get(actorId) ?? [];
  lastDecisionsByActor.set(actorId, [...prev, decision].slice(-5));
}

function invalidRecoveryOptions(type: BrainDecision["action"]["type"], resultMsg: string): string[] {
  if (resultMsg === "invalid_trade_id") {
    // 만료/잘못된 trade 재시도 금지 — 새 협상이나 다른 행동으로.
    return ["SPEAK", "OFFER_TRADE", "MOVE", "GATHER", "OPTIONS"];
  }
  if ((type === "USE" || type === "GIVE") && resultMsg === "item_not_in_inventory") {
    return ["INVENTORY", "PICKUP", "MOVE", "OPTIONS"];
  }
  if ((type === "GIVE" || type === "ATTACK") && resultMsg === "target_too_far") {
    return ["MOVE", "OPTIONS", "SPEAK", "THINK"];
  }
  if (type === "THINK" && resultMsg === "think_cap_reached") {
    return ["SPEAK", "MOVE", "INVENTORY", "OPTIONS"];
  }
  return ["SPEAK", "MOVE", "INVENTORY", "OPTIONS", "THINK", "WAIT"];
}

function recentSpeechPartner(observations: Observation[]): string | null {
  for (const obs of [...observations].reverse()) {
    if (obs.kind !== "dialogue") continue;
    const fromTag = obs.tags.find((tag) => tag.startsWith("from:"));
    if (fromTag) return fromTag.slice("from:".length);
    const toTag = obs.tags.find((tag) => tag.startsWith("to:"));
    if (toTag) return toTag.slice("to:".length);
  }
  return null;
}

function getActionTargetId(world: WorldState, me: Actor, decision: BrainDecision): string | null {
  if (decision.action.type === "SPEAK") return decision.action.targetId ?? nearestNeighborId(world, me);
  if (decision.action.type === "ATTACK" || decision.action.type === "GIVE") return decision.action.targetId ?? null;
  return null;
}

function buildInteractionObservation(
  world: WorldState,
  me: Actor,
  decision: BrainDecision,
  ok: boolean,
  resultMsg: string,
  targetId: string | null,
  targetBeforeHp: number | undefined
): {
  selfText: string;
  targetId?: string;
  targetText?: string;
  targetImportance: number;
  kind: Observation["kind"];
} | null {
  if (!ok || !targetId) return null;
  const target = world.actors[targetId];
  if (!target) return null;

  if (decision.action.type === "SPEAK") {
    const msg = decision.action.message ?? "…";
    return {
      selfText: `Said to actorId=${target.id} (${target.name}): "${msg}"`,
      targetId,
      targetText: `actorId=${me.id} (${me.name}) said to me: "${msg}"`,
      targetImportance: Importance.SPEECH_TARGET_DIALOGUE,
      kind: "dialogue"
    };
  }

  if (decision.action.type === "ATTACK") {
    const dmg = Math.max(0, (targetBeforeHp ?? target.hp + 10) - target.hp);
    return {
      selfText: `Attacked actorId=${target.id} (${target.name}); damage ${dmg}.`,
      targetId,
      targetText: `actorId=${me.id} (${me.name}) attacked me; damage ${dmg}.`,
      targetImportance: target.alive ? Importance.ATTACK_RECEIVED_LIVE : Importance.ATTACK_RECEIVED_HIGH,
      kind: "memory"
    };
  }

  if (decision.action.type === "GIVE") {
    if (decision.action.currency === "gold") {
      const amount = Number(decision.action.amount ?? 0);
      return {
        selfText: `Gave ${amount} gold to actorId=${target.id} (${target.name}).`,
        targetId,
        targetText: `actorId=${me.id} (${me.name}) gave me ${amount} gold.`,
        targetImportance: amount >= 10 ? Importance.GIVE_RECEIVED_HIGH : Importance.GIVE_RECEIVED_DEFAULT,
        kind: "memory"
      };
    }
    const itemId = decision.action.itemId ?? resultMsg.replace(/^gave:/, "");
    const prefix = itemId.split("-")[0];
    return {
      selfText: `Gave itemId=${prefix} to actorId=${target.id} (${target.name}).`,
      targetId,
      targetText: `actorId=${me.id} (${me.name}) gave me itemId=${prefix}.`,
      targetImportance: itemId.startsWith("trinket") ? Importance.GIVE_RECEIVED_HIGH : Importance.GIVE_RECEIVED_DEFAULT,
      kind: "memory"
    };
  }

  if (decision.action.type === "OFFER_TRADE") {
    const wants = decision.action.wantItem ? `wants itemId=${decision.action.wantItem} x${decision.action.wantCount ?? 1}` : "wants nothing specific";
    const offers = decision.action.offerItem
      ? `offers itemId=${decision.action.offerItem} x${decision.action.offerCount ?? 1}`
      : decision.action.offerGold
      ? `offers ${decision.action.offerGold} gold`
      : "offers nothing specific";
    return {
      selfText: `Offered trade to actorId=${target.id} (${target.name}): ${wants}; ${offers}.`,
      targetId,
      targetText: `actorId=${me.id} (${me.name}) offered me a trade: ${wants}; ${offers}.`,
      targetImportance: Importance.SPEECH_TARGET_TRADE,
      kind: "memory"
    };
  }

  return null;
}

function buildSpeechObservationFallback(
  world: WorldState,
  me: Actor,
  decision: BrainDecision,
  ok: boolean,
  resultMsg: string,
  targetId: string | null
): {
  selfText: string;
  targetId?: string;
  targetText?: string;
  targetImportance: number;
  kind: Observation["kind"];
} | null {
  if (!ok || decision.action.type !== "SPEAK" || !isActualSpeakResult(resultMsg)) return null;
  const resolvedTargetId = decision.action.targetId ?? targetId ?? null;
  if (!resolvedTargetId) return null;
  const target = world.actors[resolvedTargetId];
  if (!target) return null;
  const msg = decision.action.message ?? (resultMsg.replace(/^(say|speak|dialogue):/i, "") || "…");
  return {
    selfText: `Said to actorId=${target.id} (${target.name}): "${msg}"`,
    targetId: target.id,
    targetText: `actorId=${me.id} (${me.name}) said to me: "${msg}"`,
    targetImportance: Importance.SPEECH_TARGET_DIALOGUE,
    kind: "dialogue"
  };
}

async function applySpeechSideEffects(args: {
  from: Actor;
  to: Actor | undefined;
  message: string;
  claim?: BrainAction["claim"];
  resultMsg: string;
  resultOk: boolean;
  interactionObservation: {
    targetId?: string;
    targetText?: string;
    targetImportance: number;
    kind: Observation["kind"];
  };
}): Promise<{ heardClaimWritten: boolean; heardClaimSkippedReason?: string }> {
  const { from, to, message, claim, resultMsg, resultOk, interactionObservation } = args;
  if (!resultOk || !to || !interactionObservation.targetId || !interactionObservation.targetText) {
    return { heardClaimWritten: false, heardClaimSkippedReason: "no_target_observation" };
  }
  const isSpeak = isActualSpeakResult(resultMsg);
  if (interactionObservation.kind === "dialogue" && !isSpeak) {
    return { heardClaimWritten: false, heardClaimSkippedReason: "not_actual_say" };
  }

  await appendObservation({
    id: `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: interactionObservation.targetId,
    tick: getWorld().tick,
    timestamp: Date.now(),
    kind: interactionObservation.kind,
    text: interactionObservation.targetText,
    tags: [isSpeak ? "speak" : interactionObservation.kind, "received", from.id, ...(isSpeak ? ["speech.to_me", `from:${from.id}`] : [])],
    importance: interactionObservation.targetImportance
  });

  if (!isSpeak) {
    return { heardClaimWritten: false };
  }
  if (!claim) {
    return { heardClaimWritten: false, heardClaimSkippedReason: "no_claim" };
  }
  if (!isValidSystemClaim(claim)) {
    return { heardClaimWritten: false, heardClaimSkippedReason: "invalid_claim_payload" };
  }
  const diplomacy = to.skills?.find((skill) => skill.id === "diplomacy")?.level ?? 0;

  await appendObservation({
    id: `obs_claim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: interactionObservation.targetId,
    tick: getWorld().tick,
    timestamp: Date.now(),
    kind: "memory",
    text: `From ${from.name}: ${claim.claimKey} | ${JSON.stringify(claim.factPayload)}`,
    tags: ["heard_claim", claim.type, from.id],
    importance: Math.min(Importance.HEARD_CLAIM_CEILING, Importance.HEARD_CLAIM_BASE + diplomacy * Importance.HEARD_CLAIM_DIPLOMACY_STEP),
    claimKey: claim.claimKey,
    claimType: claim.type,
    speaker: from.id,
    factPayload: claim.factPayload
  });
  return { heardClaimWritten: true };
}

function isActualSpeakResult(resultMsg: string): boolean {
  return /^(say|speak|dialogue):/i.test(resultMsg);
}

function isValidSystemClaim(claim: BrainAction["claim"]): claim is NonNullable<BrainAction["claim"]> {
  if (!claim || typeof claim !== "object") return false;
  if (!["recipe_hint", "place_hint", "resource_location", "danger_warning"].includes(claim.type)) return false;
  if (!claim.claimKey || typeof claim.claimKey !== "string") return false;
  if (!claim.factPayload || typeof claim.factPayload !== "object" || Array.isArray(claim.factPayload)) return false;
  return true;
}

// 아이템 한국어 이름은 packages/shared/src/content/items.ts ITEM_CATALOG 단일 출처
const itemKorName = (itemId: string): string => ko.items(itemId);

function itemTypeFromId(itemId: string): string {
  return itemId.split("-")[0]?.trim() || itemId || "item";
}

function isSharingQuest(text: string): boolean {
  return /음식|당근|밀|약초/.test(text) && /(나누|나눠|거저|주어|줘|베풀|가난)/.test(text);
}

function mergeObservations(a: Observation[], b: Observation[]): Observation[] {
  const seen = new Set<string>();
  const out: Observation[] = [];
  for (const obs of [...a, ...b]) {
    if (seen.has(obs.id)) continue;
    seen.add(obs.id);
    out.push(obs);
  }
  return out;
}

function distanceToPlaceLite(me: Actor, place: Place): number {
  const dx = me.x < place.x ? place.x - me.x : me.x >= place.x + place.width ? me.x - (place.x + place.width - 1) : 0;
  const dy = me.y < place.y ? place.y - me.y : me.y >= place.y + place.height ? me.y - (place.y + place.height - 1) : 0;
  return dx + dy;
}

function nearestPlaceId(world: ReturnType<typeof getWorld>, me: Actor, maxDist: number): string | null {
  let best: { id: string; dist: number } | null = null;
  for (const place of Object.values(world.places ?? {})) {
    const dx = me.x < place.x ? place.x - me.x : me.x >= place.x + place.width ? me.x - (place.x + place.width - 1) : 0;
    const dy = me.y < place.y ? place.y - me.y : me.y >= place.y + place.height ? me.y - (place.y + place.height - 1) : 0;
    const dist = dx + dy;
    if (dist > maxDist) continue;
    if (!best || dist < best.dist) best = { id: place.id, dist };
  }
  return best?.id ?? null;
}

function nearestNeighborId(world: ReturnType<typeof getWorld>, me: Actor): string | null {
  let best: { id: string; dist: number } | null = null;
  for (const a of Object.values(world.actors)) {
    if (a.id === me.id || !a.alive) continue;
    const d = Math.abs(a.x - me.x) + Math.abs(a.y - me.y);
    if (d > 6) continue;
    if (!best || d < best.dist) best = { id: a.id, dist: d };
  }
  return best?.id ?? null;
}

// 2026-05-09 PR-1: craft 결과 → heard_claim 의 speaker 에 대한 trust 조정.
// expectedClaimKey 매칭 + 최근 4건 heard_claim 안에서 찾음. 같은 speaker 여러 번 들었으면 첫 매칭만 적용.
async function adjustTrustFromCraftResult(actorId: string, expectedClaimKey: string, delta: number, nowTick: number): Promise<void> {
  const recent = await readObservations(actorId, 30);
  const claim = recent
    .filter((o) => o.tags?.includes("heard_claim") && o.claimKey === expectedClaimKey)
    .sort((a, b) => b.tick - a.tick)[0];
  if (!claim || !claim.speaker) return;
  const rels = await readAllRelationships();
  let rel = rels.find((r) => r.from === actorId && r.to === claim.speaker);
  if (!rel) {
    rel = { from: actorId, to: claim.speaker, affinity: 0, trust: 0.5, trustEvidenceCount: 0, lastInteractionTick: nowTick, notes: "" };
    rels.push(rel);
  }
  const prev = rel.trust ?? 0.5;
  rel.trust = Math.max(0, Math.min(1, prev + delta));
  rel.trustEvidenceCount = (rel.trustEvidenceCount ?? 0) + 1;
  rel.lastInteractionTick = nowTick;
  rel.notes = (rel.notes ? rel.notes + " | " : "") + `claim_verify ${delta > 0 ? "+" : ""}${delta.toFixed(2)} on ${expectedClaimKey}`;
  await writeRelationships(rels);
}

// 2026-05-08: Aaron mentor hard prior — gpt-5.5 권고.
// belief 메모리 4회 실패 → 행동 트리거 없음. deterministic SPEAK + GIVE override.
// 2026-05-09 PR-1: deterministic claim payload 동반. mentor SPEAK 발신 시 system 이 attach → 수신 NPC 메모리에 heard_claim 자동 적립.
type MentorHint = {
  message: string;
  claim: {
    type: "recipe_hint" | "place_hint";
    claimKey: string;
    factPayload: Record<string, unknown>;
  };
};
const MENTOR_RECIPE_OUTPUT_PRIORITY = ["axe", "pickaxe", "leather_armor", "healing_potion", "bone_dagger", "bread"];
const MENTOR_TARGETS = ["npc-2", "npc-3", "npc-4", "npc-1"];
type MentorPendingDelivery = { hint: MentorHint; targetId: string; queuedAtTick: number };
const mentorState: {
  lastSpokeTick: number;
  recipeIndex: number;
  targetIndex: number;
  lastWorldTick: number;
  pendingDelivery?: MentorPendingDelivery;
} = { lastSpokeTick: 0, recipeIndex: 0, targetIndex: 0, lastWorldTick: 0 };
const MENTOR_INTERVAL_TICKS = 200; // ~1분 (3 tick/s 기준 200=66s, 6 tick/s 기준 200=33s)
const MENTOR_DELIVERY_TIMEOUT_TICKS = 100;

type MentorRecipe = typeof RECIPES[number];

function stationForRecipe(world: ReturnType<typeof getWorld>, recipe: MentorRecipe): { id: string; type: string } | null {
  return Object.values(world.structures ?? {})
    .filter((s) => s.type === recipe.station)
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

function knownResourcePath(world: ReturnType<typeof getWorld>, actor: Actor, itemPrefix: string): boolean {
  const key = itemKeyOf(itemPrefix);
  if (Object.values(world.groundItems ?? {}).some((g) => itemKeyOf(g.id) === key)) return true;
  for (const place of Object.values(actor.discoveredPlaces ?? {})) {
    if (place.resourcesSeen.includes(key)) return true;
  }
  return Object.values(world.structures ?? {}).some((s) => {
    if (key === "wood") return s.type === "tree";
    if (key === "ore" || key === "coal") return s.type === "rock";
    if (key === "fish") return s.type === "fishing_spot";
    if (key === "herb") return s.type === "herb_bed";
    if (key === "berry") return s.type === "berry_bush" || s.type === "bush";
    return false;
  });
}

function learnerCanPlausiblyReachInputs(world: ReturnType<typeof getWorld>, actor: Actor, recipe: MentorRecipe): boolean {
  return recipe.inputs.every((input) => {
    if (inventoryCountOf(actor.inventory, input.itemPrefix) >= input.count) return true;
    return knownResourcePath(world, actor, input.itemPrefix);
  });
}

function learnerMeetsRecipeSkills(actor: Actor, recipe: MentorRecipe): boolean {
  const skillLevels: Record<string, number> = {};
  for (const skill of actor.skills ?? []) skillLevels[skill.id] = skill.level;
  return checkSkillRequirements(recipe, skillLevels).ok;
}

function mentorRecipeCandidates(world: ReturnType<typeof getWorld>, learner: Actor): MentorRecipe[] {
  const priority = new Map(MENTOR_RECIPE_OUTPUT_PRIORITY.map((output, index) => [output, index]));
  return RECIPES
    .filter((recipe) => priority.has(recipe.output.itemPrefix))
    .filter((recipe) => stationForRecipe(world, recipe))
    .filter((recipe) => learnerMeetsRecipeSkills(learner, recipe))
    .filter((recipe) => learnerCanPlausiblyReachInputs(world, learner, recipe))
    .sort((a, b) => {
      const pa = priority.get(a.output.itemPrefix) ?? Number.MAX_SAFE_INTEGER;
      const pb = priority.get(b.output.itemPrefix) ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || a.output.itemPrefix.localeCompare(b.output.itemPrefix) || a.station.localeCompare(b.station) || a.id.localeCompare(b.id);
    });
}

function buildMentorHintFromRecipe(world: ReturnType<typeof getWorld>, learner: Actor, recipeIndex: number): MentorHint | null {
  const candidates = mentorRecipeCandidates(world, learner);
  if (candidates.length === 0) return null;
  const recipe = candidates[recipeIndex % candidates.length];
  const station = stationForRecipe(world, recipe);
  if (!station) return null;
  const inputs = recipe.inputs.map((input) => `${input.count} ${input.itemPrefix}`).join(" + ");
  const message = `${learner.name}, ${recipe.name} is ${inputs} at the ${recipe.station}; USE objectId=${station.id} targetItemId=${recipe.output.itemPrefix}.`;
  return {
    message,
    claim: {
      type: "recipe_hint",
      claimKey: `craft:${recipe.output.itemPrefix}|${recipe.station}`,
      factPayload: {
        recipeId: recipe.id,
        station: recipe.station,
        stationObjectId: station.id,
        inputs: recipe.inputs.map((input) => ({ itemPrefix: input.itemPrefix, count: input.count })),
        output: recipe.output.itemPrefix,
        requiredSkillsAll: recipe.requiredSkillsAll,
        requiredSkillsAny: recipe.requiredSkillsAny
      }
    }
  };
}

function computeMentorAction(world: ReturnType<typeof getWorld>, me: Actor): BrainDecision | null {
  if (world.tick < mentorState.lastWorldTick) {
    mentorState.lastSpokeTick = 0;
    mentorState.recipeIndex = 0;
    mentorState.targetIndex = 0;
    mentorState.pendingDelivery = undefined;
  }
  mentorState.lastWorldTick = world.tick;

  if (me.attackTargetId || me.gatherIntent) return null;

  if (mentorState.pendingDelivery) {
    const pending = mentorState.pendingDelivery;
    const target = world.actors[pending.targetId];
    if (!target?.alive) {
      mentorState.pendingDelivery = undefined;
      return null;
    }
    const dist = Math.max(Math.abs(me.x - target.x), Math.abs(me.y - target.y));
    if (dist <= 1) {
      mentorState.lastSpokeTick = world.tick;
      mentorState.recipeIndex += 1;
      mentorState.targetIndex += 1;
      mentorState.pendingDelivery = undefined;
      return mentorSpeakDecision(pending.targetId, pending.hint);
    }
    if (pending.queuedAtTick + MENTOR_DELIVERY_TIMEOUT_TICKS < world.tick) {
      mentorState.pendingDelivery = undefined;
      return null;
    }
    if (me.movePath) return mentorWaitDecision("mentor delivery approach in progress");
    return {
      thought: {
        priority: "walk close enough to deliver a recipe hint",
        emotion: "calm",
        nextIntent: "approach recipe hint target",
        beliefs: [],
        recentEvents: []
      },
      action: {
        type: "MOVE",
        to: { towardActor: pending.targetId },
        maxTicks: MENTOR_DELIVERY_TIMEOUT_TICKS,
        reason: "mentor pending delivery"
      }
    };
  }

  if (me.movePath) return null;
  if (world.tick - mentorState.lastSpokeTick < MENTOR_INTERVAL_TICKS) return null;
  if (me.hp < me.maxHp * 0.4) return null;
  const maxHgr = me.maxHunger ?? 100;
  if (me.hunger > maxHgr * 0.8) return null;
  const targetId = MENTOR_TARGETS[mentorState.targetIndex % MENTOR_TARGETS.length];
  const target = world.actors[targetId];
  if (!target?.alive) { mentorState.targetIndex += 1; return null; }
  const hint = buildMentorHintFromRecipe(world, target, mentorState.recipeIndex);
  if (!hint) { mentorState.recipeIndex += 1; mentorState.targetIndex += 1; return null; }
  mentorState.pendingDelivery = {
    hint,
    targetId,
    queuedAtTick: world.tick
  };
  return mentorWaitDecision("mentor recipe hint queued");
}

function mentorWaitDecision(reason: string): BrainDecision {
  return {
    thought: {
      priority: "prepare a practical recipe hint",
      emotion: "calm",
      nextIntent: "mentor recipe hint",
      beliefs: [],
      recentEvents: []
    },
    action: { type: "WAIT", reason }
  };
}

function mentorSpeakDecision(targetId: string, hint: MentorHint): BrainDecision {
  return {
    thought: {
      priority: "share a practical recipe hint",
      emotion: "calm",
      nextIntent: "mentor recipe hint",
      beliefs: [],
      recentEvents: []
    },
    action: {
      type: "SPEAK",
      targetId,
      message: hint.message,
      reason: "mentor recipe hint",
      claim: hint.claim
    }
  };
}

function nearbyActorDebug(world: ReturnType<typeof getWorld>, me: Actor): Array<{ id: string; name: string; dist: number }> {
  return Object.values(world.actors)
    .filter((a) => a.id !== me.id && a.alive)
    .map((a) => ({ id: a.id, name: a.name, dist: Math.abs(a.x - me.x) + Math.abs(a.y - me.y) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);
}

function formatActionLog(tick: number, decision: BrainDecision, resultOk: boolean, resultMsg: string): string {
  const a = decision.action;
  const parts: string[] = [];
  // 2026-05-07: 메모리/Action 로그 영문 통일.
  if (a.type === "MOVE") {
    if (typeof a.dx === "number" && typeof a.dy === "number") {
      const ns = a.dy < 0 ? "N" : a.dy > 0 ? "S" : "";
      const ew = a.dx < 0 ? "W" : a.dx > 0 ? "E" : "";
      const dir = `${ns}${ew}`;
      if (dir) parts.push(`Walked ${dir}`);
      else parts.push("Stepped in place");
    } else if (a.to?.placeId) {
      parts.push(`Moved toward placeId=${a.to.placeId}`);
    } else {
      parts.push("Moved");
    }
  }
  if (a.type === "USE") {
    if (a.skillId) {
      const verb = a.skillId === "pray" ? "Prayed" : a.skillId === "appraise" ? "Appraised" : `Used skill ${a.skillId}`;
      parts.push(verb);
    } else if (a.objectId && a.targetItemId) {
      if (isPendingUseResult(resultMsg)) parts.push(`Approaching ${a.objectId.replace(/^structure-/, "")} to make ${a.targetItemId}`);
      else parts.push(`At ${a.objectId.replace(/^structure-/, "")}, made ${a.targetItemId}`);
    } else if (a.objectId) {
      parts.push(`Inspected ${a.objectId.replace(/^structure-/, "")}`);
    } else if (a.itemId) {
      const cnt = a.count && a.count > 1 ? ` x${a.count}` : "";
      parts.push(`Used itemId=${a.itemId.split("-")[0]}${cnt}`);
    }
  } else if (a.itemId && (a.type === "PICKUP" || a.type === "DROP")) {
    const verb = a.type === "PICKUP" ? "Picked up" : "Dropped";
    const cnt = a.count && a.count > 1 ? ` x${a.count}` : "";
    parts.push(`${verb} itemId=${a.itemId.split("-")[0]}${cnt}`);
  }
  if (a.type === "GIVE") {
    let what: string;
    if (a.currency && a.amount) what = `${a.amount} ${a.currency}`;
    else if (a.itemId) what = `itemId=${a.itemId.split("-")[0]}${a.count && a.count > 1 ? ` x${a.count}` : ""}`;
    else what = "something";
    const to = a.targetId ? ` to actorId=${a.targetId}` : "";
    parts.push(`Gave ${what}${to}`);
  }
  if (a.type === "OFFER_TRADE") {
    const want = a.wantItem ? `${a.wantItem}${a.wantCount && a.wantCount > 1 ? ` x${a.wantCount}` : ""}` : null;
    const offer = a.offerGold ? `${a.offerGold} gold` : a.offerItem ? `${a.offerItem}${a.offerCount && a.offerCount > 1 ? ` x${a.offerCount}` : ""}` : null;
    const to = a.targetId ? ` to actorId=${a.targetId}` : "";
    const swap = (want && offer) ? `${offer} ↔ ${want}` : (want ? `wanted ${want}` : (offer ? `offered ${offer}` : "trade"));
    parts.push(`Offered trade${to}: ${swap}`);
  }
  if (a.type === "ACCEPT_TRADE") parts.push(`Accepted tradeId=${a.tradeId ?? "?"}`);
  if (a.type === "REJECT_TRADE") parts.push(`Rejected tradeId=${a.tradeId ?? "?"}`);
  if (a.type === "SPEAK") {
    const to = a.targetId ? ` to actorId=${a.targetId}` : "";
    const msg = a.message ? `: "${a.message.slice(0, 80)}"` : "";
    parts.push(`Said${to}${msg}`);
  }
  if (a.type === "ATTACK") {
    const to = a.targetId ? ` actorId=${a.targetId}` : "";
    parts.push(`Attacked${to}`);
  }
  if (a.type === "GATHER") {
    const what = a.gatherItem ?? (a as { item?: string }).item;
    const cnt = a.gatherCount ?? a.count ?? 1;
    const area = a.gatherArea?.placeId ? ` @${a.gatherArea.placeId}` : "";
    parts.push(`Gathered ${what ?? "?"} x${cnt}${area}`);
  }
  if (a.type === "PRAY") parts.push("Prayed");
  if (a.type === "THINK") parts.push("Reflected briefly");
  if (a.type === "WAIT") parts.push("Waited");
  if (a.type === "SLEEP") parts.push(`Slept${a.maxTicks ? ` maxTicks=${a.maxTicks}` : ""}`);
  if (a.type === "OPTIONS") parts.push("Surveyed options");
  let line = `[t${tick}] ${parts.join(" ")}`.replace(/\s+/g, " ").trim();
  if (!resultOk) line += ` — failed (${resultMsg})`;
  // 2026-05-07: 성공만 schema 라인 append. 실패 schema 는 LLM 이 imitation pattern 으로 따라하는 문제 → 제거.
  // 실패의 학습은 failure_lesson belief form 으로만 (invariant: "Belief: alchemy_table does not produce wheat").
  if (resultOk) {
    const schemaLine = formatExecutedSchema(a, true, resultMsg);
    if (schemaLine) line += `\n${schemaLine}`;
  }
  return line;
}

/**
 * Action 의 schema 와 outcome 을 영문으로 명시. memory 학습용.
 * 성공: "Executed: USE objectId=structure-forge targetItemId=pickaxe | Outcome: success"
 * 실패: "Attempted: USE objectId=structure-forge targetItemId=ore | Outcome: failed | Reason: no recipe at forge for output=ore"
 */
/**
 * 성공 schema 를 experience tag 메모리로 자동 승격 (2026-05-07).
 * - LLM 호출 X. 매 성공 행동 시점에 즉시 적립.
 * - tag: ["experience", "lesson", "success_memory", "<skill-domain>"]  → distilled 분류, lessonBoost.
 * - importance: SUCCESS_EXPERIENCE_PROMOTION (PERSONAL_SEED 와 동급)
 * - 대상: 학습 가치 높은 행동만 (craft, plant, fishing, edible USE, ATTACK kill).
 *   MOVE/WAIT/THINK/SPEAK/PICKUP 단순 case 제외.
 */
async function maybePromoteExperience(me: Actor, decision: BrainDecision, resultMsg: string, tick: number): Promise<boolean> {
  const a = decision.action;
  if (!a) return false;
  let domain: string | null = null;
  let summary: string | null = null;

  if (a.type === "USE") {
    if (a.objectId && a.targetItemId) {
      // craft (oven, alchemy_table, forge, workbench)
      const stationType = a.objectId.replace(/^structure-/, "").split("-")[0];
      domain = stationType.includes("oven") ? "cooking"
             : stationType.includes("alchemy") ? "alchemy"
             : stationType.includes("forge") ? "smithing"
             : stationType.includes("workbench") ? "architecture"
             : "craft";
      summary = `Crafted ${a.targetItemId} at ${a.objectId}.`;
    } else if (a.itemId) {
      const prefix = a.itemId.split("-")[0];
      const edibles = new Set(["herb","berry","mushroom","bread","cooked_fish","fish","meat","apple","pineapple","carrot","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"]);
      if (prefix === "wheat_seed" || prefix.endsWith("_seed")) {
        domain = "farming";
        summary = `Planted ${prefix} on field soil.`;
      } else if (edibles.has(prefix)) {
        domain = "edible";
        summary = `Ate ${prefix} from inventory; hunger eased.`;
      } else if (prefix === "fishing_rod") {
        domain = "fishing";
        summary = `Used fishing_rod by water; a fish followed.`;
      }
    } else if (a.skillId) {
      domain = a.skillId;
      summary = `Used skill ${a.skillId}.`;
    }
  } else if (a.type === "GATHER") {
    const what = a.gatherItem ?? (a as { item?: string }).item;
    if (what) {
      domain = "gathering";
      summary = `Gathered ${what}.`;
    }
  } else if (a.type === "ATTACK" && resultMsg.includes("kill")) {
    domain = "combat";
    summary = `Defeated ${a.targetId ?? "a foe"}.`;
  } else if (a.type === "OFFER_TRADE" && resultMsg.includes("accepted")) {
    domain = "trade";
    summary = `Trade accepted with ${a.targetId ?? "neighbor"}.`;
  }

  if (!domain || !summary) return false;
  const schema = formatExecutedSchema(a, true, resultMsg);
  if (!schema) return false;
  const text = `${summary}\n${schema}`;
  await appendObservation({
    id: `obs_exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick,
    timestamp: Date.now(),
    kind: "memory",
    text,
    tags: ["experience", "lesson", "success_memory", domain, "auto_promoted"],
    importance: Importance.SUCCESS_EXPERIENCE_PROMOTION
  });
  return true;
}

/**
 * 실패 분류 (2026-05-07 P0):
 * dispatch resultMsg 를 6 가지 taxonomy 로 매핑.
 *  - missing_inputs: craft_inputs_short:wheat 1/2 등
 *  - missing_skill: craft_skill_short:smithing
 *  - wrong_station: craft_wrong_station:oven→forge for=pickaxe
 *  - not_adjacent: craft_not_adjacent:structure-forge dist=4
 *  - unknown_recipe: craft_no_recipe / craft_failed_no_match / not_a_station / object_not_found
 *  - wrong_terrain: seed_plant_at_field / tile_already_planted / unknown_seed / seed_no_space
 *  - no_item: item_not_in_inventory
 * 해당 없으면 null. memory tag 와 prompt recovery 분류에 활용.
 */
export function classifyCraftFailure(resultMsg: string): { kind: string; detail: string } | null {
  if (!resultMsg) return null;
  const head = resultMsg.split(":")[0] ?? "";
  const detail = resultMsg.slice(head.length + 1) || resultMsg;
  switch (head) {
    case "craft_inputs_short": return { kind: "missing_inputs", detail };
    case "craft_skill_short":  return { kind: "missing_skill", detail };
    case "craft_wrong_station": return { kind: "wrong_station", detail };
    case "craft_not_adjacent":  return { kind: "not_adjacent", detail };
    case "craft_no_recipe":     return { kind: "unknown_recipe", detail };
    case "craft_failed_no_match": return { kind: "unknown_recipe", detail };
    case "not_a_station":       return { kind: "not_a_station", detail };
    case "object_not_found":    return { kind: "object_not_found", detail };
    case "object_not_usable":   return { kind: "object_not_usable", detail };
    case "seed_plant_at_field": return { kind: "wrong_terrain", detail: "seed needs field soil" };
    case "tile_already_planted": return { kind: "tile_occupied", detail };
    case "unknown_seed":        return { kind: "unknown_seed", detail };
    case "seed_no_space":       return { kind: "no_space", detail };
    case "item_not_in_inventory": return { kind: "no_item", detail };
    case "confirmed_invalid":   return { kind: "unknown_recipe", detail };
    default: return null;
  }
}

const failureLessonLast = new Map<string, number>();
const FAILURE_LESSON_TTL = 800; // ~13min episode 단위. 60→800 강화 (2026-05-07).

/**
 * 실패 행동을 failure_lesson 메모리로 자동 승격 (2026-05-07 P0).
 * 성공 promote 와 대칭. dedupe key: (actor, action_sig, fail_kind, place_id, text_hash).
 *  - TTL 800 tick (60 → 강화). 같은 sig+text 는 1 episode 안에 1 회만 적립.
 *  - tag: ["experience", "lesson", "failure_lesson", "<domain>", "fail:<kind>", "auto_promoted"]
 *  - importance: FAILURE_INVARIANT (success SUCCESS_EXPERIENCE_PROMOTION 보다 낮게)
 */
/**
 * 2026-05-07 v2: failure_lesson body 를 belief 형태로 — schema imitation 차단.
 * INVARIANT (재시도해도 안 풀림): unknown_recipe / wrong_station / missing_skill / not_a_station / object_not_found
 * TRANSIENT (시간/이동/재료로 풀림): missing_inputs / not_adjacent / no_space / wrong_terrain / no_item / tile_occupied
 * - INVARIANT: 영구 belief ("Belief: alchemy_table does not produce wheat. ...")
 * - TRANSIENT: 짧은 사실 메시지 (importance 0.45)
 * - 어느 쪽도 raw schema 라인 X — schema 정보는 tags 에 보존.
 */
const INVARIANT_FAIL_KINDS = new Set([
  "unknown_recipe", "wrong_station", "missing_skill", "not_a_station", "object_not_found"
]);

function buildFailureBeliefText(a: BrainAction, cls: { kind: string; detail: string }): string | null {
  if (a.type === "USE" && a.objectId && a.targetItemId) {
    const station = a.objectId.replace(/^structure-/, "").split("-")[0];
    const target = a.targetItemId;
    if (cls.kind === "unknown_recipe") return `Belief: ${station} does not produce ${target}. Confirmed by attempt; no recipe at this station.`;
    if (cls.kind === "wrong_station") {
      const m = cls.detail.match(/(\w+)→(\w+) for=(\w+)/);
      if (m) return `Belief: ${m[3]} is crafted at ${m[2]}, not ${m[1]}.`;
      return `Belief: ${target} is not produced at ${station}.`;
    }
    if (cls.kind === "missing_skill") return `Belief: crafting ${target} at ${station} requires a higher skill level than I have now.`;
    if (cls.kind === "not_a_station") return `Belief: ${a.objectId} is not a craft station.`;
    if (cls.kind === "object_not_found") return `Belief: ${a.objectId} does not exist or has moved.`;
    if (cls.kind === "missing_inputs") return `Note: ${target} at ${station} needs more ingredients (${cls.detail}).`;
    if (cls.kind === "not_adjacent") return `Note: ${a.objectId} is too far — must stand adjacent to use.`;
    return null;
  }
  if (a.type === "USE" && a.itemId) {
    const prefix = a.itemId.split("-")[0];
    if (prefix.endsWith("_seed")) {
      if (cls.kind === "wrong_terrain") return `Note: seeds plant only on field soil — current tile is wrong terrain.`;
      if (cls.kind === "no_space") return `Note: this tile is already planted — move to fresh field soil.`;
      if (cls.kind === "tile_occupied") return `Note: this tile already has a crop.`;
      if (cls.kind === "unknown_seed") return `Belief: ${prefix} cannot be planted (unknown seed type).`;
    }
    if (cls.kind === "no_item") return `Note: ${prefix} is not in my bag right now.`;
  }
  if (a.type === "GATHER") {
    return `Note: GATHER attempt did not yield (${cls.kind}).`;
  }
  return null;
}

async function maybePromoteFailureLesson(me: Actor, decision: BrainDecision, resultMsg: string, tick: number, world: WorldState): Promise<boolean> {
  const a = decision.action;
  if (!a) return false;
  const cls = classifyCraftFailure(resultMsg);
  if (!cls) return false;
  let domain: string | null = null;
  if (a.type === "USE" && a.objectId && a.targetItemId) {
    const stationType = a.objectId.replace(/^structure-/, "").split("-")[0];
    domain = stationType.includes("oven") ? "cooking"
           : stationType.includes("alchemy") ? "alchemy"
           : stationType.includes("forge") ? "smithing"
           : stationType.includes("workbench") ? "architecture"
           : "craft";
  } else if (a.type === "USE" && a.itemId) {
    const prefix = a.itemId.split("-")[0];
    if (prefix.endsWith("_seed")) domain = "farming";
  } else if (a.type === "GATHER") {
    domain = "gathering";
  }
  if (!domain) return false;
  const beliefText = buildFailureBeliefText(a, cls);
  if (!beliefText) return false;
  // dedupe key: actor + station/item + target + fail_kind + placeId
  const place = Object.values(world.places ?? {}).find((p) =>
    me.x >= p.x && me.x < p.x + p.width && me.y >= p.y && me.y < p.y + p.height);
  const placeKey = place?.id ?? `${Math.floor(me.x/8)},${Math.floor(me.y/8)}`;
  const sig = `${me.id}:${a.type}:${a.objectId ?? a.itemId ?? ""}:${a.targetItemId ?? ""}:${cls.kind}:${placeKey}`;
  const last = failureLessonLast.get(sig) ?? -Infinity;
  if (tick - last < FAILURE_LESSON_TTL) return false;
  failureLessonLast.set(sig, tick);
  // schema 정보는 tags 에만 (debug/query). text 는 belief 자연어만.
  const schemaTag = a.type === "USE" && a.objectId && a.targetItemId
    ? `attempted:${a.objectId.replace(/^structure-/, "").split("-")[0]}:${a.targetItemId}`
    : a.type === "USE" && a.itemId ? `attempted:item:${a.itemId.split("-")[0]}`
    : `attempted:${a.type.toLowerCase()}`;
  const isInvariant = INVARIANT_FAIL_KINDS.has(cls.kind);
  const tags = [
    isInvariant ? "belief" : "note",
    "experience", "lesson",
    isInvariant ? "failure_invariant" : "failure_transient",
    domain, `fail:${cls.kind}`, schemaTag, "auto_promoted"
  ];
  await appendObservation({
    id: `obs_failesn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick,
    timestamp: Date.now(),
    kind: "memory",
    text: beliefText,
    tags,
    importance: isInvariant ? Importance.FAILURE_INVARIANT : Importance.FAILURE_TRANSIENT
  });
  return true;
}

function formatExecutedSchema(a: BrainAction, ok: boolean, resultMsg: string): string {
  const fields: string[] = [`type=${a.type}`];
  if (a.itemId) fields.push(`itemId=${a.itemId.split("-")[0]}`);
  if (a.objectId) fields.push(`objectId=${a.objectId}`);
  if (a.targetItemId) fields.push(`targetItemId=${a.targetItemId}`);
  if (a.skillId) fields.push(`skillId=${a.skillId}`);
  if (a.targetId) fields.push(`targetId=${a.targetId}`);
  if (typeof a.count === "number" && a.count > 1) fields.push(`count=${a.count}`);
  // GATHER specific: gatherItem / gatherCount / gatherArea (그리고 LLM 이 보낸 raw item / area 도)
  const gatherItem = a.gatherItem ?? (a as { item?: string }).item;
  if (gatherItem) fields.push(`item=${gatherItem}`);
  const gatherCount = a.gatherCount ?? a.count;
  if (typeof gatherCount === "number" && gatherCount > 1 && a.type === "GATHER") fields.push(`gatherCount=${gatherCount}`);
  if (a.gatherArea?.placeId) fields.push(`area.placeId=${a.gatherArea.placeId}`);
  if (a.gatherArea?.radius) fields.push(`area.radius=${a.gatherArea.radius}`);
  if (a.currency) fields.push(`currency=${a.currency}`);
  if (typeof a.amount === "number") fields.push(`amount=${a.amount}`);
  if (a.wantItem) fields.push(`wantItem=${a.wantItem}`);
  if (a.offerItem) fields.push(`offerItem=${a.offerItem}`);
  if (typeof a.offerGold === "number") fields.push(`offerGold=${a.offerGold}`);
  if (a.to?.placeId) fields.push(`to.placeId=${a.to.placeId}`);
  if (a.to?.xy) fields.push(`to.xy=(${a.to.xy.x},${a.to.xy.y})`);
  if (a.to?.towardItem) fields.push(`to.towardItem=${a.to.towardItem}`);
  if (a.to?.towardActor) fields.push(`to.towardActor=${a.to.towardActor}`);
  if (typeof a.dx === "number" && typeof a.dy === "number" && (a.dx !== 0 || a.dy !== 0)) fields.push(`dx=${a.dx} dy=${a.dy}`);
  // 2026-05-08: 누락 필드 추가 (codex audit) — message/intent/wantCount/offerCount/x/y 등.
  if (a.message) fields.push(`message="${(a.message as string).slice(0, 60).replace(/"/g, "'")}"`);
  if ((a as { intent?: string }).intent) fields.push(`intent=${(a as { intent?: string }).intent}`);
  if (typeof (a as { wantCount?: number }).wantCount === "number") fields.push(`wantCount=${(a as { wantCount?: number }).wantCount}`);
  if (typeof (a as { offerCount?: number }).offerCount === "number") fields.push(`offerCount=${(a as { offerCount?: number }).offerCount}`);
  if (typeof (a as { x?: number }).x === "number" && typeof (a as { y?: number }).y === "number") fields.push(`x=${(a as { x?: number }).x} y=${(a as { y?: number }).y}`);
  if ((a as { query?: string }).query) fields.push(`query="${((a as { query?: string }).query ?? "").slice(0, 60).replace(/"/g, "'")}"`);
  // MOVE/WAIT/THINK/OPTIONS 의 단순 case 는 schema line 생략 — 학습 가치 낮음.
  if (a.type === "MOVE" || a.type === "WAIT" || a.type === "THINK" || a.type === "OPTIONS") return "";
  const pending = isPendingUseResult(resultMsg);
  const verb = pending ? "Queued" : ok ? "Executed" : "Attempted";
  const outcome = pending ? "pending" : ok ? "success" : "failed";
  let line = `${verb}: ${fields.join(" ")} | Outcome: ${outcome}`;
  if (!ok && resultMsg) {
    const reason = resultMsg.slice(0, 80);
    line += ` | Reason: ${reason}`;
  }
  return line;
}

function mergeCap(prev: string[], next: string[], cap: number): string[] {
  const merged = [...prev, ...next];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of merged) {
    const k = s.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.slice(-cap);
}
