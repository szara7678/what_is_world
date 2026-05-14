import { createDefaultWorldContext, migrateInventoryFromStringArray, type Actor, type ActorStatus, type Place, type Skill, type WorldState } from "@wiw/shared";
import { relocateGroundItems } from "../placement/groundItems";

const createLayer = (width: number, height: number, fill = 0): number[][] =>
  Array.from({ length: height }, () => Array.from({ length: width }, () => fill));

const DEFAULT_STATUS: ActorStatus = { strength: 5, dexterity: 5, constitution: 5, intelligence: 5 };

const statusForRole = (role: "hero" | "farmer" | "baker" | "merchant" | "guard" | "wanderer" | "monster"): ActorStatus => {
  if (role === "monster") return { strength: 2, dexterity: 4, constitution: 3, intelligence: 1 };
  const status = { ...DEFAULT_STATUS };
  if (role === "hero") {
    status.strength += 1;
    status.dexterity += 1;
  } else if (role === "farmer") {
    status.constitution += 1;
    status.strength += 1;
  } else if (role === "baker") {
    status.intelligence += 1;
    status.constitution += 1;
  } else if (role === "merchant") {
    status.intelligence += 1;
    status.dexterity += 1;
  } else if (role === "guard") {
    status.strength += 1;
    status.constitution += 1;
  } else if (role === "wanderer") {
    status.dexterity += 1;
    status.intelligence += 1;
  }
  return status;
};

// 2026-05-08: 모든 max stat 을 stat-coupled 공식으로 통일.
//  - maxHp:     80 + constitution * 4   (con 5 → 100, con 7 → 108)
//  - maxStamina: 50 + constitution * 5   (con 5 → 75, con 7 → 85)
//  - maxMp:     10 + intelligence * 2   (int 5 → 20, int 7 → 24)
//  - maxHunger: 80 + constitution * 4   (con 5 → 100 ceiling, con 7 → 108)
//  공식 변경 시 actor 생성 + recomputeMaxStats(actor) 두 곳 모두 동기화.
export const maxStaminaFor = (status: ActorStatus): number => 50 + status.constitution * 5;
export const maxHpFor       = (status: ActorStatus): number => 80 + status.constitution * 4;
export const maxMpFor       = (status: ActorStatus): number => 10 + status.intelligence * 2;
export const maxHungerFor   = (status: ActorStatus): number => 80 + status.constitution * 4;

/** 모든 max 스탯을 status 기준으로 다시 산정 + 현재 값 cap 보정. skill xp 가 status 변동시킨 후 호출. */
export function recomputeMaxStats(actor: { status: ActorStatus; maxHp: number; maxStamina: number; maxMp: number; maxHunger?: number; hp: number; stamina: number; mp: number; hunger: number }): void {
  actor.maxHp = maxHpFor(actor.status);
  actor.maxStamina = maxStaminaFor(actor.status);
  actor.maxMp = maxMpFor(actor.status);
  actor.maxHunger = maxHungerFor(actor.status);
  if (actor.hp > actor.maxHp) actor.hp = actor.maxHp;
  if (actor.stamina > actor.maxStamina) actor.stamina = actor.maxStamina;
  if (actor.mp > actor.maxMp) actor.mp = actor.maxMp;
  if (actor.hunger > actor.maxHunger) actor.hunger = actor.maxHunger;
}

// Skill name (한국어) is kept as a frontend display label; description and affordanceHint are English (LLM-facing).
export const createDefaultSkills = (): Skill[] => [
  { id: "running", name: "running", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "dexterity",
    description: "reduces MOVE stamina cost (0.5%/level)" },
  { id: "swordsmanship", name: "swordsmanship", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength",
    description: "ATTACK damage +5%/level",
    triggers: [{ monsterNearby: true }],
    actionTemplate: { type: "ATTACK" },
    affordanceHint: "if a threat is near, you can raise a weapon and meet it" },
  { id: "archery", name: "archery", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "dexterity",
    description: "ranged ATTACK accuracy/range affinity; bows and archer threats surface this skill",
    triggers: [{ monsterNearby: true }],
    actionTemplate: { type: "ATTACK" },
    affordanceHint: "with a bow or a distant threat, keep space and loose a shot" },
  { id: "hunting", name: "hunting", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength",
    description: "monster combat practice; ATTACK damage +0.5/level against creatures",
    triggers: [{ monsterNearby: true }],
    actionTemplate: { type: "ATTACK" },
    affordanceHint: "track a beast, close carefully, and finish the hunt" },
  { id: "gathering", name: "gathering", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength",
    description: "USE on a resource may yield extra (+3%/level)",
    triggers: [{ always: true }],
    actionTemplate: { type: "GATHER" },
    affordanceHint: "if a resource is in sight, you can commit and gather as much as your hand allows" },
  { id: "mining", name: "mining", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength",
    description: "rock USE/GATHER yields extra ore/coal chance (+5%/level)",
    triggers: [{ requiredItems: [{ item: "pickaxe", count: 1 }] }],
    actionTemplate: { type: "GATHER" },
    affordanceHint: "with a pickaxe at a rock face, ore and coal come loose" },
  { id: "woodcutting", name: "woodcutting", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength",
    description: "tree USE/GATHER yields extra wood chance (+5%/level)",
    triggers: [{ requiredItems: [{ item: "axe", count: 1 }] }],
    actionTemplate: { type: "GATHER" },
    affordanceHint: "with an axe at a tree, split the trunk into usable wood" },
  { id: "fishing", name: "fishing", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "dexterity",
    description: "USE fishing_rod near water for a chance at fish (+5%/level)",
    triggers: [{ requiredItems: [{ item: "fishing_rod", count: 1 }], placeKind: "pond" }, { requiredItems: [{ item: "fishing_rod", count: 1 }], placeKind: "well" }],
    actionTemplate: { type: "USE", itemId: "fishing_rod" },
    affordanceHint: "with a fishing_rod by the water, fish follow the line" },
  { id: "foraging", name: "foraging", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "dexterity",
    description: "PICKUP near forest_edge has +0.03/level extra yield chance" },
  // 2026-05-08: cooking 단일 스킬로 통합. 이전 baking/cooking 분리 폐지.
  // - oven USE (bread, cooked_fish 등) 시 xp 부여
  // - edible USE 시 hunger 회복 +5%/level multiplier
  { id: "cooking", name: "cooking", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence",
    description: "Bake/cook at oven (USE objectId=structure-oven targetItemId=bread|cooked_fish). Edible USE also recovers more hunger (+5%/level).",
    triggers: [{ stationType: "oven", requiredItems: [{ item: "wheat", count: 2 }] }],
    actionTemplate: { type: "USE", objectId: "structure-oven", targetItemId: "bread" },
    affordanceHint: "by the oven with 2 wheat, a loaf of bread rises" },
  { id: "conversation", name: "conversation", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence",
    description: "SPEAK affinity shift +5%/level" },
  { id: "diplomacy", name: "diplomacy", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence",
    description: "SPEAK with claims improves heard_claim retention and relationship gains (+3%/level)" },
  { id: "trading", name: "trading", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence",
    description: "OFFER_TRADE practice; better trade framing and market memory (+5%/level)",
    triggers: [{ always: true }],
    actionTemplate: { type: "OFFER_TRADE" },
    affordanceHint: "make a clear offer and ask for the exact item or gold you need" },
  { id: "farming", name: "farming", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "constitution",
    description: "field USE yields extra (+5%/level)",
    triggers: [{ placeKind: "field", requiredItems: [{ item: "wheat", count: 1 }] }],
    actionTemplate: { type: "USE", itemId: "wheat" },
    affordanceHint: "place a wheat grain onto field soil and a stalk rises in days" },
  { id: "meditation", name: "meditation", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "constitution",
    description: "PRAY/WAIT recovers stamina +0.05/level/tick",
    triggers: [{ placeKind: "shrine" }],
    actionTemplate: { type: "PRAY" },
    affordanceHint: "kneel a beat at the shrine and the breath settles" },
  // baking 폐지 → cooking 으로 통합 (2026-05-08).
  { id: "smithing", name: "smithing", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength",
    description: "forge USE: ore + wood -> tool",
    triggers: [{ stationType: "forge", requiredItems: [{ item: "ore", count: 2 }, { item: "wood", count: 2 }] }],
    actionTemplate: { type: "USE", objectId: "structure-forge", targetItemId: "pickaxe" },
    affordanceHint: "at the forge with 2 ore and 2 wood, a tool head takes weight" },
  { id: "tailoring", name: "tailoring", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "dexterity",
    description: "workbench hide/leather craft; lv3 makes leather_armor grant +5 extra maxHp",
    triggers: [{ stationType: "workbench", requiredItems: [{ item: "hide", count: 2 }] }],
    actionTemplate: { type: "USE", objectId: "structure-workbench", targetItemId: "leather_armor" },
    affordanceHint: "at the workbench with hide, stitch leather into fitted protection" },
  { id: "alchemy", name: "alchemy", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence",
    description: "alchemy_table USE: 2 herb + 1 berry -> 1 healing_potion",
    triggers: [{ stationType: "alchemy_table", requiredItems: [{ item: "herb", count: 2 }] }],
    actionTemplate: { type: "USE", objectId: "structure-alchemy-table", targetItemId: "healing_potion" },
    affordanceHint: "at the alchemy_table with 2 herb and 1 berry, a small vial fills" },
  { id: "architecture", name: "architecture", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence",
    description: "workbench USE: wood -> blueprint",
    triggers: [{ stationType: "workbench", requiredItems: [{ item: "wood", count: 5 }] }],
    actionTemplate: { type: "USE", objectId: "structure-workbench" },
    affordanceHint: "at the workbench with 5 wood, a blueprint shapes itself" },
  { id: "appraise", name: "appraise", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence",
    description: "USE skillId=appraise to inspect a target. Higher level reveals more.",
    triggers: [{ always: true }],
    actionTemplate: { type: "USE", skillId: "appraise" },
    affordanceHint: "pause a beat to inspect an unfamiliar item or person and details surface" }
];

export const createWorldState = (width = 24, height = 16): WorldState => {
  const terrain = createLayer(width, height, 1);
  const collision = createLayer(width, height, 0);
  const decor = createLayer(width, height, 0);

  for (let x = 0; x < width; x += 1) {
    collision[0][x] = 1;
    collision[height - 1][x] = 1;
  }
  for (let y = 0; y < height; y += 1) {
    collision[y][0] = 1;
    collision[y][width - 1] = 1;
  }

  const playerStatus = statusForRole("hero");
  const player: Actor = {
    id: "player-1",
    kind: "player",
    name: "Hero",
    assetKey: "human.default",
    x: 2,
    y: 2,
    hp: maxHpFor(playerStatus),
    maxHp: maxHpFor(playerStatus),
    mp: maxMpFor(playerStatus),
    maxMp: maxMpFor(playerStatus),
    stamina: maxStaminaFor(playerStatus),
    maxStamina: maxStaminaFor(playerStatus),
    hunger: 0,
    maxHunger: maxHungerFor(playerStatus),
    status: playerStatus,
    skills: createDefaultSkills(),
    gold: 10,
    inventory: [],
    alive: true
  };

  const dummy: Actor = {
    ...player,
    id: "npc-1",
    kind: "npc",
    name: "Villager",
    assetKey: "human.villager",
    x: 5,
    y: 5,
    status: statusForRole("wanderer"),
    skills: createDefaultSkills()
  };

  const monsterStatus = statusForRole("monster");
  const animal: Actor = {
    ...player,
    id: "animal-1",
    kind: "monster",
    name: "Boar",
    assetKey: "animal.boar",
    x: 8,
    y: 6,
    hp: maxHpFor(monsterStatus),
    maxHp: maxHpFor(monsterStatus),
    mp: 0,
    maxMp: 0,
    stamina: maxStaminaFor(monsterStatus),
    maxStamina: maxStaminaFor(monsterStatus),
    hunger: 0,
    maxHunger: maxHungerFor(monsterStatus),
    status: monsterStatus,
    skills: createDefaultSkills(),
    gold: 0
  };

  const world: WorldState = {
    revision: 1,
    tick: 0,
    timeOfDay: 8,
    context: createDefaultWorldContext(0),
    map: { width, height, tileSize: 32, terrain, collision, decor },
    structures: {},
    places: {},
    actors: { [player.id]: player, [dummy.id]: dummy, [animal.id]: animal },
    groundItems: { "carrot-1": { id: "carrot-1", x: 3, y: 2, type: "food", iconKey: "item.food.carrot" } },
    spawnPoints: {
      humans: [{ x: 2, y: 2, assetKey: "human.default" }],
      animals: [{ x: 8, y: 6, assetKey: "animal.boar" }],
      monsters: [{ x: 5, y: 5, assetKey: "monster.slime" }]
    }
  };
  relocateGroundItems(world);
  return world;
};

const fillRect = (layer: number[][], x: number, y: number, width: number, height: number, tile: number): void => {
  for (let yy = y; yy < y + height; yy += 1) {
    if (!layer[yy]) continue;
    for (let xx = x; xx < x + width; xx += 1) {
      if (xx < 0 || xx >= layer[yy].length) continue;
      layer[yy][xx] = tile;
    }
  }
};

const createActor = (
  id: string,
  kind: Actor["kind"],
  name: string,
  assetKey: string,
  x: number,
  y: number,
  inventoryRaw: string[] = [],
  hunger = 0,
  role: "hero" | "farmer" | "baker" | "merchant" | "guard" | "wanderer" | "monster" = kind === "monster" ? "monster" : "wanderer"
): Actor => {
  const isMonster = kind === "monster";
  const status = statusForRole(role);
  // 2026-05-08: stat-coupled max stats. 몬스터는 base mp 0 유지.
  const maxHp = maxHpFor(status);
  const maxStamina = maxStaminaFor(status);
  const maxMp = isMonster ? 0 : maxMpFor(status);
  const maxHunger = maxHungerFor(status);
  return {
    id,
    kind,
    name,
    assetKey,
    x,
    y,
    hp: maxHp,
    maxHp,
    mp: maxMp,
    maxMp,
    stamina: maxStamina,
    maxStamina,
    hunger,
    maxHunger,
    status,
    skills: createDefaultSkills(),
    gold: isMonster ? 0 : 10,
    inventory: migrateInventoryFromStringArray(inventoryRaw),
    alive: true
  };
};

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((item) => [item.id, item]));

export const createMochiVillageState = (width = 128, height = 96): WorldState => {
  // 2026-05-12: 96x64 → 128x96 확장. 기존 마을 중심은 유지하고 외곽 탐험지를 추가.
  const mapWidth = Math.max(width, 128);
  const mapHeight = Math.max(height, 96);
  const terrain = createLayer(mapWidth, mapHeight, 1);
  const collision = createLayer(mapWidth, mapHeight, 0);
  const decor = createLayer(mapWidth, mapHeight, 0);

  for (let x = 0; x < mapWidth; x += 1) {
    collision[0][x] = 1;
    collision[mapHeight - 1][x] = 1;
  }
  for (let y = 0; y < mapHeight; y += 1) {
    collision[y][0] = 1;
    collision[y][mapWidth - 1] = 1;
  }

  const places: Place[] = [
    // ── 중앙 마을 (모찌 광장 일대, 64×48 지도 중앙) ──────────────────
    {
      id: "plaza",
      name: "Mochi Plaza",
      kind: "plaza",
      x: 29, y: 21, width: 6, height: 6,
      allowedActions: ["WAIT", "SPEAK", "USE"],
      socialWeight: 0.95,
      dayPhaseBias: { morning: 0.9, day: 0.6, evening: 0.85, night: 0.2 },
      tags: ["social", "outdoor", "center"]
    },
    {
      id: "well",
      name: "Small Well",
      kind: "well",
      x: 26, y: 22, width: 2, height: 2,
      allowedActions: ["WAIT", "SPEAK", "USE"],
      socialWeight: 0.7,
      dayPhaseBias: { morning: 0.8, day: 0.55, evening: 0.5, night: 0.15 },
      tags: ["water", "social", "outdoor"]
    },
    {
      id: "noticeboard",
      name: "Village Noticeboard",
      kind: "noticeboard",
      x: 32, y: 27, width: 1, height: 1,
      allowedActions: ["WAIT", "USE", "SPEAK"],
      socialWeight: 0.55,
      dayPhaseBias: { morning: 0.7, day: 0.85, evening: 0.55, night: 0.1 },
      tags: ["info", "social", "outdoor"]
    },
    {
      id: "tavern",
      name: "Moonlight Tavern",
      kind: "tavern",
      x: 35, y: 26, width: 4, height: 4,
      allowedActions: ["WAIT", "SPEAK", "REST"],
      socialWeight: 0.85,
      dayPhaseBias: { morning: 0.15, day: 0.25, evening: 0.95, night: 0.85 },
      tags: ["social", "indoor", "evening"]
    },
    {
      id: "shrine",
      name: "Small Shrine",
      kind: "shrine",
      x: 30, y: 16, width: 3, height: 3,
      allowedActions: ["WAIT", "SPEAK", "PRAY"],
      socialWeight: 0.35,
      dayPhaseBias: { morning: 0.65, day: 0.45, evening: 0.55, night: 0.25 },
      tags: ["faith", "quiet", "outdoor"]
    },
    {
      id: "bakery",
      name: "Sunny Bakery",
      kind: "shop",
      x: 22, y: 18, width: 4, height: 4,
      allowedActions: ["WAIT", "SPEAK", "USE"],
      socialWeight: 0.8,
      dayPhaseBias: { morning: 0.95, day: 0.75, evening: 0.35, night: 0.05 },
      tags: ["food", "shop", "indoor"]
    },
    {
      id: "general-store",
      name: "Corner General Store",
      kind: "shop",
      x: 38, y: 18, width: 4, height: 4,
      allowedActions: ["WAIT", "SPEAK"],
      socialWeight: 0.65,
      dayPhaseBias: { morning: 0.55, day: 0.85, evening: 0.45, night: 0.05 },
      tags: ["shop", "tools", "indoor"]
    },
    {
      id: "home-mochi",
      name: "Mochi's Cottage",
      kind: "home",
      x: 18, y: 30, width: 4, height: 4,
      allowedActions: ["WAIT", "REST", "SPEAK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.35, day: 0.15, evening: 0.75, night: 1 },
      tags: ["home", "rest", "indoor"]
    },
    {
      id: "home-yui",
      name: "Yui's Cottage",
      kind: "home",
      x: 30, y: 31, width: 4, height: 4,
      allowedActions: ["WAIT", "REST", "SPEAK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.35, day: 0.15, evening: 0.75, night: 1 },
      tags: ["home", "rest", "indoor"]
    },
    {
      id: "home-jin",
      name: "Jin's Cottage",
      kind: "home",
      x: 42, y: 30, width: 4, height: 4,
      allowedActions: ["WAIT", "REST", "SPEAK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.35, day: 0.15, evening: 0.75, night: 1 },
      tags: ["home", "rest", "indoor"]
    },
    // ── 도로: 마을-숲-광산-강 잇는 주도로 2개 ──────────────────────
    {
      id: "road-main-ew",
      name: "East-West Main Road",
      kind: "road",
      x: 16, y: 23, width: 32, height: 2,
      allowedActions: ["WAIT", "SPEAK"],
      socialWeight: 0.45,
      dayPhaseBias: { morning: 0.55, day: 0.55, evening: 0.55, night: 0.2 },
      tags: ["road", "outdoor"]
    },
    {
      id: "road-main-ns",
      name: "North-South Main Road",
      kind: "road",
      x: 31, y: 12, width: 2, height: 28,
      allowedActions: ["WAIT", "SPEAK"],
      socialWeight: 0.45,
      dayPhaseBias: { morning: 0.55, day: 0.55, evening: 0.55, night: 0.2 },
      tags: ["road", "outdoor"]
    },
    // ── 농경지 (남쪽) ──────────────────────────────────────
    {
      id: "field-west",
      name: "West Field",
      kind: "field",
      x: 14, y: 36, width: 6, height: 6,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.35,
      dayPhaseBias: { morning: 0.55, day: 0.95, evening: 0.35, night: 0.05 },
      tags: ["farm", "food", "outdoor"]
    },
    {
      id: "field-east",
      name: "East Field",
      kind: "field",
      x: 44, y: 36, width: 6, height: 6,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.35,
      dayPhaseBias: { morning: 0.55, day: 0.95, evening: 0.35, night: 0.05 },
      tags: ["farm", "food", "outdoor"]
    },
    // 2026-05-07: 확장 맵에 추가 텃밭 (남쪽)
    {
      id: "field-south",
      name: "South Field",
      kind: "field",
      x: 24, y: 44, width: 8, height: 5,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.35,
      dayPhaseBias: { morning: 0.55, day: 0.95, evening: 0.35, night: 0.05 },
      tags: ["farm", "food", "outdoor"]
    },
    // 2026-05-07: 마을 안 대장간 (forge 옮김)
    {
      id: "smithy",
      name: "Village Smithy",
      kind: "smithy",
      x: 46, y: 26, width: 4, height: 4,
      allowedActions: ["WAIT", "WORK", "USE", "SPEAK"],
      socialWeight: 0.4,
      dayPhaseBias: { morning: 0.55, day: 0.85, evening: 0.45, night: 0.1 },
      tags: ["craft", "smithy", "outdoor"]
    },
    // 2026-05-07: 남쪽 부엌 (2nd oven)
    {
      id: "south-kitchen",
      name: "South Communal Kitchen",
      kind: "shop",
      x: 40, y: 46, width: 4, height: 4,
      allowedActions: ["WAIT", "USE", "SPEAK"],
      socialWeight: 0.5,
      dayPhaseBias: { morning: 0.85, day: 0.65, evening: 0.55, night: 0.1 },
      tags: ["food", "shop", "kitchen"]
    },
    // 2026-05-07: 동쪽 노점 (2nd alchemy table)
    {
      id: "east-stall",
      name: "East Herb Stall",
      kind: "shop",
      x: 68, y: 26, width: 5, height: 4,
      allowedActions: ["WAIT", "USE", "SPEAK"],
      socialWeight: 0.4,
      dayPhaseBias: { morning: 0.45, day: 0.85, evening: 0.55, night: 0.1 },
      tags: ["alchemy", "shop", "outdoor"]
    },
    // ── field-orchard 제거 (2026-05-05) — 과수원이 깊은 남쪽에 격리되어 NPC FOV 밖.
    //     과일나무는 마을 주변에 산재 배치(structures 섹션 참고)하여 자연스럽게 시야 진입.
    // ── 숲 (북쪽 + 서쪽) ───────────────────────────────────
    {
      id: "forest-north",
      name: "North Forest",
      kind: "forest_edge",
      x: 0, y: 0, width: 96, height: 4,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.1,
      dayPhaseBias: { morning: 0.35, day: 0.45, evening: 0.25, night: 0.1 },
      tags: ["forest", "wild", "outdoor"]
    },
    {
      id: "forest-west",
      name: "West Forest",
      kind: "forest_edge",
      x: 0, y: 4, width: 10, height: 28,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.1,
      dayPhaseBias: { morning: 0.35, day: 0.45, evening: 0.25, night: 0.1 },
      tags: ["forest", "wild", "outdoor", "deep"]
    },
    // 2026-05-07: 동쪽 숲 추가 (확장 맵 활용)
    {
      id: "forest-east",
      name: "East Forest",
      kind: "forest_edge",
      x: 70, y: 36, width: 26, height: 18,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.1,
      dayPhaseBias: { morning: 0.35, day: 0.45, evening: 0.25, night: 0.1 },
      tags: ["forest", "wild", "outdoor"]
    },
    {
      id: "forest-south",
      name: "South Forest",
      kind: "forest_edge",
      x: 0, y: 54, width: 64, height: 9,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.1,
      dayPhaseBias: { morning: 0.35, day: 0.45, evening: 0.25, night: 0.1 },
      tags: ["forest", "wild", "outdoor"]
    },
    // ── 광산 (북동) + 동굴 입구 (북) ────────────────────────
    {
      id: "mine",
      name: "Northeast Mine",
      kind: "mine",
      x: 50, y: 4, width: 8, height: 6,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.15,
      dayPhaseBias: { morning: 0.35, day: 0.65, evening: 0.25, night: 0.05 },
      tags: ["mine", "ore", "outdoor"]
    },
    {
      id: "cave-entrance",
      name: "Sealed Cave Entrance",
      kind: "mine",
      x: 28, y: 4, width: 4, height: 3,
      allowedActions: ["WAIT"],
      socialWeight: 0.05,
      dayPhaseBias: { morning: 0.2, day: 0.3, evening: 0.2, night: 0.1 },
      tags: ["cave", "danger", "sealed", "outdoor"]
    },
    // ── 강 (동쪽) + 연못 (남동 습지) ─────────────────────────
    {
      id: "river-east",
      name: "East Stream",
      kind: "pond",
      x: 60, y: 6, width: 3, height: 28,
      allowedActions: ["WAIT", "USE", "WORK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.55, day: 0.7, evening: 0.55, night: 0.15 },
      tags: ["water", "river", "fishing", "outdoor"]
    },
    // 2026-05-07: 남쪽 강 추가 (확장 맵)
    {
      id: "river-south",
      name: "South Stream",
      kind: "pond",
      x: 28, y: 50, width: 30, height: 3,
      allowedActions: ["WAIT", "USE", "WORK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.55, day: 0.7, evening: 0.55, night: 0.15 },
      tags: ["water", "river", "fishing", "outdoor"]
    },
    {
      id: "pond",
      name: "Village Pond",
      kind: "pond",
      x: 24, y: 25, width: 3, height: 2,
      allowedActions: ["WAIT", "USE", "WORK"],
      socialWeight: 0.3,
      dayPhaseBias: { morning: 0.55, day: 0.7, evening: 0.55, night: 0.15 },
      tags: ["water", "fishing", "outdoor"]
    },
    {
      id: "wetland",
      name: "Southeast Marsh",
      kind: "pond",
      x: 50, y: 42, width: 10, height: 5,
      allowedActions: ["WAIT", "USE", "WORK"],
      socialWeight: 0.15,
      dayPhaseBias: { morning: 0.4, day: 0.6, evening: 0.4, night: 0.15 },
      tags: ["water", "wetland", "fishing", "outdoor"]
    },
    // ── 외곽 폐허 (서남, 옛 사당 흔적) ────────────────────────
    {
      id: "ruins-southwest",
      name: "Southwest Ruins",
      kind: "shrine",
      x: 4, y: 42, width: 5, height: 4,
      allowedActions: ["WAIT", "PRAY"],
      socialWeight: 0.05,
      dayPhaseBias: { morning: 0.25, day: 0.3, evening: 0.4, night: 0.5 },
      tags: ["ruins", "ancient", "spirit", "outdoor"]
    },
    // ── 2026-05-12: 128×96 확장 지역 ────────────────────────
    {
      id: "marketplace",
      name: "Mochi Marketplace",
      kind: "shop",
      x: 34, y: 18, width: 4, height: 6,
      allowedActions: ["WAIT", "SPEAK", "USE"],
      socialWeight: 0.9,
      dayPhaseBias: { morning: 0.85, day: 0.95, evening: 0.45, night: 0.05 },
      tags: ["market", "trade", "social", "outdoor"]
    },
    {
      id: "fishing_dock",
      name: "East Fishing Dock",
      kind: "pond",
      x: 62, y: 24, width: 8, height: 5,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.35,
      dayPhaseBias: { morning: 0.75, day: 0.75, evening: 0.55, night: 0.2 },
      tags: ["water", "dock", "fishing", "outdoor"]
    },
    {
      id: "alchemy_garden",
      name: "Alchemy Garden",
      kind: "field",
      x: 56, y: 34, width: 9, height: 7,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.3,
      dayPhaseBias: { morning: 0.75, day: 0.8, evening: 0.45, night: 0.1 },
      tags: ["alchemy", "herb", "garden", "outdoor"]
    },
    {
      id: "cemetery",
      name: "Old Cemetery",
      kind: "shrine",
      x: 12, y: 46, width: 8, height: 7,
      allowedActions: ["WAIT", "PRAY"],
      socialWeight: 0.02,
      dayPhaseBias: { morning: 0.1, day: 0.15, evening: 0.45, night: 0.85 },
      tags: ["grave", "spirit", "night", "danger", "outdoor"]
    },
    {
      id: "ancient_temple",
      name: "Ancient Temple",
      kind: "shrine",
      x: 104, y: 14, width: 10, height: 8,
      allowedActions: ["WAIT", "PRAY", "WORK", "USE"],
      socialWeight: 0.03,
      dayPhaseBias: { morning: 0.25, day: 0.35, evening: 0.45, night: 0.55 },
      tags: ["ancient", "rare", "danger", "outdoor"]
    },
    {
      id: "deep_ruins",
      name: "Deep Ruins",
      kind: "mine",
      x: 12, y: 78, width: 10, height: 9,
      allowedActions: ["WAIT", "WORK", "USE", "PRAY"],
      socialWeight: 0.02,
      dayPhaseBias: { morning: 0.2, day: 0.3, evening: 0.45, night: 0.7 },
      tags: ["ruins", "ore", "ancient", "danger", "outdoor"]
    },
    {
      id: "apple_orchard",
      name: "Apple Orchard",
      kind: "field",
      x: 20, y: 64, width: 10, height: 8,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.2,
      dayPhaseBias: { morning: 0.65, day: 0.75, evening: 0.35, night: 0.05 },
      tags: ["orchard", "fruit", "apple", "outdoor"]
    },
    {
      id: "lumber_camp",
      name: "Lumber Camp",
      kind: "forest_edge",
      x: 72, y: 66, width: 12, height: 10,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.1,
      dayPhaseBias: { morning: 0.45, day: 0.6, evening: 0.3, night: 0.1 },
      tags: ["forest", "wood", "camp", "outdoor"]
    },
    {
      id: "mine_shaft",
      name: "South Mine Shaft",
      kind: "mine",
      x: 88, y: 70, width: 10, height: 8,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.08,
      dayPhaseBias: { morning: 0.35, day: 0.65, evening: 0.25, night: 0.05 },
      tags: ["mine", "ore", "outdoor"]
    },
    {
      id: "riverbank_north",
      name: "North Riverbank",
      kind: "pond",
      x: 62, y: 8, width: 12, height: 4,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.2,
      dayPhaseBias: { morning: 0.6, day: 0.65, evening: 0.45, night: 0.15 },
      tags: ["water", "river", "fishing", "outdoor"]
    },
    {
      id: "north_pasture",
      name: "North Pasture",
      kind: "field",
      x: 74, y: 10, width: 12, height: 8,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.15,
      dayPhaseBias: { morning: 0.65, day: 0.75, evening: 0.35, night: 0.05 },
      tags: ["pasture", "animal", "outdoor"]
    }
  ];

  const roads = places.filter((place) => place.kind === "road");
  const forest = places.filter((place) => place.kind === "forest_edge");
  const fields = places.filter((place) => place.kind === "field");
  const plaza = places.find((place) => place.kind === "plaza");
  const shopsAndHomes = places.filter((place) => place.kind === "shop" || place.kind === "home" || place.kind === "tavern" || place.kind === "shrine");
  const mines = places.filter((place) => place.kind === "mine");
  const well = places.find((place) => place.kind === "well");
  const pond = places.find((place) => place.kind === "pond");

  // 모든 decor 레이어 fill 제거 — Pipoya tilesheet decor IDs(6,7,9,10,11,13)가 잘린 나무/이상한 패턴으로 렌더링됨.
  // 시각 구분은 terrain ID + 실제 structure sprite로만 표현.
  for (const road of roads) fillRect(terrain, road.x, road.y, road.width, road.height, 3);
  if (plaza) fillRect(terrain, plaza.x, plaza.y, plaza.width, plaza.height, 2);
  for (const field of fields) {
    fillRect(terrain, field.x, field.y, field.width, field.height, 4);
  }
  for (const place of shopsAndHomes) {
    fillRect(terrain, place.x, place.y, place.width, place.height, 5);
  }
  for (const mine of mines) {
    fillRect(terrain, mine.x, mine.y, mine.width, mine.height, 6);
  }
  // 물 타일 — 사용자 결정 (2026-05-08): 단일 타일 (58) 만 사용. 체크무늬·variants 폐지.
  const WATER_PLAIN_A = 58;
  for (const p of places.filter((pl) => pl.kind === "pond")) {
    for (let yy = p.y; yy < p.y + p.height; yy += 1) {
      for (let xx = p.x; xx < p.x + p.width; xx += 1) {
        if (terrain[yy] && terrain[yy][xx] !== undefined) terrain[yy][xx] = WATER_PLAIN_A;
      }
    }
    // pond 안쪽 collision (가장자리는 통과 가능 — 낚시 동선)
    for (let yy = p.y + 1; yy < p.y + p.height - 1; yy += 1) {
      for (let xx = p.x + 1; xx < p.x + p.width - 1; xx += 1) {
        if (collision[yy] && collision[yy][xx] !== undefined) collision[yy][xx] = 1;
      }
    }
  }
  for (const p of places.filter((pl) => pl.kind === "well")) {
    for (let yy = p.y; yy < p.y + p.height; yy += 1) {
      for (let xx = p.x; xx < p.x + p.width; xx += 1) {
        if (terrain[yy] && terrain[yy][xx] !== undefined) terrain[yy][xx] = WATER_PLAIN_A;
      }
    }
  }

  const structures = [
    // ── 마을 건물 ──────────────────────────────────────────
    { id: "structure-bakery", type: "bakery", x: 22, y: 18, width: 4, height: 4, assetKey: "object.bakery", props: { placeId: "bakery" } },
    { id: "structure-general-store", type: "general-store", x: 38, y: 18, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "general-store" } },
    { id: "structure-tavern", type: "tavern", x: 35, y: 26, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "tavern" } },
    { id: "structure-shrine", type: "shrine", x: 30, y: 16, width: 3, height: 3, props: { placeId: "shrine" } },
    { id: "structure-home-mochi", type: "home", x: 18, y: 30, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "home-mochi" } },
    { id: "structure-home-yui", type: "home", x: 30, y: 31, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "home-yui" } },
    { id: "structure-home-jin", type: "home", x: 42, y: 30, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "home-jin" } },
    { id: "structure-well", type: "well", x: 26, y: 22, width: 2, height: 2, assetKey: "object.well", props: { placeId: "well" } },
    { id: "structure-noticeboard", type: "noticeboard", x: 32, y: 27, width: 2, height: 2, assetKey: "object.noticeboard", props: { placeId: "noticeboard" } },
    // ── 광장 주변 가구 ─────────────────────────────────────
    { id: "structure-streetlamp-1", type: "streetlamp", x: 28, y: 17, width: 1, height: 3, assetKey: "object.streetlamp", props: {} },
    { id: "structure-streetlamp-2", type: "streetlamp", x: 35, y: 17, width: 1, height: 3, assetKey: "object.streetlamp", props: {} },
    { id: "structure-streetlamp-3", type: "streetlamp", x: 28, y: 27, width: 1, height: 3, assetKey: "object.streetlamp", props: {} },
    { id: "structure-streetlamp-4", type: "streetlamp", x: 35, y: 27, width: 1, height: 3, assetKey: "object.streetlamp", props: {} },
    { id: "structure-streetlamp-5", type: "streetlamp", x: 41, y: 25, width: 1, height: 3, assetKey: "object.streetlamp.variant", props: {} },
    { id: "structure-bench-1", type: "bench", x: 30, y: 27, width: 2, height: 1, assetKey: "object.bench", props: {} },
    { id: "structure-bench-2", type: "bench", x: 33, y: 21, width: 2, height: 1, assetKey: "object.bench", props: {} },
    { id: "structure-bench-3", type: "bench", x: 27, y: 25, width: 2, height: 1, assetKey: "object.bench.variant", props: {} },
    { id: "structure-flowerpot-1", type: "flowerpot", x: 29, y: 21, width: 1, height: 1, assetKey: "object.flowerpot", props: {} },
    { id: "structure-flowerpot-2", type: "flowerpot", x: 34, y: 21, width: 1, height: 1, assetKey: "object.flowerpot.02", props: {} },
    { id: "structure-flowerpot-3", type: "flowerpot", x: 29, y: 26, width: 1, height: 1, assetKey: "object.flowerpot.03", props: {} },
    { id: "structure-flowerpot-4", type: "flowerpot", x: 34, y: 26, width: 1, height: 1, assetKey: "object.flowerpot.04", props: {} },
    { id: "structure-flowerpot-5", type: "flowerpot", x: 38, y: 21, width: 1, height: 1, assetKey: "object.flowerpot.05", props: {} },
    { id: "structure-signpost-1", type: "signpost", x: 25, y: 22, width: 1, height: 2, assetKey: "object.signpost", props: {} },
    { id: "structure-signpost-2", type: "signpost", x: 40, y: 22, width: 1, height: 2, assetKey: "object.signpost.variant", props: {} },
    { id: "structure-letterbox-1", type: "letterbox", x: 22, y: 30, width: 1, height: 1, assetKey: "object.letterbox", props: { placeId: "home-mochi" } },
    { id: "structure-grave-1", type: "grave", x: 8, y: 45, width: 1, height: 1, assetKey: "object.grave", props: { placeId: "ruins-southwest" } },
    // ── 텃밭·과수원 가구 ───────────────────────────────────
    { id: "structure-scarecrow-1", type: "scarecrow", x: 16, y: 35, width: 2, height: 3, assetKey: "object.scarecrow", props: {} },
    { id: "structure-scarecrow-2", type: "scarecrow", x: 46, y: 35, width: 2, height: 3, assetKey: "object.scarecrow.variant", props: {} },
    { id: "structure-feedbox-1", type: "feedbox", x: 20, y: 36, width: 1, height: 1, assetKey: "object.feedbox", props: {} },
    { id: "structure-feedbox-2", type: "feedbox", x: 50, y: 36, width: 1, height: 1, assetKey: "object.feedbox", props: {} },
    { id: "structure-bucket-1", type: "bucket", x: 28, y: 22, width: 1, height: 1, assetKey: "object.bucket.variant", props: { placeId: "well" } },
    // ── 마을 주변 산재 과일나무 (2026-05-05, 과수원 폐지 → NPC FOV 진입) ───────
    //     Apple: 광장 동·서 측면. Pear: 북쪽 광장 위. Pineapple: 동쪽 외곽.
    //     fruitTreeRegen() 이 인접 빈 칸에 ground item 자동 spawn.
    { id: "structure-apple-tree-1",     type: "tree", x: 15, y: 25, width: 2, height: 3, assetKey: "object.tree.apple",     props: { fruit: "apple" } },
    { id: "structure-apple-tree-2",     type: "tree", x: 45, y: 25, width: 2, height: 3, assetKey: "object.tree.apple",     props: { fruit: "apple" } },
    // 2026-05-12: pear 제거 → apple 로 통합 (같은 에셋이라 pear 별도 의미 없음).
    { id: "structure-apple-tree-3",     type: "tree", x: 23, y: 14, width: 2, height: 3, assetKey: "object.tree.apple",     props: { fruit: "apple" } },
    { id: "structure-apple-tree-4",     type: "tree", x: 35, y: 14, width: 2, height: 3, assetKey: "object.tree.apple",     props: { fruit: "apple" } },
    { id: "structure-pineapple-tree-1", type: "tree", x: 50, y: 26, width: 2, height: 3, assetKey: "object.tree.pineapple", props: { fruit: "pineapple" } },
    // ── 북쪽 숲 ──────────────────────────────────────────
    { id: "structure-tree-1", type: "tree", x: 4, y: 1, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-2", type: "tree", x: 9, y: 0, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-3", type: "tree", x: 14, y: 1, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-4", type: "tree", x: 19, y: 0, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-5", type: "tree", x: 36, y: 0, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-6", type: "tree", x: 42, y: 1, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-7", type: "tree", x: 47, y: 0, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    // ── 서쪽 숲 ──────────────────────────────────────────
    { id: "structure-tree-w1", type: "tree", x: 2, y: 8, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-w2", type: "tree", x: 6, y: 12, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-w3", type: "tree", x: 3, y: 16, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-w4", type: "tree", x: 7, y: 20, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-w5", type: "tree", x: 2, y: 26, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-bush-1", type: "bush", x: 6, y: 9, width: 1, height: 1, assetKey: "object.bush", props: {} },
    { id: "structure-bush-2", type: "bush", x: 9, y: 14, width: 1, height: 1, assetKey: "object.bush.01_2", props: {} },
    { id: "structure-bush-3", type: "bush", x: 5, y: 22, width: 1, height: 1, assetKey: "object.bush.01_3", props: {} },
    { id: "structure-bush-4", type: "bush", x: 8, y: 28, width: 1, height: 1, assetKey: "object.bush.01_4", props: {} },
    { id: "structure-bush-5", type: "bush", x: 72, y: 37, width: 1, height: 1, assetKey: "object.bush.01_5", props: { placeId: "forest-east" } },
    { id: "structure-bush-6", type: "bush", x: 82, y: 39, width: 1, height: 1, assetKey: "object.bush.01_6", props: { placeId: "forest-east" } },
    { id: "structure-bush-7", type: "bush", x: 92, y: 43, width: 1, height: 1, assetKey: "object.bush.01_7", props: { placeId: "forest-east" } },
    { id: "structure-bush-8", type: "bush", x: 30, y: 44, width: 1, height: 1, assetKey: "object.bush.02_1", props: { placeId: "field-south" } },
    // ── 광산 + 동굴 ──────────────────────────────────────
    { id: "structure-rock-1", type: "rock", x: 51, y: 4, width: 2, height: 2, assetKey: "object.rock", props: {} },
    { id: "structure-rock-2", type: "rock", x: 54, y: 6, width: 2, height: 2, assetKey: "object.rock", props: {} },
    { id: "structure-rock-3", type: "rock", x: 56, y: 4, width: 2, height: 2, assetKey: "object.rock", props: {} },
    { id: "structure-rock-4", type: "rock", x: 52, y: 8, width: 2, height: 2, assetKey: "object.rock", props: {} },
    { id: "structure-rock-cave1", type: "rock", x: 28, y: 4, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "cave-entrance" } },
    { id: "structure-rock-cave2", type: "rock", x: 30, y: 4, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "cave-entrance" } },
    // ── 폐허 (서남) ─────────────────────────────────────
    { id: "structure-ruins-shrine", type: "shrine", x: 5, y: 42, width: 3, height: 3, props: { placeId: "ruins-southwest" } },
    { id: "structure-ruins-rock", type: "rock", x: 4, y: 45, width: 2, height: 2, assetKey: "object.rock", props: {} },
    // ── Crafting stations (PR12.3) ─────────────────────────
    { id: "structure-oven", type: "oven", x: 23, y: 19, width: 1, height: 1, assetKey: "object.feedbox", props: { placeId: "bakery", station: "oven" } },
    { id: "structure-alchemy-table", type: "alchemy_table", x: 39, y: 19, width: 2, height: 1, assetKey: "object.bench", props: { placeId: "general-store", station: "alchemy_table" } },
    { id: "structure-workbench", type: "workbench", x: 36, y: 22, width: 2, height: 1, assetKey: "object.workbench", props: { station: "workbench" } },
    // 2026-05-07: forge 마을로 이동 (직전 50,6 광산 → 마을 동쪽 47,29 in-village smithy 영역).
    { id: "structure-forge", type: "forge", x: 47, y: 27, width: 2, height: 2, assetKey: "object.forge", props: { placeId: "smithy", station: "forge" } },
    // 2026-05-07: 추가 2차 oven (남쪽 마을 끝)
    { id: "structure-oven-2", type: "oven", x: 41, y: 47, width: 1, height: 1, assetKey: "object.feedbox", props: { placeId: "south-kitchen", station: "oven" } },
    // 2026-05-07: 추가 2차 alchemy table (확장 마을)
    { id: "structure-alchemy-table-2", type: "alchemy_table", x: 70, y: 28, width: 2, height: 1, assetKey: "object.bench", props: { placeId: "east-stall", station: "alchemy_table" } },
    // 2026-05-09 v3: forest-east (70-95, 36-53) 안에 벌목 가능 트리 12그루 + rock 광맥 4개. 몬스터 spawn 영역.
    { id: "structure-tree-fe1", type: "tree", x: 72, y: 38, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe2", type: "tree", x: 76, y: 39, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe3", type: "tree", x: 80, y: 37, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe4", type: "tree", x: 84, y: 39, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe5", type: "tree", x: 88, y: 37, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe6", type: "tree", x: 73, y: 44, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe7", type: "tree", x: 78, y: 45, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe8", type: "tree", x: 83, y: 46, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe9", type: "tree", x: 87, y: 44, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe10", type: "tree", x: 91, y: 39, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe11", type: "tree", x: 91, y: 45, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe12", type: "tree", x: 75, y: 50, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    // 광맥 4개 (forest 동쪽 끝)
    { id: "structure-rock-fe1", type: "rock", x: 81, y: 50, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "forest-east" } },
    { id: "structure-rock-fe2", type: "rock", x: 86, y: 50, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "forest-east" } },
    { id: "structure-rock-fe3", type: "rock", x: 91, y: 51, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "forest-east" } },
    { id: "structure-rock-fe4", type: "rock", x: 88, y: 41, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "forest-east" } },
    // ── 2026-05-12: expanded map structures ─────────────────
    { id: "structure-market-stall-1", type: "stall", x: 35, y: 19, width: 2, height: 1, assetKey: "object.feedbox", props: { placeId: "marketplace" } },
    { id: "structure-market-stall-2", type: "stall", x: 36, y: 21, width: 2, height: 1, assetKey: "object.bench", props: { placeId: "marketplace" } },
    { id: "structure-market-signpost", type: "signpost", x: 34, y: 18, width: 1, height: 2, assetKey: "object.signpost", props: { placeId: "marketplace" } },
    { id: "structure-market-noticeboard", type: "noticeboard", x: 36, y: 18, width: 2, height: 2, assetKey: "object.noticeboard", props: { placeId: "marketplace" } },
    { id: "structure-dock-barrel-1", type: "barrel", x: 63, y: 24, width: 1, height: 1, assetKey: "object.bucket.variant", props: { placeId: "fishing_dock" } },
    { id: "structure-dock-fishing-spot", type: "fishing_spot", x: 66, y: 25, width: 2, height: 2, assetKey: "object.well", props: { placeId: "fishing_dock" } },
    { id: "structure-dock-bench", type: "bench", x: 62, y: 28, width: 2, height: 1, assetKey: "object.bench", props: { placeId: "fishing_dock" } },
    { id: "structure-alchemy-table-garden", type: "alchemy_table", x: 56, y: 34, width: 2, height: 1, assetKey: "object.bench", props: { placeId: "alchemy_garden", station: "alchemy_table" } },
    { id: "structure-garden-herb-bed-1", type: "herb_bed", x: 58, y: 36, width: 2, height: 1, assetKey: "object.flowerpot.03", props: { placeId: "alchemy_garden" } },
    { id: "structure-garden-herb-bed-2", type: "herb_bed", x: 61, y: 36, width: 2, height: 1, assetKey: "object.flowerpot.04", props: { placeId: "alchemy_garden" } },
    { id: "structure-garden-berry-bush", type: "berry_bush", x: 57, y: 38, width: 1, height: 1, assetKey: "object.bush.02_1", props: { placeId: "alchemy_garden" } },
    { id: "structure-cemetery-grave-1", type: "grave", x: 12, y: 46, width: 1, height: 1, assetKey: "object.grave", props: { placeId: "cemetery" } },
    { id: "structure-cemetery-grave-2", type: "grave", x: 14, y: 47, width: 1, height: 1, assetKey: "object.grave", props: { placeId: "cemetery" } },
    { id: "structure-cemetery-dead-tree-1", type: "dead_tree", x: 16, y: 50, width: 2, height: 2, assetKey: "object.tree.cut", props: { placeId: "cemetery" } },
    { id: "structure-temple-shrine", type: "shrine", x: 104, y: 14, width: 3, height: 3, props: { placeId: "ancient_temple" } },
    { id: "structure-temple-chest", type: "chest", x: 107, y: 15, width: 1, height: 1, assetKey: "object.chest", props: { placeId: "ancient_temple" } },
    { id: "structure-temple-rock-1", type: "rock", x: 105, y: 16, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "ancient_temple" } },
    { id: "structure-temple-rock-2", type: "rock", x: 110, y: 16, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "ancient_temple" } },
    { id: "structure-deep-ruins-shrine", type: "shrine", x: 12, y: 78, width: 3, height: 3, props: { placeId: "deep_ruins" } },
    { id: "structure-deep-ruins-rock-1", type: "rock", x: 14, y: 82, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "deep_ruins" } },
    { id: "structure-deep-ruins-rock-2", type: "rock", x: 18, y: 82, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "deep_ruins" } },
    { id: "structure-orchard-apple-1", type: "tree", x: 21, y: 65, width: 2, height: 3, assetKey: "object.tree.apple", props: { placeId: "apple_orchard", fruit: "apple" } },
    { id: "structure-orchard-apple-2", type: "tree", x: 25, y: 66, width: 2, height: 3, assetKey: "object.tree.apple", props: { placeId: "apple_orchard", fruit: "apple" } },
    { id: "structure-orchard-apple-3", type: "tree", x: 28, y: 64, width: 2, height: 3, assetKey: "object.tree.apple", props: { placeId: "apple_orchard", fruit: "apple" } },
    { id: "structure-lumber-tree-1", type: "tree", x: 73, y: 67, width: 2, height: 3, assetKey: "object.tree.large", props: { placeId: "lumber_camp" } },
    { id: "structure-lumber-tree-2", type: "tree", x: 77, y: 70, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "lumber_camp" } },
    { id: "structure-lumber-tree-3", type: "tree", x: 81, y: 68, width: 2, height: 3, assetKey: "object.tree.large", props: { placeId: "lumber_camp" } },
    { id: "structure-lumber-bench", type: "bench", x: 75, y: 74, width: 2, height: 1, assetKey: "object.bench.variant", props: { placeId: "lumber_camp" } },
    { id: "structure-mine-shaft-rock-1", type: "rock", x: 89, y: 71, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "mine_shaft" } },
    { id: "structure-mine-shaft-rock-2", type: "rock", x: 93, y: 72, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "mine_shaft" } },
    { id: "structure-mine-shaft-rock-3", type: "rock", x: 95, y: 75, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "mine_shaft" } },
    { id: "structure-riverbank-fishing-spot", type: "fishing_spot", x: 68, y: 9, width: 2, height: 2, assetKey: "object.well", props: { placeId: "riverbank_north" } },
    { id: "structure-pasture-feedbox", type: "feedbox", x: 78, y: 14, width: 1, height: 1, assetKey: "object.feedbox", props: { placeId: "north_pasture" } },
    { id: "structure-pasture-signpost", type: "signpost", x: 74, y: 10, width: 1, height: 2, assetKey: "object.signpost.variant", props: { placeId: "north_pasture" } }
  ];

  // 2026-05-11: 시작 인벤 + 생존 장비 (wolf pack 대응). leather_armor + bone_dagger.
  const player = createActor("player-1", "player", "Aaron", "human.traveler", 20, 29, ["wheat", "herb", "axe", "leather_armor", "bone_dagger"], 0, "hero");
  player.hunger = 75;

  const monsterTuned = (id: string, name: string, asset: string, x: number, y: number, hp: number, status: ActorStatus): Actor => {
    const stamina = 50 + status.constitution * 5;
    return {
      id, kind: "monster", name, assetKey: asset, x, y,
      hp, maxHp: hp, mp: 0, maxMp: 0,
      stamina, maxStamina: stamina,
      hunger: 0, status, skills: createDefaultSkills(),
      gold: 0, inventory: [], alive: true
    };
  };

  const actors = [
    player,
    // 사용자 + gpt-5.5: 직업 함의 없는 일반 영어 이름. 직업은 페르소나 결로만 유지.
    createActor("npc-1", "npc", "Peter", "human.farmer", 28, 22, ["wheat", "carrot", "axe", "leather_armor", "bone_dagger"], 20, "farmer"),
    createActor("npc-2", "npc", "Mira", "human.baker", 25, 22, ["wheat", "herb", "axe", "leather_armor", "bone_dagger"], 0, "baker"),
    createActor("npc-3", "npc", "Lia", "human.merchant", 39, 22, ["herb", "berry", "pickaxe", "leather_armor", "bone_dagger"], 10, "merchant"),
    createActor("npc-4", "npc", "Jin", "human.guard", 32, 22, ["wood", "pickaxe", "axe", "leather_armor", "bone_dagger"], 10, "guard"),
    createActor("npc-5", "npc", "Noah", "human.healer", 30, 18, ["herb", "honey", "healing_potion", "leather_armor", "bone_dagger"], 5, "wanderer"),
    // 2026-05-09: monster name = 종 이름만 (id 가 별도 유니크). UI/이벤트 텍스트에서 ID 노출 X.
    monsterTuned("monster-boar-1", "Boar", "animal.boar", 50, 2, 22, { strength: 3, dexterity: 4, constitution: 4, intelligence: 1 }),
    monsterTuned("monster-boar-2", "Boar", "animal.boar", 52, 2, 22, { strength: 3, dexterity: 4, constitution: 4, intelligence: 1 }),
    monsterTuned("monster-deer-1", "Deer", "animal.deer", 6, 2, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-2", "Deer", "animal.deer", 16, 1, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-3", "Deer", "animal.deer", 38, 1, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-4", "Deer", "animal.deer", 4, 18, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-5", "Deer", "animal.deer", 8, 28, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-6", "Deer", "animal.deer", 60, 38, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-wolf-1", "Wolf", "animal.wolf", 4, 12, 30, { strength: 4, dexterity: 5, constitution: 4, intelligence: 1 }),
    monsterTuned("monster-wolf-2", "Wolf", "animal.wolf", 5, 13, 30, { strength: 4, dexterity: 5, constitution: 4, intelligence: 1 }),
    monsterTuned("monster-bear-1", "Bear", "animal.bear", 30, 5, 50, { strength: 6, dexterity: 3, constitution: 6, intelligence: 1 }),
    monsterTuned("monster-slime-1", "Slime", "monster.slime.green", 53, 43, 16, { strength: 2, dexterity: 2, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-slime-2", "Slime", "monster.slime.blue", 56, 44, 16, { strength: 2, dexterity: 2, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-slime-3", "Slime", "monster.slime.yellow", 58, 43, 16, { strength: 2, dexterity: 2, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-skeleton-1", "Skeleton", "monster.skeleton", 73, 38, 24, { strength: 3, dexterity: 3, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-skeleton-warrior-1", "Skeleton Warrior", "monster.skeleton_warrior", 77, 40, 34, { strength: 5, dexterity: 3, constitution: 4, intelligence: 1 }),
    monsterTuned("monster-skeleton-archer-1", "Skeleton Archer", "monster.skeleton_archer", 81, 42, 28, { strength: 3, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-naga-1", "Naga", "monster.naga", 54, 45, 42, { strength: 5, dexterity: 5, constitution: 5, intelligence: 2 }),
    monsterTuned("monster-troll-1", "Troll", "monster.troll", 90, 48, 96, { strength: 7, dexterity: 2, constitution: 7, intelligence: 1 }),
    monsterTuned("monster-spirit-cemetery-1", "Spirit", "monster.spirit", 15, 49, 28, { strength: 2, dexterity: 5, constitution: 3, intelligence: 3 }),
    monsterTuned("monster-naga-dock-1", "Naga", "monster.naga", 67, 27, 42, { strength: 5, dexterity: 5, constitution: 5, intelligence: 2 }),
    monsterTuned("monster-skeleton-archer-temple-1", "Skeleton Archer", "monster.skeleton_archer", 103, 16, 28, { strength: 3, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-troll-temple-1", "Troll", "monster.troll", 108, 17, 96, { strength: 7, dexterity: 2, constitution: 7, intelligence: 1 }),
    monsterTuned("monster-troll-deep-ruins-1", "Troll", "monster.troll", 17, 83, 96, { strength: 7, dexterity: 2, constitution: 7, intelligence: 1 }),
    monsterTuned("monster-deer-pasture-1", "Deer", "animal.deer", 80, 15, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-boar-pasture-1", "Boar", "animal.boar", 84, 16, 22, { strength: 3, dexterity: 4, constitution: 4, intelligence: 1 })
  ];

  const world: WorldState = {
    revision: 1,
    tick: 0,
    timeOfDay: 8,
    context: createDefaultWorldContext(0),
    map: { width: mapWidth, height: mapHeight, tileSize: 32, terrain, collision, decor },
    structures: byId(structures),
    places: byId(places),
    actors: byId(actors),
    groundItems: {
      // 2026-05-07: wheat 대량 보강 (baking 생산 체인 P0 — 직전 step1 2회만 → 풍부하게)
      "carrot-1": { id: "carrot-1", x: 16, y: 38, type: "food", iconKey: "item.food.carrot" },
      "carrot-2": { id: "carrot-2", x: 46, y: 38, type: "food", iconKey: "item.food.carrot" },
      "carrot-3": { id: "carrot-3", x: 28, y: 47, type: "food", iconKey: "item.food.carrot" },
      "carrot-4": { id: "carrot-4", x: 30, y: 47, type: "food", iconKey: "item.food.carrot" },
      "wheat-1": { id: "wheat-1", x: 23, y: 19, type: "food", iconKey: "item.food.wheat" },
      "wheat-2": { id: "wheat-2", x: 24, y: 19, type: "food", iconKey: "item.food.wheat" },
      "wheat-3": { id: "wheat-3", x: 18, y: 38, type: "food", iconKey: "item.food.wheat" },
      "wheat-4": { id: "wheat-4", x: 22, y: 21, type: "food", iconKey: "item.food.wheat" },  // bakery 안
      "wheat-5": { id: "wheat-5", x: 19, y: 38, type: "food", iconKey: "item.food.wheat" },  // field-west 안
      "wheat-6": { id: "wheat-6", x: 16, y: 41, type: "food", iconKey: "item.food.wheat" },
      "wheat-7": { id: "wheat-7", x: 47, y: 38, type: "food", iconKey: "item.food.wheat" },  // field-east 안
      "wheat-8": { id: "wheat-8", x: 49, y: 41, type: "food", iconKey: "item.food.wheat" },
      "wheat-9": { id: "wheat-9", x: 27, y: 45, type: "food", iconKey: "item.food.wheat" },  // field-south 안
      "wheat-10": { id: "wheat-10", x: 30, y: 45, type: "food", iconKey: "item.food.wheat" },
      // 2026-05-09: wheat_seed → wheat 통합. wheat 자체가 plantable.
      "wheat-init-1": { id: "wheat-init-1", x: 17, y: 36, type: "food", iconKey: "item.food.wheat" },
      "wheat-init-2": { id: "wheat-init-2", x: 47, y: 36, type: "food", iconKey: "item.food.wheat" },
      "wheat-init-3": { id: "wheat-init-3", x: 28, y: 44, type: "food", iconKey: "item.food.wheat" },
      "wheat-init-4": { id: "wheat-init-4", x: 22, y: 22, type: "food", iconKey: "item.food.wheat" },
      // 광산 자원 (보강)
      "ore-1": { id: "ore-1", x: 52, y: 5, type: "material", iconKey: "item.material.ore" },
      "ore-2": { id: "ore-2", x: 55, y: 7, type: "material", iconKey: "item.material.ore" },
      "ore-3": { id: "ore-3", x: 50, y: 5, type: "material", iconKey: "item.material.ore" },
      "ore-4": { id: "ore-4", x: 57, y: 9, type: "material", iconKey: "item.material.ore" },
      "ore-5": { id: "ore-5", x: 47, y: 28, type: "material", iconKey: "item.material.ore" },  // 마을 대장간 옆 (forge 인접)
      "ore-6": { id: "ore-6", x: 48, y: 28, type: "material", iconKey: "item.material.ore" },
      "coal-1": { id: "coal-1", x: 53, y: 6, type: "material", iconKey: "item.material.coal" },
      "coal-2": { id: "coal-2", x: 56, y: 8, type: "material", iconKey: "item.material.coal" },
      "coal-3": { id: "coal-3", x: 49, y: 28, type: "material", iconKey: "item.material.coal" },  // 마을 대장간 옆
      // 숲 자원 (서쪽·북쪽 + 보강)
      "wood-1": { id: "wood-1", x: 5, y: 10, type: "material", iconKey: "item.material.wood" },
      "wood-2": { id: "wood-2", x: 8, y: 17, type: "material", iconKey: "item.material.wood" },
      "wood-3": { id: "wood-3", x: 4, y: 24, type: "material", iconKey: "item.material.wood" },
      "wood-4": { id: "wood-4", x: 12, y: 1, type: "material", iconKey: "item.material.wood" },
      "wood-5": { id: "wood-5", x: 75, y: 40, type: "material", iconKey: "item.material.wood" },  // forest-east
      "wood-6": { id: "wood-6", x: 80, y: 45, type: "material", iconKey: "item.material.wood" },
      "wood-7": { id: "wood-7", x: 12, y: 56, type: "material", iconKey: "item.material.wood" },  // forest-south
      "wood-8": { id: "wood-8", x: 50, y: 28, type: "material", iconKey: "item.material.wood" },  // 마을 대장간 옆
      "wood-9": { id: "wood-9", x: 50, y: 27, type: "material", iconKey: "item.material.wood" },
      // 산열매·버섯 (숲)
      "berry-1": { id: "berry-1", x: 6, y: 5, type: "food", iconKey: "item.food.berry" },
      "berry-2": { id: "berry-2", x: 11, y: 12, type: "food", iconKey: "item.food.berry" },
      "berry-3": { id: "berry-3", x: 41, y: 2, type: "food", iconKey: "item.food.berry" },
      "berry-4": { id: "berry-4", x: 4, y: 19, type: "food", iconKey: "item.food.berry" },
      "berry-5": { id: "berry-5", x: 78, y: 38, type: "food", iconKey: "item.food.berry" },  // forest-east
      "berry-6": { id: "berry-6", x: 85, y: 50, type: "food", iconKey: "item.food.berry" },
      "berry-7": { id: "berry-7", x: 18, y: 58, type: "food", iconKey: "item.food.berry" },  // forest-south
      "berry-8": { id: "berry-8", x: 72, y: 29, type: "food", iconKey: "item.food.berry" },  // east-stall 인접 (alchemy 재료)
      "mushroom-1": { id: "mushroom-1", x: 7, y: 6, type: "food", iconKey: "item.food.mushroom" },
      "mushroom-2": { id: "mushroom-2", x: 9, y: 25, type: "food", iconKey: "item.food.mushroom" },
      "mushroom-3": { id: "mushroom-3", x: 38, y: 2, type: "food", iconKey: "item.food.mushroom" },
      "mushroom-4": { id: "mushroom-4", x: 80, y: 42, type: "food", iconKey: "item.food.mushroom" },
      "mushroom-5": { id: "mushroom-5", x: 24, y: 56, type: "food", iconKey: "item.food.mushroom" },
      // 약초 (숲·습지) — alchemy 재료. 동쪽 노점 인접에 보강.
      "herb-1": { id: "herb-1", x: 4, y: 14, type: "food", iconKey: "item.food.herb" },
      "herb-2": { id: "herb-2", x: 8, y: 22, type: "food", iconKey: "item.food.herb" },
      "herb-4": { id: "herb-4", x: 53, y: 44, type: "food", iconKey: "item.food.herb" },
      "herb-5": { id: "herb-5", x: 6, y: 44, type: "food", iconKey: "item.food.herb" },
      "herb-6": { id: "herb-6", x: 70, y: 30, type: "food", iconKey: "item.food.herb" },  // east-stall 인접
      "herb-7": { id: "herb-7", x: 71, y: 30, type: "food", iconKey: "item.food.herb" },
      "herb-8": { id: "herb-8", x: 38, y: 19, type: "food", iconKey: "item.food.herb" },  // alchemy_table 옆
      "herb-9": { id: "herb-9", x: 39, y: 20, type: "food", iconKey: "item.food.herb" },
      // ── 마을 주변 산재 음식 (2026-05-05, 과수원 폐지 + NPC FOV 진입) ──────
      // berry/mushroom/herb : 산재 ground items, 채집 affordance.
      "berry-village-1":     { id: "berry-village-1",     x: 20, y: 25, type: "food", iconKey: "item.food.berry" },
      "berry-village-2":     { id: "berry-village-2",     x: 44, y: 24, type: "food", iconKey: "item.food.berry" },
      "berry-village-3":     { id: "berry-village-3",     x: 33, y: 12, type: "food", iconKey: "item.food.berry" },
      "mushroom-village-1":  { id: "mushroom-village-1",  x: 16, y: 28, type: "food", iconKey: "item.food.mushroom" },
      "mushroom-village-2":  { id: "mushroom-village-2",  x: 47, y: 28, type: "food", iconKey: "item.food.mushroom" },
      "herb-village-1":      { id: "herb-village-1",      x: 28, y: 30, type: "food", iconKey: "item.food.herb" },
      "herb-village-2":      { id: "herb-village-2",      x: 45, y: 17, type: "food", iconKey: "item.food.herb" },
      // 산재 과일나무 옆 초기 과일 (fruitTreeRegen 첫 spawn 대기 X) ─────
      "apple-init-1":        { id: "apple-init-1",        x: 16, y: 25, type: "food", iconKey: "item.food.apple" },
      "apple-init-2":        { id: "apple-init-2",        x: 46, y: 25, type: "food", iconKey: "item.food.apple" },
      "apple-init-3":        { id: "apple-init-3",        x: 24, y: 15, type: "food", iconKey: "item.food.apple" },
      "apple-init-4":        { id: "apple-init-4",        x: 36, y: 15, type: "food", iconKey: "item.food.apple" },
      "pineapple-init-1":    { id: "pineapple-init-1",    x: 51, y: 27, type: "food", iconKey: "item.food.pineapple" },
      // Phase 2 food variety seed.
      "cheese-1":            { id: "cheese-1",            x: 36, y: 27, type: "food", iconKey: "item.food.cheese" },
      "eggs-1":              { id: "eggs-1",              x: 23, y: 20, type: "food", iconKey: "item.food.eggs" },
      "chicken_leg-1":       { id: "chicken_leg-1",       x: 37, y: 27, type: "food", iconKey: "item.food.chicken_leg" },
      "steak-1":             { id: "steak-1",             x: 38, y: 27, type: "food", iconKey: "item.food.steak" },
      "honey-1":             { id: "honey-1",             x: 30, y: 17, type: "food", iconKey: "item.food.honey" },
      "tomato-1":            { id: "tomato-1",            x: 26, y: 45, type: "food", iconKey: "item.food.tomato" },
      "potato-1":            { id: "potato-1",            x: 29, y: 45, type: "food", iconKey: "item.food.potato" },
      "onion-1":             { id: "onion-1",             x: 31, y: 45, type: "food", iconKey: "item.food.onion" },
      "cherry-1":            { id: "cherry-1",            x: 21, y: 25, type: "food", iconKey: "item.food.cherry" },
      "peach-1":             { id: "peach-1",             x: 43, y: 24, type: "food", iconKey: "item.food.peach" },
      "sushi-1":             { id: "sushi-1",             x: 55, y: 51, type: "food", iconKey: "item.food.sushi" },
      "shrimp-1":            { id: "shrimp-1",            x: 56, y: 51, type: "food", iconKey: "item.food.shrimp" },
      "sardines-1":          { id: "sardines-1",          x: 57, y: 51, type: "food", iconKey: "item.food.sardines" },
      "sashimi-1":           { id: "sashimi-1",           x: 54, y: 51, type: "food", iconKey: "item.food.sashimi" },
      // 점토 (연못·습지 근처)
      "clay-1": { id: "clay-1", x: 25, y: 27, type: "material", iconKey: "item.material.clay" },
      "clay-2": { id: "clay-2", x: 51, y: 43, type: "material", iconKey: "item.material.clay" },
      "clay-3": { id: "clay-3", x: 56, y: 44, type: "material", iconKey: "item.material.clay" },
      // 2026-05-12: expanded place seed resources.
      "fish-dock-1": { id: "fish-dock-1", x: 65, y: 26, type: "food", iconKey: "item.food.fish" },
      "fish-dock-2": { id: "fish-dock-2", x: 68, y: 27, type: "food", iconKey: "item.food.fish" },
      "fish-riverbank-1": { id: "fish-riverbank-1", x: 69, y: 10, type: "food", iconKey: "item.food.fish" },
      "herb-garden-1": { id: "herb-garden-1", x: 58, y: 36, type: "food", iconKey: "item.food.herb" },
      "herb-garden-2": { id: "herb-garden-2", x: 61, y: 37, type: "food", iconKey: "item.food.herb" },
      "mushroom-garden-1": { id: "mushroom-garden-1", x: 63, y: 39, type: "food", iconKey: "item.food.mushroom" },
      "berry-garden-1": { id: "berry-garden-1", x: 57, y: 39, type: "food", iconKey: "item.food.berry" },
      "bone-cemetery-1": { id: "bone-cemetery-1", x: 13, y: 48, type: "material", iconKey: "item.material.bone" },
      "essence-temple-1": { id: "essence-temple-1", x: 108, y: 17, type: "material", iconKey: "item.material.essence" },
      "ore-temple-1": { id: "ore-temple-1", x: 106, y: 18, type: "material", iconKey: "item.material.ore" },
      "ore-deep-ruins-1": { id: "ore-deep-ruins-1", x: 15, y: 83, type: "material", iconKey: "item.material.ore" },
      "coal-deep-ruins-1": { id: "coal-deep-ruins-1", x: 19, y: 83, type: "material", iconKey: "item.material.coal" },
      "apple-orchard-1": { id: "apple-orchard-1", x: 22, y: 66, type: "food", iconKey: "item.food.apple" },
      "apple-orchard-2": { id: "apple-orchard-2", x: 26, y: 68, type: "food", iconKey: "item.food.apple" },
      "wood-lumber-1": { id: "wood-lumber-1", x: 74, y: 70, type: "material", iconKey: "item.material.wood" },
      "wood-lumber-2": { id: "wood-lumber-2", x: 80, y: 73, type: "material", iconKey: "item.material.wood" },
      "ore-mine-shaft-1": { id: "ore-mine-shaft-1", x: 90, y: 73, type: "material", iconKey: "item.material.ore" },
      "coal-mine-shaft-1": { id: "coal-mine-shaft-1", x: 95, y: 76, type: "material", iconKey: "item.material.coal" },
      // 도구·장식
      "fishing_rod-1": { id: "fishing_rod-1", x: 39, y: 19, type: "tool", iconKey: "item.tool.fishing_rod" },
      "bucket-1": { id: "bucket-1", x: 27, y: 22, type: "tool", iconKey: "item.tool.bucket" },
      "simple_charm-1": { id: "simple_charm-1", x: 31, y: 17, type: "trinket", iconKey: "item.trinket.charm" },
      "letter-1": { id: "letter-1", x: 19, y: 31, type: "letter", iconKey: "item.letter" },
      "trinket-1": { id: "trinket-1", x: 31, y: 32, type: "trinket", iconKey: "item.trinket" }
    },
    spawnPoints: {
      humans: [
        { x: 20, y: 29, assetKey: "human.traveler" },
        { x: 28, y: 22, assetKey: "human.farmer" },
        { x: 25, y: 22, assetKey: "human.baker" },
        { x: 39, y: 22, assetKey: "human.merchant" },
        { x: 32, y: 22, assetKey: "human.guard" },
        { x: 30, y: 18, assetKey: "human.healer" }
      ],
      animals: [
        { x: 50, y: 2, assetKey: "animal.boar" },
        { x: 52, y: 2, assetKey: "animal.boar" }
      ],
      monsters: [
        { x: 42, y: 2, assetKey: "animal.boar" },
        { x: 44, y: 2, assetKey: "animal.boar" },
        { x: 41, y: 5, assetKey: "animal.boar" },
        { x: 73, y: 38, assetKey: "monster.skeleton" },
        { x: 77, y: 40, assetKey: "monster.skeleton_warrior" },
        { x: 81, y: 42, assetKey: "monster.skeleton_archer" },
        { x: 54, y: 45, assetKey: "monster.naga" },
        { x: 90, y: 48, assetKey: "monster.troll" },
        { x: 15, y: 49, assetKey: "monster.spirit" },
        { x: 67, y: 27, assetKey: "monster.naga" },
        { x: 103, y: 16, assetKey: "monster.skeleton_archer" },
        { x: 108, y: 17, assetKey: "monster.troll" },
        { x: 17, y: 83, assetKey: "monster.troll" },
        { x: 80, y: 15, assetKey: "animal.deer" },
        { x: 84, y: 16, assetKey: "animal.boar" }
      ]
    }
  };
  relocateGroundItems(world);
  return world;
};
