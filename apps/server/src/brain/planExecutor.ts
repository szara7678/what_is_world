import type { Actor, Plan, PlanStep, PlanStepRuntime, Soul, WorldState } from "@wiw/shared";
import {
  itemKeyOf, hasInInventory, inventoryCountOf,
  STATION_TYPES
} from "@wiw/shared";
import { findPath, RECIPES } from "@wiw/world-core";

/**
 * plan-driven executor — 한 step 씩 자동 실행. PR2~PR4 점진 추가.
 *
 * 책임: 물리적 실행 자동화까지. 인생 목적 변경은 LLM 만.
 *  - GO_TO: pathfind → 1칸씩 이동
 *  - GATHER: 위치 탐색 → 접근 → PICKUP 반복 (PR3)
 *  - CRAFT: station 탐색 → 접근 → USE craft (PR4)
 *  - TALK_TO: 대상 접근 → SPEAK (message 있으면 그대로, 없으면 단발 LLM)
 *  - WAIT_UNTIL: 조건 평가 (모든 WAIT 에 maxTicks 강제)
 *  - USE: 인벤/근접 object 사용
 *
 * 가드레일:
 *  1) step intent 내부에서만 판단
 *  2) 실패는 명시 사유 반환 ({ ok:false, reason, detail })
 *  3) 대체 행동 제한적 (가까운 자원 fallback OK / 다른 목표 선택은 금지)
 *  4) retry max 차등 (GO_TO 5 / GATHER 2 / CRAFT 1 / TALK_TO 2 / USE 1 / WAIT_UNTIL 0)
 *  5) interrupt 시 즉시 폐기 X — paused 후 LLM 결정
 */

export const STEP_RETRY_MAX: Record<PlanStep["kind"], number> = {
  GO_TO: 5,
  GATHER: 2,
  CRAFT: 1,
  TALK_TO: 2,
  USE: 1,
  WAIT_UNTIL: 0
};

export const FAILURE_BUDGET_DEFAULT = 3;
export const SAME_REASON_COOLDOWN_TICKS = 60;

export type StepOutcome =
  | { kind: "ongoing" }                                                  // step 진행 중 (executor 가 dispatch 했고 다음 tick 까지 기다림)
  | { kind: "step_done"; nextStep?: number }                              // 이 step 완료
  | { kind: "step_failed"; reason: string; detail?: string }              // 이 step 실패 (retry 또는 paused)
  | { kind: "plan_done" }                                                // 모든 step 완료
  | { kind: "plan_paused"; reason: string; detail?: string }              // hard interrupt → LLM 호출 필요
  | { kind: "plan_abandoned"; reason: string }                            // failureBudget 초과 또는 invalid
  | { kind: "noop" };                                                    // executor 가 이번 박자에 아무것도 안 함 (다른 system_step 이용)

/**
 * Plan validation — schema·persona·feasibility 체크. 실패면 plan 폐기.
 * gpt-5.5 가이드: persona role hard constraint 위반 polish 후 reject. soft mismatch 면 재질문.
 */
export function validatePlan(plan: Plan, _actor: Actor, _soul: Soul, world: WorldState): { ok: boolean; reason?: string } {
  if (!plan.id || !plan.goal || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return { ok: false, reason: "schema_missing_required" };
  }
  if (plan.steps.length > 12) return { ok: false, reason: "too_many_steps" };
  if (plan.ttlTicks < 50 || plan.ttlTicks > 1500) return { ok: false, reason: "ttl_out_of_range" };
  for (const step of plan.steps) {
    const r = validateStep(step, world);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function validateStep(step: PlanStep, world: WorldState): { ok: boolean; reason?: string } {
  switch (step.kind) {
    case "GO_TO": {
      if (step.placeId && !world.places?.[step.placeId]) return { ok: false, reason: `unknown_place:${step.placeId}` };
      if (step.xy) {
        const { x, y } = step.xy;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "invalid_xy" };
        if (x < 0 || y < 0 || x >= world.map.width || y >= world.map.height) return { ok: false, reason: "xy_out_of_bounds" };
      }
      if (!step.placeId && !step.xy && !step.nearItem && !step.nearActor) return { ok: false, reason: "go_to_target_missing" };
      return { ok: true };
    }
    case "GATHER": {
      if (!step.item) return { ok: false, reason: "gather_item_missing" };
      if (!step.count || step.count <= 0 || step.count > 32) return { ok: false, reason: "gather_count_invalid" };
      return { ok: true };
    }
    case "CRAFT": {
      if (!step.output) return { ok: false, reason: "craft_output_missing" };
      const recipe = RECIPES.find((r) => r.output.itemPrefix === step.output);
      if (!recipe) return { ok: false, reason: `craft_unknown_output:${step.output}` };
      return { ok: true };
    }
    case "TALK_TO": {
      if (!step.actorId && !step.topic) return { ok: false, reason: "talk_target_or_topic_missing" };
      return { ok: true };
    }
    case "USE": {
      if (!step.item && !step.objectId) return { ok: false, reason: "use_target_missing" };
      return { ok: true };
    }
    case "WAIT_UNTIL": {
      if (!step.condition) return { ok: false, reason: "wait_condition_missing" };
      if (!step.maxTicks || step.maxTicks <= 0 || step.maxTicks > 1500) return { ok: false, reason: "wait_max_ticks_invalid" };
      return { ok: true };
    }
  }
}

/** plan 안 sub-intent 가 actor 의 role hard constraint 위반인지 검사 (PR1: lenient). */
export function planPersonaConsistency(_plan: Plan, _actor: Actor, _soul: Soul): { ok: boolean; reason?: string } {
  // PR1: 모든 NPC 가 자유로이 craft/gather 가능. role hard constraint 없음.
  return { ok: true };
}

// ── WAIT_UNTIL 조건 평가 (PR1: structured object only) ─────────────────────────
export function evaluateWaitCondition(
  step: Extract<PlanStep, { kind: "WAIT_UNTIL" }>,
  actor: Actor,
  world: WorldState,
  startedAtTick: number,
  context?: Record<string, unknown>
): { satisfied: boolean; reason?: string } {
  const c = step.condition;
  switch (c.kind) {
    case "tick_at":     return { satisfied: world.tick >= c.tick };
    case "tick_after":  return { satisfied: world.tick - startedAtTick >= c.ticks };
    case "time_of_day": return { satisfied: Math.floor(world.timeOfDay) === c.hour };
    case "actor_within": {
      const t = world.actors[c.actorId];
      if (!t || !t.alive) return { satisfied: false, reason: "actor_not_found" };
      const d = Math.abs(t.x - actor.x) + Math.abs(t.y - actor.y);
      return { satisfied: d <= c.distance };
    }
    case "crop_mature": {
      const cropId = c.cropId ?? (context?.lastPlantedCropId as string | undefined);
      if (!cropId) return { satisfied: false, reason: "crop_id_unresolved" };
      const crop = world.crops?.[cropId];
      // crop 이 mature 되어 ground item 으로 변환되면 더 이상 crops 에 없음 — 그게 satisfied 신호.
      return { satisfied: !crop };
    }
    case "weather":     return { satisfied: world.context.weather === c.weather };
    case "inventory_has": return { satisfied: inventoryCountOf(actor.inventory, c.item) >= c.count };
    case "idle":        return { satisfied: world.tick - startedAtTick >= c.ticks };
  }
}

// ── 유틸: plan 진행 검사 ──────────────────────────────────────────────
export function planProgress(plan: Plan): number {
  const done = plan.stepRuntimes.filter((s) => s.status === "done").length;
  return plan.steps.length > 0 ? done / plan.steps.length : 0;
}

export function isStepKindSafe(kind: PlanStep["kind"]): boolean {
  // assist 모드에서 실행 가능한 step kind. CRAFT/TALK_TO/USE 는 full 에서만.
  return kind === "GO_TO" || kind === "WAIT_UNTIL" || kind === "GATHER";
}

// ── PR2~4 step executor 본체 ─────────────────────────────────────────
import { dispatchAction } from "@wiw/world-core";

export type DispatchFn = typeof dispatchAction;

/**
 * 한 박자 동안 한 step 진행. ongoing/step_done/step_failed/plan_done/plan_paused/plan_abandoned/noop 반환.
 * caller (loop) 가 outcome 보고 stepRuntimes·currentStep·plan.status 업데이트.
 */
export async function runPlanTick(
  world: WorldState,
  actor: Actor,
  plan: Plan,
  mode: "assist" | "full"
): Promise<StepOutcome> {
  if (plan.status !== "active") return { kind: "noop" };
  if (plan.currentStep >= plan.steps.length) return { kind: "plan_done" };
  const step = plan.steps[plan.currentStep];
  const runtime = plan.stepRuntimes[plan.currentStep] ?? { status: "pending" };
  // mode 가 assist 면 unsafe step 은 paused → LLM 결정
  if (mode === "assist" && !isStepKindSafe(step.kind)) {
    return { kind: "plan_paused", reason: "assist_mode_unsafe_step", detail: step.kind };
  }
  switch (step.kind) {
    case "GO_TO":      return execGoTo(world, actor, step, runtime, plan);
    case "GATHER":     return execGather(world, actor, step, runtime, plan);
    case "CRAFT":      return execCraft(world, actor, step, runtime, plan);
    case "USE":        return execUse(world, actor, step, runtime, plan);
    case "WAIT_UNTIL": return execWaitUntil(world, actor, step, runtime, plan);
    case "TALK_TO":    return execTalkTo(world, actor, step, runtime, plan);
  }
}

// ── GO_TO ────────────────────────────────────────────
function resolveGoToTarget(world: WorldState, actor: Actor, step: Extract<PlanStep, { kind: "GO_TO" }>): { x: number; y: number } | null {
  if (step.xy) return { x: step.xy.x, y: step.xy.y };
  if (step.placeId) {
    const p = world.places?.[step.placeId];
    if (!p) return null;
    return { x: p.x + Math.floor(p.width / 2), y: p.y + Math.floor(p.height / 2) };
  }
  if (step.nearItem) {
    const g = findNearestGroundItem(world, actor, step.nearItem);
    if (g) return { x: g.x, y: g.y };
  }
  if (step.nearActor) {
    const t = world.actors[step.nearActor];
    if (t && t.alive) return { x: t.x, y: t.y };
  }
  return null;
}

function execGoTo(world: WorldState, actor: Actor, step: Extract<PlanStep, { kind: "GO_TO" }>, _runtime: PlanStepRuntime, _plan: Plan): StepOutcome {
  const target = resolveGoToTarget(world, actor, step);
  if (!target) return { kind: "step_failed", reason: "go_to_target_unresolved" };
  if (arrivedAt(actor, target.x, target.y) || isAdjacent(actor, target.x, target.y)) {
    return { kind: "step_done" };
  }
  // path 가 없거나 끝났으면 새로 계산. 시스템 movePath 에 set 하고 ongoing 반환 — tickWorld 가 자동 진행.
  if (!actor.movePath || actor.movePath.length === 0 || !actor.movePathTarget
      || actor.movePathTarget.x !== target.x || actor.movePathTarget.y !== target.y) {
    const path = findPath(world, { x: actor.x, y: actor.y }, target, 80);
    if (!path) return { kind: "step_failed", reason: "path_unreachable" };
    if (path.length === 0) return { kind: "step_done" };
    actor.movePath = path;
    actor.movePathTarget = target;
  }
  return { kind: "ongoing" };
}

// ── GATHER ────────────────────────────────────────────
function execGather(world: WorldState, actor: Actor, step: Extract<PlanStep, { kind: "GATHER" }>, _runtime: PlanStepRuntime, _plan: Plan): StepOutcome {
  const have = inventoryCountOfActor(actor, step.item);
  if (have >= step.count) return { kind: "step_done" };
  // 같은 칸에 prefix 있으면 즉시 PICKUP
  const same = Object.values(world.groundItems).find((g) => g.x === actor.x && g.y === actor.y && itemKeyOf(g.id) === step.item);
  if (same) {
    const r = dispatchAction(world, { actorId: actor.id, action: { type: "PICKUP", itemId: same.id } });
    if (r.ok) return { kind: "ongoing" }; // 다음 tick 에 다시 들어와 count 검사
    if (r.message === "inventory_full") return { kind: "step_failed", reason: "inventory_full" };
    return { kind: "step_failed", reason: r.message };
  }
  // 가까운 ground item 으로 이동 (GO_TO sub-state)
  const place = step.location?.placeId;
  const near = findNearestGroundItem(world, actor, step.item, place);
  if (!near) {
    if (step.allowWaitSpawn && step.maxTicks) return { kind: "ongoing" }; // spawn 기다림
    return { kind: "step_failed", reason: "resource_not_found" };
  }
  if (arrivedAt(actor, near.x, near.y)) {
    const r = dispatchAction(world, { actorId: actor.id, action: { type: "PICKUP", itemId: near.id } });
    if (r.ok) return { kind: "ongoing" };
    if (r.message === "inventory_full") return { kind: "step_failed", reason: "inventory_full" };
    return { kind: "step_failed", reason: r.message };
  }
  // path 깔기
  if (!actor.movePathTarget || actor.movePathTarget.x !== near.x || actor.movePathTarget.y !== near.y) {
    const path = findPath(world, { x: actor.x, y: actor.y }, near, 80);
    if (!path) return { kind: "step_failed", reason: "path_unreachable" };
    actor.movePath = path; actor.movePathTarget = near;
  }
  return { kind: "ongoing" };
}

function inventoryCountOfActor(actor: Actor, key: string): number {
  return inventoryCountOf(actor.inventory, key);
}

// ── CRAFT ────────────────────────────────────────────
function execCraft(world: WorldState, actor: Actor, step: Extract<PlanStep, { kind: "CRAFT" }>, runtime: PlanStepRuntime, _plan: Plan): StepOutcome {
  const recipe = RECIPES.find((r) => r.output.itemPrefix === step.output);
  if (!recipe) return { kind: "step_failed", reason: "unknown_recipe" };
  // 재료 점검
  for (const inp of recipe.inputs) {
    const have = inventoryCountOf(actor.inventory, inp.itemPrefix);
    if (have < inp.count) {
      return { kind: "step_failed", reason: `missing_material:${inp.itemPrefix}:${have}/${inp.count}` };
    }
  }
  // station 탐색
  let stationId: string | undefined = step.station?.objectId;
  if (!stationId) {
    const st = findNearestStation(world, actor, recipe.station);
    if (!st) return { kind: "step_failed", reason: `no_station:${recipe.station}` };
    stationId = st.id;
  }
  const st = world.structures?.[stationId];
  if (!st) return { kind: "step_failed", reason: "station_missing" };
  // station 위/인접 도달했으면 USE objectId+target craft
  if (isAtStation(world, actor, stationId)) {
    const r = dispatchAction(world, {
      actorId: actor.id,
      action: { type: "USE", objectId: stationId, targetItemId: step.output, count: step.count }
    });
    if (r.ok) {
      // 결과 cropId 같은 step context 저장 (PR4: bread craft 후 inventory 에 bread instance id 추적)
      runtime.context = { ...(runtime.context ?? {}), lastCraftedOutput: step.output };
      return { kind: "step_done" };
    }
    if (r.message.startsWith("craft_inputs_short")) return { kind: "step_failed", reason: r.message };
    return { kind: "step_failed", reason: r.message };
  }
  // 이동
  const cx = st.x + Math.floor(st.width / 2); const cy = st.y + Math.floor(st.height / 2);
  if (!actor.movePathTarget || actor.movePathTarget.x !== cx || actor.movePathTarget.y !== cy) {
    const path = findPath(world, { x: actor.x, y: actor.y }, { x: cx, y: cy }, 80);
    if (!path) return { kind: "step_failed", reason: "path_unreachable_to_station" };
    actor.movePath = path; actor.movePathTarget = { x: cx, y: cy };
  }
  return { kind: "ongoing" };
}

// ── USE ────────────────────────────────────────────
function execUse(world: WorldState, actor: Actor, step: Extract<PlanStep, { kind: "USE" }>, runtime: PlanStepRuntime, _plan: Plan): StepOutcome {
  if (step.item) {
    if (!hasInInventory(actor.inventory, itemKeyOf(step.item))) {
      return { kind: "step_failed", reason: "item_not_in_inventory" };
    }
    const r = dispatchAction(world, { actorId: actor.id, action: { type: "USE", itemId: step.item } });
    if (r.ok) {
      // seed 심기 시 cropId context 보존 (다음 WAIT_UNTIL 에서 사용)
      const m = r.message.match(/planted:(\w+) grow_in:(\d+)t/);
      // 우리 plantSeed 메시지는 "planted:wheat grow_in:100t" 형태라 cropId 가 없지만,
      // world.crops 의 마지막 entry 가 actor 가 심은 것이라 가정. 좀 더 정확한 추적을 위해
      // dispatchAction 결과에 cropId 를 넣어주는 게 이상적. PR3.5 추적.
      if (m) {
        const lastCrop = Object.entries(world.crops ?? {}).find(([_id, c]) => c.plantedBy === actor.id && c.plantedAtTick === world.tick);
        if (lastCrop) runtime.context = { ...(runtime.context ?? {}), lastPlantedCropId: lastCrop[0] };
      }
      return { kind: "step_done" };
    }
    return { kind: "step_failed", reason: r.message };
  }
  if (step.objectId) {
    if (!isAtStation(world, actor, step.objectId)) {
      // 가까이 가야 함
      const st = world.structures?.[step.objectId];
      if (!st) return { kind: "step_failed", reason: "object_not_found" };
      const cx = st.x + Math.floor(st.width / 2); const cy = st.y + Math.floor(st.height / 2);
      const path = findPath(world, { x: actor.x, y: actor.y }, { x: cx, y: cy }, 80);
      if (!path) return { kind: "step_failed", reason: "path_unreachable" };
      actor.movePath = path; actor.movePathTarget = { x: cx, y: cy };
      return { kind: "ongoing" };
    }
    const r = dispatchAction(world, {
      actorId: actor.id,
      action: { type: "USE", objectId: step.objectId, targetItemId: step.targetItemId }
    });
    if (r.ok) return { kind: "step_done" };
    return { kind: "step_failed", reason: r.message };
  }
  return { kind: "step_failed", reason: "use_target_missing" };
}

// ── WAIT_UNTIL ────────────────────────────────────────────
function execWaitUntil(world: WorldState, actor: Actor, step: Extract<PlanStep, { kind: "WAIT_UNTIL" }>, runtime: PlanStepRuntime, _plan: Plan): StepOutcome {
  const startedAt = runtime.startedAtTick ?? world.tick;
  // maxTicks 초과 → step_failed
  if (world.tick - startedAt >= step.maxTicks) {
    return { kind: "step_failed", reason: "wait_max_ticks_exceeded" };
  }
  const r = evaluateWaitCondition(step, actor, world, startedAt, runtime.context);
  if (r.satisfied) return { kind: "step_done" };
  // 자연스러운 stamina 회복용 dispatchAction WAIT (선택)
  dispatchAction(world, { actorId: actor.id, action: { type: "WAIT" } });
  return { kind: "ongoing" };
}

// ── TALK_TO ────────────────────────────────────────────
function execTalkTo(world: WorldState, actor: Actor, step: Extract<PlanStep, { kind: "TALK_TO" }>, _runtime: PlanStepRuntime, _plan: Plan): StepOutcome {
  if (!step.actorId) {
    // topic 만 있으면 가까운 humanoid 임의 선택 (assist/full 둘 다)
    return { kind: "step_failed", reason: "talk_actor_missing" };
  }
  const t = world.actors[step.actorId];
  if (!t || !t.alive) return { kind: "step_failed", reason: "talk_actor_not_found" };
  const dist = Math.abs(t.x - actor.x) + Math.abs(t.y - actor.y);
  if (dist > 1) {
    // 인접까지 이동
    const path = findPath(world, { x: actor.x, y: actor.y }, { x: t.x, y: t.y }, 80);
    if (!path) return { kind: "step_failed", reason: "path_unreachable_to_actor" };
    actor.movePath = path; actor.movePathTarget = { x: t.x, y: t.y };
    return { kind: "ongoing" };
  }
  if (!step.message) {
    // message 없으면 LLM 호출이 필요 — paused 처리
    return { kind: "plan_paused", reason: "talk_message_missing" };
  }
  const r = dispatchAction(world, { actorId: actor.id, action: { type: "SPEAK", message: step.message, intent: step.intent === "request" ? "help_request" : step.intent === "trade" ? "small_talk" : step.intent === "greet" ? "small_talk" : step.intent === "apologize" ? "apology" : step.intent === "inform" ? "small_talk" : "small_talk" } });
  if (r.ok) return { kind: "step_done" };
  return { kind: "step_failed", reason: r.message };
}

export function ensureRuntimes(plan: Plan): Plan {
  if (plan.stepRuntimes && plan.stepRuntimes.length === plan.steps.length) return plan;
  const runtimes: PlanStepRuntime[] = plan.steps.map((_, i) => plan.stepRuntimes?.[i] ?? { status: "pending" });
  return { ...plan, stepRuntimes: runtimes };
}

// helper: nearest station of type
export function findNearestStation(world: WorldState, actor: Actor, stationType: string): { id: string; x: number; y: number } | null {
  const cands = Object.values(world.structures ?? {}).filter((s) => s.type === stationType);
  let best: { id: string; x: number; y: number; d: number } | null = null;
  for (const s of cands) {
    const cx = s.x + Math.floor(s.width / 2);
    const cy = s.y + Math.floor(s.height / 2);
    const d = Math.abs(cx - actor.x) + Math.abs(cy - actor.y);
    if (!best || d < best.d) best = { id: s.id, x: cx, y: cy, d };
  }
  return best ? { id: best.id, x: best.x, y: best.y } : null;
}

// helper: nearest ground item of prefix
export function findNearestGroundItem(world: WorldState, actor: Actor, prefix: string, withinPlaceId?: string): { id: string; x: number; y: number } | null {
  const place = withinPlaceId ? world.places?.[withinPlaceId] : undefined;
  let best: { id: string; x: number; y: number; d: number } | null = null;
  for (const g of Object.values(world.groundItems)) {
    if (itemKeyOf(g.id) !== prefix) continue;
    if (place) {
      if (g.x < place.x || g.x >= place.x + place.width || g.y < place.y || g.y >= place.y + place.height) continue;
    }
    const d = Math.abs(g.x - actor.x) + Math.abs(g.y - actor.y);
    if (!best || d < best.d) best = { id: g.id, x: g.x, y: g.y, d };
  }
  return best ? { id: best.id, x: best.x, y: best.y } : null;
}

export function isSafeMode(mode: string | undefined): boolean {
  return mode === "assist" || mode === "full";
}

export function isFullMode(mode: string | undefined): boolean {
  return mode === "full";
}

// 공통 helper: actor 가 GO_TO target 좌표에 도달했는지
export function arrivedAt(actor: Actor, x: number, y: number): boolean {
  return actor.x === x && actor.y === y;
}

// adjacent within 1 chebyshev
export function isAdjacent(actor: Actor, x: number, y: number): boolean {
  return Math.max(Math.abs(actor.x - x), Math.abs(actor.y - y)) <= 1;
}

// 공통 helper: actor 가 station 위/인접인가 — station 은 width/height 가 1 이상이라 within rect or adjacent
export function isAtStation(world: WorldState, actor: Actor, structureId: string): boolean {
  const s = world.structures?.[structureId];
  if (!s) return false;
  const within = actor.x >= s.x && actor.x < s.x + s.width && actor.y >= s.y && actor.y < s.y + s.height;
  if (within) return true;
  const cx = s.x + Math.floor(s.width / 2); const cy = s.y + Math.floor(s.height / 2);
  return Math.max(Math.abs(actor.x - cx), Math.abs(actor.y - cy)) <= 1;
}

// invariants for tests
void STATION_TYPES; void hasInInventory; void findPath;
