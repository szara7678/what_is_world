import type { Actor, ActionRequest, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import { levelForXp, ko } from "@wiw/shared";
import { dispatchAction, findPath } from "@wiw/world-core";
import { getBrainConfig, onBrainConfigChange } from "../config/brainConfig";
import { getWorld, setWorld } from "../state/worldStore";
import { appendRawEvent } from "../logging/eventLogStore";
import { appendMetric } from "../logging/metricsStore";
import {
  readSoul, readThought, writeThought,
  readObservations, appendObservation, writeSoul, readAllRelationships
} from "../persistence/soulStore";
import { decideWithMock } from "./mock";
import { decideWithOpenRouter } from "./openrouter";
import { decideWithLocalProxy } from "./localproxy";
import { decideWithChatgptDirect } from "./chatgptDirect";
import type { BrainDecision, RecentDecision } from "./prompt";
import { getLastAffordanceKinds } from "./prompt";
import { MemoryStore } from "./memoryStore";
import { seedBootstrapMemories } from "./bootstrapSeed";
import { readRecentHistory, recordHistory, type HistoryEntry } from "../logging/historyLogStore";
import { configureLlmQueue } from "./llmQueue";

let timer: NodeJS.Timeout | null = null;
let rr = 0; // round-robin pointer
const inflightActor = new Set<string>();
const invalidActionByActor = new Map<string, { reason: string; options: string[] }>();
const lastDecisionsByActor = new Map<string, RecentDecision[]>();
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
    return { kind: "target_invalid", text: `'${intent}'의 상대를 더 이상 찾지 못한다. 다른 길을 정해야 할 듯하다.` };
  }
  // craft 재료 부족
  if (resultMsg.startsWith("craft_inputs_short") || resultMsg.startsWith("craft_failed_no_match")) {
    return { kind: "inputs_short", text: `'${intent}' 만들기에는 재료가 모자랐다. 먼저 재료를 모아야겠다.` };
  }
  // path 길이 막힘 / 자주
  if (resultMsg === "blocked_actor" || resultMsg === "blocked_tile" || resultMsg.startsWith("no_path") || resultMsg === "out_of_bounds") {
    return { kind: "path_blocked", text: `'${intent}' 길목이 자꾸 막혀 다른 길을 떠올려야 한다.` };
  }
  // 일반 temporary
  return { kind: "temporary", text: `'${intent}'이(가) 자꾸 어긋나 잠시 다시 살펴봐야겠다.` };
}

/**
 * P2: 같은 실패가 3회 누적될 때 한 번 떠오르는 사후 자기관찰 톤의 다음 행동 힌트.
 * "그렇게 하라" X. "그러면 가능하다" 톤.
 */
function composeNextActionHint(decision: BrainDecision, resultMsg: string): string | null {
  const a = decision.action;
  if (a.type === "USE") {
    if (resultMsg === "use_target_required") {
      return "USE를 쓰려면 itemId·objectId·skillId 중 하나는 정해야 한다는 걸 손이 익혀가고 있다.";
    }
    if (resultMsg === "use_inventory_missing" || resultMsg === "item_not_in_inventory") {
      return "쓰려는 물건이 가방에 있는지 먼저 확인하고 USE를 써야 한다.";
    }
    if (resultMsg.startsWith("craft_inputs_short")) {
      return "작업대로 만들려면 재료를 먼저 모아야 한다는 게 머리에 남는다.";
    }
  }
  if (a.type === "PICKUP" && resultMsg === "item_too_far") {
    return "줍기 전 한 칸 가까이 가야 한다는 걸 떠올린다.";
  }
  if (a.type === "MOVE" && resultMsg === "blocked_actor") {
    return "사람이 막은 칸은 잠시 비켜 다른 길을 살피는 편이 낫다.";
  }
  return null;
}

function composeRecoveryHint(decision: BrainDecision, resultMsg: string): string | null {
  const a = decision.action;
  if (a.type === "USE") {
    if (resultMsg === "use_target_required") {
      return "조금 전 USE는 어느 모드를 골랐는지 비어 있어서 손이 머쓱했다.";
    }
    if (resultMsg === "use_inventory_missing" || resultMsg === "item_not_in_inventory") {
      const k = a.itemId ? a.itemId.split("-")[0] : "그 물건";
      return `조금 전 ${k}을(를) 쓰려 했지만 가방에 없었다.`;
    }
    if (resultMsg.startsWith("craft_failed_no_match")) {
      return "조금 전 작업대 앞에서 손이 비어 아무것도 만들지 못했다.";
    }
    if (resultMsg.startsWith("craft_inputs_short")) {
      return "조금 전 만들려 했지만 재료가 모자랐다.";
    }
    if (resultMsg === "object_not_usable") {
      return "조금 전 가리킨 물건은 쓸 수 있는 작업대가 아니었다.";
    }
    if (resultMsg === "seed_plant_at_field") {
      return "씨앗은 텃밭 위에서만 심을 수 있다고 손끝이 알려줬다.";
    }
  }
  if (a.type === "PICKUP") {
    if (resultMsg === "inventory_full") return "가방이 꽉 차서 더 줍지 못했다.";
    if (resultMsg === "item_too_far") {
      // 좌표·방향 포함. world 가 closure 에 없으므로 caller 가 보강하지만 여기선 일반 톤.
      return `조금 전 줍고 싶던 ${a.itemId ? a.itemId.split("-")[0] : "그것"}이 다른 칸에 있어 한 발 다가가야 했다.`;
    }
    if (resultMsg === "item_not_found") return "그 자리에는 더 이상 그것이 없었다.";
  }
  if (a.type === "MOVE" && resultMsg === "blocked_actor") {
    return "조금 전 가던 칸에 누가 서 있어 발이 막혔다.";
  }
  if (a.type === "GIVE" && resultMsg === "target_inventory_full") {
    return "상대 가방이 꽉 차 있어 받지 못했다.";
  }
  return null;
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
// ineffective hard mask: key=actor:sig 마지막 효과 없는 시도 반복 카운트, mask until tick
type IneffEntry = { count: number; maskUntilTick: number };
const ineffectiveMask = new Map<string, IneffEntry>();
const INEFFECTIVE_THRESHOLD = 3;
const INEFFECTIVE_MASK_TICKS = 90; // 5 → 90. LLM scheduled_reconsider 60 보다 길게 — mask 풀린 직후 같은 결정 반복 차단.
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
    .filter((a) => a.alive && !inflightActor.has(a.id));
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
  if (soul.seededAt === undefined && me.kind !== "monster") {
    await seedBootstrapMemories(me.id, soul, world.tick);
    await writeSoul({ ...soul, seededAt: world.tick });
    soul.seededAt = world.tick;
  }
  await maybeExpireAgenda(me, soul, world.tick);
  await maybeInjectThreatObservation(me, world);

  // Step 3: monster 가 아닌 NPC 는 매 tick LLM 호출 대신 event-trigger 만 호출.
  let triggerReason: string | null = null;
  if (me.kind !== "monster") {
    triggerReason = evaluateTrigger(me, soul, world);
    if (triggerReason === null) {
      const sysResult = await runSystemStep(me, soul, world);
      if (sysResult.ok) return; // system_step 성공
      const lastLlm = lastLlmTickByActor.get(me.id) ?? -Infinity;
      if (world.tick - lastLlm < 3) {
        // silent skip — 단, 빈도 측정용으로 events 에 기록
        await appendRawEvent({
          tick: world.tick,
          timestamp: Date.now(),
          actorId: me.id,
          category: "brain",
          type: "SYSTEM_SKIP",
          result: "info",
          reason: sysResult.fail ?? "no_trigger",
          payload: { provider: "system", trigger: null, sysFail: sysResult.fail }
        });
        return;
      }
      triggerReason = "force_unstuck";
    }
    lastLlmTickByActor.set(me.id, world.tick);
  }

  const lastTwo = await readObservations(me.id, 2);
  const currentPlace = nearestPlaceId(world, me, 0);
  const targetActorId = nearestNeighborId(world, me);
  const activeOracleText = soul.activeQuest?.status === "active" ? soul.activeQuest.text : "";
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
  const retrieved = await MemoryStore.retrieve({
    text: `${soul.role ?? ""} ${agendaText} ${thought.priority} ${activeOracleText}`,
    actorId: me.id,
    placeId: currentPlace ?? undefined,
    targetActorId: soul.agenda?.targetActorId ?? targetActorId ?? undefined,
    needs: needs.length ? needs : undefined,
    limit: 6
  }, me, { tick: world.tick, ts: Date.now() });
  const memories = mergeObservations(retrieved, lastTwo);
  const nearbyActors = nearbyActorDebug(world, me);
  const invalidAction = invalidActionByActor.get(me.id);
  const lastDecisions = lastDecisionsByActor.get(me.id) ?? [];
  invalidActionByActor.delete(me.id);

  let decision: BrainDecision | null = null;
  let providerUsed: string = cfg.provider;
  let llmFailed = false;
  if (me.kind === "monster") {
    decision = decideWithMock({ world, me, soul, thought, memories });
    providerUsed = "mock";
  } else if (cfg.provider === "mock") {
    decision = decideWithMock({ world, me, soul, thought, memories });
    providerUsed = "mock";
  } else if (cfg.provider === "openrouter" && cfg.apiKey) {
    decision = await decideWithOpenRouter(cfg, { world, me, soul, thought, memories, invalidAction, lastDecisions });
    llmFailed = !decision;
  } else if (cfg.provider === "local-proxy") {
    decision = await decideWithLocalProxy(cfg, { world, me, soul, thought, memories, invalidAction, lastDecisions });
    llmFailed = !decision;
  } else if (cfg.provider === "chatgpt-direct") {
    // actor 별 model override (각 NPC 다른 모델로 살아있는 A/B)
    const actorModel = cfg.modelOverrides?.[me.id] ?? cfg.model;
    const actorCfg = actorModel === cfg.model ? cfg : { ...cfg, model: actorModel };
    decision = await decideWithChatgptDirect(actorCfg, { world, me, soul, thought, memories, invalidAction, lastDecisions });
    llmFailed = !decision;
    providerUsed = `chatgpt-direct/${actorModel}`;
  } else {
    llmFailed = true;
  }
  if (!decision) {
    if (me.kind === "monster") {
      decision = decideWithMock({ world, me, soul, thought, memories });
      providerUsed = "mock";
    } else {
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
  }
  if (providerUsed !== "mock") {
    decision.thought = buildThoughtFromAction(me, soul, world, decision, thought, memories);
  }

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
  const beforeSnap = {
    hp: me.hp, hunger: me.hunger, stamina: me.stamina,
    invLen: me.inventory.length, x: me.x, y: me.y
  };
  if (actReq) {
    // ineffective hard mask: 같은 (action, target/item) 이 cooldown 중이면 즉시 fail
    if (isIneffectiveMasked(me.id, decision, world.tick)) {
      resultOk = false;
      resultMsg = "ineffective_cooldown";
      await appendRawEvent({
        tick: world.tick,
        timestamp: Date.now(),
        actorId: me.id,
        category: "brain",
        type: "INEFFECTIVE_MASK",
        result: "info",
        reason: ineffSig(decision),
        payload: { provider: "system", action: decision.action }
      });
    } else if (decision.action.type === "USE" && decision.action.itemId && !inventoryHasItemPrefix(me, decision.action.itemId)) {
      // simulation invariant: USE itemId 인벤 없으면 즉시 fail + 같은 sig 5 tick mask
      resultOk = false;
      resultMsg = "use_inventory_missing";
      const k = ineffKey(me.id, ineffSig(decision));
      const cur = ineffectiveMask.get(k) ?? { count: 0, maskUntilTick: 0 };
      cur.count = INEFFECTIVE_THRESHOLD;
      cur.maskUntilTick = world.tick + INEFFECTIVE_MASK_TICKS;
      ineffectiveMask.set(k, cur);
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
    } else {
    const result = dispatchAction(world, actReq);
    setWorld(world);
    resultOk = result.ok;
    resultMsg = result.message;
    if (resultOk) {
      resultMsg = await applyMetaActionSideEffects(me, decision, resultMsg);
      skillProgress = await applyThinXp(me, decision, resultMsg);
      if (skillProgress.length) setWorld(world);
      if (resultMsg.includes("trade_closed")) {
        await recordHistory({
          tick: world.tick,
          ts: Date.now(),
          actorId: me.id,
          kind: "trade.done",
          text: "거래 성사",
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
    }
    // ineffective tracking: dx/dy/hp/hunger 등의 delta 가 0 이거나 fail 이면 무효 카운트
    const delta = (me.hp - beforeSnap.hp) + (beforeSnap.hunger - me.hunger) + (me.inventory.length - beforeSnap.invLen) + (Math.abs(me.x - beforeSnap.x) + Math.abs(me.y - beforeSnap.y));
    const effective = resultOk && delta !== 0;
    noteIneffectiveAttempt(me.id, decision, effective, world.tick);
    // PICKUP 성공 → 같은 prefix 의 USE mask 자동 해제
    if (resultOk && decision.action.type === "PICKUP" && decision.action.itemId) {
      const prefix = decision.action.itemId.split("-")[0];
      for (const key of [...ineffectiveMask.keys()]) {
        if (key.startsWith(`${me.id}:USE:`) && (key.includes(`:${prefix}`) || key.includes(`:${decision.action.itemId}`))) {
          ineffectiveMask.delete(key);
        }
      }
    }
  }

  if (resultOk) {
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
          text: `${targetName}에게 ${itemKorName(itemId)}을(를) 선물했다.`,
          tags: ["gift", itemId.split("-")[0] ?? "item", decision.action.targetId],
          importance: itemId.startsWith("trinket") ? 0.7 : 0.55
        });
      }
    } else if (decision.action.type === "PRAY" && soul.isFollower) {
      await writeSoul({ ...soul, faith: Math.min(1, (soul.faith ?? 0.05) + 0.05) });
    }
    await maybeFulfillOracleQuest(me, soul, decision, resultMsg);
  } else {
    // invalidAction reason 은 사실만. "이렇게 해라" 같은 명령형·강제 hint 금지 (사용자 의도).
    let factReason = resultMsg;
    if (decision.action.type === "USE" && (resultMsg === "item_not_in_inventory" || resultMsg === "use_inventory_missing")) {
      const itemId = decision.action.itemId;
      if (itemId) {
        const prefix = itemId.split("-")[0];
        factReason = `USE ${prefix} 닿지 않음 — 인벤에 ${prefix} 없음.`;
      }
    }
    invalidActionByActor.set(me.id, {
      reason: factReason,
      options: invalidRecoveryOptions(decision.action.type, resultMsg)
    });
    // P0-2 + P2: recovery_hint. 같은 sig 30tick 내 1회. 누적 3회 도달 시 next-action hint 승격(120tick).
    let hintText = composeRecoveryHint(decision, resultMsg);
    // PICKUP item_too_far 의 경우 좌표·방향 보강 (자기관찰 톤 유지)
    if (hintText && decision.action.type === "PICKUP" && resultMsg === "item_too_far" && decision.action.itemId) {
      const targetGround = world.groundItems[decision.action.itemId];
      if (targetGround) {
        const dx = targetGround.x - me.x; const dy = targetGround.y - me.y;
        const dist = Math.abs(dx) + Math.abs(dy);
        const dir = ko.directionShort(dx, dy);
        const k = decision.action.itemId.split("-")[0];
        hintText = `조금 전 줍고 싶던 ${ko.items(k)}은 ${dir} ${dist}칸 떨어져 있어 손이 닿지 않았다. 한 발 가까이 가야 했다.`;
      }
    }
    if (hintText) {
      const sig = `${decision.action.type}:${resultMsg}`;
      const k = `${me.id}:${sig}`;
      const last = recoveryHintLast.get(k) ?? -Infinity;
      if (world.tick - last >= 30) {
        recoveryHintLast.set(k, world.tick);
        const cnt = (recoveryHintCount.get(k) ?? 0) + 1;
        recoveryHintCount.set(k, cnt);
        await appendObservation({
          id: `obs_recov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          actorId: me.id,
          tick: world.tick,
          timestamp: Date.now(),
          kind: "memory",
          text: hintText,
          tags: ["recovery_hint", "self", `last_failed_action:${decision.action.type}`],
          importance: 0.35
        });
        // 3회 누적 + 120tick 안에 승격 안 한 적 있으면 next-action hint 한 번
        const lastPromote = recoveryHintPromotedAt.get(k) ?? -Infinity;
        if (cnt >= 3 && world.tick - lastPromote >= 120) {
          recoveryHintPromotedAt.set(k, world.tick);
          recoveryHintCount.set(k, 0);
          const nextText = composeNextActionHint(decision, resultMsg);
          if (nextText) {
            await appendObservation({
              id: `obs_recov_promote_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
              actorId: me.id,
              tick: world.tick,
              timestamp: Date.now(),
              kind: "memory",
              text: nextText,
              tags: ["recovery_hint", "next_action_hint", `last_failed_action:${decision.action.type}`],
              importance: 0.55
            });
          }
        }
      }
    }
  }
  rememberDecision(me.id, { type: decision.action.type, result: resultMsg });
  await recordActionSignature(me, decision, beforeSnap, resultOk, world);
  await applyGoalDecision(me, soul, world, decision, resultOk, resultMsg);
  // 자동 COMPLETE 는 강제. target_reached trigger 로 LLM 이 직접 결정하게 둠 (사용자 의도).

  // write thought — recentEvents 는 시스템이 시간순으로 한 줄씩 누적 (LLM 출력 무시).
  const sysEvent = formatActionLog(world.tick, decision, resultOk, resultMsg);
  const updatedThought = {
    ...thought,
    priority: decision.thought.priority,
    emotion: decision.thought.emotion,
    nextIntent: decision.thought.nextIntent,
    beliefs: mergeCap(thought.beliefs, decision.thought.beliefs, 8),
    recentEvents: mergeCap(thought.recentEvents, [sysEvent], 8),
    activePath: resultOk || decision.action.type !== "MOVE" ? decision.thought.activePath : undefined,
    updatedAtTick: world.tick,
    updatedAtMs: Date.now()
  };
  await writeThought(updatedThought);

  const interactionObservation = buildInteractionObservation(
    world,
    me,
    decision,
    resultOk,
    resultMsg,
    actionTargetId,
    targetBeforeHp
  );

  // write observation (self-action) — text 에 행동 파라미터 (item, target, dir 등) 풍부하게 노출
  const selfText = interactionObservation?.selfText
    ?? formatActionLog(world.tick, decision, resultOk, resultMsg).replace(/^\[t\d+\]\s*/, "");
  await appendObservation({
    id: `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick: world.tick,
    timestamp: Date.now(),
    kind: "action",
    text: selfText,
    tags: [decision.action.type.toLowerCase(), providerUsed],
    importance: await computeImportance(decision.action, resultOk, resultMsg, me, decision.action.reason)
  });

  if (interactionObservation?.targetText && interactionObservation.targetId) {
    await appendObservation({
      id: `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: interactionObservation.targetId,
      tick: world.tick,
      timestamp: Date.now(),
      kind: interactionObservation.kind,
      text: interactionObservation.targetText,
      tags: [decision.action.type.toLowerCase(), "received", me.id],
      importance: interactionObservation.targetImportance
    });
    // 직접 사회 입력 → 다음 tick 에 trigger interrupt_social
    if (decision.action.type === "SPEAK" || decision.action.type === "GIVE" || decision.action.type === "ATTACK") {
      noteSocialInput(interactionObservation.targetId, world.tick);
    }
  }

  // raw event (shows up in feed via SSE)
  await appendRawEvent({
    tick: world.tick,
    timestamp: Date.now(),
    actorId: me.id,
    category: "brain",
    type: llmFailed && me.kind !== "monster"
      ? `LLM failed → ${decision.action.type}`
      : `${decision.action.type}${decision.action.message ? `: ${decision.action.message}` : ""}`,
    result: resultOk ? "success" : "failed",
    reason: resultOk ? undefined : resultMsg,
    payload: {
      provider: providerUsed,
      llmFailed,
      memoryUsed: memories.length,
      skillProgress,
      nearbyActors,
      thought: decision.thought,
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
    success: resultOk,
    failReason: resultOk ? undefined : resultMsg,
    cooldownBlocked: !resultOk && /cooldown/.test(resultMsg),
    staminaBlocked: !resultOk && resultMsg === "stamina_too_low",
    inventoryBlocked: !resultOk && (resultMsg === "inventory_full" || resultMsg === "target_inventory_full"),
    agendaState: soul.agenda?.status ?? "none",
    skillXp: Object.keys(xpDelta).length ? xpDelta : undefined,
    tradeOpened: decision.action.type === "OFFER_TRADE",
    tradeClosed: resultOk && /trade_closed/.test(resultMsg),
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
  const emotion = me.hp < me.maxHp * 0.3 ? "두려움"
    : me.hunger > 80 ? "피곤함"
    : prevThought.emotion ?? "평온";
  return {
    actorId: me.id,
    updatedAtTick: world.tick,
    updatedAtMs: Date.now(),
    priority: reason || prevThought.priority,
    nextIntent: intentMap[decision.action.type] ?? decision.action.type,
    emotion,
    beliefs: mergeCap(prevThought.beliefs, decision.thought.beliefs, 8),
    recentEvents: [
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

  if (args.me.hunger >= 70 || args.me.stamina <= 30) {
    return {
      thought: {
        priority: "몸 상태가 위태로워 가진 것을 확인한다",
        emotion: args.me.hp < args.me.maxHp * 0.5 ? "불안" : "긴장",
        nextIntent: "WAIT",
        beliefs: ["LLM 실패 시 잠시 멈춰 다음 결정을 모은다"],
        recentEvents: ["LLM 결정 실패"],
        activePath: args.thought.activePath
      },
      action: { type: "WAIT" }
    };
  }

  return {
    thought: {
      priority: "결정을 잇지 못해 잠깐 몸을 보존한다",
      emotion: "평온",
      nextIntent: "WAIT",
      beliefs: ["LLM 실패 시 mock 대신 안전한 폴백을 쓴다"],
      recentEvents: ["LLM 결정 실패"],
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
      priority: "정해 둔 길을 이어서 걷는다",
      emotion: "평온",
      nextIntent: "MOVE",
      beliefs: [`목적지는 (${activePath.targetXY.x},${activePath.targetXY.y})이다`],
      recentEvents: ["LLM 결정 실패 후 activePath를 따른다"],
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

function toActionRequest(actorId: string, d: BrainDecision): ActionRequest | null {
  const a = d.action;
  switch (a.type) {
    case "MOVE":
      if ((a.dx ?? 0) === 0 && (a.dy ?? 0) === 0) return null;
      return { actorId, action: { type: "MOVE", dx: a.dx ?? 0, dy: a.dy ?? 0 } };
    case "ATTACK":
      if (!a.targetId) return null;
      return { actorId, action: { type: "ATTACK", targetId: a.targetId } };
    case "SPEAK":
      return { actorId, action: { type: "SPEAK", message: a.message ?? "…" } };
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
    case "BUY":
      if (!a.targetId || !a.itemType) return null;
      return { actorId, action: { type: "BUY", targetId: a.targetId, itemType: a.itemType } };
    case "SELL":
      if (!a.targetId || !a.itemId) return null;
      return { actorId, action: { type: "SELL", targetId: a.targetId, itemId: a.itemId } };
    case "PRAY":
      return { actorId, action: { type: "PRAY" } };
    case "THINK":
      return { actorId, action: { type: "THINK", query: a.query ?? d.thought.priority } };
    case "OPTIONS":
      return { actorId, action: { type: "OPTIONS" } };
    case "WAIT":
      return { actorId, action: { type: "WAIT" } };
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
    goals: soul.goals.filter((goal) => goal !== `[신탁] ${quest.text}`),
    updatedAt: Date.now()
  };
  await writeSoul(next);
  await appendObservation({
    id: `obs_oracle_done_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick: world.tick,
    timestamp: Date.now(),
    kind: "memory",
    text: `신탁을 이행했다: ${quest.text}`,
    tags: ["oracle", "fulfilled"],
    importance: 0.9
  });
  await recordHistory({
    tick: world.tick,
    ts: Date.now(),
    actorId: me.id,
    kind: "oracle.fulfilled",
    text: "신탁 완수",
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
    ? `방금 ${attacker.name}에게 공격받았다 (hp ${Math.round(me.hp)}/${me.maxHp}).`
    : `방금 공격을 받아 hp가 줄었다 (${Math.round(me.hp)}/${me.maxHp}).`;
  await appendObservation({
    id: `obs_threat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick: world.tick,
    timestamp: Date.now(),
    kind: "memory",
    text,
    tags: ["threat:auto", attacker?.id ?? "unknown"],
    importance: 0.95
  });
}

async function maybeExpireOracleQuest(me: Actor, soul: Soul): Promise<void> {
  const quest = soul.activeQuest;
  const world = getWorld();
  if (!quest || quest.status !== "active" || quest.expiresAtTick > world.tick) return;
  await writeSoul({
    ...soul,
    activeQuest: { ...quest, status: "abandoned" },
    goals: soul.goals.filter((goal) => goal !== `[신탁] ${quest.text}`),
    updatedAt: Date.now()
  });
  await recordHistory({
    tick: world.tick,
    ts: Date.now(),
    actorId: me.id,
    kind: "oracle.abandoned",
    text: "신탁 미완",
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
  agenda_no_path: 3,        // path 못 만들어도 즉시 LLM 폭주 방지 (3 tick)
  interrupt_threat: 5,
  interrupt_crisis: 5,
  interrupt_social: 4,
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
    a.kind === "monster" && a.alive && Math.abs(a.x - me.x) + Math.abs(a.y - me.y) <= 2
  );
  if (adjMonster) return cooldownGate(me, world.tick, "interrupt_threat");

  // 3. interrupt: crisis
  if (me.hp <= me.maxHp * 0.25 || me.hunger >= 90 || me.stamina <= 10) {
    return cooldownGate(me, world.tick, "interrupt_crisis");
  }

  // 4. interrupt: 직접 사회 입력
  if (recentSocialInput(me.id, world.tick)) return cooldownGate(me, world.tick, "interrupt_social");

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

const recentSocialInputTicks = new Map<string, number>();
function noteSocialInput(actorId: string, tick: number): void {
  recentSocialInputTicks.set(actorId, tick);
}
function recentSocialInput(actorId: string, tick: number): boolean {
  const t = recentSocialInputTicks.get(actorId);
  return t !== undefined && tick - t <= 2;
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
    text: `'${agenda.intent}' 의 자리에 닿았다.`,
    tags: ["agenda", "completed", "auto", "lesson"],
    importance: 0.6
  });
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

function ineffSig(decision: BrainDecision): string {
  const a = decision.action;
  const target = a.targetId ?? a.itemId ?? "";
  const dir = a.type === "MOVE" ? `${a.dx ?? 0},${a.dy ?? 0}` : "";
  return `${a.type}:${target}${dir ? `:${dir}` : ""}`;
}
function ineffKey(actorId: string, sig: string): string { return `${actorId}:${sig}`; }
function isIneffectiveMasked(actorId: string, decision: BrainDecision, tick: number): boolean {
  const e = ineffectiveMask.get(ineffKey(actorId, ineffSig(decision)));
  return e !== undefined && tick < e.maskUntilTick;
}
function noteIneffectiveAttempt(actorId: string, decision: BrainDecision, effective: boolean, tick: number): void {
  const k = ineffKey(actorId, ineffSig(decision));
  const cur = ineffectiveMask.get(k) ?? { count: 0, maskUntilTick: 0 };
  if (effective) {
    ineffectiveMask.delete(k);
    return;
  }
  cur.count += 1;
  if (cur.count >= INEFFECTIVE_THRESHOLD) {
    cur.maskUntilTick = tick + INEFFECTIVE_MASK_TICKS;
    cur.count = 0; // mask 후 reset (다시 처음부터 카운트)
  }
  ineffectiveMask.set(k, cur);
}

function buildPathStep(world: WorldState, me: Actor, agenda: Agenda): Array<{ dx: number; dy: number }> | null {
  const plan = buildPathPlan(world, me, agenda);
  return "path" in plan ? plan.path : null;
}

async function runSystemStep(me: Actor, soul: Soul, world: WorldState): Promise<{ ok: boolean; fail?: string }> {
  const agenda = soul.agenda;
  if (!agenda || (agenda.status !== "active" && agenda.status !== "settling")) {
    return { ok: false, fail: "agenda_not_runnable" };
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
        thought: { priority: agenda.intent, emotion: "차분함", nextIntent: "MOVE", beliefs: [], recentEvents: [] },
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
        text: `'${agenda.intent}' 시도가 막혔다. 잠시 다른 길을 본다.`,
        tags: ["agenda", "blocked", "lesson"],
        importance: 0.55
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
        text: `'${agenda.intent}' 의 시간이 다 됐다. 다음 마음을 정한다.`,
        tags: ["agenda", "expired", "lesson"],
        importance: 0.55
      });
    }
  }
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
          importance: 0.45
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
    await appendObservation({
      id: `obs_agenda_done_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick,
      timestamp: Date.now(),
      kind: "memory",
      text: `'${current.intent}' 을(를) 마쳤다.`,
      tags: ["agenda", "completed", "lesson"],
      importance: 0.7
    });
    return;
  }

  if (gd.kind === "ABANDON" && current && current.status === "active") {
    soul.agenda = { ...current, status: "abandoned" };
    await writeSoul({ ...soul, agenda: soul.agenda, updatedAt: Date.now() });
    await appendObservation({
      id: `obs_agenda_aban_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick,
      timestamp: Date.now(),
      kind: "memory",
      text: `'${current.intent}' 을(를) 그만뒀다. (${gd.reason ?? ""})`,
      tags: ["agenda", "abandoned", "lesson"],
      importance: 0.5
    });
    return;
  }

  if (gd.kind === "CHANGE" && gd.proposal && gd.proposal.intent.length >= 2) {
    const p = gd.proposal;
    const canonicalActorId = p.targetActorId && world.actors[p.targetActorId] ? p.targetActorId : undefined;
    // targetXY 검증: 맵 안인지, passable 인지
    let validXY: { x: number; y: number } | undefined;
    if (p.targetXY) {
      const x = Math.trunc(p.targetXY.x), y = Math.trunc(p.targetXY.y);
      if (x >= 0 && y >= 0 && x < world.map.width && y < world.map.height) {
        validXY = { x, y };
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
        text: `'${p.intent}' 방향으로는 지금 갈 길이 없다. 다른 방법을 떠올려야 한다. (${plan.fail})`,
        tags: ["agenda", "path_unreachable", "lesson"],
        importance: 0.6
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
    await appendObservation({
      id: `obs_agenda_set_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick,
      timestamp: Date.now(),
      kind: "memory",
      text: `'${p.intent}' 을(를) 마음에 둔다. (${p.reason || ""})`,
      tags: ["agenda", "started"],
      importance: 0.6
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
    const recalled = await MemoryStore.retrieve({
      text: query,
      actorId: me.id,
      limit: 3
    }, me, { tick: world.tick, ts: now });
    for (const obs of recalled) {
      await appendObservation({
        id: `obs_think_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: me.id,
        tick: world.tick,
        timestamp: now,
        kind: "memory",
        text: `떠올렸다: ${obs.text}`,
        tags: ["self-recall", "think"],
        importance: 0.5
      });
    }
    const important = recalled.find((obs) => obs.importance >= 0.8);
    if (important && !(await hasHistory("memory.recalled_important", (entry) => entry.actorId === me.id))) {
      await recordHistory({
        tick: world.tick,
        ts: now,
        actorId: me.id,
        kind: "memory.recalled_important",
        text: `${me.name} 이(가) 중요한 기억을 떠올렸어요.`,
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
      importance: 0.4
    });
  }
  if (decision.action.type === "USE" && decision.action.itemId?.startsWith("letter")) {
    const text = "편지 내용 belief: 다른 마을에서 온 소식과 전할 말이 있다.";
    await appendObservation({
      id: `obs_letter_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: now,
      kind: "memory",
      text,
      tags: ["letter", "belief"],
      importance: 0.65
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
      importance: 0.3
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
  if (action.type === "USE" && isFarmPractice(action.itemId, resultMsg)) changes.push({ skillId: "farming", key: `USE:${itemKey}`, xp: 3 });
  if (action.type === "PICKUP" && isFarmItem(action.itemId)) changes.push({ skillId: "farming", key: `PICKUP:${itemKey}`, xp: 2 });
  if (action.type === "USE" && isGatheringPractice(action.itemId, resultMsg)) changes.push({ skillId: "gathering", key: `USE:${itemKey}`, xp: 2 });
  if (action.type === "PICKUP" && isGatheringItem(action.itemId)) changes.push({ skillId: "gathering", key: `PICKUP:${itemKey}`, xp: 2 });
  if (action.type === "PICKUP" && isForageItem(action.itemId)) changes.push({ skillId: "foraging", key: `PICKUP:${itemKey}`, xp: 3 });
  if (action.type === "USE" && action.itemId?.startsWith("fishing_rod")) changes.push({ skillId: "fishing", key: `USE:fishing_rod`, xp: resultMsg.includes("fish_caught") ? 5 : 1 });
  if (action.type === "ATTACK") changes.push({ skillId: "swordsmanship", key: `ATTACK:${targetKey}`, xp: 3 });
  if (action.type === "PRAY") changes.push({ skillId: "meditation", key: "PRAY", xp: 2 });
  if (action.type === "WAIT") changes.push({ skillId: "meditation", key: "WAIT", xp: 1 });
  if (action.type === "THINK" && action.query && action.query.length >= 8) changes.push({ skillId: "meditation", key: `THINK:${(action.query ?? "").slice(0, 24)}`, xp: 1 });
  if (action.type === "USE" && action.itemId && isFoodItem(action.itemId)) changes.push({ skillId: "cooking", key: `USE_FOOD:${itemKey}`, xp: 2 });

  const applied: AppliedSkillProgress[] = [];
  const world = getWorld();
  const memMap = recentXpKeys.get(me.id) ?? new Map<string, { count: number; tick: number }>();
  recentXpKeys.set(me.id, memMap);
  for (const [k, v] of memMap) if (world.tick - v.tick > XP_DECAY_WINDOW_TICKS) memMap.delete(k);

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
      skill.level = Math.min(10, newLevel);
      entry.levelUp = { newLevel: skill.level };
      await recordHistory({
        tick: world.tick,
        ts: Date.now(),
        actorId: me.id,
        kind: "skill.level_up",
        text: `${me.name} 의 ${skill.name} 숙련이 ${skill.level}레벨이 되었어요.`,
        meta: { skillId: skill.id, newLevel: skill.level }
      });
    }
    applied.push(entry);
  }
  if (applied.length) world.revision += 1;
  return applied;
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
  return Boolean(itemId && /^(carrot|wheat)-/.test(itemId));
}

function isGatheringItem(itemId: string | undefined): boolean {
  return Boolean(itemId && /^(wood|ore|coal|clay)-/.test(itemId));
}

function isForageItem(itemId: string | undefined): boolean {
  return Boolean(itemId && /^(berry|mushroom)-/.test(itemId));
}

function isFoodItem(itemId: string): boolean {
  return /^(carrot|wheat|herb|bread|food|berry|mushroom|fish)-/.test(itemId);
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
        text: `${me.name} 와 ${targetName} 이(가) 처음 말을 나눴어요.`,
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
        : (itemId ? itemKorName(itemId) : "선물");
      await recordHistory({
        tick: world.tick,
        ts: Date.now(),
        actorId: me.id,
        kind: "gift.significant",
        text: `${me.name} 이(가) ${targetName} 에게 ${giftPretty} 을(를) 건넸어요.`,
        meta: { from: me.id, to: actionTargetId, itemId, currency: decision.action.currency, amount: decision.action.amount }
      });
    }
  }

  if (decision.action.type === "PICKUP" && args.pickupItemId && /^(carrot|wheat|wood|ore)-/.test(args.pickupItemId)) {
    const resource = args.pickupItemId.split("-")[0] ?? args.pickupItemType ?? "item";
    const day = Math.floor(world.tick / 2400) + 1;
    if (!(await hasHistory("harvest.first_of_day", (entry) => entry.meta?.day === day && entry.meta?.resource === resource))) {
      await recordHistory({
        tick: world.tick,
        ts: Date.now(),
        actorId: me.id,
        kind: "harvest.first_of_day",
        text: `${me.name} 이(가) 오늘 첫 ${resource} 을(를) 거뒀어요.`,
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
        text: `${me.name} 이(가) ${target.name} 에게 첫 상처를 냈어요.`,
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
        text: `최근 ${verb}${target ? ` ${target}` : ""}을(를) ${recentSame.length}번 시도했지만 변화가 없었다. 다른 방법을 찾아야겠다.`,
        tags: ["ineffective", "self-observation"],
        importance: 0.7
      });
    }
  }
}

function rememberDecision(actorId: string, decision: RecentDecision): void {
  const prev = lastDecisionsByActor.get(actorId) ?? [];
  lastDecisionsByActor.set(actorId, [...prev, decision].slice(-5));
}

function invalidRecoveryOptions(type: BrainDecision["action"]["type"], resultMsg: string): string[] {
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
      selfText: `${target.name}에게 '${msg}'라고 말했다.`,
      targetId,
      targetText: `${me.name}이(가) 나에게 '${msg}'라고 말했다.`,
      targetImportance: 0.55,
      kind: "dialogue"
    };
  }

  if (decision.action.type === "ATTACK") {
    const dmg = Math.max(0, (targetBeforeHp ?? target.hp + 10) - target.hp);
    return {
      selfText: `${target.name}을(를) 공격했다 (피해 ${dmg}).`,
      targetId,
      targetText: `${me.name}이(가) 나를 공격했다 (피해 ${dmg}).`,
      targetImportance: target.alive ? 0.9 : 1,
      kind: "memory"
    };
  }

  if (decision.action.type === "GIVE") {
    if (decision.action.currency === "gold") {
      const amount = Number(decision.action.amount ?? 0);
      return {
        selfText: `${target.name}에게 ${amount}gold를 건넸다.`,
        targetId,
        targetText: `${me.name}이(가) 나에게 ${amount}gold를 건넸다.`,
        targetImportance: amount >= 10 ? 0.8 : 0.65,
        kind: "memory"
      };
    }
    const itemId = decision.action.itemId ?? resultMsg.replace(/^gave:/, "");
    const itemKor = itemKorName(itemId);
    return {
      selfText: `${target.name}에게 ${itemKor}을(를) 건넸다.`,
      targetId,
      targetText: `${me.name}이(가) 나에게 ${itemKor}을(를) 건넸다.`,
      targetImportance: itemId.startsWith("trinket") ? 0.8 : 0.65,
      kind: "memory"
    };
  }

  return null;
}

// 아이템 한국어 이름은 packages/shared/src/content/items.ts ITEM_CATALOG 단일 출처
const itemKorName = (itemId: string): string => ko.items(itemId);

function itemTypeFromId(itemId: string): string {
  return itemId.split("-")[0]?.trim() || itemId || "물건";
}

async function computeImportance(
  action: BrainDecision["action"],
  ok: boolean,
  resultMsg: string,
  me: Actor,
  reason?: string
): Promise<number> {
  if (!ok) return 0.2;
  const reasonBoost = computeReasonImportanceBoost(reason);
  const world = getWorld();
  if (action.type === "ATTACK" && action.targetId) {
    const target = world.actors[action.targetId];
    return Math.min(1, (!target || !target.alive || target.hp <= 10 ? 1 : 0.75) + reasonBoost);
  }
  if (action.type === "SPEAK") {
    const recent = await readObservations(me.id, 8);
    if (recent.some((obs) => obs.kind === "dialogue" && obs.tags.includes("visitor"))) return Math.min(1, 0.9 + reasonBoost);
    const targetId = action.targetId ?? nearestNeighborId(world, me);
    if (targetId) {
      const rels = await readAllRelationships();
      if (!rels.some((rel) => rel.from === me.id && rel.to === targetId)) return Math.min(1, 0.6 + reasonBoost);
    }
    return Math.min(1, 0.4 + reasonBoost);
  }
  if (action.type === "USE") {
    if (me.hunger > 80 || resultMsg.includes("oracle")) return Math.min(1, 0.8 + reasonBoost);
    return Math.min(1, 0.2 + reasonBoost);
  }
  if (action.type === "GIVE") {
    if (resultMsg.includes("trade_closed")) return Math.min(1, 0.8 + reasonBoost);
    const soul = await readSoul(me.id, me.name);
    return Math.min(1, (soul.isFollower && soul.activeQuest?.status === "active" ? 0.9 : 0.7) + reasonBoost);
  }
  if (action.type === "BUY" || action.type === "SELL") return Math.min(1, 0.5 + reasonBoost);
  if (action.type === "THINK" || action.type === "OPTIONS") return Math.min(1, 0.3 + reasonBoost);
  if (action.type === "PRAY") return Math.min(1, 0.6 + reasonBoost);
  return Math.min(1, 0.2 + reasonBoost);
}

function computeReasonImportanceBoost(reason: string | undefined): number {
  if (!reason) return 0;
  return /(신탁|신의 명|명령|기도|사당|위험|공격|도움|나누|거래|굶|배고|기억|떠올)/.test(reason)
    ? 0.15
    : 0;
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
  if (a.type === "MOVE") {
    const dir = ko.direction(a.dx ?? 0, a.dy ?? 0);
    if (dir) parts.push(`${dir}으로`);
  }
  if (a.type === "USE") {
    // USE 모드별 분기 — "무언가" 두루뭉술 표현 제거.
    if (a.skillId) {
      // pray / appraise — 스킬 이름 직접 표시
      parts.push(`${a.skillId === "pray" ? "기도로" : a.skillId === "appraise" ? "감정으로" : a.skillId + "로"}`);
    } else if (a.objectId && a.targetItemId) {
      // craft — "오븐에서 빵을 만들었다"
      parts.push(`${a.objectId.replace(/^structure-/, "")}에서 ${ko.items(a.targetItemId)}을(를)`);
    } else if (a.objectId) {
      parts.push(`${a.objectId.replace(/^structure-/, "")}을(를)`);
    } else if (a.itemId) {
      parts.push(`${ko.items(a.itemId)}을(를)${a.count && a.count > 1 ? ` ${a.count}개` : ""}`);
    }
  } else if (a.itemId && (a.type === "PICKUP" || a.type === "DROP")) {
    parts.push(`${ko.items(a.itemId)}을(를)${a.count && a.count > 1 ? ` ${a.count}개` : ""}`);
  }
  if (a.type === "GIVE") {
    if (a.currency && a.amount) parts.push(`${a.amount}${a.currency}을(를)`);
    else if (a.itemId) parts.push(`${ko.items(a.itemId)}을(를)${a.count && a.count > 1 ? ` ${a.count}개` : ""}`);
    if (a.targetId) parts.push(`${a.targetId}에게`);
  }
  if (a.type === "OFFER_TRADE") {
    const want = a.wantItem ? `${ko.items(a.wantItem)}${a.wantCount && a.wantCount > 1 ? ` ${a.wantCount}개` : ""}` : null;
    const offer = a.offerGold ? `금화 ${a.offerGold}` : a.offerItem ? `${ko.items(a.offerItem)}${a.offerCount && a.offerCount > 1 ? ` ${a.offerCount}개` : ""}` : null;
    if (a.targetId) parts.push(`${a.targetId}에게`);
    if (want && offer) parts.push(`${offer} 주고 ${want}을(를)`);
    else if (want) parts.push(`${want}을(를)`);
    else if (offer) parts.push(`${offer} 대가로`);
    parts.push("거래 제안");
  }
  if ((a.type === "SPEAK" || a.type === "ATTACK") && a.targetId) parts.push(`${a.targetId}에게`);
  if (a.type !== "OFFER_TRADE") parts.push(ko.action(a.type));
  if (a.type === "SPEAK" && a.message) parts.push(`"${a.message.slice(0, 60)}"`);
  let line = `[t${tick}] ${parts.join(" ")}`.replace(/\s+/g, " ").trim();
  if (!resultOk) line += ` — ${ko.result(resultMsg)}`;
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
