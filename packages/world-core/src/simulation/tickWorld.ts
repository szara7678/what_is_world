import { inventoryCountOf, inventorySlotsUsed, itemKeyOf, itemMaxStack, itemStackable, type Actor, type GroundItem, type Place, type Structure, type WorldState } from "@wiw/shared";
import { cleanupPendingTrades } from "../economy/pendingTrade";
import { tickWorldContext, fruitTreeRegen } from "./tickWorldContext";
import { actorNearStructure, dispatchAction, maturateCrops, tickAutoAttack, tickSleep, armorMaxHpBonus } from "../actions/dispatchAction";
import { findPath } from "../pathing/findPath";
import { MONSTER_CATALOG, behaviorForMonster, inferMonsterKind, inferMonsterTier, TIER_MULT, TIER_PREFIX, rollMonsterTier } from "../content/monsters";

// 2026-05-09 Phase B.1: 몬스터 위협 강화 — 티어 시스템(common/alpha/dire) + pursue 14 + 야간 floor 7.
//   기존 (05-08 v3): wander bias 약화 + respawn floor 4. directed wander 10%.
const MONSTER_OUT_OF_COMBAT_TICKS = 100;
const MONSTER_HP_REGEN_PER_TICK = 0.05;
const MONSTER_WANDER_INTERVAL = 8;
const MONSTER_PURSUE_RADIUS = 14;             // 2026-05-09: 10 → 14 (Phase B.1)
const MONSTER_PURSUE_INTERVAL = 4;
const VILLAGE_CENTER = { x: 32, y: 25 };
// 2026-05-09 v3: village_bias 제거 — 자유 wander + pack cohesion 만. spawn 위치(forest-east)로 거리 자체가 위협 완화.
// 2026-05-09 v4: 멸종 방지 최소 floor 1, 번식 로직으로 점진 증가.
const HOSTILE_FLOOR_DAY = 5;            // Codex 7차 권고: 10 → 5. character drift가 전투/실패에 묻히지 않게 압력 완화.
const HOSTILE_FLOOR_NIGHT = 7;          // 밤은 야간 표면 surge 유지 (12 → 7).
const HOSTILE_RESPAWN_INTERVAL = 1200;  // 600 → 1200. respawn 간격 늘려서 NPC가 hunger/trade/social 더 충분히 겪고 위협 만나도록.
const PACK_SPAWN_CHANCE = 0.35;
const INVENTORY_LIMIT = 14;
type SpawnKind = { kind: string; assetKey: string; namePrefix: string; weight: number };
type SpawnZone = { placeId: string; entries: SpawnKind[]; nightOnly?: boolean; weight: number };

// 2026-05-09 v4: 번식 — 같은 종 ≥2 인접 (4타일) 마다 작은 확률로 새끼 spawn.
// floor 보다 위에서도 자연 증가. CAP 으로 폭발 방지.
const BREEDING_CHECK_INTERVAL = 60;     // ~1분 wallclock
const BREEDING_PAIR_CHANCE = 0.03;      // Codex 8차 라이브: 0.08 → 0.03. 누적 번식으로 alpha boar 다수 → NPC 사망 4건 발생.
const BREEDING_RADIUS = 4;
const HOSTILE_POPULATION_CAP = 18;       // 36 → 18. character drift 검증 환경에는 위협 saturate 더 낮게.
let lastBreedCheckTick = 0;
const DISCOVER_RESOURCE_RADIUS = 8;
const DISCOVER_RESOURCE_SCAN_INTERVAL = 10;

const cellOf = (pos: { x: number; y: number }): { x: number; y: number } => ({
  x: Math.floor(pos.x),
  y: Math.floor(pos.y)
});

const sameCell = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
  const ac = cellOf(a);
  const bc = cellOf(b);
  return ac.x === bc.x && ac.y === bc.y;
};

const tileBlocked = (world: WorldState, x: number, y: number): boolean => {
  const cell = cellOf({ x, y });
  return (
    cell.x < 0 ||
    cell.y < 0 ||
    cell.x >= world.map.width ||
    cell.y >= world.map.height ||
    world.map.collision[cell.y]?.[cell.x] === 1
  );
};

// hostile asset key → MonsterKind 역매핑. 2026-05-09: weight 기반 — wolf/bear 비중 ↑.
const HOSTILE_KINDS: SpawnKind[] = [
  { kind: "boar",  assetKey: "animal.boar",  namePrefix: "Boar",  weight: 2 },
  { kind: "wolf",  assetKey: "animal.wolf",  namePrefix: "Wolf",  weight: 4 },
  { kind: "bear",  assetKey: "animal.bear",  namePrefix: "Bear",  weight: 2 },
  { kind: "deer",  assetKey: "animal.deer",  namePrefix: "Deer",  weight: 1 },
  { kind: "spirit", assetKey: "monster.spirit", namePrefix: "Spirit", weight: 1 },
  { kind: "skeleton", assetKey: "monster.skeleton", namePrefix: "Skeleton", weight: 2 },
  { kind: "skeleton_warrior", assetKey: "monster.skeleton_warrior", namePrefix: "Skeleton Warrior", weight: 1 },
  { kind: "skeleton_archer", assetKey: "monster.skeleton_archer", namePrefix: "Skeleton Archer", weight: 1 },
  { kind: "naga", assetKey: "monster.naga", namePrefix: "Naga", weight: 1 },
  { kind: "troll", assetKey: "monster.troll", namePrefix: "Troll", weight: 1 }
];
const kind = (kindName: string): SpawnKind => HOSTILE_KINDS.find((h) => h.kind === kindName) ?? HOSTILE_KINDS[0];
const HOSTILE_SPAWN_ZONES: SpawnZone[] = [
  { placeId: "forest-east", weight: 4, entries: [kind("wolf"), kind("bear"), kind("skeleton"), kind("boar")] },
  { placeId: "cemetery", nightOnly: true, weight: 3, entries: [kind("skeleton"), kind("skeleton_warrior"), kind("spirit")] },
  { placeId: "fishing_dock", weight: 2, entries: [kind("naga")] },
  { placeId: "riverbank_north", weight: 2, entries: [kind("naga")] },
  { placeId: "ancient_temple", weight: 2, entries: [kind("troll"), kind("skeleton_archer"), kind("skeleton_warrior")] },
  { placeId: "deep_ruins", weight: 2, entries: [kind("troll"), kind("skeleton_archer"), kind("skeleton")] },
  { placeId: "forest-south", weight: 2, entries: [kind("boar"), kind("deer")] },
  { placeId: "north_pasture", weight: 2, entries: [kind("boar"), kind("deer")] }
];
const HOSTILE_FLOOR_KINDS = new Set(["boar", "wolf", "bear", "spirit", "skeleton", "skeleton_warrior", "skeleton_archer", "naga", "troll"]);
const pickWeighted = <T extends { weight: number }>(entries: T[]): T => {
  const total = entries.reduce((s, entry) => s + entry.weight, 0);
  let r = Math.random() * total;
  for (const entry of entries) {
    r -= entry.weight;
    if (r <= 0) return entry;
  }
  return entries[0];
};

const placeAt = (world: WorldState, actor: Actor): Place | null => {
  for (const place of Object.values(world.places ?? {})) {
    if (actor.x >= place.x && actor.x < place.x + place.width && actor.y >= place.y && actor.y < place.y + place.height) {
      return place;
    }
  }
  return null;
};

const groundResource = (item: GroundItem): string | null => {
  const key = itemKeyOf(item.id);
  return key || item.type || null;
};

const discoveryStructureResource = (struct: Structure): string | null => {
  if (struct.type === "tree") return "wood";
  if (struct.type === "rock") return "ore";
  if (struct.type === "bush" || struct.type === "berry_bush" || struct.type === "plant") return "berry";
  if (struct.type === "herb" || struct.type === "herb_bed") return "herb";
  if (struct.type === "pond" || struct.type === "fishing_spot") return "fish";
  return null;
};

const visibleResourcesNear = (world: WorldState, actor: Actor): string[] => {
  const seen = new Set<string>();
  for (const item of Object.values(world.groundItems ?? {})) {
    if (Math.abs(item.x - actor.x) + Math.abs(item.y - actor.y) > DISCOVER_RESOURCE_RADIUS) continue;
    const resource = groundResource(item);
    if (resource) seen.add(resource);
  }
  for (const struct of Object.values(world.structures ?? {})) {
    const resource = discoveryStructureResource(struct);
    if (!resource) continue;
    const center = structureCenter(struct);
    if (Math.abs(center.x - actor.x) + Math.abs(center.y - actor.y) <= DISCOVER_RESOURCE_RADIUS) seen.add(resource);
  }
  return [...seen].sort();
};

const updateDiscoveredPlaces = (world: WorldState, actor: Actor): void => {
  const place = placeAt(world, actor);
  if (!place) return;

  actor.discoveredPlaces ??= {};
  const existing = actor.discoveredPlaces[place.id];
  const isNew = !existing;
  const shouldScanResources = isNew || world.tick % DISCOVER_RESOURCE_SCAN_INTERVAL === 0;
  const resourcesSeen = shouldScanResources
    ? [...new Set([...(existing?.resourcesSeen ?? []), ...visibleResourcesNear(world, actor)])].sort()
    : existing?.resourcesSeen ?? [];

  actor.discoveredPlaces[place.id] = {
    resourcesSeen,
    firstVisitTick: existing?.firstVisitTick ?? world.tick,
    lastVisitTick: world.tick,
    locked: existing?.locked ?? false
  };

  if (isNew) {
    world.eventQueue ??= [];
    world.eventQueue.push({
      tick: world.tick,
      actorId: actor.id,
      category: "world",
      type: "place_discovered",
      result: "success",
      payload: { placeId: place.id, resourcesSeen }
    });
  }
};

let lastRespawnCheckTick = 0;
const maybeRespawnHostile = (world: WorldState): void => {
  if (world.tick - lastRespawnCheckTick < HOSTILE_RESPAWN_INTERVAL) return;
  lastRespawnCheckTick = world.tick;
  let aliveHostile = 0;
  for (const a of Object.values(world.actors)) {
    if (!a.alive || a.kind !== "monster") continue;
    const monsterKind = inferMonsterKind(a.assetKey ?? "");
    if (monsterKind && HOSTILE_FLOOR_KINDS.has(monsterKind)) aliveHostile += 1;
  }
  // 2026-05-11: forest-east visibility fix — 낮 10, 밤 12. nighttime surge.
  const isNight = world.timeOfDay >= 20 || world.timeOfDay < 5;
  const floor = isNight ? HOSTILE_FLOOR_NIGHT : HOSTILE_FLOOR_DAY;
  if (aliveHostile >= floor) return;
  const need = floor - aliveHostile;
  // 2026-05-11: forest-east 우선, 없거나 막혔으면 외곽 place 후보로 분산.
  const activeZones: Array<SpawnZone & { place: Place }> = [];
  for (const zone of HOSTILE_SPAWN_ZONES) {
    if (zone.nightOnly && !isNight) continue;
    const place = world.places?.[zone.placeId];
    if (place) activeZones.push({ ...zone, place });
  }
  const pickSpawn = (): { place: Place; def: SpawnKind } | null => {
    const zone = pickWeighted(activeZones);
    if (!zone) return null;
    return { place: zone.place, def: pickWeighted(zone.entries) };
  };
  const pickSpawnXY = (place: Place | undefined): { x: number; y: number } => {
    if (!place) {
      // fallback: 우측 외곽
      return { x: world.map.width - 6, y: Math.floor(world.map.height / 2) };
    }
    for (let tries = 0; tries < 20; tries += 1) {
      const x = place.x + Math.floor(Math.random() * place.width);
      const y = place.y + Math.floor(Math.random() * place.height);
      if (world.map.collision[y]?.[x] === 1) continue;
      // structure 위 회피
      const occupied = Object.values(world.structures ?? {}).some((s) =>
        x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height
      );
      if (occupied) continue;
      return { x, y };
    }
    return { x: place.x + Math.floor(place.width / 2), y: place.y + Math.floor(place.height / 2) };
  };
  let spawned = 0; let packs = 0; let i = 0;
  while (spawned < need) {
    const spawn = pickSpawn();
    const def = spawn?.def ?? kind("wolf");
    const base = pickSpawnXY(spawn?.place);
    const baseX = base.x; const baseY = base.y;
    // 2026-05-09 Phase B.1 (option D): 30% 확률 pack — 같은 종 2-3마리 인접.
    const isPack = Math.random() < PACK_SPAWN_CHANCE;
    const groupSize = isPack ? 2 + Math.floor(Math.random() * 2) : 1;  // pack 2-3, single 1
    if (isPack) packs += 1;
    for (let g = 0; g < groupSize && spawned < need; g += 1) {
      // pack 동료는 같은 종, 각자 tier 추첨 (위계 자연스럽게)
      const tier = rollMonsterTier();
      const mult = TIER_MULT[tier];
      const tierSuffix = tier === 3 ? ".dire" : tier === 2 ? ".alpha" : "";
      // 인접 ±2 칸 내 분산
      let x = baseX + (g === 0 ? 0 : Math.floor(Math.random() * 5) - 2);
      let y = baseY + (g === 0 ? 0 : Math.floor(Math.random() * 5) - 2);
      x = Math.max(1, Math.min(world.map.width - 2, x));
      y = Math.max(1, Math.min(world.map.height - 2, y));
      const id = `monster-${def.kind}${tierSuffix}-respawn-${world.tick}-${i}`;
      const baseStatus = { strength: 2, dexterity: 4, constitution: 3, intelligence: 1 };
      const status = {
        ...baseStatus,
        strength: Math.round(baseStatus.strength * mult.str),
        constitution: Math.round(baseStatus.constitution * mult.con)
      };
      const behavior = behaviorForMonster(`${def.assetKey}${tierSuffix}`);
      const maxHp = Math.round((80 + status.constitution * 4) * mult.hp * (behavior === "tank" ? 1.5 : 1));
      const maxStamina = 50 + status.constitution * 5;
      world.actors[id] = {
        id, kind: "monster",
        // 2026-05-09: name = 종(+tier prefix) 만. 유니크 식별은 id 로만. UI/이벤트 텍스트에 ID 안 보이게.
        name: `${TIER_PREFIX[tier]}${def.namePrefix}`,
        assetKey: `${def.assetKey}${tierSuffix}`,
        x, y,
        hp: maxHp, maxHp,
        mp: 0, maxMp: 0,
        stamina: maxStamina, maxStamina,
        hunger: 0, maxHunger: 80 + status.constitution * 4,
        status,
        skills: [], gold: 0,
        inventory: [],
        alive: true
      };
      spawned += 1; i += 1;
    }
  }
  console.log(`[monster] respawn ${spawned} hostile (was ${aliveHostile}, floor ${floor}${isNight ? " NIGHT" : ""}, packs ${packs})`);
};

// 2026-05-09 v4: 번식 — 같은 종 ≥2 인접 시 작은 확률로 새끼 spawn. 마을 위협 점진 증가.
const maybeBreedHostile = (world: WorldState): void => {
  if (world.tick - lastBreedCheckTick < BREEDING_CHECK_INTERVAL) return;
  lastBreedCheckTick = world.tick;
  const hostileAlive: Actor[] = [];
  for (const a of Object.values(world.actors)) {
    if (!a.alive || a.kind !== "monster") continue;
    const ak = a.assetKey ?? "";
    if (HOSTILE_KINDS.some((h) => ak.includes(h.kind))) hostileAlive.push(a);
  }
  if (hostileAlive.length >= HOSTILE_POPULATION_CAP) return;

  // 종 별 그룹화
  const byKind: Record<string, Actor[]> = {};
  for (const a of hostileAlive) {
    const kind = inferMonsterKind(a.assetKey ?? "");
    if (!kind) continue;
    (byKind[kind] ??= []).push(a);
  }

  let bornCount = 0;
  for (const [kind, group] of Object.entries(byKind)) {
    if (group.length < 2) continue;  // 번식엔 ≥2 필요
    // 인접 쌍 찾기 + 각 쌍 별 확률
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (hostileAlive.length + bornCount >= HOSTILE_POPULATION_CAP) break;
        const A = group[i]; const B = group[j];
        const d = Math.abs(A.x - B.x) + Math.abs(A.y - B.y);
        if (d > BREEDING_RADIUS) continue;
        if (Math.random() >= BREEDING_PAIR_CHANCE) continue;
        // 새끼 spawn — common 위주. Codex 8차 라이브: alpha 18% → 6%, dire 2% → 1%.
        // Passive boar/deer 가 누적 번식하면서 alpha 변이체가 village 침입 → NPC 사망 4건. tier 변이 확률 강제 인하.
        const r = Math.random();
        const childTier: import("../content/monsters").MonsterTier = r < 0.01 ? 3 : r < 0.07 ? 2 : 1;
        const mult = TIER_MULT[childTier];
        const tierSuffix = childTier === 3 ? ".dire" : childTier === 2 ? ".alpha" : "";
        const cx = Math.round((A.x + B.x) / 2);
        const cy = Math.round((A.y + B.y) / 2);
        const namePrefix = HOSTILE_KINDS.find((h) => h.kind === kind)?.namePrefix ?? "Beast";
        const assetKey = HOSTILE_KINDS.find((h) => h.kind === kind)?.assetKey ?? "";
        const id = `monster-${kind}${tierSuffix}-born-${world.tick}-${bornCount}`;
        const baseStatus = { strength: 2, dexterity: 4, constitution: 3, intelligence: 1 };
        const status = {
          ...baseStatus,
          strength: Math.round(baseStatus.strength * mult.str),
          constitution: Math.round(baseStatus.constitution * mult.con)
        };
        const behavior = behaviorForMonster(`${assetKey}${tierSuffix}`);
        const maxHp = Math.round((80 + status.constitution * 4) * mult.hp * (behavior === "tank" ? 1.5 : 1));
        const maxStamina = 50 + status.constitution * 5;
        // 부모 옆 빈 칸 찾기 (간단히 ±1)
        let sx = cx; let sy = cy;
        for (let t = 0; t < 5; t += 1) {
          const tx = cx + Math.floor(Math.random() * 3) - 1;
          const ty = cy + Math.floor(Math.random() * 3) - 1;
          if (tx < 0 || ty < 0 || tx >= world.map.width || ty >= world.map.height) continue;
          if (world.map.collision[ty]?.[tx] === 1) continue;
          sx = tx; sy = ty; break;
        }
        world.actors[id] = {
          id, kind: "monster",
          name: `${TIER_PREFIX[childTier]}${namePrefix}`,
          assetKey: `${assetKey}${tierSuffix}`,
          x: sx, y: sy,
          hp: maxHp, maxHp,
          mp: 0, maxMp: 0,
          stamina: maxStamina, maxStamina,
          hunger: 0, maxHunger: 80 + status.constitution * 4,
          status, skills: [], gold: 0, inventory: [], alive: true
        };
        bornCount += 1;
      }
    }
  }
  if (bornCount > 0) console.log(`[monster] bred ${bornCount} new hostile (alive ${hostileAlive.length} → ${hostileAlive.length + bornCount}, cap ${HOSTILE_POPULATION_CAP})`);
};

const tickMonsterAI = (world: WorldState, monster: Actor): void => {
  const inCombat = (monster.lastAttackedAtTick !== undefined) && ((world.tick - monster.lastAttackedAtTick) < MONSTER_OUT_OF_COMBAT_TICKS);
  // 1) HP regen out-of-combat (피격 후 100 tick 정지, 그 외 0.05/tick).
  if (!inCombat && !monster.attackTargetId && !monster.movePath) {
    monster.hp = Math.min(monster.maxHp, monster.hp + MONSTER_HP_REGEN_PER_TICK);
  }
  // 2026-05-09: 티어별 pursue radius 가산 (alpha +3, dire +6).
  const tier = inferMonsterTier(monster.assetKey);
  const kind = inferMonsterKind(monster.assetKey ?? "");
  const def = kind ? MONSTER_CATALOG[kind] : undefined;
  const behavior = behaviorForMonster(monster.assetKey) ?? def?.behavior ?? "territorial";
  const isNight = world.timeOfDay >= 20 || world.timeOfDay < 5;
  const basePursueRadius = behavior === "predator"
    ? 18
    : behavior === "ranged"
    ? 16
    : behavior === "territorial"
    ? 6
    : MONSTER_PURSUE_RADIUS;
  const pursueRadius = basePursueRadius + TIER_MULT[tier].pursueBonus + (behavior === "hostile_night" && isNight ? 4 : 0);

  if (behavior === "passive") {
    monster.attackTargetId = undefined;
    monster.attackUntil = undefined;
    let nearest: Actor | undefined; let nearestDist = Infinity;
    for (const other of Object.values(world.actors)) {
      if (!other.alive || other.kind === "monster") continue;
      const d = Math.abs(other.x - monster.x) + Math.abs(other.y - monster.y);
      if (d <= 6 && d < nearestDist) { nearest = other; nearestDist = d; }
    }
    if (nearest) {
      const dxRaw = monster.x - nearest.x;
      const dyRaw = monster.y - nearest.y;
      const useDx = Math.abs(dxRaw) >= Math.abs(dyRaw);
      const dx = useDx ? Math.sign(dxRaw) || (Math.random() < 0.5 ? -1 : 1) : 0;
      const dy = useDx ? 0 : Math.sign(dyRaw) || (Math.random() < 0.5 ? -1 : 1);
      const x = Math.max(0, Math.min(world.map.width - 1, monster.x + dx));
      const y = Math.max(0, Math.min(world.map.height - 1, monster.y + dy));
      if (!tileBlocked(world, x, y)) {
        dispatchAction(world, { actorId: monster.id, action: { type: "MOVE", to: { xy: { x, y } } } });
      }
      return;
    }
  }
  // 2) Hostile 추격: pursueRadius 이내 player/npc 발견 시 sticky ATTACK intent 생산.
  // 2026-05-09 Phase B.1: alpha/dire 티어는 종(boar/deer 비선공 포함) 무관 적대.
  const isAggro = behavior === "territorial"
    || behavior === "predator"
    || behavior === "ranged"
    || behavior === "tank"
    || behavior === "hostile_night"
    || (behavior === "hostile_day" && !isNight)
    || tier >= 2;
  if (isAggro && !monster.attackTargetId) {
    let nearest: Actor | undefined; let nearestDist = Infinity;
    const territory = behavior === "territorial" ? placeAt(world, monster) : null;
    for (const other of Object.values(world.actors)) {
      if (other.id === monster.id || !other.alive) continue;
      if (other.kind === "monster") continue;
      const d = Math.abs(other.x - monster.x) + Math.abs(other.y - monster.y);
      if (behavior === "territorial") {
        const inTerritory = territory
          ? other.x >= territory.x && other.x < territory.x + territory.width && other.y >= territory.y && other.y < territory.y + territory.height
          : d <= 6;
        if (!inTerritory) continue;
      }
      if (d <= pursueRadius && d < nearestDist) { nearest = other; nearestDist = d; }
    }
    if (nearest) {
      dispatchAction(world, {
        actorId: monster.id,
        action: {
          type: "ATTACK",
          targetId: nearest.id,
          until: [
          { kind: "target_dead" },
          { kind: "target_lost" },
          { kind: "self_stamina_below", value: 8 },
          { kind: "max_ticks", value: 200 }
          ]
        }
      });
    }
  }

  if (monster.attackTargetId || monster.movePath) return;

  if (world.tick % MONSTER_WANDER_INTERVAL === Math.floor((monster.x + monster.y) % MONSTER_WANDER_INTERVAL)) {
    // 2026-05-09 v3: 마을 강제 유인 제거. 자연스러운 random wander + 같은 종 4타일 내 있으면 pack cohesion (군집).
    let dx = 0, dy = 0;
    const PACK_RADIUS = 4;
    let packCx = 0, packCy = 0, packCount = 0;
    const myKind = inferMonsterKind(monster.assetKey ?? "");
    if (myKind) {
      for (const other of Object.values(world.actors)) {
        if (other.id === monster.id || !other.alive) continue;
        if (other.kind !== "monster") continue;
        if (inferMonsterKind(other.assetKey ?? "") !== myKind) continue;
        const md = Math.abs(other.x - monster.x) + Math.abs(other.y - monster.y);
        if (md > 0 && md <= PACK_RADIUS * 2) { packCx += other.x; packCy += other.y; packCount += 1; }
      }
    }
    // 동료 ≥1 이고 너무 멀어지면 (≥3 타일) 30% 확률로 pack 중심 방향
    if (packCount >= 1 && Math.random() < 0.30) {
      const cx = packCx / packCount; const cy = packCy / packCount;
      const ddx = cx - monster.x; const ddy = cy - monster.y;
      const dist = Math.abs(ddx) + Math.abs(ddy);
      if (dist >= 3) {
        const useDx = Math.abs(ddx) >= Math.abs(ddy);
        dx = useDx ? Math.sign(ddx) : 0;
        dy = useDx ? 0 : Math.sign(ddy);
      }
    }
    if (dx === 0 && dy === 0) {
      dx = Math.floor(Math.random() * 3) - 1;
      dy = dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    }
    if (dx !== 0 || dy !== 0) {
      dispatchAction(world, {
        actorId: monster.id,
        action: {
          type: "MOVE",
          to: {
            xy: {
              x: Math.max(0, Math.min(world.map.width - 1, monster.x + dx)),
              y: Math.max(0, Math.min(world.map.height - 1, monster.y + dy))
            }
          }
        }
      });
    }
  }
};

/**
 * actor 가 movePath 를 가지고 있으면 매 tickWorld 호출 시 cooldown 검사 후 1 칸 자동 진행.
 * cooldown 은 dispatchAction 의 MOVE 핸들러 가 actor.lastMoveTick 으로 관리.
 * 즉 LLM 결정 없이도 path 따라 자연 이동 (속도는 stat·skill 차등).
 */
const advanceMovePath = (world: WorldState, actor: Actor): void => {
  const path = actor.movePath;
  if (!path || path.length === 0) return;
  let next = path[0];
  if (tileBlocked(world, actor.x + next.dx, actor.y + next.dy)) {
    const target = actor.movePathTarget;
    const replanned = target ? findPath(world, { x: actor.x, y: actor.y }, target, 80) : null;
    if (!replanned || replanned.length === 0) {
      actor.movePath = undefined;
      actor.movePathTarget = undefined;
      return;
    }
    actor.movePath = replanned;
    next = replanned[0];
    if (tileBlocked(world, actor.x + next.dx, actor.y + next.dy)) return;
  }
  const result = dispatchAction(world, {
    actorId: actor.id,
    action: { type: "MOVE", dx: next.dx, dy: next.dy }
  });
  if (result.ok) {
    actor.movePath = (actor.movePath ?? path).slice(1);
    if (actor.movePath.length === 0) actor.movePath = undefined;
  } else if (result.message === "blocked_tile") {
    const target = actor.movePathTarget;
    const replanned = target ? findPath(world, { x: actor.x, y: actor.y }, target, 80) : null;
    actor.movePath = replanned && replanned.length > 0 ? replanned : undefined;
    if (!actor.movePath) actor.movePathTarget = undefined;
  } else if (result.message !== "move_cooldown" && result.message !== "stamina_too_low") {
    // 회복 불가 막힘 (out_of_bounds 등) → path 폐기, brain 이 새 결정
    actor.movePath = undefined;
    actor.movePathTarget = undefined;
  }
};

type GatherIntent = NonNullable<Actor["gatherIntent"]>;
type PendingUse = NonNullable<Actor["pendingUse"]>;

const GATHER_DEFAULT_RADIUS = 12;
const PENDING_USE_TIMEOUT_TICKS = 100;

const pushGatherEvent = (
  world: WorldState,
  actor: Actor,
  type: "gather:progress" | "gather:done",
  step: GatherIntent,
  count: number
): void => {
  world.eventQueue ??= [];
  world.eventQueue.push({
    tick: world.tick,
    actorId: actor.id,
    category: "action",
    type,
    result: "success",
    payload: { action: { type: "GATHER", item: step.item, count }, item: step.item, count, total: step.collected }
  });
};

const pushPendingUseEvent = (
  world: WorldState,
  actor: Actor,
  type: "use:timeout" | "use:target_missing" | "use:path_unreachable" | "craft_completed",
  result: "success" | "failed" | "info",
  pending: PendingUse,
  reason?: string
): void => {
  world.eventQueue ??= [];
  world.eventQueue.push({
    tick: world.tick,
    actorId: actor.id,
    category: "action",
    type,
    result,
    reason,
    payload: {
      action: {
        type: "USE",
        objectId: pending.objectId,
        itemId: pending.itemId,
        targetItemId: pending.targetItemId,
        skillId: pending.skillId
      },
      queuedAtTick: pending.queuedAtTick
    }
  });
};

const gatherOrigin = (_world: WorldState, actor: Actor, _step: GatherIntent): { x: number; y: number } => ({ x: actor.x, y: actor.y });

const withinGatherScope = (
  world: WorldState,
  actor: Actor,
  step: GatherIntent,
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

const inventoryCanAccept = (actor: Actor, itemIdOrKey: string): boolean => {
  const key = itemKeyOf(itemIdOrKey);
  if (!itemStackable(key)) return inventorySlotsUsed(actor.inventory) < INVENTORY_LIMIT;
  for (const slot of actor.inventory) {
    if (slot.kind === "stack" && slot.item === key && slot.count < itemMaxStack(key)) return true;
  }
  return inventorySlotsUsed(actor.inventory) < INVENTORY_LIMIT;
};

const structureResource = (struct: Structure): "wood" | "ore" | "coal" | "fish" | "herb" | "berry" | null => {
  if (struct.type === "tree") return "wood";
  if (struct.type === "rock") return "ore";
  if (struct.type === "fishing_spot") return "fish";
  if (struct.type === "herb_bed") return "herb";
  if (struct.type === "berry_bush" || struct.type === "bush") return "berry";
  return null;
};

const requiredToolForStructure = (step: GatherIntent, struct: Structure): string | null => {
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

type GatherCandidate = {
  kind: "groundItem" | "structure";
  id: string;
  target: { x: number; y: number };
  path: Array<{ dx: number; dy: number }>;
  cost: number;
};

const nearestKnownGatherSource = (
  world: WorldState,
  step: GatherIntent
): { x: number; y: number } | null => {
  let best: { x: number; y: number; d: number } | null = null;
  const itemMatches = (g: GroundItem): boolean => itemKeyOf(g.id) === step.item;
  for (const g of Object.values(world.groundItems ?? {})) {
    if (!itemMatches(g)) continue;
    const d = Math.abs(g.x) + Math.abs(g.y);
    if (!best || d < best.d) best = { x: g.x, y: g.y, d };
  }
  for (const struct of Object.values(world.structures ?? {})) {
    const resource = structureResource(struct);
    if (resource !== step.item && !(step.item === "coal" && struct.type === "rock")) continue;
    const c = structureCenter(struct);
    const d = Math.abs(c.x) + Math.abs(c.y);
    if (!best || d < best.d) best = { x: c.x, y: c.y, d };
  }
  return best ? { x: best.x, y: best.y } : null;
};

const findGatherCandidate = (
  world: WorldState,
  actor: Actor,
  step: GatherIntent
): { candidate: GatherCandidate | null; sawSourceInScope: boolean; missingTool: string | null } => {
  let best: GatherCandidate | null = null;
  let sawSourceInScope = false;
  let missingTool: string | null = null;
  const consider = (candidate: GatherCandidate): void => {
    if (!best || candidate.cost < best.cost) best = candidate;
  };

  for (const g of Object.values(world.groundItems ?? {})) {
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

const clearGatherClaim = (world: WorldState, actor: Actor, step: GatherIntent): void => {
  if (!step.targetId || !step.targetKind) return;
  if (step.targetKind === "groundItem") {
    const g = world.groundItems[step.targetId];
    if (g?.claimedBy === actor.id) g.claimedBy = undefined;
  } else {
    const s = world.structures?.[step.targetId];
    if (s?.props?.gatherClaimBy === actor.id) {
      const { gatherClaimBy: _claim, ...rest } = s.props;
      s.props = rest;
    }
  }
  step.targetId = undefined;
  step.targetKind = undefined;
};

const gatherFailureReason = (
  world: WorldState,
  actor: Actor,
  step: GatherIntent,
  head: string
): string => {
  const origin = gatherOrigin(world, actor, step);
  const nearest = nearestKnownGatherSource(world, step);
  const nearestPart = nearest ? ` nearest=(${nearest.x},${nearest.y})` : "";
  return `${head}:${step.item} radius=${step.area?.radius ?? GATHER_DEFAULT_RADIUS} near=(${Math.floor(origin.x)},${Math.floor(origin.y)})${nearestPart}`;
};

const failGatherIntent = (world: WorldState, actor: Actor, step: GatherIntent, reason: string): void => {
  clearGatherClaim(world, actor, step);
  actor.gatherIntent = undefined;
  actor.lastBlockedPlan = { tick: world.tick, text: `GATHER ${step.item} count=${step.count} failed: ${reason}`, reason };
  actor.recentBlockers = [...(actor.recentBlockers ?? []), { tick: world.tick, reason }].slice(-5);
  world.revision += 1;
};

const runAutoGather = (world: WorldState, actor: Actor): boolean => {
  const step = actor.gatherIntent;
  if (!step) return false;
  if (step.collected >= step.count || inventoryCountOf(actor.inventory, step.item) >= step.count) {
    clearGatherClaim(world, actor, step);
    pushGatherEvent(world, actor, "gather:done", step, Math.max(step.collected, step.count));
    actor.gatherIntent = undefined;
    actor.movePath = undefined;
    actor.movePathTarget = undefined;
    world.revision += 1;
    return true;
  }

  if (step.targetKind === "groundItem" && step.targetId) {
    const target = world.groundItems[step.targetId];
    if (!target) {
      clearGatherClaim(world, actor, step);
    } else if (sameCell(actor, target)) {
      if (!inventoryCanAccept(actor, target.id)) {
        failGatherIntent(world, actor, step, "inventory_full");
        return true;
      }
      const result = dispatchAction(world, { actorId: actor.id, action: { type: "PICKUP", itemId: target.id } });
      clearGatherClaim(world, actor, step);
      if (result.ok) {
        step.collected += 1;
        pushGatherEvent(world, actor, "gather:progress", step, step.collected);
        if (step.collected >= step.count) {
          pushGatherEvent(world, actor, "gather:done", step, step.collected);
          actor.gatherIntent = undefined;
        }
      } else {
        failGatherIntent(world, actor, step, result.message === "inventory_full" ? "inventory_full" : `transient:${result.message}`);
      }
      return true;
    } else if (!actor.movePath || !actor.movePathTarget || !sameCell(actor.movePathTarget, target)) {
      const path = findPath(world, { x: actor.x, y: actor.y }, { x: target.x, y: target.y }, 120);
      if (!path) clearGatherClaim(world, actor, step);
      else {
        actor.movePath = path;
        actor.movePathTarget = { x: target.x, y: target.y };
      }
    }
    if (step.targetId) {
      advanceMovePath(world, actor);
      return true;
    }
  }

  if (step.targetKind === "structure" && step.targetId) {
    const struct = world.structures?.[step.targetId];
    if (!struct) {
      clearGatherClaim(world, actor, step);
    } else {
      const center = structureCenter(struct);
      const dist = Math.max(Math.abs(actor.x - center.x), Math.abs(actor.y - center.y));
      if (dist <= Math.max(struct.width, struct.height)) {
        const result = dispatchAction(world, { actorId: actor.id, action: { type: "USE", objectId: struct.id } });
        clearGatherClaim(world, actor, step);
        if (!result.ok) {
          const reason = result.message === "axe_required"
            ? "repair:inventory_short:axe 0/1"
            : result.message === "pickaxe_required"
            ? "repair:inventory_short:pickaxe 0/1"
            : result.message === "fishing_rod_required"
            ? "repair:inventory_short:fishing_rod 0/1"
            : result.message.startsWith("harvest_regrowing")
            ? "transient:structure_regrowing"
            : `transient:${result.message}`;
          failGatherIntent(world, actor, step, reason);
        }
        return true;
      }
      if (!actor.movePath || !actor.movePathTarget) {
        const targetCells = gatherTargetCellsForStructure(world, struct)
          .map((target) => ({ target, path: findPath(world, { x: actor.x, y: actor.y }, target, 120) }))
          .filter((p): p is { target: { x: number; y: number }; path: Array<{ dx: number; dy: number }> } => Boolean(p.path))
          .sort((a, b) => a.path.length - b.path.length);
        if (targetCells.length === 0) clearGatherClaim(world, actor, step);
        else {
          actor.movePath = targetCells[0].path;
          actor.movePathTarget = targetCells[0].target;
        }
      }
      if (step.targetId) {
        advanceMovePath(world, actor);
        return true;
      }
    }
  }

  const { candidate, sawSourceInScope, missingTool } = findGatherCandidate(world, actor, step);
  if (!candidate) {
    actor.movePath = undefined;
    actor.movePathTarget = undefined;
    if (step.allowWaitSpawn && !missingTool && !sawSourceInScope) return true;
    const reason = missingTool
      ? `repair:inventory_short:${missingTool} 0/1`
      : sawSourceInScope
      ? "permanent:path_unreachable"
      : gatherFailureReason(world, actor, step, "repair:no_item_in_radius");
    failGatherIntent(world, actor, step, reason);
    return true;
  }

  step.targetId = candidate.id;
  step.targetKind = candidate.kind;
  if (candidate.kind === "groundItem") {
    const g = world.groundItems[candidate.id];
    if (g) g.claimedBy = actor.id;
  } else {
    const s = world.structures[candidate.id];
    if (s) s.props = { ...(s.props ?? {}), gatherClaimBy: actor.id };
  }
  actor.movePath = candidate.path;
  actor.movePathTarget = candidate.target;
  advanceMovePath(world, actor);
  return true;
};

const structureUseReady = actorNearStructure;

const clearPendingUse = (
  world: WorldState,
  actor: Actor,
  pending: PendingUse,
  type: "use:timeout" | "use:target_missing" | "use:path_unreachable",
  reason: string
): void => {
  actor.pendingUse = undefined;
  actor.movePath = undefined;
  actor.movePathTarget = undefined;
  actor.lastBlockedPlan = { tick: world.tick, text: `USE ${pending.objectId ?? pending.itemId ?? pending.skillId ?? "?"} failed: ${reason}`, reason };
  actor.recentBlockers = [...(actor.recentBlockers ?? []), { tick: world.tick, reason }].slice(-5);
  pushPendingUseEvent(world, actor, type, "failed", pending, reason);
  world.revision += 1;
};

const runPendingUse = (world: WorldState, actor: Actor): boolean => {
  const pending = actor.pendingUse;
  if (!pending) return false;
  if (world.tick - pending.queuedAtTick > PENDING_USE_TIMEOUT_TICKS) {
    clearPendingUse(world, actor, pending, "use:timeout", "pending_use_timeout");
    return true;
  }

  if (!pending.objectId) {
    actor.pendingUse = undefined;
    return false;
  }

  const struct = world.structures?.[pending.objectId];
  if (!struct) {
    clearPendingUse(world, actor, pending, "use:target_missing", `object_not_found:${pending.objectId}`);
    return true;
  }

  if (structureUseReady(actor, struct)) {
    const result = dispatchAction(world, {
      actorId: actor.id,
      action: {
        type: "USE",
        objectId: pending.objectId,
        itemId: pending.itemId,
        targetItemId: pending.targetItemId,
        skillId: pending.skillId
      }
    });

    if (result.message.startsWith("pending_use_approach:")) {
      actor.pendingUse = pending;
      return true;
    }

    actor.pendingUse = undefined;
    actor.movePath = undefined;
    actor.movePathTarget = undefined;
    const craftSucceeded = result.message.startsWith("crafted_output_added:") || result.message.startsWith("crafted:");
    if (craftSucceeded) {
      pushPendingUseEvent(world, actor, "craft_completed", "success", pending);
    } else {
      const reason = result.ok ? `unexpected_pending_use_result:${result.message}` : result.message;
      actor.lastBlockedPlan = { tick: world.tick, text: `USE ${pending.objectId ?? pending.itemId ?? pending.skillId ?? "?"} failed: ${reason}`, reason };
      actor.recentBlockers = [...(actor.recentBlockers ?? []), { tick: world.tick, reason }].slice(-5);
      pushPendingUseEvent(world, actor, "craft_completed", "failed", pending, reason);
    }
    world.revision += 1;
    return true;
  }

  if (!actor.movePath || !actor.movePathTarget) {
    const targetCells = gatherTargetCellsForStructure(world, struct)
      .map((target) => ({ target, path: findPath(world, { x: actor.x, y: actor.y }, target, 120) }))
      .filter((p): p is { target: { x: number; y: number }; path: Array<{ dx: number; dy: number }> } => Boolean(p.path))
      .sort((a, b) => a.path.length - b.path.length);
    if (targetCells.length === 0) {
      clearPendingUse(world, actor, pending, "use:path_unreachable", "path_unreachable");
      return true;
    }
    actor.movePath = targetCells[0].path;
    actor.movePathTarget = targetCells[0].target;
  }

  advanceMovePath(world, actor);
  return true;
};

export const tickWorld = (world: WorldState): void => {
  world.tick += 1;
  // 2026-05-06: 1 tick = 1 game minute. 1 game day = 1440 tick.
  // 직전 0.01 (=0.6 game min) → 0.01667 (=1 game min). 30분 라이브 = 1.25 game day.
  world.timeOfDay = (world.timeOfDay + 1/60) % 24;
  tickWorldContext(world);
  cleanupPendingTrades(world);
  maturateCrops(world);
  fruitTreeRegen(world);
  // 2026-05-08: hostile floor check — 멸종 방지.
  maybeRespawnHostile(world);
  maybeBreedHostile(world);  // 2026-05-09 v4: 자연 번식 — 같은 종 인접 시 점진 증식.

  for (const actor of Object.values(world.actors)) {
    if (!actor.alive) continue;
    updateDiscoveredPlaces(world, actor);
    const constitution = actor.status?.constitution ?? 5;
    const intelligence = actor.status?.intelligence ?? 5;
    const meditation = actor.skills?.find((skill) => skill.id === "meditation")?.level ?? 0;
    const monsterBehavior = actor.kind === "monster" ? behaviorForMonster(actor.assetKey) : null;
    // 2026-05-08: 모든 max stat stat-coupled 재산정. 직전엔 maxStamina 만 했음.
    // 2026-05-09: leather_armor 보유 시 +15 maxHp.
    actor.maxHp = Math.round((80 + constitution * 4) * (monsterBehavior === "tank" ? 1.5 : 1)) + armorMaxHpBonus(actor);
    actor.maxStamina = 50 + constitution * 5;
    actor.maxMp = actor.kind === "monster" ? 0 : (10 + intelligence * 2);
    actor.maxHunger = 80 + constitution * 4;
    // 2026-05-07: monster 는 hunger 증가 X (테스트 동안 mock AI 라 식량 채집 X 굶주려 감).
    if (actor.kind !== "monster") {
      actor.hunger = Math.min(actor.maxHunger, actor.hunger + 0.008);
    }
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 0.10 + meditation * 0.05);

    if (actor.hunger >= actor.maxHunger) {
      actor.hp = Math.max(0, actor.hp - 0.01);
    }

    if (actor.kind === "npc" && actor.hunger < actor.maxHunger * 0.5) {
      actor.hp = Math.min(actor.maxHp, actor.hp + 0.05);
    }

    const handledSleep = tickSleep(world, actor);
    if (handledSleep) continue;

    const handledGather = runAutoGather(world, actor);
    const handledPendingUse = handledGather ? false : runPendingUse(world, actor);
    // path 자동 진행 (NPC + player). monster 는 별도 AI.
    if (!handledGather && !handledPendingUse && actor.kind !== "monster") {
      advanceMovePath(world, actor);
    } else if (!handledGather && !handledPendingUse) {
      // 2026-05-08: monster AI — hp regen + wander + 추격.
      tickMonsterAI(world, actor);
      advanceMovePath(world, actor);
    }
    // P0-4: ATTACK 자동 반복 — attackTargetId stash 있으면 매 tick cooldown 통과 시 한 번 공격/접근.
    if (!handledGather && !handledPendingUse && actor.attackTargetId) {
      tickAutoAttack(world, actor);
    }
  }
};
