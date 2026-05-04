import { createDefaultWorldContext, type ActionRequest, type Actor, type WorldState } from "@wiw/shared";
import {
  levelForXp,
  addToInventory,
  removeFromInventory,
  hasInInventory,
  inventoryCountOf,
  inventorySlotsUsed,
  findInstanceSlot,
  itemKeyOf,
  itemStackable
} from "@wiw/shared";
import { closeMatchingPendingTrade, createPendingTradeFromIntent, createPendingTradeFromSpeech, tradePairCooldownLeft } from "../economy/pendingTrade";
import { applyItemEffect } from "../effects/itemEffects";
import { RECIPES, checkInputs, checkSkillRequirements, type StationKind } from "../recipes/recipes";

type ActionResult = { ok: boolean; message: string };
const INVENTORY_LIMIT = 8;
/**
 * actor 별 MOVE cooldown (tick 단위).
 * 기본 5 tick (= 100ms × 5 = 500ms). DEX 와 running 스킬 레벨로 단축, monster 는 약간 더 짧게.
 * 최소 1 tick (즉시) 까지. 즉 매우 빠른 actor 는 거의 매 tick 이동 가능, 느린 actor 는 5+ tick 마다.
 */
const computeMoveCooldownTicks = (actor: Actor): number => {
  const dex = actor.status?.dexterity ?? 5;
  const running = actor.skills?.find((s) => s.id === "running")?.level ?? 0;
  const base = actor.kind === "monster" ? 4 : 6;
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

const inBounds = (world: WorldState, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < world.map.width && y < world.map.height;

const actorAt = (world: WorldState, x: number, y: number): string | undefined =>
  Object.values(world.actors).find((a) => a.alive && a.x === x && a.y === y)?.id;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const placeAtActor = (world: WorldState, actor: { x: number; y: number }) =>
  Object.values(world.places ?? {}).find((place) =>
    actor.x >= place.x &&
    actor.x < place.x + place.width &&
    actor.y >= place.y &&
    actor.y < place.y + place.height
  );

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
    world.groundItems[id] = {
      id,
      x: actor.x,
      y: actor.y,
      type: "food",
      iconKey: prefix === "carrot" ? "item.food.carrot" : "item.food.wheat"
    };
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
      case "BUY":
      case "SELL":
        return 2;
      case "SPEAK": {
        // PR6: 0→1. conversation lv↑ 시 비용 점진 감소.
        const lv = getSkillLevel(actor, "conversation");
        return Math.max(0, 1 - lv * 0.1);
      }
      case "OFFER_TRADE":
        return 1; // SPEAK 와 동등. 명시 거래는 약간의 노력.
      case "PRAY":
      case "THINK":
      case "OPTIONS":
      case "WAIT":
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

const attackDamage = (actor: Actor): number => {
  const base = actor.kind === "monster" ? 2 : 10;
  return base + statusOf(actor).strength + getSkillLevel(actor, "swordsmanship") * 0.5;
};

const spendStamina = (actor: Actor, cost: number): void => {
  actor.stamina = Math.max(0, actor.stamina - cost);
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
        text: `${actor.name} 사망 - ${reason}`,
        meta: { reason }
      };
      return fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8"));
    })
    .catch(() => undefined);
};

type DropEntry = { item: string; iconKey: string; type: string; chance: number; rare?: boolean };

const MONSTER_DROPS: Record<string, DropEntry[]> = {
  boar: [
    { item: "meat", iconKey: "item.food.meat", type: "food", chance: 0.85 },
    { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.55 },
    { item: "boar_tusk", iconKey: "item.material.tusk", type: "material", chance: 0.15, rare: true }
  ],
  wolf: [
    { item: "meat", iconKey: "item.food.meat", type: "food", chance: 0.7 },
    { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.55 },
    { item: "fang", iconKey: "item.material.fang", type: "material", chance: 0.45 },
    { item: "tracking_recipe", iconKey: "item.recipe", type: "recipe", chance: 0.05, rare: true }
  ],
  deer: [
    { item: "meat", iconKey: "item.food.meat", type: "food", chance: 0.85 },
    { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.6 },
    { item: "antler", iconKey: "item.material.bone", type: "material", chance: 0.25, rare: true }
  ],
  bear: [
    { item: "meat", iconKey: "item.food.meat", type: "food", chance: 0.9 },
    { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.7 },
    { item: "bear_claw", iconKey: "item.material.claw", type: "material", chance: 0.5 },
    { item: "blueprint_smithing", iconKey: "item.recipe", type: "recipe", chance: 0.08, rare: true }
  ],
  slime: [
    { item: "gel", iconKey: "item.material.gel", type: "material", chance: 0.85 },
    { item: "slime_core", iconKey: "item.material.gel", type: "material", chance: 0.25, rare: true }
  ],
  spirit: [
    { item: "essence", iconKey: "item.material.essence", type: "material", chance: 0.6 },
    { item: "altar_recipe", iconKey: "item.recipe", type: "recipe", chance: 0.1, rare: true }
  ]
};

const inferMonsterKind = (actor: Actor): string | null => {
  if (actor.kind !== "monster") return null;
  const ak = (actor.assetKey ?? "").toLowerCase();
  if (ak.includes("boar")) return "boar";
  if (ak.includes("wolf")) return "wolf";
  if (ak.includes("bear")) return "bear";
  if (ak.includes("deer")) return "deer";
  if (ak.includes("slime")) return "slime";
  if (ak.includes("spirit") || ak.includes("ghost")) return "spirit";
  return null;
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
        world.groundItems[slot.id] = { id: slot.id, x: actor.x, y: actor.y, type: slot.item || "item" };
      }
      // instance 떨궜으니 슬롯 제거 (kept 에 push 안 함)
    } else {
      // stack: 1개 떨어뜨리고 슬롯에서 차감
      const newId = nextItemId(world, slot.item);
      world.groundItems[newId] = { id: newId, x: actor.x, y: actor.y, type: slot.item || "item" };
      const remain = slot.count - 1;
      if (remain > 0) kept.push({ ...slot, count: remain });
    }
  }
  actor.inventory = kept;
  const corpseId = `corpse-${actor.id}`;
  world.groundItems[corpseId] = {
    id: corpseId,
    x: actor.x,
    y: actor.y,
    type: "corpse",
    iconKey: "decor.corpse",
    actorName: actor.name
  };

  const monsterKind = inferMonsterKind(actor);
  if (monsterKind && MONSTER_DROPS[monsterKind]) {
    const drops = MONSTER_DROPS[monsterKind];
    const offsets = [{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }];
    let i = 0;
    for (const drop of drops) {
      if (Math.random() >= drop.chance) continue;
      const off = offsets[i % offsets.length] ?? { dx: 0, dy: 0 };
      const id = `${drop.item}-${Math.random().toString(36).slice(2, 7)}`;
      if (!world.groundItems[id]) {
        world.groundItems[id] = {
          id,
          x: Math.max(0, Math.min(world.map.width - 1, actor.x + off.dx)),
          y: Math.max(0, Math.min(world.map.height - 1, actor.y + off.dy)),
          type: drop.type,
          iconKey: drop.iconKey
        };
      }
      i += 1;
    }
  }

  writeDeathHistory(world, actor, reason);
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
  return `${items || "비어 있음"}, ${actor.gold} gold`;
};

const optionsSummary = (world: WorldState, actorId: string): string => {
  const actor = world.actors[actorId];
  if (!actor) return "지금 가능: WAIT";
  const parts: string[] = [];
  const adjacent = Object.values(world.actors)
    .filter((other) => other.id !== actor.id && other.alive && distance(actor, other) <= 1);
  const nearbyHumanoids = adjacent.filter((a) => a.kind !== "monster").slice(0, 3);
  const adjacentMonsters = adjacent.filter((a) => a.kind === "monster").slice(0, 3);
  const isHungry = actor.hunger >= 70;

  for (const m of adjacentMonsters) parts.push(`ATTACK ${m.id}`);
  for (const other of nearbyHumanoids) parts.push(`SPEAK to ${other.id}`);

  // PR6: 권유성 hint 제거. 사실(상태)만 노출. catalog key 만 사용.
  const EDIBLE_KEYS = new Set(["carrot","berry","mushroom","fish","herb","corpse","bread","cooked_fish","meat"]);
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
    if (rod) parts.push(`USE itemId=fishing_rod (낚시)`);
    if (bucket) parts.push(`USE itemId=bucket (물긷기)`);
  }

  parts.push("THINK", "WAIT");
  return `지금 가능: ${parts.slice(0, 12).join(", ")}`;
};

export const dispatchAction = (world: WorldState, request: ActionRequest): ActionResult => {
  const actor = world.actors[request.actorId];
  if (!actor || !actor.alive) return { ok: false, message: "actor_not_found" };
  world.context ??= createDefaultWorldContext(world.tick);
  const cost = actionStaminaCost(actor, request.action);
  if (cost > 0 && actor.stamina <= 0) return { ok: false, message: "stamina_too_low" };
  if (actor.stamina < cost) return { ok: false, message: "stamina_too_low" };

  switch (request.action.type) {
    case "MOVE": {
      // 이동 cooldown — 스탯(DEX) + 스킬(running) 에 따라 actor 별 차등.
      // 빠른 NPC 는 자주 이동, 느린 NPC 는 덜. 너무 잦은 dispatch 시 fail.
      const cooldown = computeMoveCooldownTicks(actor);
      const last = actor.lastMoveTick ?? -Infinity;
      if (world.tick - last < cooldown) {
        return { ok: false, message: "move_cooldown" };
      }
      const nx = actor.x + request.action.dx;
      const ny = actor.y + request.action.dy;
      if (!inBounds(world, nx, ny)) return { ok: false, message: "out_of_bounds" };
      if (world.map.collision[ny][nx] === 1) return { ok: false, message: "blocked_tile" };
      if (actorAt(world, nx, ny)) return { ok: false, message: "blocked_actor" };
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
      const dist = Math.max(Math.abs(target.x - actor.x), Math.abs(target.y - actor.y));
      if (dist > 1) return { ok: false, message: "target_too_far" };
      spendStamina(actor, cost);
      target.hp -= attackDamage(actor);
      target.lastAttackedAtTick = world.tick;
      target.lastAttackerId = actor.id;
      if (target.hp <= 0) {
        target.hp = 0;
        killActor(world, target, `${actor.name}의 공격`);
      }
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      return { ok: true, message: "attacked" };
    }
    case "SPEAK": {
      resetThinkStreak(world, actor.id);
      spendStamina(actor, cost);
      const targetId = Object.values(world.actors)
        .filter((other) => other.id !== actor.id && other.alive)
        .sort((a, b) => distance(actor, a) - distance(actor, b))[0]?.id;
      // 거래는 OFFER_TRADE 로 분리됨. SPEAK 는 NLU keyword 만 (legacy 거래 표현).
      createPendingTradeFromSpeech(world, actor.id, targetId, request.action.message);
      return { ok: true, message: `say:${request.action.message}` };
    }
    case "OFFER_TRADE": {
      const target = world.actors[request.action.targetId];
      if (!target || !target.alive) return { ok: false, message: "target_not_found" };
      const dist = Math.abs(target.x - actor.x) + Math.abs(target.y - actor.y);
      if (dist > 2) return { ok: false, message: "target_too_far" };
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
    case "USE": {
      const useAction = request.action;
      // 1) skillId — 액티브 스킬 (PR5 에서 본격 구현; 현재는 pray 만 위임)
      if (useAction.skillId) {
        const skillResult = activateSkill(world, actor, useAction.skillId, {
          targetId: useAction.targetId,
          targetItemId: useAction.targetItemId,
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
        const station = stationAtObject(world, actor, useAction.objectId);
        if (!station) return { ok: false, message: "object_not_usable" };
        // objectId + targetItemId → 그 출력 결과로 craft
        if (useAction.targetItemId) {
          spendStamina(actor, cost);
          resetThinkStreak(world, actor.id);
          const result = tryCraftSpecific(world, actor, station, useAction.targetItemId);
          world.revision += 1;
          return result;
        }
        // objectId 만 → 사용 가능 레시피 목록 반환 (정보성, stamina 소모 X)
        return { ok: true, message: describeStationRecipes(actor, station) };
      }
      // 3) itemId — 인벤 아이템 사용 (count 만큼 반복; 1 기본, max 32)
      if (useAction.itemId) {
        const reqStr = useAction.itemId;
        const key = itemKeyOf(reqStr);
        const count = Math.min(32, Math.max(1, useAction.count ?? 1));
        const have = inventoryCountOf(actor.inventory, key);
        if (have <= 0) return { ok: false, message: "item_not_in_inventory" };
        const useCount = Math.min(count, have);
        // 3a) seed at field → planting
        if (key.endsWith("_seed")) {
          const place = placeAtActor(world, actor);
          if (!place || place.kind !== "field") return { ok: false, message: "seed_plant_at_field" };
          // count > 1 이면 인접 빈 칸 찾아서 여러 개 심기. 못 심으면 그만큼만.
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
    case "PICKUP": {
      // count > 1 이면 발 밑 같은 prefix 의 ground item 을 count 만큼 줍는다.
      const reqId = request.action.itemId;
      const reqKey = itemKeyOf(reqId);
      const reqCount = Math.min(32, Math.max(1, request.action.count ?? 1));
      // 발 밑 후보. 정확 id 우선, 없으면 같은 key.
      const exactItem = world.groundItems[reqId];
      const candidates = exactItem
        ? [exactItem]
        : Object.values(world.groundItems).filter((g) => g.x === actor.x && g.y === actor.y && itemKeyOf(g.id) === reqKey);
      if (candidates.length === 0) return { ok: false, message: "item_not_found" };
      // 발 밑 검사 (정확 id 가 아닌 경우 자동 매칭은 같은 칸만)
      const valid = candidates.filter((g) => g.x === actor.x && g.y === actor.y);
      if (valid.length === 0) return { ok: false, message: "item_too_far" };
      let picked = 0;
      // P1-7: foraging 보너스. forest_edge 위 berry/mushroom/wood/herb PICKUP 시 +0.03/lv 추가 1개.
      const place = placeAtActor(world, actor);
      const FORAGING_KEYS = new Set(["berry","mushroom","wood","herb"]);
      const foraging = getSkillLevel(actor, "foraging");
      for (const g of valid) {
        if (picked >= reqCount) break;
        const k = itemKeyOf(g.id);
        if (itemStackable(k)) {
          const r = addToInventory(actor.inventory, k, 1, INVENTORY_LIMIT);
          if (r.added === 0) break;
        } else {
          if (inventorySlotsUsed(actor.inventory) >= INVENTORY_LIMIT) break;
          addToInventory(actor.inventory, g.id, 1, INVENTORY_LIMIT);
        }
        delete world.groundItems[g.id];
        picked += 1;
        // foraging bonus
        if (place?.kind === "forest_edge" && FORAGING_KEYS.has(k) && Math.random() < foraging * 0.03) {
          const newId = nextItemId(world, k);
          if (itemStackable(k)) addToInventory(actor.inventory, k, 1, INVENTORY_LIMIT);
          else if (inventorySlotsUsed(actor.inventory) < INVENTORY_LIMIT) addToInventory(actor.inventory, newId, 1, INVENTORY_LIMIT);
          // foraging xp tick
          const sk = (actor.skills ?? []).find((s) => s.id === "foraging");
          if (sk) { sk.xp = (sk.xp ?? 0) + 1; const lv = levelForXp(sk.xp); if (lv > sk.level) sk.level = Math.min(10, lv); }
        }
      }
      if (picked === 0) return { ok: false, message: "inventory_full" };
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
      const x = request.action.x ?? actor.x;
      const y = request.action.y ?? actor.y;
      if (!inBounds(world, x, y)) return { ok: false, message: "out_of_bounds" };
      if (world.map.collision[y][x] === 1) return { ok: false, message: "blocked_tile" };
      let dropped = 0;
      for (let i = 0; i < Math.min(dropCount, have); i += 1) {
        const instanceSlot = findInstanceSlot(actor.inventory, reqId);
        const dropId = instanceSlot ? instanceSlot.id : nextItemId(world, dropKey);
        if (world.groundItems[dropId]) break;
        removeFromInventory(actor.inventory, instanceSlot ? dropId : dropKey, 1);
        world.groundItems[dropId] = { id: dropId, x, y, type: dropKey };
        dropped += 1;
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
      if (dist > 1) return { ok: false, message: "target_too_far" };
      if ("currency" in request.action) {
        if (request.action.currency !== "gold" || request.action.amount <= 0) return { ok: false, message: "invalid_currency" };
        if (actor.gold < request.action.amount) return { ok: false, message: "not_enough_gold" };
        spendStamina(actor, cost);
        actor.gold -= request.action.amount;
        target.gold += request.action.amount;
        const trade = closeMatchingPendingTrade(world, actor.id, target.id, {
          currency: "gold",
          amount: request.action.amount
        });
        resetThinkStreak(world, actor.id);
        world.revision += 1;
        return { ok: true, message: trade ? `gave:${request.action.amount}gold trade_closed` : `gave:${request.action.amount}gold` };
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
      const trade = closeMatchingPendingTrade(world, actor.id, target.id, { itemId: lastId });
      resetThinkStreak(world, actor.id);
      world.revision += 1;
      const gift = giveKey === "trinket" ? " trinket_gift" : "";
      return { ok: true, message: trade ? `gave:${giveKey}×${given}${gift} trade_closed` : `gave:${giveKey}×${given}${gift}` };
    }
    case "BUY":
    case "SELL":
      resetThinkStreak(world, actor.id);
      return { ok: false, message: "deprecated_use_speak_and_give" };
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
      actor.stamina = Math.min(actor.maxStamina, actor.stamina + getSkillLevel(actor, "meditation") * 0.05);
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

function tryCraft(world: WorldState, actor: Actor, station: StationKind): ActionResult {
  const skillLevels: Record<string, number> = {};
  for (const sk of actor.skills ?? []) skillLevels[sk.id] = sk.level;
  const candidates = RECIPES.filter((r) => r.station === station);
  // 가장 높은 skill 요구 + 입력 충족 recipe 우선 (자율적으로 좋은 선택)
  const viable = candidates
    .map((r) => ({
      recipe: r,
      skill: checkSkillRequirements(r, skillLevels),
      inputs: checkInputs(r, actor.inventory)
    }))
    .filter((x) => x.skill.ok && x.inputs.ok);
  if (viable.length === 0) {
    // 시도만 하고 실패: 작은 +1 xp 부여
    const anyMatch = candidates[0];
    if (anyMatch) {
      grantSkillXp(actor, anyMatch.xpReward.map((r) => ({ skillId: r.skillId, xp: 1 })));
    }
    return { ok: false, message: `craft_failed_no_match station:${station}` };
  }
  // 가장 좋은 recipe (최고 skill 요구) 선택
  viable.sort((a, b) => {
    const ax = (a.recipe.requiredSkillsAll ?? []).reduce((s, r) => s + r.minLevel, 0);
    const bx = (b.recipe.requiredSkillsAll ?? []).reduce((s, r) => s + r.minLevel, 0);
    return bx - ax;
  });
  const chosen = viable[0]?.recipe;
  if (!chosen) return { ok: false, message: "craft_no_choice" };

  // 실패 확률 (failLossRate)
  const failLoss = chosen.failLossRate ?? 0;
  if (failLoss > 0 && Math.random() < failLoss) {
    // 일부 재료만 소실 + 부분 xp
    consumeInputs(actor, chosen, true);
    grantSkillXp(actor, chosen.xpReward.map((r) => ({ skillId: r.skillId, xp: Math.max(1, Math.floor(r.xp / 3)) })));
    return { ok: true, message: `craft_failed_partial:${chosen.id} 재료 일부 소실` };
  }

  // 성공
  consumeInputs(actor, chosen, false);
  emitCraftOutput(world, actor, chosen);
  grantSkillXp(actor, chosen.xpReward);
  return { ok: true, message: `crafted:${chosen.id} → ${chosen.output.itemPrefix}` };
}

function consumeInputs(actor: Actor, recipe: typeof RECIPES[number], partial: boolean): void {
  for (const need of recipe.inputs) {
    const remove = partial ? Math.max(1, Math.floor(need.count / 2)) : need.count;
    removeFromInventory(actor.inventory, need.itemPrefix, remove);
  }
}

/** craft 출력 결과를 인벤(또는 ground)에 추가 */
function emitCraftOutput(world: WorldState, actor: Actor, recipe: typeof RECIPES[number]): void {
  const outKey = recipe.output.itemPrefix;
  if (itemStackable(outKey)) {
    const r = addToInventory(actor.inventory, outKey, 1, INVENTORY_LIMIT);
    if (r.added === 0) {
      const newId = nextItemId(world, outKey);
      world.groundItems[newId] = { id: newId, x: actor.x, y: actor.y, type: recipe.output.type, iconKey: recipe.output.iconKey };
    }
  } else {
    if (inventorySlotsUsed(actor.inventory) < INVENTORY_LIMIT) {
      const newId = nextItemId(world, outKey);
      addToInventory(actor.inventory, newId, 1, INVENTORY_LIMIT);
    } else {
      const newId = nextItemId(world, outKey);
      world.groundItems[newId] = { id: newId, x: actor.x, y: actor.y, type: recipe.output.type, iconKey: recipe.output.iconKey };
    }
  }
}

function grantSkillXp(actor: Actor, rewards: { skillId: string; xp: number }[]): void {
  for (const r of rewards) {
    const skill = (actor.skills ?? []).find((s) => s.id === r.skillId);
    if (!skill) continue;
    skill.xp = (skill.xp ?? 0) + r.xp;
    const newLevel = levelForXp(skill.xp);
    if (newLevel > skill.level) skill.level = Math.min(10, newLevel);
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
  const within = (s: { x: number; y: number; width: number; height: number }, x: number, y: number) =>
    x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height;
  // 인접 (체비셰프 거리 1) 안에 actor 가 있어야 함
  const inside = within(struct, actor.x, actor.y);
  const adjacent = !inside && Math.max(
    Math.abs(actor.x - (struct.x + Math.floor(struct.width / 2))),
    Math.abs(actor.y - (struct.y + Math.floor(struct.height / 2)))
  ) <= 1;
  if (!inside && !adjacent) return null;
  const station = STATION_BY_STRUCTURE_TYPE[struct.type];
  return station ?? null;
}

/** 사용 가능 레시피 정보 — LLM 이 보고 다음 USE objectId+targetItemId 결정. */
function describeStationRecipes(actor: Actor, station: StationKind): string {
  const skillLevels: Record<string, number> = {};
  for (const sk of actor.skills ?? []) skillLevels[sk.id] = sk.level;
  const candidates = RECIPES.filter((r) => r.station === station);
  if (candidates.length === 0) return `station:${station} 사용 가능 레시피 없음`;
  const lines: string[] = [];
  for (const r of candidates) {
    const skill = checkSkillRequirements(r, skillLevels);
    const inputs = checkInputs(r, actor.inventory);
    const need = inputs.needed.map((n) => `${n.itemPrefix} ${n.have}/${n.want}`).join(", ");
    const status = (skill.ok && inputs.ok) ? "가능" : skill.ok ? "재료부족" : "스킬부족";
    lines.push(`${r.output.itemPrefix} (${r.name}) — ${status} [${need}]`);
  }
  // 가능 → 재료부족 → 스킬부족 순 정렬
  lines.sort((a, b) => {
    const rank = (s: string): number => s.includes("가능") ? 0 : s.includes("재료부족") ? 1 : 2;
    return rank(a) - rank(b);
  });
  return `station:${station} | ${lines.join(" | ")}`;
}

/** targetItemId(출력 prefix) 매치되는 첫 레시피로 craft. */
function tryCraftSpecific(world: WorldState, actor: Actor, station: StationKind, targetItemPrefix: string): ActionResult {
  const skillLevels: Record<string, number> = {};
  for (const sk of actor.skills ?? []) skillLevels[sk.id] = sk.level;
  const recipe = RECIPES.find((r) => r.station === station && r.output.itemPrefix === targetItemPrefix);
  if (!recipe) return { ok: false, message: `craft_no_recipe:${station}/${targetItemPrefix}` };
  const skill = checkSkillRequirements(recipe, skillLevels);
  if (!skill.ok) return { ok: false, message: `craft_skill_short:${(skill.missing ?? []).join(",")}` };
  const inputs = checkInputs(recipe, actor.inventory);
  if (!inputs.ok) {
    const short = inputs.needed.filter((n) => n.have < n.want).map((n) => `${n.itemPrefix} ${n.have}/${n.want}`).join(",");
    return { ok: false, message: `craft_inputs_short:${short}` };
  }
  // 실패 확률
  const failLoss = recipe.failLossRate ?? 0;
  if (failLoss > 0 && Math.random() < failLoss) {
    consumeInputs(actor, recipe, true);
    grantSkillXp(actor, recipe.xpReward.map((r) => ({ skillId: r.skillId, xp: Math.max(1, Math.floor(r.xp / 3)) })));
    return { ok: true, message: `craft_failed_partial:${recipe.id} 재료 일부 소실` };
  }
  consumeInputs(actor, recipe, false);
  emitCraftOutput(world, actor, recipe);
  grantSkillXp(actor, recipe.xpReward);
  return { ok: true, message: `crafted:${recipe.id} → ${recipe.output.itemPrefix}` };
}

// ── PR4: 농사 crop ──────────────────────────────────────────────
const CROP_BY_SEED: Record<string, string> = {
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
    iconKey: itemPrefix === "wheat" ? "item.food.wheat" : "item.food.carrot"
  };
  // farming xp
  const skill = (actor.skills ?? []).find((s) => s.id === "farming");
  if (skill) {
    skill.xp = (skill.xp ?? 0) + 3;
    const newLevel = levelForXp(skill.xp);
    if (newLevel > skill.level) skill.level = Math.min(10, newLevel);
  }
  return { ok: true, message: `planted:${itemPrefix} grow_in:${growthTicks}t` };
}

/** tickWorld 매 tick 호출. mature 된 crop 을 ground item 으로 변환. */
export function maturateCrops(world: WorldState): void {
  if (!world.crops) return;
  const matured: string[] = [];
  for (const [id, crop] of Object.entries(world.crops)) {
    if (world.tick < crop.matureAtTick) continue;
    matured.push(id);
    for (let i = 0; i < crop.yieldCount; i += 1) {
      const itemId = `${crop.itemPrefix}-${Math.random().toString(36).slice(2, 7)}`;
      // 충돌 회피: 같은 id 중복 시 재생성
      if (world.groundItems[itemId]) continue;
      world.groundItems[itemId] = {
        id: itemId,
        x: crop.x,
        y: crop.y,
        type: "food",
        iconKey: crop.iconKey
      };
    }
  }
  for (const id of matured) {
    delete world.crops[id];
    world.revision += 1;
  }
}

// ── PR2: USE skillId 라우팅 (액티브 스킬) ────────────────────────
type SkillContext = { targetId?: string; targetItemId?: string; x?: number; y?: number };

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
    // appraise xp +1 (성공 시)
    const sk = (actor.skills ?? []).find((s) => s.id === "appraise");
    if (sk) {
      sk.xp = (sk.xp ?? 0) + 1;
      const newLevel = levelForXp(sk.xp);
      if (newLevel > sk.level) sk.level = Math.min(10, newLevel);
    }
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
  // 1) targetId — actor 정보
  if (ctx.targetId) {
    const t = world.actors[ctx.targetId];
    if (!t || !t.alive) return { ok: false, message: "appraise_target_not_found" };
    const dist = Math.abs(t.x - actor.x) + Math.abs(t.y - actor.y);
    if (dist > 4) return { ok: false, message: "appraise_too_far" };
    const parts: string[] = [`${t.name}(${t.kind})`];
    if (lv >= 1) {
      const hpBand = t.hp <= t.maxHp * 0.3 ? "위중" : t.hp <= t.maxHp * 0.7 ? "다침" : "건강";
      const staBand = t.stamina <= t.maxStamina * 0.3 ? "탈진" : t.stamina <= t.maxStamina * 0.6 ? "피로" : "여유";
      const hgBand = t.hunger >= 80 ? "굶주림" : t.hunger >= 50 ? "배고픔" : "포만";
      parts.push(`상태=${hpBand}/${staBand}/${hgBand}`);
    }
    if (lv >= 2) {
      parts.push(`HP ${Math.round(t.hp)}/${t.maxHp} Stamina ${Math.round(t.stamina)}/${t.maxStamina} Hunger ${t.hunger.toFixed(0)}`);
    }
    if (lv >= 3 && t.kind !== "monster") {
      const inv = (t.inventory ?? []).slice(0, 4).map((s) => s.kind === "stack" ? `${s.item}×${s.count}` : s.item).join(",");
      parts.push(`소지(상위) ${inv || "없음"}, gold ${t.gold}`);
    }
    if (lv >= 4) {
      const sk = (t.skills ?? []).filter((s) => s.level > 0).slice(0, 3).map((s) => `${s.id} ${s.level}`).join(",");
      parts.push(`강점 ${sk || "없음"}`);
    }
    if (lv >= 5) {
      // 경향 (확정 예언 금지). 단순히 stat·hunger 기반 묘사.
      const tendencies: string[] = [];
      if (t.hunger >= 70) tendencies.push("음식 갈망 가능성 높음");
      if (t.stamina <= t.maxStamina * 0.3) tendencies.push("휴식·후퇴 경향");
      if (t.kind === "monster") tendencies.push("적대 가능");
      parts.push(`경향: ${tendencies.join(", ") || "특이 사항 없음"}`);
    }
    return { ok: true, message: `appraise:actor:${ctx.targetId} | ${parts.join(" · ")}` };
  }
  // 2) targetItemId — 인벤 또는 발밑 ground item
  if (ctx.targetItemId) {
    const id = resolveInventoryItem(actor, ctx.targetItemId)
      ?? Object.values(world.groundItems).find((g) => g.id === ctx.targetItemId || g.id.split("-")[0] === ctx.targetItemId)?.id;
    if (!id) return { ok: false, message: "appraise_item_not_found" };
    const prefix = id.split("-")[0] ?? id;
    const parts: string[] = [`item:${prefix}`];
    if (lv >= 1) parts.push("category 정보 prompt 카탈로그 참고");
    if (lv >= 2) parts.push("station/recipe input 여부는 작업대 USE 로 확인 가능");
    return { ok: true, message: `appraise:item:${prefix} | ${parts.join(" · ")}` };
  }
  // 3) objectId — structure
  if (ctx.x !== undefined && ctx.y !== undefined) {
    const struct = Object.values(world.structures ?? {}).find((s) =>
      ctx.x! >= s.x && ctx.x! < s.x + s.width && ctx.y! >= s.y && ctx.y! < s.y + s.height
    );
    if (!struct) return { ok: false, message: "appraise_no_structure_at" };
    return { ok: true, message: `appraise:structure:${struct.id} type=${struct.type}` };
  }
  return { ok: false, message: "appraise_target_required" };
}
