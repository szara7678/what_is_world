import type { Actor, Observation, Place, Soul, SoulRole, Thought, WorldState } from "@wiw/shared";
import { findPath } from "@wiw/world-core";
import { recordHistory } from "../logging/historyLogStore";
import type { BrainDecision } from "./prompt";

type DayPhase = "night" | "morning" | "day" | "evening";

const farmerWorkCounters = new Map<string, number>();
const guardPatrolIndexes = new Map<string, number>();

type XY = { x: number; y: number };

const pickFreeDir = (world: WorldState, me: Actor): { dx: number; dy: number } | null => {
  const dirs = [
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 0, dy: -1 }
  ].sort(() => Math.random() - 0.5);
  for (const d of dirs) {
    const nx = me.x + d.dx;
    const ny = me.y + d.dy;
    if (nx < 0 || ny < 0 || nx >= world.map.width || ny >= world.map.height) continue;
    if (world.map.collision[ny]?.[nx] === 1) continue;
    const blocked = Object.values(world.actors).some((a) => a.alive && a.x === nx && a.y === ny);
    if (blocked) continue;
    return d;
  }
  return null;
};

function phaseOf(hour: number): DayPhase {
  if (hour < 6 || hour >= 22) return "night";
  if (hour < 11) return "morning";
  if (hour < 18) return "day";
  return "evening";
}

function distanceToPlace(actor: Actor, place: Place): number {
  const dx = actor.x < place.x ? place.x - actor.x : actor.x >= place.x + place.width ? actor.x - (place.x + place.width - 1) : 0;
  const dy = actor.y < place.y ? place.y - actor.y : actor.y >= place.y + place.height ? actor.y - (place.y + place.height - 1) : 0;
  return dx + dy;
}

function manhattan(a: XY, b: XY): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function chebyshev(a: XY, b: XY): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function inPlaceArea(actor: Actor, place: Place): boolean {
  return distanceToPlace(actor, place) === 0;
}

function pointForPlace(place: Place): XY {
  return {
    x: Math.floor(place.x + place.width / 2),
    y: Math.floor(place.y + place.height / 2)
  };
}

function placeById(world: WorldState, id: string): Place | null {
  return world.places?.[id] ?? null;
}

function nearestPlace(world: WorldState, me: Actor, kinds: Place["kind"][]): { place: Place; dist: number } | null {
  return Object.values(world.places ?? {})
    .filter((place) => kinds.includes(place.kind))
    .map((place) => ({ place, dist: distanceToPlace(me, place) }))
    .sort((a, b) => a.dist - b.dist)[0] ?? null;
}

function actorBlocked(world: WorldState, me: Actor, x: number, y: number): boolean {
  return Object.values(world.actors).some((a) => a.id !== me.id && a.alive && a.x === x && a.y === y);
}

function passableCell(world: WorldState, me: Actor, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.map.width || y >= world.map.height) return false;
  if (world.map.collision[y]?.[x] === 1) return false;
  return !actorBlocked(world, me, x, y);
}

function canStep(world: WorldState, me: Actor, dx: number, dy: number): boolean {
  const nx = me.x + dx;
  const ny = me.y + dy;
  return passableCell(world, me, nx, ny);
}

function followActivePath(world: WorldState, me: Actor, thought: Thought): BrainDecision | null {
  const activePath = thought.activePath;
  if (!activePath) return null;
  const [next, ...remaining] = activePath.remaining;
  if (!next) return null;
  if (!canStep(world, me, next.dx, next.dy)) {
    return waitDecision("막힌 길 앞에서 멈춘다", ["가려던 길이 막혔다"]);
  }
  return {
    thought: {
      priority: "정한 목적지로 걸어간다",
      emotion: "평온",
      nextIntent: "MOVE",
      beliefs: [`목적지는 (${activePath.targetXY.x},${activePath.targetXY.y})이다`],
      recentEvents: [],
      activePath: remaining.length > 0 ? { ...activePath, remaining } : undefined
    },
    action: { type: "MOVE", dx: next.dx as -1|0|1, dy: next.dy as -1|0|1 }
  };
}

function goToDecision(args: {
  world: WorldState;
  me: Actor;
  targetXY: XY;
  targetPlaceId?: string;
  priority: string;
  belief: string;
}): BrainDecision | null {
  const path = findPath(args.world, { x: args.me.x, y: args.me.y }, args.targetXY);
  if (!path || path.length === 0) return null;
  const [next, ...remaining] = path;
  return {
    thought: {
      priority: args.priority,
      emotion: "평온",
      nextIntent: "GoTo",
      beliefs: [args.belief],
      recentEvents: [],
      activePath: remaining.length > 0
        ? { targetXY: args.targetXY, targetPlaceId: args.targetPlaceId, remaining }
        : undefined
    },
    action: { type: "MOVE", dx: next.dx as -1|0|1, dy: next.dy as -1|0|1 }
  };
}

function goToPlace(world: WorldState, me: Actor, place: Place, priority: string, belief: string): BrainDecision | null {
  return goToDecision({
    world,
    me,
    targetXY: pointForPlace(place),
    targetPlaceId: place.id,
    priority,
    belief
  });
}

function nearestPassableCellInPlace(world: WorldState, me: Actor, place: Place, edgeOnly = false): XY | null {
  const cells: XY[] = [];
  for (let y = place.y; y < place.y + place.height; y += 1) {
    for (let x = place.x; x < place.x + place.width; x += 1) {
      if (edgeOnly) {
        const onEdge = x === place.x || x === place.x + place.width - 1 || y === place.y || y === place.y + place.height - 1;
        if (!onEdge) continue;
      }
      if (passableCell(world, me, x, y)) cells.push({ x, y });
    }
  }
  return cells.sort((a, b) => manhattan(me, a) - manhattan(me, b))[0] ?? null;
}

function goToPlaceReliable(world: WorldState, me: Actor, place: Place, priority: string, belief: string): BrainDecision | null {
  const center = pointForPlace(place);
  const direct = goToDecision({ world, me, targetXY: center, targetPlaceId: place.id, priority, belief });
  if (direct) return direct;

  const fallback = nearestPassableCellInPlace(world, me, place, true) ?? nearestPassableCellInPlace(world, me, place);
  if (!fallback) return null;
  return goToDecision({
    world,
    me,
    targetXY: fallback,
    targetPlaceId: place.id,
    priority,
    belief: `${belief}; 가장 가까운 출입 가능한 칸으로 간다`
  });
}

function pickupDecision(itemId: string, priority: string, beliefs: string[] = []): BrainDecision {
  return {
    thought: { priority, emotion: "평온", nextIntent: "PICKUP", beliefs, recentEvents: [] },
    action: { type: "PICKUP", itemId }
  };
}

function waitDecision(priority: string, beliefs: string[] = [], emotion: BrainDecision["thought"]["emotion"] = "평온"): BrainDecision {
  return {
    thought: { priority, emotion, nextIntent: "WAIT", beliefs, recentEvents: [] },
    action: { type: "WAIT" }
  };
}

function speakDecision(message: string, targetId: string | undefined, priority: string, beliefs: string[] = []): BrainDecision {
  return {
    thought: { priority, emotion: "즐거움", nextIntent: "SPEAK", beliefs, recentEvents: [] },
    action: { type: "SPEAK", message, targetId }
  };
}

function useDecision(itemId: string, priority: string, beliefs: string[] = []): BrainDecision {
  return {
    thought: { priority, emotion: "평온", nextIntent: "USE", beliefs, recentEvents: [] },
    action: { type: "USE", itemId }
  };
}

function sellDecision(target: Actor, itemId: string, priority: string, beliefs: string[] = []): BrainDecision {
  return {
    thought: { priority, emotion: "즐거움", nextIntent: "SELL", beliefs, recentEvents: [] },
    action: { type: "SELL", targetId: target.id, itemId }
  };
}

function isFoodItemId(itemId: string): boolean {
  return itemId.startsWith("carrot") || itemId.startsWith("wheat") || itemId.startsWith("herb");
}

function foodOnCell(world: WorldState, x: number, y: number): string | null {
  return Object.values(world.groundItems)
    .find((item) => item.x === x && item.y === y && isFoodItemId(item.id))?.id ?? null;
}

function nearestGroundFood(world: WorldState, me: Actor): { id: string; x: number; y: number; dist: number } | null {
  return Object.values(world.groundItems)
    .filter((item) => isFoodItemId(item.id))
    .map((item) => ({ id: item.id, x: item.x, y: item.y, dist: Math.abs(item.x - me.x) + Math.abs(item.y - me.y) }))
    .sort((a, b) => a.dist - b.dist)[0] ?? null;
}

function nearestNeighbor(world: WorldState, me: Actor, maxDist = 3): { actor: Actor; dist: number } | null {
  return Object.values(world.actors)
    .filter((a) => a.id !== me.id && a.alive && a.kind !== "monster")
    .map((actor) => ({ actor, dist: Math.abs(actor.x - me.x) + Math.abs(actor.y - me.y) }))
    .filter((entry) => entry.dist <= maxDist)
    .sort((a, b) => a.dist - b.dist)[0] ?? null;
}

function roleFor(me: Actor, soul: Soul): SoulRole {
  if (soul.role) return soul.role;
  if (me.id === "player-1") return "hero";
  if (me.id === "npc-1") return "farmer";
  if (me.id === "npc-2" || me.name.toLowerCase().includes("baker")) return "baker";
  if (me.id === "npc-3") return "merchant";
  if (me.id === "npc-4") return "guard";
  return "wanderer";
}

function nextItemId(world: WorldState, prefix: string): string {
  const exists = (id: string) =>
    Boolean(world.groundItems[id])
    || Object.values(world.actors).some((actor) =>
        actor.inventory.some((slot) => slot.kind === "instance" && slot.id === id));
  let n = 1;
  while (exists(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

function placeProducedItem(world: WorldState, itemId: string, place: Place, type: string, iconKey: string): void {
  world.groundItems[itemId] = {
    id: itemId,
    x: place.x + Math.min(1, place.width - 1),
    y: place.y + Math.min(1, place.height - 1),
    type,
    iconKey
  };
  world.revision += 1;
}

function groundItemByPrefixInPlace(world: WorldState, prefix: string, place: Place): { id: string; x: number; y: number } | null {
  return Object.values(world.groundItems)
    .filter((item) =>
      item.id.startsWith(prefix) &&
      item.x >= place.x &&
      item.x < place.x + place.width &&
      item.y >= place.y &&
      item.y < place.y + place.height
    )
    .map((item) => ({ id: item.id, x: item.x, y: item.y }))
    .sort((a, b) => manhattan(a, pointForPlace(place)) - manhattan(b, pointForPlace(place)))[0] ?? null;
}

function maybeGiveCarrot(world: WorldState, me: Actor): BrainDecision | null {
  if (me.hunger > 30) return null;
  const has = me.inventory.some((s) => s.item === "carrot");
  if (!has) return null;
  const target = nearestNeighbor(world, me, 1);
  if (!target) return null;
  return {
    thought: {
      priority: `${target.actor.name}에게 수확한 당근을 나눈다`,
      emotion: "즐거움",
      nextIntent: "GIVE",
      beliefs: [`${target.actor.name}이(가) 곁에 있다`, `당근을 나눌 수 있다`],
      recentEvents: []
    },
    action: { type: "GIVE", targetId: target.actor.id, itemId: "carrot" }
  };
}

function recordProduced(kind: "carrot", world: WorldState, actor: Actor, itemId: string): void {
  const text = `${actor.name} 이(가) ${itemId} 당근을 수확했어요.`;
  void recordHistory({
    tick: world.tick,
    ts: Date.now(),
    actorId: actor.id,
    kind: "carrot.harvested",
    text,
    meta: { itemId }
  });
}

function customerNearShopkeeper(world: WorldState, me: Actor): Actor | null {
  return Object.values(world.actors)
    .filter((actor) => actor.id !== me.id && actor.alive && actor.kind !== "monster" && manhattan(actor, me) <= 1)
    .sort((a, b) => manhattan(a, me) - manhattan(b, me))[0] ?? null;
}

function maybeSellFromInventory(world: WorldState, me: Actor, prefixes: string[]): BrainDecision | null {
  const customer = customerNearShopkeeper(world, me);
  if (!customer || customer.inventory.length >= 8) return null;
  const slot = me.inventory.find((s) => prefixes.some((p) => s.item === p));
  if (!slot) return null;
  const key = slot.item;
  return sellDecision(customer, key, `${customer.name}에게 ${key}을(를) 판다`, [`${customer.name}이(가) 가게 가까이에 있다`]);
}

function restockInventory(world: WorldState, me: Actor, prefix: string, max = 2): void {
  const count = me.inventory.reduce((n, s) => n + (s.item === prefix ? (s.kind === "stack" ? s.count : 1) : 0), 0);
  if (count >= max || me.inventory.length >= 8) return;
  // helper 직접 호출은 mock 의 의도를 살림 — instance 면 instance, stackable 이면 stack
  const id = nextItemId(world, prefix);
  // catalog stackable 여부에 따라 슬롯 종류 결정
  // mock 단순화: addToInventory helper 사용
  // 하지만 import 회피 위해 식 직접 사용
  const slot = me.inventory.find((s) => s.kind === "stack" && s.item === prefix);
  if (slot && slot.kind === "stack") slot.count += 1;
  else me.inventory.push({ kind: "instance", id, item: prefix });
  world.revision += 1;
}

function decideForHunger(world: WorldState, me: Actor): BrainDecision | null {
  if (me.hunger <= 70) return null;

  const foodSlot = me.inventory.find((s) => isFoodItemId(s.item));
  if (foodSlot) {
    const fkey = foodSlot.item;
    return useDecision(fkey, "배가 고파 음식을 먹는다", [`가방에 ${fkey}이(가) 있다`]);
  }

  const cellFood = foodOnCell(world, me.x, me.y);
  if (cellFood) {
    return {
      thought: {
        priority: "발밑의 음식을 줍는다",
        emotion: "피곤함",
        nextIntent: "PICKUP",
        beliefs: [`${cellFood}이(가) 같은 칸에 있다`],
        recentEvents: []
      },
      action: { type: "PICKUP", itemId: cellFood }
    };
  }

  const food = nearestGroundFood(world, me);
  if (food) {
    return goToDecision({
      world,
      me,
      targetXY: { x: food.x, y: food.y },
      priority: `${food.id} 쪽으로 먹을 것을 찾아간다`,
      belief: `${food.id}이(가) ${food.dist}칸 떨어져 있다`
    });
  }

  const field = nearestPlace(world, me, ["field"]);
  if (field) {
    return goToPlace(world, me, field.place, `${field.place.name}으로 먹을 것을 찾아간다`, `${field.place.name}에 먹을 것이 있을 수 있다`);
  }
  return null;
}

function inferMonsterKind(actor: Actor): "boar" | "wolf" | "bear" | "deer" | "slime" | "spirit" | "generic" {
  const ak = (actor.assetKey ?? "").toLowerCase();
  if (ak.includes("boar")) return "boar";
  if (ak.includes("wolf")) return "wolf";
  if (ak.includes("bear")) return "bear";
  if (ak.includes("deer")) return "deer";
  if (ak.includes("slime")) return "slime";
  if (ak.includes("spirit") || ak.includes("ghost")) return "spirit";
  return "generic";
}

function nearestPrey(world: WorldState, me: Actor, includeMonsters = false): { a: Actor; dist: number } | null {
  const list = Object.values(world.actors)
    .filter((a) => a.alive && a.id !== me.id && (includeMonsters || a.kind !== "monster"))
    .map((a) => ({ a, dist: Math.abs(a.x - me.x) + Math.abs(a.y - me.y) }))
    .sort((x, y) => x.dist - y.dist);
  return list[0] ?? null;
}

const MONSTER_LEASH: Record<string, number> = {
  // 비선공 동물: 넓게 자유롭게 돌아다님
  deer: 16,
  // 포식자: 좁게 (NPC 마을 침범 방지)
  boar: 8, wolf: 7, bear: 6, slime: 5, spirit: 8, generic: 6
};

function decideForMonster(world: WorldState, me: Actor): BrainDecision {
  const kind = inferMonsterKind(me);
  const forest = nearestPlace(world, me, ["forest_edge"]);
  const water = nearestPlace(world, me, ["pond"]);
  const mine = nearestPlace(world, me, ["mine"]);
  const territoryPlace = kind === "slime" ? water : kind === "bear" ? mine : forest;
  const leashCenter = territoryPlace
    ? { x: territoryPlace.place.x + Math.floor(territoryPlace.place.width / 2), y: territoryPlace.place.y + Math.floor(territoryPlace.place.height / 2) }
    : null;
  const leashRadius = MONSTER_LEASH[kind] ?? 6;
  const distFromLeash = leashCenter ? Math.abs(me.x - leashCenter.x) + Math.abs(me.y - leashCenter.y) : 0;
  const beyondLeash = leashCenter && distFromLeash > leashRadius;
  const fleeToTerritory = (priority: string, belief: string): BrainDecision | null => {
    if (!territoryPlace) return null;
    if (inPlaceArea(me, territoryPlace.place)) return null;
    return goToPlaceReliable(world, me, territoryPlace.place, priority, belief);
  };
  const wanderInTerritory = (): BrainDecision => {
    const home = fleeToTerritory("영역으로 돌아간다", `${territoryPlace?.place.name ?? "영역"}에 머문다`);
    if (home) return home;
    const dir = pickFreeDir(world, me);
    if (dir) {
      return {
        thought: {
          priority: territoryPlace ? `${territoryPlace.place.name}을(를) 배회한다` : "영역을 배회한다",
          emotion: kind === "deer" ? "경계" : kind === "spirit" ? "차분함" : "경계",
          nextIntent: "MOVE",
          beliefs: territoryPlace ? [`${territoryPlace.place.name}에 머문다`] : [],
          recentEvents: []
        },
        action: { type: "MOVE", dx: dir.dx as -1|0|1, dy: dir.dy as -1|0|1 }
      };
    }
    return waitDecision("가만히 숨을 고른다", [], "경계");
  };

  // 사슴: 비선공, 자유롭게 넓게 돌아다님. 사람 보면 도주
  if (kind === "deer") {
    const danger = nearestPrey(world, me);
    if (danger && danger.dist <= 4) {
      const dx = me.x === danger.a.x ? 0 : me.x < danger.a.x ? -1 : 1;
      const dy = me.y === danger.a.y ? 0 : me.y < danger.a.y ? -1 : 1;
      if (dx !== 0 || dy !== 0) {
        return {
          thought: { priority: `${danger.a.name}에서 멀어진다`, emotion: "두려움", nextIntent: "MOVE", beliefs: [], recentEvents: [] },
          action: { type: "MOVE", dx: dx as -1|0|1, dy: dy as -1|0|1 }
        };
      }
    }
    // 자유 배회 (territory 강제 X)
    const dir = pickFreeDir(world, me);
    if (dir) {
      return {
        thought: { priority: "한가로이 들판을 거닌다", emotion: "차분함", nextIntent: "MOVE", beliefs: [], recentEvents: [] },
        action: { type: "MOVE", dx: dir.dx as -1|0|1, dy: dir.dy as -1|0|1 }
      };
    }
    return waitDecision("풀을 뜯는다", [], "차분함");
  }

  // 정령: 야간/안개에만 활성, 평소 사라짐 (WAIT). 공격보다 회피.
  if (kind === "spirit") {
    const phase = phaseOf(world.timeOfDay);
    const weather = world.context.weather;
    const active = phase === "night" || weather === "fog";
    if (!active) return waitDecision("희미해져 머문다", [], "차분함");
    const danger = nearestPrey(world, me);
    if (danger && danger.dist <= 3) {
      const dx = me.x === danger.a.x ? 0 : me.x < danger.a.x ? -1 : 1;
      const dy = me.y === danger.a.y ? 0 : me.y < danger.a.y ? -1 : 1;
      return {
        thought: { priority: "산 자에게서 거리를 둔다", emotion: "차분함", nextIntent: "MOVE", beliefs: [], recentEvents: [] },
        action: { type: "MOVE", dx: dx as -1|0|1, dy: dy as -1|0|1 }
      };
    }
    return wanderInTerritory();
  }

  // hp 낮으면 도주 (모든 포식자)
  if (me.hp < me.maxHp * 0.3) {
    const flee = fleeToTerritory("다친 몸을 이끌고 영역으로 물러난다", `체력이 낮다 (${Math.round(me.hp)}/${me.maxHp})`);
    if (flee) return flee;
    return waitDecision("상처를 숨기고 웅크린다", [`체력이 낮다 (${Math.round(me.hp)}/${me.maxHp})`], "두려움");
  }

  // 영역 밖이면 우선 영역으로 복귀 (leash)
  if (beyondLeash) {
    const home = fleeToTerritory("영역에서 너무 멀어졌다", `${territoryPlace?.place.name}로 돌아간다`);
    if (home) return home;
  }

  // 곰: 영역 방어, 가까운 사람 적극 공격 (단 leash 안에서)
  if (kind === "bear") {
    const prey = nearestPrey(world, me);
    if (prey && prey.dist <= 5) {
      if (prey.dist <= 1) return { thought: { priority: "영역을 침범한 자를 위협한다", emotion: "분노", nextIntent: `ATTACK ${prey.a.name}`, beliefs: [], recentEvents: [] }, action: { type: "ATTACK", targetId: prey.a.id } };
      const go = goToDecision({ world, me, targetXY: { x: prey.a.x, y: prey.a.y }, priority: "침입자 쪽으로 천천히 다가간다", belief: `${prey.a.name}이(가) ${prey.dist}칸` });
      if (go) return go;
    }
    return wanderInTerritory();
  }

  // 늑대: pack hunting (다른 늑대 가까이 있으면 적극, 혼자면 신중)
  if (kind === "wolf") {
    const packMate = Object.values(world.actors).find((a) => a.alive && a.id !== me.id && (a.assetKey ?? "").includes("wolf") && Math.abs(a.x - me.x) + Math.abs(a.y - me.y) <= 3);
    const aggressive = me.hunger >= 60 || Boolean(packMate);
    if (aggressive) {
      const prey = nearestPrey(world, me);
      if (prey && prey.dist <= 1) return { thought: { priority: "사냥감을 문다", emotion: "흥분", nextIntent: `ATTACK ${prey.a.name}`, beliefs: [], recentEvents: [] }, action: { type: "ATTACK", targetId: prey.a.id } };
      if (prey && prey.dist <= 6) {
        const go = goToDecision({ world, me, targetXY: { x: prey.a.x, y: prey.a.y }, priority: packMate ? "무리와 사냥감을 추격한다" : "사냥감을 추격한다", belief: `${prey.a.name}이(가) ${prey.dist}칸` });
        if (go) return go;
      }
    }
    return wanderInTerritory();
  }

  // 슬라임: 느림, 인접한 자만 공격. 평소 wander.
  if (kind === "slime") {
    const prey = nearestPrey(world, me, true);
    if (prey && prey.dist <= 1 && prey.a.kind !== "monster") {
      return { thought: { priority: "닿은 자에게 점착한다", emotion: "차분함", nextIntent: `ATTACK ${prey.a.name}`, beliefs: [], recentEvents: [] }, action: { type: "ATTACK", targetId: prey.a.id } };
    }
    if (Math.random() < 0.5) return waitDecision("천천히 출렁인다", [], "차분함");
    return wanderInTerritory();
  }

  // 멧돼지 (기본): 굶주릴 때만 사냥
  if (me.hunger <= 70) return wanderInTerritory();
  const prey = nearestPrey(world, me);
  if (prey && prey.dist <= 1) {
    return {
      thought: { priority: "눈앞의 사람을 위협한다", emotion: "경계", nextIntent: `ATTACK ${prey.a.name}`, beliefs: [`${prey.a.name}이(가) 가까이 있다`], recentEvents: [] },
      action: { type: "ATTACK", targetId: prey.a.id }
    };
  }
  if (prey) {
    const goPrey = goToDecision({ world, me, targetXY: { x: prey.a.x, y: prey.a.y }, priority: "먹잇감 쪽으로 다가간다", belief: `${prey.a.name}이(가) ${prey.dist}칸 떨어져 있다` });
    if (goPrey) return goPrey;
  }
  return wanderInTerritory();
}

function decideForBaker(world: WorldState, me: Actor): BrainDecision {
  const hour = world.timeOfDay;
  const bakery = placeById(world, "bakery");
  const home = placeById(world, "home-mochi") ?? placeById(world, "home-yui");
  if (!bakery) return decideForWanderer(world, me, { goals: ["빵집을 찾는다"] } as Soul);

  if (hour >= 7 && hour < 17) {
    if (!inPlaceArea(me, bakery)) {
      const go = goToPlaceReliable(world, me, bakery, `${bakery.name}으로 출근한다`, "일과 중에는 빵집 안에서 손님을 맞는다");
      if (go) return go;
      return waitDecision(`${bakery.name}으로 들어갈 길을 찾는다`, ["빵집 안에 아직 도착하지 못했다"], "피곤함");
    }

    const groundWheat = groundItemByPrefixInPlace(world, "wheat", bakery);
    if (groundWheat) {
      if (groundWheat.x === me.x && groundWheat.y === me.y) {
        return pickupDecision(groundWheat.id, `${bakery.name} 안의 밀을 정리한다`, [`${groundWheat.id}이(가) 발밑에 있다`]);
      }
      const go = goToDecision({
        world,
        me,
        targetXY: { x: groundWheat.x, y: groundWheat.y },
        targetPlaceId: bakery.id,
        priority: `${groundWheat.id} 밀이 있는 칸으로 간다`,
        belief: "가공은 아직 못 하지만 재료를 정리할 수 있다"
      });
      if (go) return go;
    }

    return waitDecision(`${bakery.name} 안에서 재료를 정리한다`, ["가공은 아직 구현되지 않았다"]);
  }

  if (hour >= 17 && hour < 21 && home) {
    if (distanceToPlace(me, home) > 0) {
      const go = goToPlaceReliable(world, me, home, `${home.name}으로 돌아간다`, "저녁에는 일을 마치고 쉰다");
      if (go) return go;
    }
    return waitDecision(`${home.name}에서 쉰다`, ["하루 장사를 마쳤다"], "피곤함");
  }

  if (home && distanceToPlace(me, home) > 0) {
    const go = goToPlaceReliable(world, me, home, `${home.name}으로 밤길을 돌아간다`, "밤에는 집에서 쉰다");
    if (go) return go;
  }
  return waitDecision(home ? `${home.name}에서 조용히 쉰다` : "밤이라 쉰다", ["밤에는 일을 멈춘다"], "피곤함");
}

function decideForFarmer(world: WorldState, me: Actor): BrainDecision {
  const hour = world.timeOfDay;
  const field = placeById(world, "field-west");
  const plaza = placeById(world, "plaza");
  const home = placeById(world, "home-mochi");

  const give = maybeGiveCarrot(world, me);
  if (give) return give;

  if (hour >= 6 && hour < 10 && field) {
    if (!inPlaceArea(me, field)) {
      const go = goToPlaceReliable(world, me, field, `${field.name}으로 밭일을 하러 간다`, "아침에는 서쪽 텃밭을 돌본다");
      if (go) return go;
      return waitDecision(`${field.name}으로 들어갈 길을 찾는다`, ["밭 안에 아직 도착하지 못했다"], "피곤함");
    }
    const count = (farmerWorkCounters.get(me.id) ?? 0) + 1;
    farmerWorkCounters.set(me.id, count);
    if (count >= 5) {
      farmerWorkCounters.set(me.id, 0);
      const carrotId = nextItemId(world, "carrot");
      placeProducedItem(world, carrotId, field, "food", "item.food.carrot");
      world.context.resources.carrotStock = Math.min(99, world.context.resources.carrotStock + 1);
      recordProduced("carrot", world, me, carrotId);
    }
    return waitDecision(`${field.name}에서 물을 주고 흙을 고른다`, [`밭일 횟수 ${count}/5`]);
  }

  if (hour >= 10 && hour < 17 && plaza) {
    if (distanceToPlace(me, plaza) > 0) {
      const go = goToPlaceReliable(world, me, plaza, `${plaza.name}으로 사람들을 만나러 간다`, "낮에는 광장에서 마을 사람들을 만난다");
      if (go) return go;
    }
    const target = nearestNeighbor(world, me, 5);
    return speakDecision("밭에서 막 돌아왔어요.", target?.actor.id, `${plaza.name}에서 마을 사람과 이야기한다`, ["낮에는 광장이 북적인다"]);
  }

  if (hour >= 17 && hour < 22 && home) {
    if (distanceToPlace(me, home) > 0) {
      const go = goToPlaceReliable(world, me, home, `${home.name}으로 돌아간다`, "저녁에는 집에서 쉰다");
      if (go) return go;
    }
    return waitDecision(`${home.name}에서 쉰다`, ["밭일을 마쳤다"], "피곤함");
  }

  return waitDecision("밤이라 조용히 쉰다", ["밤에는 밭일을 하지 않는다"], "피곤함");
}

function decideForMerchant(world: WorldState, me: Actor): BrainDecision {
  const hour = world.timeOfDay;
  const store = placeById(world, "general-store");
  const home = placeById(world, "home-yui");

  if (hour >= 6 && hour < 21 && store) {
    if (!inPlaceArea(me, store)) {
      const go = goToPlaceReliable(world, me, store, `${store.name}으로 가게를 보러 간다`, "낮에는 잡화점을 지킨다");
      if (go) return go;
      return waitDecision(`${store.name}으로 들어갈 길을 찾는다`, ["가게 안에 아직 도착하지 못했다"], "피곤함");
    }
    restockInventory(world, me, "potion-heal", 1);
    const sale = maybeSellFromInventory(world, me, ["potion-heal"]);
    if (sale) return sale;
    if (Math.random() < 0.45) {
      const target = nearestNeighbor(world, me, 4);
      return speakDecision("필요한 물건 있으면 둘러보세요.", target?.actor.id, `${store.name}에서 손님을 맞는다`, ["잡화점 영업 중이다"]);
    }
    return waitDecision(`${store.name} 안에서 물건을 정리한다`, ["잡화점을 맡고 있다"]);
  }

  if (home && distanceToPlace(me, home) > 0) {
    const go = goToPlaceReliable(world, me, home, `${home.name}으로 돌아간다`, "밤에는 집에서 쉰다");
    if (go) return go;
  }
  return waitDecision(home ? `${home.name}에서 쉰다` : "밤이라 쉰다", ["가게 문을 닫았다"], "피곤함");
}

function nearestActorInDanger(world: WorldState, me: Actor): { victim: Actor; monster?: Actor; dist: number } | null {
  const dangers: Array<{ victim: Actor; monster?: Actor; dist: number }> = [];
  for (const victim of Object.values(world.actors)) {
    if (!victim.alive || (victim.kind !== "npc" && victim.kind !== "player")) continue;
    const adjacentMonster = Object.values(world.actors)
      .filter((actor) => actor.alive && actor.kind === "monster" && chebyshev(actor, victim) <= 1)
      .sort((a, b) => chebyshev(a, victim) - chebyshev(b, victim))[0];
    const hurt = victim.hp < victim.maxHp * 0.8;
    if (!hurt && !adjacentMonster) continue;
    dangers.push({ victim, monster: adjacentMonster, dist: manhattan(me, victim) });
  }
  dangers.sort((a, b) => a.dist - b.dist);
  return dangers[0] ?? null;
}

function attackDecision(target: Actor, priority: string, beliefs: string[]): BrainDecision {
  return {
    thought: {
      priority,
      emotion: "경계",
      nextIntent: "ATTACK",
      beliefs,
      recentEvents: []
    },
    action: { type: "ATTACK", targetId: target.id }
  };
}

function clampToSquareRadius(center: XY, target: XY, radius: number): XY {
  return {
    x: Math.max(center.x - radius, Math.min(center.x + radius, target.x)),
    y: Math.max(center.y - radius, Math.min(center.y + radius, target.y))
  };
}

function decideForGuard(world: WorldState, me: Actor): BrainDecision {
  const danger = nearestActorInDanger(world, me);
  if (danger) {
    if (danger.monster && chebyshev(me, danger.monster) <= 1) {
      return attackDecision(
        danger.monster,
        `${danger.victim.name} 곁의 ${danger.monster.name}을(를) 막아선다`,
        [`${danger.victim.name}이(가) 위험하다`, `${danger.monster.name}이(가) 인접해 있다`]
      );
    }
    const go = goToDecision({
      world,
      me,
      targetXY: { x: danger.victim.x, y: danger.victim.y },
      priority: `${danger.victim.name}의 위험 신호로 달려간다`,
      belief: danger.monster
        ? `${danger.monster.name}이(가) ${danger.victim.name}에게 붙어 있다`
        : `${danger.victim.name}의 체력이 낮다`
    });
    if (go) return go;
  }

  const monster = Object.values(world.actors)
    .filter((actor) => actor.alive && actor.kind === "monster")
    .map((actor) => ({ actor, dist: manhattan(actor, me) }))
    .filter((entry) => entry.dist <= 4)
    .sort((a, b) => a.dist - b.dist)[0];

  if (monster) {
    if (monster.dist <= 1) {
      return attackDecision(monster.actor, `${monster.actor.name}을(를) 막아선다`, [`${monster.actor.name}이(가) 너무 가까이 있다`]);
    }
    const go = goToDecision({
      world,
      me,
      targetXY: { x: monster.actor.x, y: monster.actor.y },
      priority: `${monster.actor.name} 쪽으로 달려간다`,
      belief: `몬스터가 ${monster.dist}칸 거리에 있다`
    });
    if (go) return go;
  }

  const hour = world.timeOfDay;
  const plaza = placeById(world, "plaza");
  if (hour >= 21 || hour < 6) {
    if (plaza && distanceToPlace(me, plaza) > 0) {
      const go = goToPlaceReliable(world, me, plaza, `${plaza.name} 야간 순찰 지점으로 간다`, "밤에는 광장을 지킨다");
      if (go) return go;
    }
    return waitDecision(plaza ? `${plaza.name}에서 야간 순찰을 선다` : "야간 순찰을 선다", ["밤에도 경계를 늦추지 않는다"], "경계");
  }

  const patrolCenter = plaza ? pointForPlace(plaza) : { x: me.x, y: me.y };
  const fieldEast = placeById(world, "field-east");
  const forestNorth = placeById(world, "forest-north");
  const patrol = [
    { place: plaza, targetXY: plaza ? pointForPlace(plaza) : { x: me.x, y: me.y } },
    { place: fieldEast, targetXY: fieldEast ? clampToSquareRadius(patrolCenter, pointForPlace(fieldEast), 8) : { x: me.x, y: me.y } },
    { place: forestNorth, targetXY: clampToSquareRadius(patrolCenter, { x: 42, y: 2 }, 8) }
  ].filter((entry): entry is { place: Place; targetXY: { x: number; y: number } } => Boolean(entry.place));

  if (patrol.length === 0) return waitDecision("순찰할 지점을 찾는다", [], "경계");
  let index = guardPatrolIndexes.get(me.id) ?? 0;
  let current = patrol[index % patrol.length];
  const atTarget = Math.abs(me.x - current.targetXY.x) + Math.abs(me.y - current.targetXY.y) <= 1;
  if (atTarget) {
    index = (index + 1) % patrol.length;
    guardPatrolIndexes.set(me.id, index);
    current = patrol[index];
    if (Math.random() < 0.35) {
      return waitDecision(`${current.place.name} 쪽 순찰을 확인한다`, ["순찰 경로를 따라 움직인다"], "경계");
    }
  }

  const go = goToDecision({
    world,
    me,
    targetXY: current.targetXY,
    targetPlaceId: current.place.id,
    priority: `${current.place.name} 쪽으로 순찰한다`,
    belief: "광장, 동쪽 텃밭, 북쪽 숲 가장자리를 순환한다"
  });
  if (go) return go;
  return waitDecision(`${current.place.name} 근처를 살핀다`, ["순찰 중이다"], "경계");
}

function decideForHero(world: WorldState, me: Actor, soul: Soul): BrainDecision {
  const hunger = decideForHunger(world, me);
  if (hunger) return hunger;
  return decideForWanderer(world, me, soul);
}

function decideForWanderer(world: WorldState, me: Actor, soul: Soul): BrainDecision {
  const phase = phaseOf(world.timeOfDay);
  const nearSocialPlace = nearestPlace(world, me, ["plaza", "well"]);
  const nearField = nearestPlace(world, me, ["field"]);
  const nearHome = nearestPlace(world, me, ["home"]);

  const hunger = decideForHunger(world, me);
  if (hunger) return hunger;

  const plaza = nearestPlace(world, me, world.context.marketDayActive ? ["plaza", "shop"] : ["plaza"]);
  if ((phase === "morning" || phase === "evening") && plaza && plaza.dist > 0 && plaza.dist <= 6) {
    const goPlaza = goToPlace(world, me, plaza.place, `${plaza.place.name}으로 향한다`, `${phase === "morning" ? "아침" : "저녁"}에는 광장에 사람들이 모인다`);
    if (goPlaza) return goPlaza;
  }

  if (world.context.weather === "rain" && nearHome && nearHome.dist > 0 && Math.random() < 0.35) {
    const goHome = goToPlaceReliable(world, me, nearHome.place, `${nearHome.place.name}으로 비를 피하러 간다`, "비가 오면 실내에 머문다");
    if (goHome) return goHome;
  }

  if (phase === "night") {
    const waitChance = nearHome && nearHome.dist === 0 ? 0.95 : 0.85;
    if (Math.random() < waitChance) {
      return waitDecision(
        nearHome && nearHome.dist === 0 ? `${nearHome.place.name}에서 쉰다` : "밤이라 쉰다",
        nearHome && nearHome.dist === 0 ? ["해가 저물었다", `${nearHome.place.name} 안에 있다`] : ["해가 저물었다"],
        "피곤함"
      );
    }
  }

  if (phase === "day" && nearField && nearField.dist <= 5 && Math.random() < 0.18) {
    return waitDecision(`${nearField.place.name} 근처에서 밭일을 살핀다`, [`${nearField.place.name}이(가) 가까이 있다`]);
  }

  const socialBoost = nearSocialPlace && nearSocialPlace.dist <= 5 && (phase === "morning" || phase === "evening") ? 0.2 : 0;
  const speakChance = Math.min(0.85, (phase === "morning" ? 0.45 : phase === "evening" ? 0.28 : 0.14) + socialBoost);
  if (Math.random() < speakChance) {
    const neighbor = nearestNeighbor(world, me, 3);
    if (neighbor) {
      const pool: Record<DayPhase, string[]> = {
        morning: [`좋은 아침, ${neighbor.actor.name}!`, "새벽 공기가 맑네.", "오늘은 뭐 할까?"],
        day: [`안녕, ${neighbor.actor.name}!`, "날씨 좋다.", "저쪽 길이 조용하네."],
        evening: [`${neighbor.actor.name}, 고생했어.`, "해가 많이 기울었네.", "곧 집에 들어가자."],
        night: ["조용히 하자...", "별이 보인다.", `${neighbor.actor.name}, 아직 안 자?`]
      };
      const messages = pool[phase];
      return speakDecision(
        messages[Math.floor(Math.random() * messages.length)],
        neighbor.actor.id,
        nearSocialPlace && nearSocialPlace.dist <= 5
          ? `${nearSocialPlace.place.name}에서 ${neighbor.actor.name}와(과) 인사한다`
          : `${neighbor.actor.name}와(과) 인사한다`,
        [`${neighbor.actor.name}이(가) 근처에 있다`]
      );
    }
  }

  const dir = pickFreeDir(world, me);
  if (dir) {
    return {
      thought: { priority: soul.goals?.[0] ?? "마을을 둘러본다", emotion: "평온", nextIntent: "MOVE", beliefs: [], recentEvents: [] },
      action: { type: "MOVE", dx: dir.dx as -1|0|1, dy: dir.dy as -1|0|1 }
    };
  }
  return waitDecision("잠깐 멈춰서 주위를 본다");
}

export function decideWithMock(args: {
  world: WorldState;
  me: Actor;
  soul: Soul;
  thought: Thought;
  memories: Observation[];
}): BrainDecision {
  const { world, me, soul, thought, memories } = args;
  if (me.kind === "monster") return decideForMonster(world, me);

  const oracle = decideForOracle(world, me, soul, memories);
  if (oracle) return oracle;

  const role = roleFor(me, soul);
  switch (role) {
    case "baker":
      return decideForBaker(world, me);
    case "farmer":
      return decideForFarmer(world, me);
    case "merchant":
      return decideForMerchant(world, me);
    case "guard":
      return decideForGuard(world, me);
    case "hero":
      {
        const activePathDecision = followActivePath(world, me, thought);
        if (activePathDecision) return activePathDecision;
      }
      return decideForHero(world, me, soul);
    case "wanderer":
    default:
      {
        const activePathDecision = followActivePath(world, me, thought);
        if (activePathDecision) return activePathDecision;
      }
      return decideForWanderer(world, me, soul);
  }
}

function decideForOracle(world: WorldState, me: Actor, soul: Soul, memories: Observation[]): BrainDecision | null {
  if (!soul.isFollower) return null;
  const active = soul.activeQuest?.status === "active" && soul.activeQuest.expiresAtTick > world.tick
    ? soul.activeQuest.text
    : memories.filter((m) => m.kind === "oracle" && m.tags.includes("oracle")).slice(-1)[0]?.text;
  if (!active) return null;

  const plaza = placeById(world, "plaza");
  if (active.includes("광장") && plaza) {
    if (inPlaceArea(me, plaza)) return waitDecision("신탁대로 광장에 도착해 기다린다", ["신의 명을 따랐다"]);
    return goToPlaceReliable(world, me, plaza, "신탁을 따라 광장으로 간다", active) ?? speakDecision("신의 말씀에 따르겠습니다.", undefined, "신탁을 되뇌며 길을 찾는다", [active]);
  }

  const shrine = placeById(world, "shrine");
  if (active.includes("사당") && shrine) {
    if (inPlaceArea(me, shrine)) {
      return {
        thought: { priority: "신탁을 따라 사당에서 기도한다", emotion: "평온", nextIntent: "PRAY", beliefs: [active], recentEvents: [] },
        action: { type: "PRAY" }
      };
    }
    return goToPlaceReliable(world, me, shrine, "신탁을 따라 사당으로 간다", active) ?? speakDecision("신의 말씀에 따르겠습니다.", undefined, "사당으로 갈 길을 찾는다", [active]);
  }

  if (active.includes("음식") && active.includes("나누")) {
    const food = me.inventory.find((s) => isFoodItemId(s.item));
    const target = nearestNeighbor(world, me, 1);
    if (food && target) {
      return {
        thought: { priority: "신탁을 따라 음식을 나눈다", emotion: "즐거움", nextIntent: "GIVE", beliefs: [active], recentEvents: [] },
        action: { type: "GIVE", targetId: target.actor.id, itemId: food.item }
      };
    }
  }

  return speakDecision("신의 말씀에 따르겠습니다.", undefined, "신탁을 받들어 응답한다", [active]);
}
