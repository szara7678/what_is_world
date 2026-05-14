import { createDefaultWorldContext, type ActionRequest, type Actor, type GroundItem, type InventorySlot, type Structure, type WorldState } from "@wiw/shared";
import {
  levelForXp,
  addToInventory,
  removeFromInventory,
  hasInInventory,
  inventoryCountOf,
  inventorySlotsUsed,
  findInstanceSlot,
  itemKeyOf,
  itemMaxStack,
  itemStackable
} from "@wiw/shared";
import { acceptPendingTrade, createPendingTradeFromIntent, createPendingTradeFromSpeech, normalizePendingTrades, rejectPendingTrade, tradePairCooldownLeft } from "../economy/pendingTrade";
import { applyItemEffect } from "../effects/itemEffects";
import { findPath } from "../pathing/findPath";
import { nearestItemPlacement, placeGroundItemAt } from "../placement/groundItems";
import { MONSTER_CATALOG, behaviorForMonster, inferMonsterKind as inferMonsterKindFromAsset, inferMonsterTier, TIER_MULT } from "../content/monsters";
import { RECIPES, checkInputs, checkSkillRequirements, type StationKind } from "../recipes/recipes";
import { ITEM_CATALOG, itemDef, itemKor, DEFAULT_MAX_STACK, DEFAULT_STACKABLE, STATION_CATALOG } from "@wiw/shared";

type ActionResult = { ok: boolean; message: string };
const INVENTORY_LIMIT = 14;  // 2026-05-12: 10 → 14. armor/weapon/tool baseline leaves room for craft outputs.

const inventoryCanAccept = (actor: Actor, itemIdOrKey: string): boolean => {
  const key = itemKeyOf(itemIdOrKey);
  if (!itemStackable(key)) return inventorySlotsUsed(actor.inventory) < INVENTORY_LIMIT;
  for (const slot of actor.inventory) {
    if (slot.kind === "stack" && slot.item === key && slot.count < itemMaxStack(key)) return true;
  }
  return inventorySlotsUsed(actor.inventory) < INVENTORY_LIMIT;
};

const markInventoryFull = (world: WorldState, actor: Actor, actionText: string): ActionResult => {
  const reason = "inventory_full";
  actor.lastBlockedPlan = { tick: world.tick, text: `${actionText} failed: ${reason}`, reason };
  actor.recentBlockers = [...(actor.recentBlockers ?? []), { tick: world.tick, reason }].slice(-5);
  world.revision += 1;
  return { ok: false, message: reason };
};
/**
 * actor 별 MOVE cooldown (tick 단위).
 * 기본 5 tick (= 100ms × 5 = 500ms). DEX 와 running 스킬 레벨로 단축, monster 는 약간 더 짧게.
 * 최소 1 tick (즉시) 까지. 즉 매우 빠른 actor 는 거의 매 tick 이동 가능, 느린 actor 는 5+ tick 마다.
 */
const computeMoveCooldownTicks = (actor: Actor): number => {
  const dex = (actor.status?.dexterity ?? 5) + equipmentDexBonus(actor);
  const running = actor.skills?.find((s) => s.id === "running")?.level ?? 0;
  const behavior = actor.kind === "monster" ? behaviorForMonster(actor.assetKey) : null;
  const base = behavior === "tank" ? 8 : actor.kind === "monster" ? 4 : 6;
  // dex 5 = -1 tick, dex 10 = -2 tick (정수 단계)
  const dexBonus = Math.max(0, Math.floor((dex - 4) / 4));
  // running level 1 = -1 tick, level 5 = -2 tick (점진)
  const runBonus = Math.min(3, Math.floor(running / 3));
  // stamina 매우 낮으면 +1 tick (피로)
  const tired = actor.stamina < (actor.maxStamina * 0.2) ? 2 : 0;
  return Math.max(1, base - dexBonus - runBonus + tired);
};

/**
 * LLM 이 보낸 itemId / prefix 를 실제 매칭 가능한 catalog key 로 정규화.
 * 인벤에 해당 key 가 있으면 key 그 자체 반환. 없으면 null.
 * 자료구조 stack/instance 통합 후, "어떤 instance 에서 빼는지" 는 helper 가 처리.
 */
const resolveInventoryItem = (actor: Actor, requested: string): string | null => {
  const key = itemKeyOf(requested);
  if (hasInInventory(actor.inventory, key)) return key;
  return null;
};

/** instance id 로 직접 들어온 경우 그 instance 슬롯 찾기 (도구 등) */
const resolveInventoryInstance = (actor: Actor, requested: string): string | null => {
  const slot = findInstanceSlot(actor.inventory, requested);
  return slot ? slot.id : null;
};

const cellOf = (pos: { x: number; y: number }): { x: number; y: number } => ({
  x: Math.floor(pos.x),
  y: Math.floor(pos.y)
});

const inBounds = (world: WorldState, x: number, y: number): boolean => {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  return cx >= 0 && cy >= 0 && cx < world.map.width && cy < world.map.height;
};

const tileBlocked = (world: WorldState, x: number, y: number): boolean => {
  const { x: cx, y: cy } = cellOf({ x, y });
  return !inBounds(world, cx, cy) || world.map.collision[cy]?.[cx] === 1;
};

const setApproachPath = (world: WorldState, actor: Actor, target: { x: number; y: number }, limit = 120): boolean => {
  const path = findPath(world, { x: actor.x, y: actor.y }, target, limit);
  if (!path) return false;
  actor.movePath = path;
  actor.movePathTarget = target;
  return true;
};

const structureApproachPath = (
  world: WorldState,
  actor: Actor,
  struct: Structure
): { target: { x: number; y: number }; path: Array<{ dx: number; dy: number }> } | null => {
  let best: { target: { x: number; y: number }; path: Array<{ dx: number; dy: number }> } | null = null;
  const minX = Math.max(0, struct.x - 1);
  const minY = Math.max(0, struct.y - 1);
  const maxX = Math.min(world.map.width - 1, struct.x + struct.width);
  const maxY = Math.min(world.map.height - 1, struct.y + struct.height);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const inside = x >= struct.x && x < struct.x + struct.width && y >= struct.y && y < struct.y + struct.height;
      if (inside || tileBlocked(world, x, y)) continue;
      const path = findPath(world, { x: actor.x, y: actor.y }, { x, y }, 120);
      if (!path) continue;
      if (!best || path.length < best.path.length) best = { target: { x, y }, path };
    }
  }
  return best;
};

const continuesPendingUse = (action: ActionRequest["action"], pending: NonNullable<Actor["pendingUse"]>): boolean => {
  return action.type === "USE"
    && action.objectId === pending.objectId
    && action.itemId === pending.itemId
    && action.targetItemId === pending.targetItemId
    && action.skillId === pending.skillId;
};

const abortPendingUseForAction = (
  world: WorldState,
  actor: Actor,
  pending: NonNullable<Actor["pendingUse"]>,
  action: ActionRequest["action"]
): void => {
  actor.pendingUse = undefined;
  actor.movePath = undefined;
  actor.movePathTarget = undefined;
  pushWorldEvent(world, {
    actorId: actor.id,
    category: "action",
    type: "use:aborted",
    result: "info",
    reason: `interrupted_by:${action.type}`,
    payload: {
      action: {
        type: "USE",
        objectId: pending.objectId,
        itemId: pending.itemId,
        targetItemId: pending.targetItemId,
        skillId: pending.skillId
      },
      interruptedBy: action.type,
      queuedAtTick: pending.queuedAtTick
    }
  });
  world.revision += 1;
};

export const actorNearStructure = (actor: Pick<Actor, "x" | "y">, struct: Structure): boolean => {
  const cx = struct.x + Math.floor(struct.width / 2);
  const cy = struct.y + Math.floor(struct.height / 2);
  const inside = actor.x >= struct.x && actor.x < struct.x + struct.width && actor.y >= struct.y && actor.y < struct.y + struct.height;
  return inside || Math.max(Math.abs(actor.x - cx), Math.abs(actor.y - cy)) <= 1;
};

const sameCell = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
  const ac = cellOf(a);
  const bc = cellOf(b);
  return ac.x === bc.x && ac.y === bc.y;
};

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const euclideanDistance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const ATTACK_RANGE_EPSILON = 0.05;
const SLEEP_DEFAULT_MAX_TICKS = 30;
const SLEEP_HOSTILE_INTERRUPT_RADIUS = 6;
const SLEEP_STAMINA_PER_TICK = 2.0;
const SLEEP_HUNGER_PER_TICK = 0.05;

export const weaponRange = (actor: Actor): number => {
  const behavior = actor.kind === "monster" ? behaviorForMonster(actor.assetKey) : null;
  if (behavior === "ranged") {
    const kind = inferMonsterKindFromAsset(actor.assetKey);
    return kind === "naga" ? 5 : 4;
  }
  const hasSword = actor.inventory.some((slot) => slot.item.includes("sword"));
  const hasBow = actor.inventory.some((slot) => slot.item.includes("bow"));
  if (hasBow) return 4 + Math.min(2, getSkillLevel(actor, "archery") * 0.2);
  if (hasSword) return 1.5;
  return 1.0;
};

export const isTargetWithinWeaponRange = (actor: Actor, target: Actor): boolean =>
  euclideanDistance(actor, target) <= weaponRange(actor) + ATTACK_RANGE_EPSILON;

const placeAtActor = (world: WorldState, actor: { x: number; y: number }) =>
  Object.values(world.places ?? {}).find((place) =>
    actor.x >= place.x &&
    actor.x < place.x + place.width &&
    actor.y >= place.y &&
    actor.y < place.y + place.height
  );

/** 사용자 처방 C: SPEAK same-pair cooldown. 같은 (from,to) 짝 N tick 내 재발 차단. 핑퐁 폭주 방지. */
const speakPairCooldown = new Map<string, number>(); // `${from}:${to}` → unblockTick
export function speakPairCooldownLeft(from: string, to: string, nowTick: number): number {
  const k = `${from}:${to}`;
  const until = speakPairCooldown.get(k) ?? 0;
  return Math.max(0, until - nowTick);
}
export function setSpeakPairCooldown(from: string, to: string, nowTick: number, ticks: number): void {
  speakPairCooldown.set(`${from}:${to}`, nowTick + ticks);
}

/** P0-4: ATTACK default until — 사용자/gpt-5.5 결정. 0.35 ratio. */
function defaultAttackUntil(): import("@wiw/shared").AttackUntilCondition[] {
  return [
    { kind: "target_dead" },
    { kind: "self_hp_below", ratio: 0.35 },
    { kind: "self_stamina_below", value: 20 },
    { kind: "target_lost" },
    { kind: "max_ticks", value: 100 }
  ];
}

/** P0-4: until 평가 — 종료 조건 만족 시 { stop: true, reason }. */
function checkAttackUntil(
  actor: Actor,
  target: Actor | undefined,
  until: import("@wiw/shared").AttackUntilCondition[],
  startedAt: number,
  nowTick: number
): { stop: boolean; reason?: string } {
  if (!target || !target.alive) return { stop: true, reason: "target_lost" };
  for (const c of until) {
    if (c.kind === "target_dead" && target.hp <= 0) return { stop: true, reason: "target_dead" };
    if (c.kind === "target_lost" && (!target || !target.alive)) return { stop: true, reason: "target_lost" };
    if (c.kind === "self_hp_below" && actor.hp <= actor.maxHp * c.ratio) return { stop: true, reason: "self_hp_low" };
    if (c.kind === "self_stamina_below" && actor.stamina <= c.value) return { stop: true, reason: "self_stamina_low" };
    if (c.kind === "target_hp_below" && target.hp <= target.maxHp * c.ratio) return { stop: true, reason: "target_hp_low" };
    if (c.kind === "max_ticks" && nowTick - startedAt >= c.value) return { stop: true, reason: "max_ticks" };
  }
  return { stop: false };
}

/** P0-4: tickWorld 에서 호출. attack stash 있는 actor 한 명에 자동 공격 한 박자 진행. */
export function tickAutoAttack(world: WorldState, actor: Actor): { ok: boolean; reason?: string; killed?: boolean } | null {
  if (!actor.attackTargetId || !actor.attackUntil) return null;
  const target = world.actors[actor.attackTargetId];
  const startedAt = actor.attackStartedAtTick ?? world.tick;
  const stop = checkAttackUntil(actor, target, actor.attackUntil, startedAt, world.tick);
  if (stop.stop) {
    actor.attackTargetId = undefined; actor.attackUntil = undefined; actor.attackStartedAtTick = undefined;
    pushWorldEvent(world, {
      actorId: actor.id,
      category: "action",
      type: "attack:stop",
      result: "info",
      reason: stop.reason,
      payload: { action: { type: "ATTACK", targetId: target?.id }, reason: stop.reason }
    });
    return { ok: false, reason: stop.reason };
  }
  if (!target) return { ok: false, reason: "target_not_found" };
  if (!isTargetWithinWeaponRange(actor, target)) {
    if (!actor.movePath || !actor.movePathTarget || !sameCell(actor.movePathTarget, target)) {
      if (!setApproachPath(world, actor, { x: target.x, y: target.y }, 120)) {
        actor.attackTargetId = undefined; actor.attackUntil = undefined; actor.attackStartedAtTick = undefined;
        return { ok: false, reason: "path_unreachable" };
      }
    }
    return { ok: true, reason: "approaching" };
  }
  // ATTACK cost stamina 16. 부족하면 stop.
  const cost = 16;
  if (actor.stamina < cost) {
    actor.attackTargetId = undefined; actor.attackUntil = undefined; actor.attackStartedAtTick = undefined;
    return { ok: false, reason: "stamina_too_low" };
  }
  actor.stamina -= cost;
  // 2026-05-09 Phase B.1: attackDamage 통일 (인벤 weapon 보너스 포함).
  const dmg = attackDamage(actor, world);
  target.hp -= dmg;
  target.lastAttackedAtTick = world.tick;
  target.lastAttackerId = actor.id;
  let killed = false;
  if (target.hp <= 0) {
    target.hp = 0;
    killActor(world, target, `${actor.name}의 공격`);
    if (target.kind === "monster") grantSkillXp(actor, [{ skillId: "hunting", xp: 6 }]);
    actor.attackTargetId = undefined; actor.attackUntil = undefined; actor.attackStartedAtTick = undefined;
    killed = true;
  }
  pushWorldEvent(world, {
    actorId: actor.id,
    category: "action",
    type: killed ? "attack:done" : "attack:hit",
    result: "success",
    payload: { action: { type: "ATTACK", targetId: target.id }, damage: dmg, killed, targetHp: target.hp }
  });
  world.revision += 1;
  return { ok: true, killed };
}

const isHostileMonster = (actor: Actor): boolean => {
  if (actor.kind !== "monster") return false;
  const kind = inferMonsterKindFromAsset(actor.assetKey) ?? inferMonsterKindFromAsset(actor.name);
  if (kind && MONSTER_CATALOG[kind]?.hostile === true) return true;
  return false;
};

const nearbyHostile = (world: WorldState, actor: Actor, radius: number): Actor | undefined =>
  Object.values(world.actors).find((other) =>
    other.id !== actor.id &&
    other.alive &&
    isHostileMonster(other) &&
    distance(actor, other) <= radius
  );

export function interruptSleep(world: WorldState, actor: Actor, reason: string): boolean {
  if (!actor.sleeping) return false;
  actor.sleeping = undefined;
  pushWorldEvent(world, {
    actorId: actor.id,
    category: "action",
    type: "sleep:interrupt",
    result: "info",
    reason,
    payload: { reason }
  });
  world.revision += 1;
  return true;
}

/** SLEEP sticky executor. tickWorld calls this before movement/gather/attack. */
export function tickSleep(world: WorldState, actor: Actor): boolean {
  const sleep = actor.sleeping;
  if (!sleep) return false;
  const hostile = nearbyHostile(world, actor, SLEEP_HOSTILE_INTERRUPT_RADIUS);
  if (hostile) {
    interruptSleep(world, actor, "hostile_nearby");
    return false;
  }
  if ((actor.lastAttackedAtTick ?? -Infinity) >= sleep.lastTick) {
    interruptSleep(world, actor, "attacked");
    return false;
  }
  const elapsed = world.tick - sleep.startedAtTick;
  if (elapsed >= sleep.maxTicks || actor.stamina > 40 || actor.stamina >= actor.maxStamina) {
    actor.sleeping = undefined;
    pushWorldEvent(world, {
      actorId: actor.id,
      category: "action",
      type: "sleep:end",
      result: "success",
      payload: { elapsed, stamina: actor.stamina }
    });
    world.revision += 1;
    return false;
  }
  actor.stamina = Math.min(actor.maxStamina, actor.stamina + SLEEP_STAMINA_PER_TICK);
  actor.hunger = Math.min(actor.maxHunger ?? 100, actor.hunger + SLEEP_HUNGER_PER_TICK);
  actor.sleeping = { ...sleep, lastTick: world.tick };
  world.revision += 1;
  return true;
}

/** P0-2: MOVE.to 해석. placeId/xy/towardItem/towardActor → 좌표. */
function resolveMoveTo(world: WorldState, actor: Actor, to: NonNullable<Extract<ActionRequest["action"], { type: "MOVE" }>["to"]>): { x: number; y: number } | null {
  if (to.xy) return { x: to.xy.x, y: to.xy.y };
  if (to.placeId) {
    const p = world.places?.[to.placeId];
    if (!p) return null;
    return { x: p.x + Math.floor(p.width / 2), y: p.y + Math.floor(p.height / 2) };
  }
  if (to.towardItem) {
    const prefix = to.towardItem;
    let best: { x: number; y: number; d: number } | null = null;
    for (const g of Object.values(world.groundItems)) {
      if ((g.id.split("-")[0] ?? "") !== prefix) continue;
      const d = Math.abs(g.x - actor.x) + Math.abs(g.y - actor.y);
      if (!best || d < best.d) best = { x: g.x, y: g.y, d };
    }
    return best ? { x: best.x, y: best.y } : null;
  }
  if (to.towardActor) {
    const t = world.actors[to.towardActor];
    return t && t.alive ? { x: t.x, y: t.y } : null;
  }
  return null;
}

const statusOf = (actor: Actor) =>
  actor.status ?? { strength: 5, dexterity: 5, constitution: 5, intelligence: 5 };

const getSkillLevel = (actor: Actor, skillId: string): number =>
  actor.skills?.find((skill) => skill.id === skillId)?.level ?? 0;

/** ground item id 충돌 회피용. inventory 의 instance slot id 도 검사. */
const nextItemId = (world: WorldState, prefix: string): string => {
  let n = 1;
  const idTaken = (id: string): boolean => {
    if (world.groundItems[id]) return true;
    for (const actor of Object.values(world.actors)) {
      for (const slot of actor.inventory) {
        if (slot.kind === "instance" && slot.id === id) return true;
      }
    }
    return false;
  };
  while (idTaken(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
};

const spawnFieldYield = (world: WorldState, actor: Actor): string => {
  const place = placeAtActor(world, actor);
  const prefix = Math.random() < 0.65 ? "carrot" : "wheat";
  const ids = [nextItemId(world, prefix)];
  const bonusChance = getSkillLevel(actor, "gathering") * 0.03 + getSkillLevel(actor, "farming") * 0.05;
  if (Math.random() < bonusChance) ids.push(nextItemId({ ...world, groundItems: { ...world.groundItems, [ids[0]]: { id: ids[0], x: actor.x, y: actor.y, type: "food" } } }, prefix));
  for (const id of ids) {
    placeGroundItemAt(world, {
      id,
      x: actor.x,
      y: actor.y,
      type: "food",
      iconKey: prefix === "carrot" ? "item.food.carrot" : "item.food.wheat"
    });
  }
  world.context.resources.carrotStock = Math.min(99, world.context.resources.carrotStock + ids.filter((id) => id.startsWith("carrot")).length);
  return `${place?.kind ?? "field"} yielded:${ids.join(",")}`;
};

const actionStaminaCost = (actor: Actor, action: ActionRequest["action"]): number => {
  const status = statusOf(actor);
  const base = (() => {
    switch (action.type) {
      case "MOVE":
        return 2;
      case "ATTACK":
        return 16;
      case "USE":
        return 4;
      case "PICKUP":
      case "DROP":
      case "GIVE":
      case "GATHER":
        return 2;
      case "ACCEPT_TRADE":
      case "REJECT_TRADE":
        return 0.5;
      case "SPEAK": {
        // 사용자 처방 B: floor 0.5. SPEAK 무료화로 인한 폭주 차단.
        // conversation lv 효과는 stamina cost 보다 reaction 빠르기·affinity 보너스 등 다른 면에 둘 것.
        const lv = getSkillLevel(actor, "conversation");
        return Math.max(0.5, 1 - lv * 0.05);
      }
      case "OFFER_TRADE":
        return 1; // SPEAK 와 동등. 명시 거래는 약간의 노력.
      case "PRAY":
      case "THINK":
      case "OPTIONS":
      case "WAIT":
      case "SLEEP":
        return 0;
    }
  })();
  switch (action.type) {
    case "MOVE":
      return Math.max(0.5, base * (1 - status.dexterity / 40 - getSkillLevel(actor, "running") / 40));
    default:
      return Math.max(base > 0 ? 0.5 : 0, base);
  }
};

// 2026-05-09 Phase B.1: 인벤 weapon/tool 보너스. Phase 4 tier progression 포함.
const weaponBonus = (actor: Actor): number => {
  const inv = actor.inventory ?? [];
  if (inv.some((s) => s.item === "steel_sword")) return 15;
  if (inv.some((s) => s.item === "iron_sword")) return 8;
  if (inv.some((s) => s.item === "sword")) return 6;
  if (inv.some((s) => s.item === "master_axe")) return 6;
  if (inv.some((s) => s.item === "iron_axe")) return 5;
  if (inv.some((s) => s.item === "bone_dagger")) return 5;
  if (inv.some((s) => s.item === "wooden_axe" || s.item === "axe")) return 4;
  if (inv.some((s) => s.item === "iron_pickaxe")) return 3;
  if (inv.some((s) => s.item === "pickaxe")) return 2;
  return 0;
};
const equipmentDexBonus = (actor: Actor): number => {
  return (actor.inventory ?? []).some((s) => s.item === "leather_boots") ? 1 : 0;
};
// 2026-05-09: 인벤 leather_armor 면 max HP +15. Phase 4 armor progression 포함.
export const armorMaxHpBonus = (actor: Actor): number => {
  const inv = actor.inventory ?? [];
  let bonus = 0;
  if (inv.some((s) => s.item === "leather_helmet")) bonus += 5;
  if (inv.some((s) => s.item === "leather_armor")) {
    bonus += 15;
    if (getSkillLevel(actor, "tailoring") >= 3) bonus += 5;
  }
  if (inv.some((s) => s.item === "chainmail")) bonus += 25;
  return bonus;
};
const attackDamage = (actor: Actor, world: WorldState): number => {
  const base = actor.kind === "monster" ? 5 : 10;
  let damage = base + statusOf(actor).strength + getSkillLevel(actor, "swordsmanship") * 0.5 + weaponBonus(actor);
  if (actor.kind !== "monster") {
    damage += getSkillLevel(actor, "hunting") * 0.5;
    if (actor.inventory.some((slot) => slot.item.includes("bow"))) damage += getSkillLevel(actor, "archery") * 0.5;
  } else {
    const behavior = behaviorForMonster(actor.assetKey);
    const isNight = world.timeOfDay >= 20 || world.timeOfDay < 5;
    if (behavior === "hostile_night" && isNight) damage *= 1.25;
    if (behavior === "hostile_day" && !isNight) damage *= 1.15;
    if (behavior === "tank") damage *= 1.1;
  }
  return damage;
};

const spendStamina = (actor: Actor, cost: number): void => {
  actor.stamina = Math.max(0, actor.stamina - cost);
};

const pushWorldEvent = (
  world: WorldState,
  event: Omit<NonNullable<WorldState["eventQueue"]>[number], "tick">
): void => {
  world.eventQueue ??= [];
  world.eventQueue.push({ tick: world.tick, ...event });
};

const writeDeathHistory = (world: WorldState, actor: Actor, reason: string): void => {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  const cwd = proc?.cwd?.() ?? ".";
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  void Promise.all([dynamicImport("node:fs/promises"), dynamicImport("node:path")])
    .then(([fsModule, pathModule]) => {
      const fs = fsModule as { mkdir: (path: string, options: { recursive: boolean }) => Promise<void>; appendFile: (path: string, data: string, encoding: string) => Promise<void> };
      const path = pathModule as { dirname: (path: string) => string; resolve: (...parts: string[]) => string };
      const file = path.resolve(cwd, "data/history.ndjson");
      const entry = {
        tick: world.tick,
        ts: Date.now(),
        actorId: actor.id,
        kind: "actor.death",
        text: `${actor.name} died — ${reason}`,
        meta: { reason }
      };
      return fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8"));
    })
    .catch(() => undefined);
};

/** monsters.ts MONSTER_CATALOG 단일 출처. 본 파일에서는 lookup 만. */
const inferMonsterKind = (actor: Actor): string | null => {
  if (actor.kind !== "monster") return null;
  return inferMonsterKindFromAsset(actor.assetKey);
};

export const killActor = (world: WorldState, actor: Actor, reason: string): void => {
  if (!actor.alive) return;
  actor.alive = false;
  actor.hp = Math.max(0, actor.hp);
  // 50% 확률로 각 슬롯의 1개씩을 ground item 으로 떨굼. 나머지는 보존.
  const kept = [];
  for (const slot of actor.inventory) {
    if (Math.random() >= 0.5) {
      kept.push(slot);
      continue;
    }
    if (slot.kind === "instance") {
      if (!world.groundItems[slot.id]) {
        placeGroundItemAt(world, { id: slot.id, x: actor.x, y: actor.y, type: slot.item || "item", iconKey: iconKeyForItem(slot.item) });
      }
      // instance 떨궜으니 슬롯 제거 (kept 에 push 안 함)
    } else {
      // stack: 1개 떨어뜨리고 슬롯에서 차감
      const newId = nextItemId(world, slot.item);
      placeGroundItemAt(world, { id: newId, x: actor.x, y: actor.y, type: slot.item || "item", iconKey: iconKeyForItem(slot.item) });
      const remain = slot.count - 1;
      if (remain > 0) kept.push({ ...slot, count: remain });
    }
  }
  actor.inventory = kept;
  const corpseId = `corpse-${actor.id}`;
  placeGroundItemAt(world, {
    id: corpseId,
    x: actor.x,
    y: actor.y,
    type: "corpse",
    iconKey: "decor.corpse",
    actorName: actor.name
  });

  const monsterKind = inferMonsterKind(actor);
  const def = monsterKind ? MONSTER_CATALOG[monsterKind as keyof typeof MONSTER_CATALOG] : undefined;
  if (def) {
    // 2026-05-09: 티어별 보상 — alpha 골드 ×2 + extraDropChance 0.4, dire ×4 + 0.7.
    const tier = inferMonsterTier(actor.assetKey);
    const tierMult = TIER_MULT[tier];
    const offsets = [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }];
    let i = 0;
    for (const drop of def.drops) {
      if (Math.random() >= drop.chance) continue;
      const off = offsets[i % offsets.length] ?? { dx: 0, dy: 0 };
      const id = `${drop.item}-${Math.random().toString(36).slice(2, 7)}`;
      if (!world.groundItems[id]) {
        placeGroundItemAt(world, {
          id,
          x: Math.max(0, Math.min(world.map.width - 1, actor.x + off.dx)),
          y: Math.max(0, Math.min(world.map.height - 1, actor.y + off.dy)),
          type: drop.type,
          iconKey: drop.iconKey
        });
      }
      i += 1;
      // 2026-05-09: 티어 보너스 — 같은 drop 한 번 더 (alpha 0.4, dire 0.7 확률)
      if (tier > 1 && Math.random() < tierMult.extraDropChance) {
        const id2 = `${drop.item}-${Math.random().toString(36).slice(2, 7)}`;
        const off2 = offsets[i % offsets.length] ?? { dx: 0, dy: 0 };
        if (!world.groundItems[id2]) {
          placeGroundItemAt(world, {
            id: id2,
            x: Math.max(0, Math.min(world.map.width - 1, actor.x + off2.dx)),
            y: Math.max(0, Math.min(world.map.height - 1, actor.y + off2.dy)),
            type: drop.type,
            iconKey: drop.iconKey
          });
        }
        i += 1;
      }
    }
    // gold drop. 2026-05-09: tier 별 goldMult.
    const [lo, hi] = def.goldDrop;
    const baseAmount = lo + Math.floor(Math.random() * (hi - lo + 1));
    const amount = Math.round(baseAmount * tierMult.goldMult);
    const attacker = actor.lastAttackerId ? world.actors[actor.lastAttackerId] : undefined;
    if (attacker && attacker.alive && attacker.kind !== "monster") {
      attacker.gold = (attacker.gold ?? 0) + amount;
    } else {
      const gid = `gold-${Math.random().toString(36).slice(2, 7)}`;
      placeGroundItemAt(world, { id: gid, x: actor.x, y: actor.y, type: "gold", iconKey: "item.recipe", actorName: `${amount}gold` });
    }
  }

  writeDeathHistory(world, actor, reason);

  // 2026-05-09 v3: monster 사망 시 즉시 actor 제거 (corpse/drop 은 ground item 으로 남음).
  // NPC/player 는 alive=false 로 유지 (부활 가능 + soul/memory 보존).
  if (actor.kind === "monster") {
    delete world.actors[actor.id];
  }
};

const resetThinkStreak = (world: WorldState, actorId: string): void => {
  const actor = world.actors[actorId];
  if (actor) actor.consecutiveThinks = 0;
};

const inventorySummary = (actor: { inventory: import("@wiw/shared").InventorySlot[]; gold: number }): string => {
  const counts: Record<string, number> = {};
  for (const slot of actor.inventory) {
    const k = slot.item;
    counts[k] = (counts[k] ?? 0) + (slot.kind === "stack" ? slot.count : 1);
  }
  const items = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ");
  return `${items || "empty"}, ${actor.gold} gold`;
};

const optionsSummary = (world: WorldState, actorId: string): string => {
  const actor = world.actors[actorId];
  if (!actor) return "available now: WAIT";
  const parts: string[] = [];
  const adjacent = Object.values(world.actors)
    .filter((other) => other.id !== actor.id && other.alive && distance(actor, other) <= 1);
  const nearbyHumanoids = adjacent.filter((a) => a.kind !== "monster").slice(0, 3);
  const adjacentMonsters = adjacent.filter((a) => a.kind === "monster").slice(0, 3);
  const isHungry = actor.hunger >= 70;

  for (const m of adjacentMonsters) parts.push(`ATTACK ${m.id}`);
  for (const other of nearbyHumanoids) parts.push(`SPEAK to ${other.id}`);

  // PR6: 권유성 hint 제거. 사실(상태)만 노출. catalog key 만 사용.
  const EDIBLE_KEYS = new Set(["carrot","berry","mushroom","fish","herb","corpse","bread","cooked_fish","meat","apple","pineapple","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"]);
  const edibleKey = actor.inventory.find((s) => EDIBLE_KEYS.has(s.item))?.item;
  if (edibleKey && isHungry) parts.push(`USE itemId=${edibleKey}`);

  if (actor.inventory.length > 0) {
    const first = actor.inventory[0].item;
    if (!edibleKey || !isHungry) parts.push(`USE itemId=${first}`);
    parts.push(`DROP itemId=${first}`);
  }

  const onItem = Object.values(world.groundItems).find((item) => item.x === actor.x && item.y === actor.y);
  if (onItem) parts.push(`PICKUP itemId=${itemKeyOf(onItem.id)}`);

  const nearbyItem = Object.values(world.groundItems)
    .filter((item) => Math.abs(item.x - actor.x) + Math.abs(item.y - actor.y) <= 2 && (item.x !== actor.x || item.y !== actor.y))
    .slice(0, 2);
  for (const item of nearbyItem) {
    const dx = Math.sign(item.x - actor.x);
    const dy = Math.sign(item.y - actor.y);
    parts.push(`MOVE dx=${dx} dy=${dy} → ${itemKeyOf(item.id)}`);
  }

  const place = placeAtActor(world, actor);
  if (place?.kind === "shrine") parts.push("PRAY");
  if (place?.kind === "well" || place?.kind === "pond") {
    const rod = actor.inventory.find((s) => s.item === "fishing_rod");
    const bucket = actor.inventory.find((s) => s.item === "bucket");
    if (rod) parts.push(`USE itemId=fishing_rod (fishing)`);
    if (bucket) parts.push(`USE itemId=bucket (draw water)`);
  }

  parts.push("THINK", "WAIT");
  return `available now: ${parts.slice(0, 12).join(", ")}`;
};

const GATHER_DEFAULT_RADIUS = 12;

type DispatchGatherIntent = NonNullable<Actor["gatherIntent"]>;

const normalizeGatherArea = (area: DispatchGatherIntent["area"]): DispatchGatherIntent["area"] => {
  if (!area) return { radius: GATHER_DEFAULT_RADIUS };
  const radius = area.radius === undefined
    ? undefined
    : Math.max(1, Math.min(20, Math.floor(area.radius)));
  return {
    placeId: area.placeId,
    radius: radius !== undefined && radius <= 2 ? GATHER_DEFAULT_RADIUS : radius
  };
};

const gatherOrigin = (_world: WorldState, actor: Actor, _step: DispatchGatherIntent): { x: number; y: number } => ({ x: actor.x, y: actor.y });

const withinGatherScope = (
  world: WorldState,
  actor: Actor,
  step: DispatchGatherIntent,
  pos: { x: number; y: number }
): boolean => {
  if (step.area?.placeId) {
    const place = world.places?.[step.area.placeId];
    if (!place) return false;
    return pos.x >= place.x && pos.x < place.x + place.width && pos.y >= place.y && pos.y < place.y + place.height;
  }
  const origin = gatherOrigin(world, actor, step);
  const radius = step.area?.radius ?? GATHER_DEFAULT_RADIUS;
  return Math.abs(pos.x - origin.x) + Math.abs(pos.y - origin.y) <= radius;
};

const structureCenter = (struct: Structure): { x: number; y: number } => ({
  x: struct.x + Math.floor(struct.width / 2),
  y: struct.y + Math.floor(struct.height / 2)
});

const structureResource = (struct: Structure): "wood" | "ore" | "coal" | "fish" | "herb" | "berry" | null => {
  if (struct.type === "tree") return "wood";
  if (struct.type === "rock") return "ore";
  if (struct.type === "fishing_spot") return "fish";
  if (struct.type === "herb_bed") return "herb";
  if (struct.type === "berry_bush" || struct.type === "bush") return "berry";
  return null;
};

const requiredToolForStructure = (step: DispatchGatherIntent, struct: Structure): string | null => {
  if (struct.type === "tree" && step.item === "wood") return "axe";
  if (struct.type === "rock" && (step.item === "ore" || step.item === "coal")) return "pickaxe";
  if (struct.type === "fishing_spot" && step.item === "fish") return "fishing_rod";
  return null;
};

const hasGatherTool = (actor: Actor, tool: string | null): boolean => {
  if (!tool) return true;
  if (tool === "axe") return actor.inventory.some((slot) => slot.item === "axe" || slot.item === "wooden_axe" || slot.item === "iron_axe" || slot.item === "master_axe");
  if (tool === "pickaxe") return actor.inventory.some((slot) => slot.item === "pickaxe" || slot.item === "iron_pickaxe");
  return actor.inventory.some((slot) => slot.item === tool);
};

const gatherTargetCellsForStructure = (world: WorldState, struct: Structure): Array<{ x: number; y: number }> => {
  const out: Array<{ x: number; y: number }> = [];
  const minX = Math.max(0, struct.x - 1);
  const minY = Math.max(0, struct.y - 1);
  const maxX = Math.min(world.map.width - 1, struct.x + struct.width);
  const maxY = Math.min(world.map.height - 1, struct.y + struct.height);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const inside = x >= struct.x && x < struct.x + struct.width && y >= struct.y && y < struct.y + struct.height;
      if (inside || tileBlocked(world, x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
};

type DispatchGatherCandidate = {
  kind: "groundItem" | "structure";
  id: string;
  target: { x: number; y: number };
  path: Array<{ dx: number; dy: number }>;
  cost: number;
};

const nearestKnownGatherSource = (
  world: WorldState,
  step: DispatchGatherIntent
): { x: number; y: number } | null => {
  let best: { x: number; y: number; d: number } | null = null;
  const consider = (pos: { x: number; y: number }): void => {
    const d = Math.abs(pos.x) + Math.abs(pos.y);
    if (!best || d < best.d) best = { x: pos.x, y: pos.y, d };
  };
  for (const g of Object.values(world.groundItems ?? {}) as GroundItem[]) {
    if (itemKeyOf(g.id) === step.item) consider(g);
  }
  for (const struct of Object.values(world.structures ?? {})) {
    const resource = structureResource(struct);
    if (resource !== step.item && !(step.item === "coal" && struct.type === "rock")) continue;
    consider(structureCenter(struct));
  }
  if (best === null) return null;
  const nearest = best as { x: number; y: number; d: number };
  return { x: nearest.x, y: nearest.y };
};

const findDispatchGatherCandidate = (
  world: WorldState,
  actor: Actor,
  step: DispatchGatherIntent
): { candidate: DispatchGatherCandidate | null; sawSourceInScope: boolean; missingTool: string | null } => {
  let best: DispatchGatherCandidate | null = null;
  let sawSourceInScope = false;
  let missingTool: string | null = null;
  const consider = (candidate: DispatchGatherCandidate): void => {
    if (!best || candidate.cost < best.cost) best = candidate;
  };

  for (const g of Object.values(world.groundItems ?? {}) as GroundItem[]) {
    if (itemKeyOf(g.id) !== step.item) continue;
    if (!withinGatherScope(world, actor, step, g)) continue;
    sawSourceInScope = true;
    if (g.claimedBy && g.claimedBy !== actor.id) continue;
    const path = findPath(world, { x: actor.x, y: actor.y }, { x: g.x, y: g.y }, 120);
    if (!path) continue;
    consider({ kind: "groundItem", id: g.id, target: { x: g.x, y: g.y }, path, cost: path.length });
  }

  for (const struct of Object.values(world.structures ?? {})) {
    const resource = structureResource(struct);
    if (resource !== step.item && !(step.item === "coal" && struct.type === "rock")) continue;
    const center = structureCenter(struct);
    if (!withinGatherScope(world, actor, step, center)) continue;
    const felledUntil = (struct.props?.felledUntilTick as number | undefined) ?? 0;
    if (felledUntil > world.tick) continue;
    sawSourceInScope = true;
    if (struct.props?.gatherClaimBy && struct.props.gatherClaimBy !== actor.id) continue;
    const tool = requiredToolForStructure(step, struct);
    if (!hasGatherTool(actor, tool)) {
      missingTool ??= tool;
      continue;
    }
    for (const target of gatherTargetCellsForStructure(world, struct)) {
      const path = findPath(world, { x: actor.x, y: actor.y }, target, 120);
      if (!path) continue;
      consider({ kind: "structure", id: struct.id, target, path, cost: path.length });
    }
  }

  return { candidate: best, sawSourceInScope, missingTool };
};

const gatherFailureReason = (
  world: WorldState,
  actor: Actor,
  step: DispatchGatherIntent,
  head: string
): string => {
  const origin = gatherOrigin(world, actor, step);
  const nearest = nearestKnownGatherSource(world, step);
  const nearestPart = nearest ? ` nearest=(${nearest.x},${nearest.y})` : "";
  return `${head}:${step.item} radius=${step.area?.radius ?? GATHER_DEFAULT_RADIUS} near=(${Math.floor(origin.x)},${Math.floor(origin.y)})${nearestPart}`;
};

export const dispatchAction = (world: WorldState, request: ActionRequest): ActionResult => {
  const actor = world.actors[request.actorId];
  if (!actor || !actor.alive) return { ok: false, message: "actor_not_found" };
  world.context ??= createDefaultWorldContext(world.tick);
  if (actor.pendingUse && request.action.type !== "WAIT" && !continuesPendingUse(request.action, actor.pendingUse)) {
    abortPendingUseForAction(world, actor, actor.pendingUse, request.action);
  }
  if (actor.sleeping && request.action.type !== "SLEEP" && request.action.type !== "WAIT") {
    interruptSleep(world, actor, "manual_action");
  }
  const cost = actionStaminaCost(actor, request.action);
  if (cost > 0 && actor.stamina <= 0) return { ok: false, message: "stamina_too_low" };
  if (actor.stamina < cost) return { ok: false, message: "stamina_too_low" };

  switch (request.action.type) {
    case "SLEEP": {
      const hostile = nearbyHostile(world, actor, SLEEP_HOSTILE_INTERRUPT_RADIUS);
      if (hostile) return { ok: false, message: `sleep_blocked:hostile:${hostile.id}` };
      const maxTicks = Math.max(1, Math.min(200, Math.floor(request.action.maxTicks ?? SLEEP_DEFAULT_MAX_TICKS)));
      actor.sleeping = { startedAtTick: world.tick, maxTicks, lastTick: world.tick };
      actor.movePath = undefined;
      actor.movePathTarget = undefined;
      actor.pendingUse = undefined;
      actor.gatherIntent = undefined;
      actor.attackTargetId = undefined;
      actor.attackUntil = undefined;
      actor.attackStartedAtTick = undefined;
      resetThinkStreak(world, actor.id);
      pushWorldEvent(world, {
        actorId: actor.id,
        category: "action",
        type: "sleep:start",
        result: "success",
        payload: { maxTicks }
      });
      world.revision += 1;
      return { ok: true, message: `sleep_started:${maxTicks}` };
    }
    case "MOVE": {
      // P0-2: MOVE.to 명시 시 path 자동 깔기 (한 박자엔 1칸만 진행 — tickWorld 자동 진행이 나머지).
      // dx,dy 도 to 도 없으면 invalid.
      const move = request.action;
      if (move.to && (move.dx === undefined || move.dy === undefined)) {
        const target = resolveMoveTo(world, actor, move.to);
        if (!target) return { ok: false, message: "move_target_unresolved" };
        // AutoMovePolicy: place 이탈 검사 — 현재 place 와 target place 가 다르면 confirmOnPlaceExit 신호
        // (실제 차단은 LLM 재호출 trigger 가 처리. 여기서는 path 깔고 1칸 진행만.)
        const path = findPath(world, { x: actor.x, y: actor.y }, target, 80);
        if (!path) return { ok: false, message: "path_unreachable" };
        if (path.length === 0) return { ok: true, message: "already_at_target" };
        actor.movePath = path;
        actor.movePathTarget = target;
        // 첫 칸 즉시 진행 시도 (cooldown 통과 시)
        const cd = computeMoveCooldownTicks(actor);
        const last = actor.lastMoveTick ?? -Infinity;
        if (world.tick - last < cd) return { ok: true, message: `move_path_set:${path.length}` };
        const next = path[0];
        const nx = actor.x + next.dx; const ny = actor.y + next.dy;
        if (tileBlocked(world, nx, ny)) {
          return { ok: true, message: `move_path_set:${path.length}` };
        }
        spendStamina(actor, cost);
        actor.x = nx; actor.y = ny; actor.lastMoveTick = world.tick;
        actor.movePath = path.slice(1);
        if (!actor.movePath.length) actor.movePath = undefined;
        resetThinkStreak(world, actor.id);
        world.revision += 1;
        return { ok: true, message: "moved_to_path" };
      }
      // 이동 cooldown — 스탯(DEX) + 스킬(running) 에 따라 actor 별 차등.
      const cooldown = computeMoveCooldownTicks(actor);
      const last = actor.lastMoveTick ?? -Infinity;
      if (world.tick - last < cooldown) {
        return { ok: false, message: "move_cooldown" };
      }
      const nx = actor.x + (move.dx ?? 0);
      const ny = actor.y + (move.dy ?? 0);
      if (!inBounds(world, nx, ny)) return { ok: false, message: "out_of_bounds" };
      // 사용자 처방 E: 1칸 dx/dy 시도가 tile collision 으로 막혀도 fail 대신 path 자동 우회.
      // 단 cooldown 은 그대로 적용. 그 박자엔 movePath 만 set, 다음 tickWorld 자동 진행.
      if (tileBlocked(world, nx, ny)) {
        // path 자동 생성 — 한 칸 너머 같은 방향 좌표 (또는 그 자리) 까지.
        const tx = nx; const ty = ny;
        const path = findPath(world, { x: actor.x, y: actor.y }, { x: tx, y: ty }, 30);
        if (path && path.length > 0) {
          actor.movePath = path;
          actor.movePathTarget = { x: tx, y: ty };
          // 첫 칸 즉시 진행 (dx/dy 와 다를 수 있음 — 우회 방향)
          const next = path[0];
          const ax = actor.x + next.dx; const ay = actor.y + next.dy;
          if (!tileBlocked(world, ax, ay)) {
            spendStamina(actor, cost);
            actor.x = ax; actor.y = ay; actor.lastMoveTick = world.tick;
            actor.movePath = path.slice(1);
            if (!actor.movePath.length) actor.movePath = undefined;
            resetThinkStreak(world, actor.id);
            world.revision += 1;
            return { ok: true, message: "moved_detour" };
          }
          return { ok: true, message: `move_detour_set:${path.length}` };
        }
        return { ok: false, message: "blocked_tile" };
      }
      spendStamina(actor, cost);
      actor.x = nx;
      actor.y = ny;
      actor.lastMoveTick = world.tick;
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return { ok: true, message: "moved" };
    }
    case "ATTACK": {
      const target = world.actors[request.action.targetId];
      if (!target || !target.alive) return { ok: false, message: "target_not_found" };
      // P0-4: ATTACK 자동 종료 — until/maxTicks 검사. 한 dispatch 는 1회 공격이지만, 공격 의도를 actor 에 stash 해서
      // 다음 tickWorld 에서 자동 반복 공격 (target 인접 + cooldown 통과 + 종료조건 미달).
      const intent = (request.action as { until?: import("@wiw/shared").AttackUntilCondition[]; maxTicks?: number });
      const until = intent.until ?? defaultAttackUntil();
      const maxTicks = intent.maxTicks ?? 100;
      actor.attackTargetId = target.id;
      actor.attackUntil = until;
      actor.attackStartedAtTick = actor.attackStartedAtTick ?? world.tick;
      actor.attackMaxTicks = maxTicks;
      if (!isTargetWithinWeaponRange(actor, target)) {
        if (!setApproachPath(world, actor, { x: target.x, y: target.y }, 120)) {
          actor.attackTargetId = undefined; actor.attackUntil = undefined; actor.attackStartedAtTick = undefined;
          return { ok: false, message: "path_unreachable" };
        }
        world.revision += 1;
        return { ok: true, message: "attack_approach" };
      }
      // 현재 박자 종료조건 평가 — 공격 전 체크
      const stop = checkAttackUntil(actor, target, until, world.tick, world.tick);
      if (stop.stop) {
        // 종료 조건 이미 만족 (이전 공격으로 hp 떨어짐 등). 그냥 stash 만 클리어.
        actor.attackTargetId = undefined;
        actor.attackUntil = undefined;
        actor.attackStartedAtTick = undefined;
        return { ok: false, message: `attack_stop:${stop.reason}` };
      }
      spendStamina(actor, cost);
      target.hp -= attackDamage(actor, world);
      target.lastAttackedAtTick = world.tick;
      target.lastAttackerId = actor.id;
      if (target.hp <= 0) {
      target.hp = 0;
      killActor(world, target, `${actor.name}'s attack`);
      if (target.kind === "monster") grantSkillXp(actor, [{ skillId: "hunting", xp: 6 }]);
      actor.attackTargetId = undefined; actor.attackUntil = undefined; actor.attackStartedAtTick = undefined;
      } else {
        // 자동 반복 stash
        actor.attackTargetId = target.id;
        actor.attackUntil = until;
        actor.attackStartedAtTick = actor.attackStartedAtTick ?? world.tick;
        actor.attackMaxTicks = maxTicks;
      }
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return { ok: true, message: "attacked" };
    }
    case "SPEAK": {
      resetThinkStreak(world, actor.id);
      // 2026-05-08 P0: 명시 targetId 우선. 미설정 시에만 nearest auto-pick.
      const requested = request.action.targetId;
      let targetId: string | undefined;
      if (requested) {
        const t = world.actors[requested];
        if (!t || !t.alive) return { ok: false, message: "speak_target_not_found" };
        const dist = Math.abs(t.x - actor.x) + Math.abs(t.y - actor.y);
        if (dist > 6) {
          if (!setApproachPath(world, actor, { x: t.x, y: t.y }, 120)) return { ok: false, message: "path_unreachable" };
          world.revision += 1;
          return { ok: true, message: `speak_approach:dist=${dist}` };
        }
        targetId = requested;
      } else {
        targetId = Object.values(world.actors)
          .filter((other) => other.id !== actor.id && other.alive)
          .sort((a, b) => distance(actor, a) - distance(actor, b))[0]?.id;
      }
      // 사용자 처방 C: same-pair cooldown. 같은 (from, to) 짝 12tick 내 재발 차단 → 핑퐁 SPEAK 폭주 방지.
      if (targetId) {
        const left = speakPairCooldownLeft(actor.id, targetId, world.tick);
        if (left > 0) return { ok: false, message: `speak_pair_cooldown:${left}` };
        setSpeakPairCooldown(actor.id, targetId, world.tick, 12);
      }
      spendStamina(actor, cost);
      // 거래는 OFFER_TRADE 로 분리됨. SPEAK 는 NLU keyword 만 (legacy 거래 표현).
      createPendingTradeFromSpeech(world, actor.id, targetId, request.action.message);
      if (targetId) {
        const target = world.actors[targetId];
        if (target?.sleeping) interruptSleep(world, target, "speech_received");
      }
      return { ok: true, message: `say:${request.action.message}` };
    }
    case "OFFER_TRADE": {
      const target = world.actors[request.action.targetId];
      if (!target || !target.alive) return { ok: false, message: "target_not_found" };
      const dist = Math.abs(target.x - actor.x) + Math.abs(target.y - actor.y);
      if (dist > 2) {
        if (!setApproachPath(world, actor, { x: target.x, y: target.y }, 120)) return { ok: false, message: "path_unreachable" };
        world.revision += 1;
        return { ok: true, message: "trade_approach" };
      }
      if (target.kind === "monster") return { ok: false, message: "target_not_tradable" };
      const cdLeft = tradePairCooldownLeft(world, actor.id, target.id);
      if (cdLeft > 0) return { ok: false, message: `trade_cooldown:${cdLeft}` };
      const a = request.action;
      if (!a.wantItem && !a.offerGold && !a.offerItem) {
        return { ok: false, message: "trade_target_required" };
      }
      spendStamina(actor, cost);
      createPendingTradeFromIntent(world, actor.id, target.id, {
        wantItem: a.wantItem,
        wantCount: a.wantCount,
        offerItem: a.offerItem,
        offerCount: a.offerCount,
        offerGold: a.offerGold
      });
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return { ok: true, message: `trade_proposed:${a.wantItem ?? a.offerItem ?? "gold"}` };
    }
    case "ACCEPT_TRADE": {
      const action = request.action as Extract<ActionRequest["action"], { type: "ACCEPT_TRADE" }>;
      const trade = normalizePendingTrades(world).find((t) => t.id === action.tradeId);
      if (!trade || trade.status !== "pending") return { ok: false, message: "trade_not_found" };
      if (trade.to !== actor.id) return { ok: false, message: "trade_not_for_actor" };
      spendStamina(actor, cost);
      const result = acceptPendingTrade(world, actor.id, action.tradeId, INVENTORY_LIMIT);
      if (result.ok) resetThinkStreak(world, actor.id);
      return result;
    }
    case "REJECT_TRADE": {
      spendStamina(actor, cost);
      const result = rejectPendingTrade(world, actor.id, request.action.tradeId);
      if (result.ok) resetThinkStreak(world, actor.id);
      return result;
    }
    case "USE": {
      const useAction = request.action;
      // 1) skillId — 액티브 스킬 (PR5 에서 본격 구현; 현재는 pray 만 위임)
      if (useAction.skillId) {
        const skillResult = activateSkill(world, actor, useAction.skillId, {
          targetId: useAction.targetId,
          targetItemId: useAction.targetItemId,
          objectId: useAction.objectId,
          x: useAction.x,
          y: useAction.y
        });
        if (!skillResult.ok) return skillResult;
        spendStamina(actor, cost);
        resetThinkStreak(world, actor.id);
        world.revision += 1;
        return skillResult;
      }
      // 2) objectId — station 또는 field/pond/shrine 등 인접 오브젝트 직접 지정
      if (useAction.objectId) {
        // 2026-05-09: 벌목/채광 분기 — tree → axe 로 wood, rock → pickaxe 로 ore/coal.
        const struct = world.structures?.[useAction.objectId];
        if (struct) {
          if (!actorNearStructure(actor, struct)) {
            const route = structureApproachPath(world, actor, struct);
            if (!route) return { ok: false, message: "path_unreachable" };
            actor.movePath = route.path;
            actor.movePathTarget = route.target;
            if (useAction.targetItemId) {
              actor.pendingUse = {
                objectId: useAction.objectId,
                targetItemId: useAction.targetItemId,
                queuedAtTick: world.tick
              };
              pushWorldEvent(world, {
                actorId: actor.id,
                category: "action",
                type: "use:pending",
                result: "info",
                payload: {
                  action: {
                    type: "USE",
                    objectId: useAction.objectId,
                    targetItemId: useAction.targetItemId
                  },
                  target: route.target,
                  pathLength: route.path.length
                }
              });
              world.revision += 1;
              return { ok: true, message: `pending_use_approach:${struct.id}->${useAction.targetItemId}` };
            }
            world.revision += 1;
            return { ok: true, message: `use_approach:${struct.id}` };
          }
        }
        if (struct?.type === "tree" || struct?.type === "rock" || struct?.type === "fishing_spot" || struct?.type === "herb_bed" || struct?.type === "berry_bush" || struct?.type === "bush") {
          const harvestResult = tryHarvestStructure(world, actor, struct);
          if (harvestResult.ok) {
            spendStamina(actor, cost);
            resetThinkStreak(world, actor.id);
            world.revision += 1;
          }
          return harvestResult;
        }
        const station = stationAtObject(world, actor, useAction.objectId);
        if (!station) return { ok: false, message: classifyObjectUseFailure(world, actor, useAction.objectId) };
        // objectId + targetItemId → 그 출력 결과로 craft
        if (useAction.targetItemId) {
          actor.pendingUse = undefined;
          spendStamina(actor, cost);
          resetThinkStreak(world, actor.id);
          const result = tryCraftSpecific(world, actor, station, useAction.targetItemId);
          world.revision += 1;
          return result;
        }
        // objectId 만 → 사용 가능 레시피 목록 반환 (정보성, stamina 소모 X)
        return { ok: true, message: `inspected_station:${describeStationRecipes(actor, station)}` };
      }
      // 3) itemId — 인벤 아이템 사용 (count 만큼 반복; 1 기본, max 32)
      if (useAction.itemId) {
        const reqStr = useAction.itemId;
        const key = itemKeyOf(reqStr);
        const count = Math.min(32, Math.max(1, useAction.count ?? 1));
        const have = inventoryCountOf(actor.inventory, key);
        if (have <= 0) return { ok: false, message: "item_not_in_inventory" };
        const useCount = Math.min(count, have);
        // 3a) plantable item at field → planting. 2026-05-08: wheat_seed 통합 — wheat 자체도 직접 plant.
        if (CROP_BY_SEED[key]) {
          const place = placeAtActor(world, actor);
          if (!place || place.kind !== "field") return { ok: false, message: "seed_plant_at_field" };
          let planted = 0;
          for (let i = 0; i < useCount; i += 1) {
            const result = plantSeed(world, actor, key);
            if (!result.ok) break;
            removeFromInventory(actor.inventory, key, 1);
            planted += 1;
          }
          if (planted === 0) return { ok: false, message: "seed_no_space" };
          spendStamina(actor, cost);
          resetThinkStreak(world, actor.id);
          world.revision += 1;
          return { ok: true, message: `planted:${key}×${planted}` };
        }
        // 3b) 일반 아이템 효과 — count 만큼 반복
        let used = 0;
        let consumedTotal = 0;
        let lastEffect = "";
        for (let i = 0; i < useCount; i += 1) {
          const targetId = resolveInventoryInstance(actor, reqStr) ?? key;
          const effect = applyItemEffect(actor, targetId, world);
          if (!effect.ok) {
            if (used === 0) return { ok: false, message: effect.message };
            break;
          }
          if (effect.consumed) {
            removeFromInventory(actor.inventory, targetId, 1);
            consumedTotal += 1;
          }
          lastEffect = effect.message;
          used += 1;
        }
        spendStamina(actor, cost);
        resetThinkStreak(world, actor.id);
        world.revision += 1;
        return { ok: true, message: `used:${key}×${used} consumed=${consumedTotal} ${lastEffect}` };
      }
      return { ok: false, message: "use_target_required" };
    }
    case "GATHER": {
      // Sticky GATHER: LLM 은 의도 1개만 제출하고 tickWorld 가 count 까지 이동/줍기/채집을 진행한다.
      const g = request.action;
      const count = Math.max(1, Math.min(32, Math.floor(g.count ?? 1)));
      const have = inventoryCountOf(actor.inventory, g.item);
      if (have >= count) return { ok: true, message: `gather_done:${g.item}×${have}` };
      const area = normalizeGatherArea(g.area);
      const nextIntent: DispatchGatherIntent = {
        item: g.item,
        count,
        area,
        allowWaitSpawn: g.allowWaitSpawn,
        startedAtTick: world.tick,
        collected: 0
      };
      const { candidate, sawSourceInScope, missingTool } = findDispatchGatherCandidate(world, actor, nextIntent);
      if (!candidate && !(g.allowWaitSpawn && !missingTool && !sawSourceInScope)) {
        const reason = missingTool
          ? `inventory_short:${missingTool} 0/1`
          : sawSourceInScope
          ? "path_unreachable"
          : gatherFailureReason(world, actor, nextIntent, "no_item_in_radius");
        actor.lastBlockedPlan = { tick: world.tick, text: `GATHER ${g.item} count=${count} failed: ${reason}`, reason };
        actor.recentBlockers = [...(actor.recentBlockers ?? []), { tick: world.tick, reason }].slice(-5);
        world.revision += 1;
        return { ok: false, message: reason };
      }
      actor.gatherIntent = {
        ...nextIntent
      };
      actor.attackTargetId = undefined;
      actor.attackUntil = undefined;
      actor.attackStartedAtTick = undefined;
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return { ok: true, message: `gather_started:${g.item}×${count}` };
    }
    case "PICKUP": {
      // count > 1 이면 발 밑 같은 prefix 의 ground item 을 count 만큼 줍는다.
      const reqId = request.action.itemId;
      const reqKey = itemKeyOf(reqId);
      const reqCount = Math.min(32, Math.max(1, request.action.count ?? 1));
      // 발 밑 후보. 정확 id 우선, 없으면 같은 key.
      const exactItem = world.groundItems[reqId];
      const candidates = exactItem
        ? [exactItem]
        : Object.values(world.groundItems).filter((g) => sameCell(g, actor) && itemKeyOf(g.id) === reqKey);
      if (candidates.length === 0) {
        const nearest = Object.values(world.groundItems)
          .filter((g) => itemKeyOf(g.id) === reqKey)
          .map((g) => ({ g, d: Math.abs(g.x - actor.x) + Math.abs(g.y - actor.y) }))
          .sort((a, b) => a.d - b.d)[0]?.g;
        if (nearest && setApproachPath(world, actor, { x: nearest.x, y: nearest.y }, 120)) {
          world.revision += 1;
          return { ok: true, message: `pickup_approach:${reqKey}` };
        }
        return { ok: false, message: "item_not_found" };
      }
      // 발 밑 검사 (정확 id 가 아닌 경우 자동 매칭은 같은 칸만)
      const valid = candidates.filter((g) => sameCell(g, actor));
      if (valid.length === 0) {
        const target = candidates[0];
        if (setApproachPath(world, actor, { x: target.x, y: target.y }, 120)) {
          world.revision += 1;
          return { ok: true, message: `pickup_approach:${reqKey}` };
        }
        return { ok: false, message: "path_unreachable" };
      }
      let picked = 0;
      // P1-7: foraging 보너스. forest_edge 위 berry/mushroom/wood/herb PICKUP 시 +0.03/lv 추가 1개.
      // 2026-05-08: gathering 보너스. 모든 자원 PICKUP 시 +0.03/lv 추가 1개 (cumulative with foraging).
      const place = placeAtActor(world, actor);
      const FORAGING_KEYS = new Set(["berry","mushroom","wood","herb"]);
      const RESOURCE_KEYS = new Set(["berry","mushroom","wood","herb","ore","clay","coal","wheat","carrot","fish","apple","pineapple","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi","wheat_seed","carrot_seed"]);
      const foraging = getSkillLevel(actor, "foraging");
      const gathering = getSkillLevel(actor, "gathering");
      const grantBonusYield = (k: string): void => {
        const newId = nextItemId(world, k);
        if (itemStackable(k)) addToInventory(actor.inventory, k, 1, INVENTORY_LIMIT);
        else if (inventorySlotsUsed(actor.inventory) < INVENTORY_LIMIT) addToInventory(actor.inventory, newId, 1, INVENTORY_LIMIT);
      };
      // 2026-05-09: recipe scroll PICKUP → knownRecipes 자동 학습. tracking → bone_dagger, altar → healing_potion, blueprint_smithing → iron_sword.
      const RECIPE_SCROLL_MAP: Record<string, string> = {
        tracking_recipe: "bone_dagger",
        altar_recipe: "healing_potion",
        blueprint_smithing: "iron_sword"
      };
      for (const g of valid) {
        if (picked >= reqCount) break;
        const k = itemKeyOf(g.id);
        if (!inventoryCanAccept(actor, g.id)) break;
        if (itemStackable(k)) {
          const r = addToInventory(actor.inventory, k, 1, INVENTORY_LIMIT);
          if (r.added === 0) break;
        } else {
          const r = addToInventory(actor.inventory, g.id, 1, INVENTORY_LIMIT);
          if (r.added === 0) break;
        }
        delete world.groundItems[g.id];
        picked += 1;
        // recipe scroll 학습
        const learnId = RECIPE_SCROLL_MAP[k];
        if (learnId) {
          recordKnownRecipe(actor, learnId, world.tick);
        }
        // gathering bonus (general): 자원 종류 PICKUP 시 +3%/lv 확률 1개 추가 + xp tick.
        // 2026-05-08: 직접 xp 증가 → grantSkillXp 통일 (stat raise + max 재산정 일관 보장).
        if (RESOURCE_KEYS.has(k) && Math.random() < gathering * 0.03) {
          grantBonusYield(k);
          grantSkillXp(actor, [{ skillId: "gathering", xp: 1 }]);
        }
        // foraging bonus (forest_edge 한정)
        if (place?.kind === "forest_edge" && FORAGING_KEYS.has(k) && Math.random() < foraging * 0.03) {
          grantBonusYield(k);
          grantSkillXp(actor, [{ skillId: "foraging", xp: 1 }]);
        }
      }
      if (picked === 0) return markInventoryFull(world, actor, `PICKUP ${reqKey}`);
      spendStamina(actor, cost);
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return { ok: true, message: `picked:${reqKey}×${picked}` };
    }
    case "DROP": {
      const reqId = request.action.itemId;
      const dropKey = itemKeyOf(reqId);
      const dropCount = Math.min(32, Math.max(1, request.action.count ?? 1));
      const have = inventoryCountOf(actor.inventory, dropKey);
      if (have <= 0) return { ok: false, message: "item_not_in_inventory" };
      const dropCell = request.action.x !== undefined && request.action.y !== undefined
        ? cellOf({ x: request.action.x, y: request.action.y })
        : cellOf(actor);
      const x = dropCell.x;
      const y = dropCell.y;
      if (!inBounds(world, x, y)) return { ok: false, message: "out_of_bounds" };
      if (!nearestItemPlacement(world, x, y)) return { ok: false, message: "blocked_tile" };
      let dropped = 0;
      for (let i = 0; i < Math.min(dropCount, have); i += 1) {
        const instanceSlot = findInstanceSlot(actor.inventory, reqId);
        const dropId = instanceSlot ? instanceSlot.id : nextItemId(world, dropKey);
        if (world.groundItems[dropId]) break;
        removeFromInventory(actor.inventory, instanceSlot ? dropId : dropKey, 1);
        if (placeGroundItemAt(world, { id: dropId, x, y, type: dropKey, iconKey: iconKeyForItem(dropKey) })) {
          dropped += 1;
        }
      }
      if (dropped === 0) return { ok: false, message: "drop_failed" };
      spendStamina(actor, cost);
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return { ok: true, message: `dropped:${dropKey}×${dropped}` };
    }
    case "GIVE": {
      const target = world.actors[request.action.targetId];
      if (!target || !target.alive) return { ok: false, message: "target_not_found" };
      const dist = Math.abs(target.x - actor.x) + Math.abs(target.y - actor.y);
      if (dist > 1) {
        if (!setApproachPath(world, actor, { x: target.x, y: target.y }, 120)) return { ok: false, message: "path_unreachable" };
        world.revision += 1;
        return { ok: true, message: "give_approach" };
      }
      if ("currency" in request.action) {
        if (request.action.currency !== "gold" || request.action.amount <= 0) return { ok: false, message: "invalid_currency" };
        if (actor.gold < request.action.amount) return { ok: false, message: "not_enough_gold" };
        spendStamina(actor, cost);
        actor.gold -= request.action.amount;
        target.gold += request.action.amount;
        resetThinkStreak(world, actor.id);
        world.revision += 1;
        return { ok: true, message: `gave:${request.action.amount}gold` };
      }
      const giveReq = request.action.itemId;
      const giveKey = itemKeyOf(giveReq);
      const giveCount = Math.min(32, Math.max(1, request.action.count ?? 1));
      const giveHave = inventoryCountOf(actor.inventory, giveKey);
      if (giveHave <= 0) return { ok: false, message: "item_not_in_inventory" };
      let given = 0;
      let lastId: string = giveKey;
      for (let i = 0; i < Math.min(giveCount, giveHave); i += 1) {
        // target 슬롯 가용성 검사
        if (!itemStackable(giveKey) && inventorySlotsUsed(target.inventory) >= INVENTORY_LIMIT) {
          if (given === 0) return { ok: false, message: "target_inventory_full" };
          break;
        }
        const giveInstance = findInstanceSlot(actor.inventory, giveReq);
        const givenId = giveInstance ? giveInstance.id : giveKey;
        const r = addToInventory(target.inventory, givenId, 1, INVENTORY_LIMIT, giveInstance?.meta);
        if (r.added === 0) break;
        removeFromInventory(actor.inventory, giveInstance ? givenId : giveKey, 1);
        lastId = givenId;
        given += 1;
      }
      if (given === 0) return { ok: false, message: "give_failed" };
      spendStamina(actor, cost);
      void lastId;
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      const gift = giveKey === "trinket" ? " trinket_gift" : "";
      return { ok: true, message: `gave:${giveKey}×${given}${gift}` };
    }
    case "PRAY": {
      // 내부 위임: USE skillId=pray 와 동일 효과. backward compat.
      const r = activateSkill(world, actor, "pray", {});
      if (!r.ok) return r;
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return r;
    }
    case "THINK": {
      const query = request.action.query.trim();
      if (query.length <= 3) return { ok: false, message: "invalid_message" };
      if ((actor.consecutiveThinks ?? 0) >= 3) return { ok: false, message: "think_cap_reached" };
      actor.consecutiveThinks = (actor.consecutiveThinks ?? 0) + 1;
      world.revision += 1;
      return { ok: true, message: "think" };
    }
    case "OPTIONS": {
      if (world.tick - (actor.lastSkillTick ?? -Infinity) < 600) return { ok: false, message: "invalid_action" };
      actor.lastSkillTick = world.tick;
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return { ok: true, message: optionsSummary(world, actor.id) };
    }
    case "WAIT": {
      actor.stamina = Math.min(actor.maxStamina, actor.stamina + 0.4 + getSkillLevel(actor, "meditation") * 0.05);
      resetThinkStreak(world, actor.id);
      return { ok: true, message: "waited" };
    }
  }
  return { ok: false, message: "unknown_action" };
};

// ── Recipe / Crafting ───────────────────────────────────────────
const STATION_BY_STRUCTURE_TYPE: Record<string, StationKind> = {
  oven: "oven",
  bakery: "oven",
  alchemy_table: "alchemy_table",
  workbench: "workbench",
  forge: "forge"
};

function detectStation(world: WorldState, actor: { x: number; y: number }): StationKind | null {
  const within = (s: { x: number; y: number; width: number; height: number }) =>
    actor.x >= s.x && actor.x < s.x + s.width && actor.y >= s.y && actor.y < s.y + s.height;
  for (const struct of Object.values(world.structures ?? {})) {
    if (!within(struct)) continue;
    const station = STATION_BY_STRUCTURE_TYPE[struct.type];
    if (station) return station;
  }
  // station 은 오로지 structure 위에서만 인식. place fallback 없음.
  return null;
}

// 2026-05-08: legacy tryCraft 제거. USE 핸들러는 항상 targetItemId 명시하는 tryCraftSpecific 만 사용.
// 이전엔 caller 없는 dead path 였고 skill-based fail reduction 도 적용 안 됐음.

function consumeInputs(actor: Actor, recipe: typeof RECIPES[number], partial: boolean): void {
  for (const need of recipe.inputs) {
    const remove = partial ? Math.max(1, Math.floor(need.count / 2)) : need.count;
    removeFromInventory(actor.inventory, need.itemPrefix, remove);
  }
}

const cloneInventory = (inventory: InventorySlot[]): InventorySlot[] =>
  inventory.map((slot) => slot.kind === "stack"
    ? { ...slot }
    : { ...slot, meta: slot.meta ? { ...slot.meta } : undefined });

const canFitCraftOutput = (actor: Actor, recipe: typeof RECIPES[number]): boolean => {
  const probe = cloneInventory(actor.inventory);
  return addToInventory(probe, recipe.output.itemPrefix, 1, INVENTORY_LIMIT).added === 1;
};

/** craft 출력 결과를 반드시 인벤에 추가. cap 초과는 실패로 반환하고 ground silent drop 금지. */
function emitCraftOutput(world: WorldState, actor: Actor, recipe: typeof RECIPES[number]): ActionResult {
  const outKey = recipe.output.itemPrefix;
  const pushCraftOutputEvent = (): void => {
    pushWorldEvent(world, {
      actorId: actor.id,
      category: "action",
      type: "crafted_output_added",
      result: "success",
      payload: {
        action: { type: "USE", targetItemId: outKey },
        recipeId: recipe.id,
        output: outKey
      }
    });
  };
  if (itemStackable(outKey)) {
    const r = addToInventory(actor.inventory, outKey, 1, INVENTORY_LIMIT);
    if (r.added === 1) {
      pushCraftOutputEvent();
      return { ok: true, message: `crafted_output_added:${outKey}` };
    }
    return { ok: false, message: `craft_inventory_full:${outKey}` };
  }
  if (inventorySlotsUsed(actor.inventory) >= INVENTORY_LIMIT) {
    return { ok: false, message: `craft_inventory_full:${outKey}` };
  }
  const newId = nextItemId(world, outKey);
  const r = addToInventory(actor.inventory, newId, 1, INVENTORY_LIMIT);
  if (r.added === 1) {
    pushCraftOutputEvent();
    return { ok: true, message: `crafted_output_added:${outKey}` };
  }
  return { ok: false, message: `craft_inventory_full:${outKey}` };
}

function grantSkillXp(actor: Actor, rewards: { skillId: string; xp: number }[]): void {
  let leveledUp = false;
  for (const r of rewards) {
    const skill = (actor.skills ?? []).find((s) => s.id === r.skillId);
    if (!skill) continue;
    skill.xp = (skill.xp ?? 0) + r.xp;
    const newLevel = levelForXp(skill.xp);
    if (newLevel > skill.level) {
      const gain = Math.min(10, newLevel) - skill.level;
      skill.level = Math.min(10, newLevel);
      // 2026-05-08: skill level up → primaryStat raise (active +0.5/lv, passive +0.25/lv).
      const primary = skill.primaryStat;
      if (primary && actor.status && (primary in actor.status)) {
        const inc = (skill.type === "active" ? 0.5 : 0.25) * gain;
        const key = primary as keyof typeof actor.status;
        actor.status[key] = (actor.status[key] ?? 5) + inc;
        leveledUp = true;
      }
    }
  }
  // 2026-05-08: stat 변동 시 max 들 재산정 (recomputeMaxStats 동등 — circular import 회피 위해 인라인).
  if (leveledUp && actor.status) {
    const con = actor.status.constitution ?? 5;
    const int = actor.status.intelligence ?? 5;
    actor.maxHp = 80 + con * 4;
    actor.maxStamina = 50 + con * 5;
    actor.maxMp = (actor.kind === "monster" ? 0 : (10 + int * 2));
    actor.maxHunger = 80 + con * 4;
    if (actor.hp > actor.maxHp) actor.hp = actor.maxHp;
    if (actor.stamina > actor.maxStamina) actor.stamina = actor.maxStamina;
    if (actor.mp > actor.maxMp) actor.mp = actor.maxMp;
  }
}

// ── PR2: USE objectId 라우팅 ───────────────────────────────────
/**
 * actor 발 밑 또는 인접 (1칸) 의 structure 중 objectId 매칭하면 station 반환.
 * 자기 칸 우선, 그 다음 4 방향. station 이 아니면 null.
 */
function stationAtObject(world: WorldState, actor: Actor, objectId: string): StationKind | null {
  const struct = world.structures?.[objectId];
  if (!struct) return null;
  if (!actorNearStructure(actor, struct)) return null;
  const station = STATION_BY_STRUCTURE_TYPE[struct.type];
  return station ?? null;
}

/** USE objectId 실패 시 정확한 이유 분류 (not_adjacent vs not_a_station vs object_not_found). */
function classifyObjectUseFailure(world: WorldState, actor: Actor, objectId: string): string {
  const struct = world.structures?.[objectId];
  if (!struct) return `object_not_found:${objectId}`;
  if (!actorNearStructure(actor, struct)) {
    const cx = struct.x + Math.floor(struct.width / 2);
    const cy = struct.y + Math.floor(struct.height / 2);
    const dist = Math.max(Math.abs(actor.x - cx), Math.abs(actor.y - cy));
    return `craft_not_adjacent:${objectId} dist=${dist}`;
  }
  // adjacent 인데 station 아님
  return `not_a_station:${objectId} type=${struct.type}`;
}

/** 사용 가능 레시피 정보 — LLM 이 보고 다음 USE objectId+targetItemId 결정. */
function describeStationRecipes(actor: Actor, station: StationKind): string {
  const skillLevels: Record<string, number> = {};
  for (const sk of actor.skills ?? []) skillLevels[sk.id] = sk.level;
  const candidates = RECIPES.filter((r) => r.station === station);
  if (candidates.length === 0) return `station:${station} no recipes available`;
  const lines: string[] = [];
  for (const r of candidates) {
    const skill = checkSkillRequirements(r, skillLevels);
    const inputs = checkInputs(r, actor.inventory);
    const need = inputs.needed.map((n) => `${n.itemPrefix} ${n.have}/${n.want}`).join(", ");
    const status = (skill.ok && inputs.ok) ? "ready" : skill.ok ? "input_short" : "skill_short";
    lines.push(`${r.output.itemPrefix} (${r.name}) — ${status} [${need}]`);
  }
  // ready → input_short → skill_short 순 정렬
  lines.sort((a, b) => {
    const rank = (s: string): number => s.includes("ready") ? 0 : s.includes("input_short") ? 1 : 2;
    return rank(a) - rank(b);
  });
  return `station:${station} | ${lines.join(" | ")}`;
}

/** targetItemId(출력 prefix) 매치되는 첫 레시피로 craft. */
function tryCraftSpecific(world: WorldState, actor: Actor, station: StationKind, targetItemPrefix: string): ActionResult {
  const skillLevels: Record<string, number> = {};
  for (const sk of actor.skills ?? []) skillLevels[sk.id] = sk.level;
  const targetKey = itemKeyOf(targetItemPrefix);
  const recipe = RECIPES.find((r) => r.station === station && r.output.itemPrefix === targetKey);
  if (!recipe) {
    // wrong_station 감지: 같은 출력이 다른 station 레시피에 있으면 안내
    const elsewhere = RECIPES.find((r) => r.output.itemPrefix === targetKey);
    if (elsewhere) return { ok: false, message: `craft_wrong_station:${station}→${elsewhere.station} for=${targetKey}` };
    return { ok: false, message: `craft_no_recipe:${station}/${targetKey}` };
  }
  const skill = checkSkillRequirements(recipe, skillLevels);
  if (!skill.ok) return { ok: false, message: `craft_skill_short:${(skill.missing ?? []).join(",")}` };
  const inputs = checkInputs(recipe, actor.inventory);
  if (!inputs.ok) {
    const short = inputs.needed.filter((n) => n.have < n.want).map((n) => `${n.itemPrefix} ${n.have}/${n.want}`).join(",");
    return { ok: false, message: `craft_inputs_short:${short}` };
  }
  if (!canFitCraftOutput(actor, recipe)) {
    return { ok: false, message: `craft_inventory_full:${recipe.output.itemPrefix}` };
  }
  // 2026-05-08 P1: skill-based fail reduction.
  // base failLossRate (1.0) * max(0.05, 1 - primarySkillLevel * 0.1) → 실효 실패율.
  // primary skill = recipe 의 첫 requiredSkillsAll skill (없으면 requiredSkillsAny 첫 항목).
  const baseFail = recipe.failLossRate ?? 0;
  const primarySkillId = recipe.requiredSkillsAll?.[0]?.skillId ?? recipe.requiredSkillsAny?.[0]?.skillId;
  const primaryLv = primarySkillId ? (skillLevels[primarySkillId] ?? 0) : 0;
  const skillReduction = Math.max(0.05, 1 - primaryLv * 0.1);
  const effectiveFail = baseFail * skillReduction;
  if (effectiveFail > 0 && Math.random() < effectiveFail) {
    consumeInputs(actor, recipe, true);
    grantSkillXp(actor, recipe.xpReward.map((r) => ({ skillId: r.skillId, xp: Math.max(1, Math.floor(r.xp / 3)) })));
    // 2026-05-09: ok: false — events 분류 정확화. 이전엔 ok:true 라 forge success 로 카운트되어 인벤 미반영 버그처럼 보임.
    return { ok: false, message: `craft_failed_partial:${recipe.id} (effective_fail=${Math.round(effectiveFail*100)}%, ${primarySkillId} lv${primaryLv})` };
  }
  consumeInputs(actor, recipe, false);
  const output = emitCraftOutput(world, actor, recipe);
  if (!output.ok) return output;
  grantSkillXp(actor, recipe.xpReward);
  // 2026-05-08: knownRecipes 갱신 — 본인이 실제 성공한 recipe 만.
  recordKnownRecipe(actor, recipe.id, world.tick);
  return { ok: true, message: `crafted:${recipe.id} → ${recipe.output.itemPrefix}` };
}

function recordKnownRecipe(actor: Actor, recipeId: string, tick: number): void {
  if (!actor.knownRecipes) actor.knownRecipes = [];
  const existing = actor.knownRecipes.find((r) => r.recipeId === recipeId);
  if (existing) {
    existing.count += 1;
    existing.lastCraftedTick = tick;
  } else {
    actor.knownRecipes.push({ recipeId, count: 1, firstCraftedTick: tick, lastCraftedTick: tick });
  }
}

// ── PR4: 농사 crop ──────────────────────────────────────────────
// 2026-05-09: ITEM_CATALOG.category 기준 iconKey 자동 도출. drop/death/crop 경로에서 누락 fallback.
function iconKeyForItem(prefix: string): string {
  const def = itemDef(prefix);
  if (!def) return "item.recipe";
  return `item.${def.category}.${prefix}`;
}

// 2026-05-09 Phase B.1: 벌목/채광 — axe→tree, pickaxe→rock. 사용 후 일정 tick 동안 felled (props.felledUntilTick).
const TREE_FELL_REGEN_TICKS = 1500;     // ~25분 wallclock @ 1tick/s
const ROCK_MINE_REGEN_TICKS = 2400;     // ~40분 광물 더 귀함
const SMALL_GATHER_REGEN_TICKS = 900;   // herbs/berries/fishing spots recover faster than trees/ore.
const TREE_WOOD_DROP = [2, 4];          // [min, max] inclusive
const ROCK_ORE_DROP = [1, 3];
const ROCK_COAL_CHANCE = 0.4;           // 40% 확률로 coal 1 추가
function tryHarvestStructure(world: WorldState, actor: Actor, struct: Structure): ActionResult {
  // 인접 검사 (1 타일 이내)
  const cx = struct.x + Math.floor(struct.width / 2);
  const cy = struct.y + Math.floor(struct.height / 2);
  const dist = Math.max(Math.abs(actor.x - cx), Math.abs(actor.y - cy));
  if (dist > Math.max(struct.width, struct.height)) {
    return { ok: false, message: `harvest_too_far:${struct.id} dist=${dist}` };
  }
  const felledUntil = (struct.props?.felledUntilTick as number | undefined) ?? 0;
  if (felledUntil > world.tick) {
    const remain = felledUntil - world.tick;
    return { ok: false, message: `harvest_regrowing:${struct.id} ${remain}t` };
  }
  if (struct.type === "tree") {
    pushWorldEvent(world, {
      actorId: actor.id,
      category: "action",
      type: "chop_attempted",
      result: "info",
      payload: { structureId: struct.id }
    });
    const hasAxe = actor.inventory.some((s) => s.item === "axe" || s.item === "wooden_axe" || s.item === "iron_axe" || s.item === "master_axe");
    if (!hasAxe) {
      pushWorldEvent(world, {
        actorId: actor.id,
        category: "action",
        type: "chop_missing_tool",
        result: "failed",
        reason: "axe_required",
        payload: { structureId: struct.id }
      });
      return { ok: false, message: "axe_required" };
    }
    // 과일나무는 fruitTreeRegen 으로만 자라게 — 베면 fruit prop 잃지 X (regen 시 회복).
    const [lo, hi] = TREE_WOOD_DROP;
    const woodcutting = getSkillLevel(actor, "woodcutting");
    const toolBonus = actor.inventory.some((s) => s.item === "master_axe")
      ? 2
      : actor.inventory.some((s) => s.item === "iron_axe")
      ? 1
      : 0;
    const skillBonus = Math.random() < woodcutting * 0.05 ? 1 : 0;
    const baseCount = lo + Math.floor(Math.random() * (hi - lo + 1));
    const count = actor.inventory.some((s) => s.item === "master_axe") ? baseCount * 2 + skillBonus : baseCount + toolBonus + skillBonus;
    for (let i = 0; i < count; i += 1) {
      const id = `wood-cut-${world.tick}-${i}`;
      const dx = i % 2 === 0 ? 1 : -1; const dy = i < 2 ? 0 : 1;
      placeGroundItemAt(world, {
        id, x: Math.max(0, Math.min(world.map.width - 1, cx + dx)),
        y: Math.max(0, Math.min(world.map.height - 1, cy + dy)),
        type: "material", iconKey: "item.material.wood"
      });
    }
    struct.props = { ...(struct.props ?? {}), felledUntilTick: world.tick + TREE_FELL_REGEN_TICKS };
    grantSkillXp(actor, [{ skillId: "gathering", xp: 3 }, { skillId: "woodcutting", xp: 5 }]);
    pushWorldEvent(world, {
      actorId: actor.id,
      category: "action",
      type: "chop_success",
      result: "success",
      payload: { structureId: struct.id, wood: count }
    });
    return { ok: true, message: `chopped:tree ${count} wood` };
  }
  if (struct.type === "rock") {
    pushWorldEvent(world, {
      actorId: actor.id,
      category: "action",
      type: "mine_attempted",
      result: "info",
      payload: { structureId: struct.id }
    });
    const hasPickaxe = actor.inventory.some((s) => s.item === "pickaxe" || s.item === "iron_pickaxe");
    if (!hasPickaxe) {
      pushWorldEvent(world, {
        actorId: actor.id,
        category: "action",
        type: "mine_missing_tool",
        result: "failed",
        reason: "pickaxe_required",
        payload: { structureId: struct.id }
      });
      return { ok: false, message: "pickaxe_required" };
    }
    const [lo, hi] = ROCK_ORE_DROP;
    const mining = getSkillLevel(actor, "mining");
    const oreCount = lo + Math.floor(Math.random() * (hi - lo + 1))
      + (actor.inventory.some((s) => s.item === "iron_pickaxe") ? 1 : 0)
      + (Math.random() < mining * 0.05 ? 1 : 0);
    for (let i = 0; i < oreCount; i += 1) {
      const id = `ore-mine-${world.tick}-${i}`;
      const dx = i % 2 === 0 ? 1 : -1; const dy = i < 2 ? 0 : 1;
      placeGroundItemAt(world, {
        id, x: Math.max(0, Math.min(world.map.width - 1, cx + dx)),
        y: Math.max(0, Math.min(world.map.height - 1, cy + dy)),
        type: "material", iconKey: "item.material.ore"
      });
    }
    let coalCount = 0;
    if (Math.random() < ROCK_COAL_CHANCE) {
      const id = `coal-mine-${world.tick}-c`;
      const placed = placeGroundItemAt(world, {
        id, x: Math.max(0, Math.min(world.map.width - 1, cx)),
        y: Math.max(0, Math.min(world.map.height - 1, cy + 1)),
        type: "material", iconKey: "item.material.coal"
      });
      coalCount = placed ? 1 : 0;
    }
    struct.props = { ...(struct.props ?? {}), felledUntilTick: world.tick + ROCK_MINE_REGEN_TICKS };
    grantSkillXp(actor, [{ skillId: "gathering", xp: 3 }, { skillId: "mining", xp: 5 }]);
    pushWorldEvent(world, {
      actorId: actor.id,
      category: "action",
      type: "mine_success",
      result: "success",
      payload: { structureId: struct.id, ore: oreCount, coal: coalCount }
    });
    return { ok: true, message: `mined:rock ${oreCount} ore, ${coalCount} coal` };
  }
  if (struct.type === "fishing_spot" || struct.type === "herb_bed" || struct.type === "berry_bush" || struct.type === "bush") {
    const resource = struct.type === "fishing_spot" ? "fish" : struct.type === "herb_bed" ? "herb" : "berry";
    if (struct.type === "fishing_spot") {
      const hasRod = actor.inventory.some((s) => s.item === "fishing_rod");
      if (!hasRod) return { ok: false, message: "fishing_rod_required" };
    }
    const skillId = resource === "fish" ? "fishing" : "foraging";
    const skillLevel = getSkillLevel(actor, skillId);
    const count = 1 + (Math.random() < skillLevel * 0.05 ? 1 : 0);
    for (let i = 0; i < count; i += 1) {
      const id = `${resource}-gather-${struct.id}-${world.tick}-${i}`;
      const dx = i % 2 === 0 ? 1 : -1;
      const dy = i < 2 ? 0 : 1;
      placeGroundItemAt(world, {
        id,
        x: Math.max(0, Math.min(world.map.width - 1, cx + dx)),
        y: Math.max(0, Math.min(world.map.height - 1, cy + dy)),
        type: resource === "fish" ? "food" : "food",
        iconKey: iconKeyForItem(resource)
      });
    }
    struct.props = { ...(struct.props ?? {}), felledUntilTick: world.tick + SMALL_GATHER_REGEN_TICKS };
    grantSkillXp(actor, [{ skillId: "gathering", xp: 1 }, { skillId, xp: 3 }]);
    pushWorldEvent(world, {
      actorId: actor.id,
      category: "action",
      type: "gather_source_success",
      result: "success",
      payload: { structureId: struct.id, item: resource, count }
    });
    return { ok: true, message: `gathered_source:${resource}×${count}` };
  }
  return { ok: false, message: "harvest_unsupported" };
}

// 2026-05-08: wheat_seed 통합 — wheat 자체가 plantable. wheat_seed 는 legacy 호환 (기존 인벤/메모리).
const CROP_BY_SEED: Record<string, string> = {
  wheat: "wheat",
  wheat_seed: "wheat",
  carrot_seed: "carrot"
};

const CROP_BASE_GROWTH_TICKS = 100;

/** seed prefix 로부터 crop 생성. 한 칸에 이미 자라는 작물이 있으면 실패. */
function plantSeed(world: WorldState, actor: Actor, seedItemId: string): ActionResult {
  const seedPrefix = seedItemId.split("-")[0] ?? "";
  const itemPrefix = CROP_BY_SEED[seedPrefix];
  if (!itemPrefix) return { ok: false, message: `unknown_seed:${seedPrefix}` };
  world.crops ??= {};
  // 같은 칸에 이미 작물 있으면 실패
  const occupied = Object.values(world.crops).some((c) => c.x === actor.x && c.y === actor.y);
  if (occupied) return { ok: false, message: "tile_already_planted" };
  const farming = getSkillLevel(actor, "farming");
  const growthTicks = Math.max(20, Math.round(CROP_BASE_GROWTH_TICKS / (1 + farming * 0.08)));
  const yieldCount = 1 + Math.floor(Math.random() * 2) + Math.floor(farming / 4);
  const id = `crop-${itemPrefix}-${Math.random().toString(36).slice(2, 7)}`;
  world.crops[id] = {
    id,
    x: actor.x,
    y: actor.y,
    itemPrefix,
    seedPrefix,
    plantedBy: actor.id,
    plantedAtTick: world.tick,
    matureAtTick: world.tick + growthTicks,
    yieldCount,
    iconKey: iconKeyForItem(itemPrefix)
  };
  // farming xp — 2026-05-08: grantSkillXp 통일.
  grantSkillXp(actor, [{ skillId: "farming", xp: 3 }]);
  return { ok: true, message: `planted:${itemPrefix} grow_in:${growthTicks}t` };
}

/** tickWorld 매 tick 호출. mature 된 crop 을 ground item 으로 변환.
 * P0-B: 한 칸에 한 개체 — yieldCount 는 그대로 유지하되 spawn 위치를 같은 칸 + 인접 빈 칸으로 분산.
 * 인접 빈 칸이 부족하면 (나머지) 같은 칸 stack 처리 (시각상 1개로 보이지만 PICKUP 시 여러 개 줍기 가능).
 */
export function maturateCrops(world: WorldState): void {
  if (!world.crops) return;
  const matured: string[] = [];
  for (const [id, crop] of Object.entries(world.crops)) {
    if (world.tick < crop.matureAtTick) continue;
    matured.push(id);
    // 빈 칸 후보: crop 좌표 + 4방향. 단 collision/groundItem 비어 있어야.
    const candidates: Array<{ x: number; y: number }> = [
      { x: crop.x, y: crop.y },
      { x: crop.x + 1, y: crop.y }, { x: crop.x - 1, y: crop.y },
      { x: crop.x, y: crop.y + 1 }, { x: crop.x, y: crop.y - 1 }
    ];
    const empty: Array<{ x: number; y: number }> = [];
    for (const c of candidates) {
      if (c.x < 0 || c.y < 0 || c.x >= world.map.width || c.y >= world.map.height) continue;
      if (world.map.collision[c.y]?.[c.x] === 1) continue;
      const occupied = Object.values(world.groundItems).some((g) => g.x === c.x && g.y === c.y && (g.id.split("-")[0] ?? "") === crop.itemPrefix);
      if (!occupied) empty.push(c);
    }
    // 분산 spawn — yieldCount 만큼. 빈 칸 부족하면 같은 칸에 추가 (드물게).
    for (let i = 0; i < crop.yieldCount; i += 1) {
      const target = empty[i] ?? { x: crop.x, y: crop.y };
      const itemId = `${crop.itemPrefix}-${Math.random().toString(36).slice(2, 7)}`;
      if (world.groundItems[itemId]) continue;
      placeGroundItemAt(world, {
        id: itemId,
        x: target.x,
        y: target.y,
        type: "food",
        iconKey: crop.iconKey
      });
    }
  }
  for (const id of matured) {
    delete world.crops[id];
    world.revision += 1;
  }
}

// ── PR2: USE skillId 라우팅 (액티브 스킬) ────────────────────────
type SkillContext = { targetId?: string; targetItemId?: string; objectId?: string; x?: number; y?: number };

/**
 * 액티브 스킬 발동. PR2 시점에는 pray 만 라우팅 (PRAY 액션 호환). Appraise 등은 PR5.
 */
function activateSkill(world: WorldState, actor: Actor, skillId: string, ctx: SkillContext): ActionResult {
  if (skillId === "pray") {
    const place = placeAtActor(world, actor);
    if (!place || place.kind !== "shrine") return { ok: false, message: "not_at_shrine" };
    actor.mp = Math.min(actor.maxMp, actor.mp + 2);
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 5 + getSkillLevel(actor, "meditation") * 0.05);
    return { ok: true, message: "prayed" };
  }
  if (skillId === "appraise") {
    const result = appraiseTarget(world, actor, ctx);
    if (!result.ok) return result;
    // 2026-05-08: grantSkillXp 통일 (stat raise + max 재산정 보장).
    grantSkillXp(actor, [{ skillId: "appraise", xp: 1 }]);
    return result;
  }
  return { ok: false, message: `skill_not_implemented:${skillId}` };
}

/**
 * Appraise — 대상의 정보를 레벨 차등 공개. 결과 message 는 caller(loop) 에서 memory 로 저장.
 * lv0: 이름·종류
 * lv1: 기본 상태(HP/Stamina/Hunger 거시 카테고리)
 * lv2: 정확한 수치
 * lv3: 관계·인벤(있는 경우)
 * lv4+: 숨은 속성·약점 (확정 예언은 금지 — "경향" 까지만)
 */
function appraiseTarget(world: WorldState, actor: Actor, ctx: SkillContext): ActionResult {
  const lv = getSkillLevel(actor, "appraise");
  // 1) targetId — actor 정보 (per-actor 학습 저장은 안 함; 대상 상태가 자주 바뀜)
  if (ctx.targetId) {
    const t = world.actors[ctx.targetId];
    if (!t || !t.alive) return { ok: false, message: "appraise_target_not_found" };
    const dist = Math.abs(t.x - actor.x) + Math.abs(t.y - actor.y);
    if (dist > 4) return { ok: false, message: "appraise_too_far" };
    const parts: string[] = [`${t.name}(${t.kind})`];
    if (lv >= 1) {
      const hpBand = t.hp <= t.maxHp * 0.3 ? "critical" : t.hp <= t.maxHp * 0.7 ? "wounded" : "healthy";
      const staBand = t.stamina <= t.maxStamina * 0.3 ? "exhausted" : t.stamina <= t.maxStamina * 0.6 ? "tired" : "rested";
      const hgBand = t.hunger >= 80 ? "starving" : t.hunger >= 50 ? "hungry" : "full";
      parts.push(`state=${hpBand}/${staBand}/${hgBand}`);
    }
    if (lv >= 2) {
      parts.push(`HP ${Math.round(t.hp)}/${t.maxHp} Stamina ${Math.round(t.stamina)}/${t.maxStamina} Hunger ${t.hunger.toFixed(0)}`);
    }
    if (lv >= 3 && t.kind !== "monster") {
      const inv = (t.inventory ?? []).slice(0, 4).map((s) => s.kind === "stack" ? `${s.item}×${s.count}` : s.item).join(",");
      parts.push(`inventory(top) ${inv || "none"}, gold ${t.gold}`);
    }
    if (lv >= 4) {
      const sk = (t.skills ?? []).filter((s) => s.level > 0).slice(0, 3).map((s) => `${s.id} ${s.level}`).join(",");
      parts.push(`strengths ${sk || "none"}`);
    }
    if (lv >= 5) {
      // tendencies (no hard prediction). Stat/hunger based hints only.
      const tendencies: string[] = [];
      if (t.hunger >= 70) tendencies.push("likely seeking food");
      if (t.stamina <= t.maxStamina * 0.3) tendencies.push("likely to rest or retreat");
      if (t.kind === "monster") tendencies.push("possibly hostile");
      parts.push(`tendencies: ${tendencies.join(", ") || "nothing notable"}`);
    }
    return { ok: true, message: `appraise:actor:${ctx.targetId} | ${parts.join(" · ")}` };
  }
  // 2) targetItemId — 인벤 또는 발밑 ground item. 본인이 학습한 max lv 저장 + no_new_info 피드백.
  if (ctx.targetItemId) {
    const id = resolveInventoryItem(actor, ctx.targetItemId)
      ?? Object.values(world.groundItems).find((g) => g.id === ctx.targetItemId || g.id.split("-")[0] === ctx.targetItemId)?.id;
    if (!id) return { ok: false, message: "appraise_item_not_found" };
    const prefix = id.split("-")[0] ?? id;
    if (!actor.appraisedItems) actor.appraisedItems = {};
    const prev = actor.appraisedItems[prefix];
    if (prev !== undefined && prev >= lv) {
      return { ok: true, message: `appraise:item:${prefix} | no_new_info (already known at lv${prev}; raise appraise skill to learn more)` };
    }
    actor.appraisedItems[prefix] = lv;
    return { ok: true, message: `appraise:item:${prefix} | ${describeItemTiered(prefix, lv)}` };
  }
  // 3) objectId 또는 (x,y) — structure. station kind 기준으로 학습 lv 저장.
  let struct: Structure | undefined;
  if (ctx.objectId) {
    struct = world.structures?.[ctx.objectId];
    if (!struct) return { ok: false, message: "appraise_no_structure_at" };
    const dist = Math.abs(struct.x + Math.floor(struct.width/2) - actor.x) + Math.abs(struct.y + Math.floor(struct.height/2) - actor.y);
    if (dist > 4) return { ok: false, message: "appraise_too_far" };
  } else if (ctx.x !== undefined && ctx.y !== undefined) {
    struct = Object.values(world.structures ?? {}).find((s) =>
      ctx.x! >= s.x && ctx.x! < s.x + s.width && ctx.y! >= s.y && ctx.y! < s.y + s.height
    );
    if (!struct) return { ok: false, message: "appraise_no_structure_at" };
  }
  if (struct) {
    const stationKey = STATION_BY_STRUCTURE_TYPE[struct.type] ?? struct.type;
    if (!actor.appraisedStations) actor.appraisedStations = {};
    const prev = actor.appraisedStations[stationKey];
    if (prev !== undefined && prev >= lv) {
      return { ok: true, message: `appraise:structure:${struct.id} | no_new_info (already known at lv${prev}; raise appraise skill to learn more)` };
    }
    actor.appraisedStations[stationKey] = lv;
    return { ok: true, message: `appraise:structure:${struct.id} | ${describeStructureTiered(struct, lv)}` };
  }
  return { ok: false, message: "appraise_target_required" };
}

/**
 * Item appraise — tiered info, fully derived from ITEM_CATALOG + RECIPES (auto-updates on add/edit).
 *  lv0: name + category + stack rules
 *  lv1: + full description
 *  lv2: + ALL recipes that use this as input (every station × every output)
 *  lv3: + ALL recipes that produce this (every station, every input set)
 *  lv4: + skill requirements + xp rewards + fail rates for each recipe (input + output)
 */
export function describeItemTiered(prefix: string, lv: number): string {
  const def = itemDef(prefix);
  if (!def) return `unknown item, no catalog entry (lv ${lv})`;
  const parts: string[] = [];
  // lv0
  parts.push(`name=${def.korName}(${prefix})`);
  parts.push(`category=${def.category}`);
  const stackable = def.stackable ?? DEFAULT_STACKABLE[def.category];
  const maxStack = def.maxStack ?? DEFAULT_MAX_STACK[def.category];
  parts.push(`stack=${stackable ? `yes(max ${maxStack})` : "no(per-instance slot)"}`);
  // lv1
  if (lv >= 1 && def.desc) parts.push(`desc: ${def.desc}`);
  // Pre-compute relations
  const asInput = RECIPES.filter((r) => r.inputs.some((i) => i.itemPrefix === prefix));
  const asOutput = RECIPES.filter((r) => r.output.itemPrefix === prefix);
  // lv2: ALL recipes consuming this item
  if (lv >= 2) {
    if (asInput.length === 0) {
      parts.push(`as_input: none`);
    } else {
      const lines = asInput.map((r) => `${r.station} → ${r.output.itemPrefix} (uses ${r.inputs.find((i) => i.itemPrefix === prefix)!.count} ${prefix})`);
      parts.push(`as_input(${asInput.length}): ${lines.join(" | ")}`);
    }
  }
  // lv3: ALL recipes producing this item — full ingredients
  if (lv >= 3) {
    if (asOutput.length === 0) {
      parts.push(`as_output: none (cannot be crafted)`);
    } else {
      const lines = asOutput.map((r) => {
        const inputs = r.inputs.map((i) => `${i.itemPrefix}×${i.count}`).join("+");
        return `${r.station}: ${inputs} → ${r.output.itemPrefix}`;
      });
      parts.push(`as_output(${asOutput.length}): ${lines.join(" | ")}`);
    }
  }
  // lv4: skill reqs + fail rate + xp for EVERY related recipe
  if (lv >= 4) {
    const allRelated = [...asInput, ...asOutput.filter((r) => !asInput.includes(r))];
    for (const r of allRelated) {
      const skillsAll = (r.requiredSkillsAll ?? []).map((s) => `${s.skillId} lv${s.minLevel}+`).join(", ");
      const skillsAny = (r.requiredSkillsAny ?? []).map((s) => `${s.skillId} lv${s.minLevel}+`).join(" or ");
      const skillStr = skillsAll ? `all[${skillsAll}]` : skillsAny ? `any[${skillsAny}]` : "no req";
      const failPct = r.failLossRate ? ` fail ${Math.round(r.failLossRate * 100)}%` : "";
      const xp = r.xpReward.map((x) => `${x.skillId}+${x.xp}`).join(",");
      parts.push(`${r.station}/${r.output.itemPrefix} skill=${skillStr}${failPct} xp=${xp}`);
    }
  }
  return parts.join(" · ");
}

/**
 * Structure appraise — tiered info, fully derived from STATION_BY_STRUCTURE_TYPE + RECIPES.
 *  lv0: type + station kind
 *  lv1: + position, size, place id
 *  lv2: + ALL outputs producible at this station
 *  lv3: + each recipe's full ingredients + skill requirements
 *  lv4: + fail rate + xp reward per recipe
 */
export function describeStructureTiered(struct: { id: string; type: string; x: number; y: number; width: number; height: number; props?: Record<string, unknown> }, lv: number): string {
  const station = STATION_BY_STRUCTURE_TYPE[struct.type];
  const parts: string[] = [`type=${struct.type}`];
  if (station) parts.push(`station=${station}`); else parts.push(`station=none`);
  // station desc — STATION_CATALOG 가 단일 출처. recipes.ts 와 정합 유지.
  if (station) {
    const sdef = STATION_CATALOG[station];
    if (sdef?.desc) parts.push(`desc: ${sdef.desc}`);
  }
  if (lv >= 1) {
    parts.push(`pos=(${struct.x},${struct.y}) size=${struct.width}×${struct.height}`);
    const placeId = struct.props?.placeId;
    if (typeof placeId === "string") parts.push(`place=${placeId}`);
  }
  if (station) {
    const recipes = RECIPES.filter((r) => r.station === station);
    if (lv >= 2) {
      const outs = recipes.map((r) => `${r.output.itemPrefix}`).join(", ");
      parts.push(`outputs(${recipes.length}): ${outs || "none"}`);
    }
    if (lv >= 3) {
      for (const r of recipes) {
        const inputs = r.inputs.map((i) => `${i.itemPrefix}×${i.count}`).join("+");
        const skillsAll = (r.requiredSkillsAll ?? []).map((s) => `${s.skillId} lv${s.minLevel}+`).join(",");
        const skillsAny = (r.requiredSkillsAny ?? []).map((s) => `${s.skillId} lv${s.minLevel}+`).join(" or ");
        const skillStr = skillsAll ? `all[${skillsAll}]` : skillsAny ? `any[${skillsAny}]` : "no req";
        parts.push(`${r.output.itemPrefix}: ${inputs} skill=${skillStr}`);
      }
    }
    if (lv >= 4) {
      for (const r of recipes) {
        const failPct = r.failLossRate ? ` fail ${Math.round(r.failLossRate * 100)}%` : "";
        const xp = r.xpReward.map((x) => `${x.skillId}+${x.xp}`).join(",");
        parts.push(`${r.output.itemPrefix} extras:${failPct} xp=${xp}`);
      }
    }
  } else if (lv >= 2) {
    parts.push("not a craft station (no recipes)");
  }
  return parts.join(" · ");
}

// Force ITEM_CATALOG reference to retain bundle entry (avoid tree-shake of catalog import).
void ITEM_CATALOG;
void itemKor;
