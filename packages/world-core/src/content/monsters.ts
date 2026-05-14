/**
 * 몬스터 통합 카탈로그.
 *
 * 사용자 요구: gold/drop/스탯/스킬/AI 행동 등 한 파일에서 정의.
 * dispatchAction.killActor, mock AI, createWorldState 가 이 파일을 참조.
 */
import type { Actor, ActorStatus, Skill, WorldState } from "@wiw/shared";

export type MonsterKind =
  | "boar"
  | "wolf"
  | "deer"
  | "bear"
  | "slime"
  | "spirit"
  | "skeleton"
  | "skeleton_warrior"
  | "skeleton_archer"
  | "naga"
  | "troll";

export type DropEntry = {
  item: string;
  iconKey: string;
  type: string;
  /** 0~1 */
  chance: number;
  rare?: boolean;
};

export type MonsterBehavior =
  | "passive"
  | "territorial"
  | "hostile_day"
  | "hostile_night"
  | "predator"
  | "ranged"
  | "tank";

export type MonsterDef = {
  kind: MonsterKind;
  /** 한국어 표시 이름 (시각상) */
  korName: string;
  /** assetKey 매핑 — animal.boar 등 */
  assetKey: string;
  /** 기본 hp */
  hp: number;
  /** 기본 status (str/dex/con/int) */
  status: ActorStatus;
  /** 적대 여부 — 비선공이면 false (deer 등) */
  hostile: boolean;
  /** AI 활동성 — true 면 자주 움직임, false 면 자주 멈춤 */
  active: boolean;
  /** Phase 4 AI behavior tag. */
  behavior: MonsterBehavior;
  /** 사망 시 골드 드롭 [min, max] */
  goldDrop: [number, number];
  /** 사망 시 아이템 드롭 후보 */
  drops: DropEntry[];
  /** 시작 스킬 (있으면) — 대부분 비어 있음 */
  skills?: Array<Pick<Skill, "id" | "level">>;
};

export const MONSTER_CATALOG: Record<MonsterKind, MonsterDef> = {
  boar: {
    kind: "boar",
    korName: "멧돼지",
    assetKey: "animal.boar",
    hp: 22,
    status: { strength: 3, dexterity: 4, constitution: 4, intelligence: 1 },
    hostile: false,         // 직접 도발 X 한 비선공. 다만 lastAttacker 있으면 반격.
    active: true,
    behavior: "passive",
    goldDrop: [3, 7],
    drops: [
      { item: "meat", iconKey: "item.food.meat", type: "food", chance: 0.85 },
      { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.55 },
      { item: "boar_tusk", iconKey: "item.material.tusk", type: "material", chance: 0.15, rare: true }
    ]
  },
  wolf: {
    kind: "wolf",
    korName: "늑대",
    assetKey: "animal.wolf",
    hp: 30,
    status: { strength: 4, dexterity: 5, constitution: 4, intelligence: 1 },
    hostile: true,
    active: true,
    behavior: "hostile_night",
    goldDrop: [4, 9],
    drops: [
      { item: "meat", iconKey: "item.food.meat", type: "food", chance: 0.7 },
      { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.55 },
      { item: "fang", iconKey: "item.material.fang", type: "material", chance: 0.45 },
      { item: "tracking_recipe", iconKey: "item.recipe", type: "recipe", chance: 0.05, rare: true }
    ]
  },
  deer: {
    kind: "deer",
    korName: "사슴",
    assetKey: "animal.deer",
    hp: 18,
    status: { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 },
    hostile: false,
    active: true,
    behavior: "passive",
    goldDrop: [2, 5],
    drops: [
      { item: "meat", iconKey: "item.food.meat", type: "food", chance: 0.85 },
      { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.6 },
      { item: "antler", iconKey: "item.material.bone", type: "material", chance: 0.25, rare: true }
    ]
  },
  bear: {
    kind: "bear",
    korName: "곰",
    assetKey: "animal.bear",
    hp: 50,
    status: { strength: 6, dexterity: 3, constitution: 6, intelligence: 1 },
    hostile: true,
    active: true,
    behavior: "predator",
    goldDrop: [12, 22],
    drops: [
      { item: "meat", iconKey: "item.food.meat", type: "food", chance: 0.9 },
      { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.7 },
      { item: "bear_claw", iconKey: "item.material.claw", type: "material", chance: 0.5 },
      { item: "blueprint_smithing", iconKey: "item.recipe", type: "recipe", chance: 0.08, rare: true }
    ]
  },
  slime: {
    kind: "slime",
    korName: "슬라임",
    assetKey: "monster.slime.green",
    hp: 16,
    status: { strength: 2, dexterity: 2, constitution: 3, intelligence: 1 },
    hostile: true,
    active: false,
    behavior: "territorial",
    goldDrop: [1, 3],
    drops: [
      { item: "gel", iconKey: "item.material.gel", type: "material", chance: 0.85 },
      { item: "slime_core", iconKey: "item.material.gel", type: "material", chance: 0.25, rare: true }
    ]
  },
  spirit: {
    kind: "spirit",
    korName: "영혼",
    assetKey: "monster.spirit",
    hp: 35,
    status: { strength: 3, dexterity: 5, constitution: 3, intelligence: 5 },
    hostile: true,
    active: true,
    behavior: "hostile_night",
    goldDrop: [8, 16],
    drops: [
      { item: "essence", iconKey: "item.material.essence", type: "material", chance: 0.6 },
      { item: "altar_recipe", iconKey: "item.recipe", type: "recipe", chance: 0.1, rare: true }
    ]
  },
  skeleton: {
    kind: "skeleton",
    korName: "스켈레톤",
    assetKey: "monster.skeleton",
    hp: 24,
    status: { strength: 3, dexterity: 3, constitution: 3, intelligence: 1 },
    hostile: true,
    active: true,
    behavior: "hostile_day",
    goldDrop: [3, 8],
    drops: [
      { item: "bone", iconKey: "item.material.bone", type: "material", chance: 0.75 },
      { item: "essence", iconKey: "item.material.essence", type: "material", chance: 0.12, rare: true }
    ]
  },
  skeleton_warrior: {
    kind: "skeleton_warrior",
    korName: "스켈레톤 전사",
    assetKey: "monster.skeleton_warrior",
    hp: 34,
    status: { strength: 5, dexterity: 3, constitution: 4, intelligence: 1 },
    hostile: true,
    active: true,
    behavior: "hostile_day",
    goldDrop: [6, 13],
    drops: [
      { item: "bone", iconKey: "item.material.bone", type: "material", chance: 0.8 },
      { item: "fang", iconKey: "item.material.fang", type: "material", chance: 0.22 },
      { item: "blueprint_smithing", iconKey: "item.recipe", type: "recipe", chance: 0.05, rare: true }
    ]
  },
  skeleton_archer: {
    kind: "skeleton_archer",
    korName: "스켈레톤 궁수",
    assetKey: "monster.skeleton_archer",
    hp: 28,
    status: { strength: 3, dexterity: 6, constitution: 3, intelligence: 1 },
    hostile: true,
    active: true,
    behavior: "ranged",
    goldDrop: [5, 11],
    drops: [
      { item: "bone", iconKey: "item.material.bone", type: "material", chance: 0.72 },
      { item: "tracking_recipe", iconKey: "item.recipe", type: "recipe", chance: 0.06, rare: true }
    ]
  },
  naga: {
    kind: "naga",
    korName: "나가",
    assetKey: "monster.naga",
    hp: 42,
    status: { strength: 5, dexterity: 5, constitution: 5, intelligence: 2 },
    hostile: true,
    active: true,
    behavior: "ranged",
    goldDrop: [10, 20],
    drops: [
      { item: "fang", iconKey: "item.material.fang", type: "material", chance: 0.5 },
      { item: "essence", iconKey: "item.material.essence", type: "material", chance: 0.18, rare: true }
    ]
  },
  troll: {
    kind: "troll",
    korName: "트롤",
    assetKey: "monster.troll",
    hp: 64,
    status: { strength: 7, dexterity: 2, constitution: 7, intelligence: 1 },
    hostile: true,
    active: true,
    behavior: "tank",
    goldDrop: [14, 28],
    drops: [
      { item: "hide", iconKey: "item.material.hide", type: "material", chance: 0.65 },
      { item: "claw", iconKey: "item.material.claw", type: "material", chance: 0.45 },
      { item: "bone", iconKey: "item.material.bone", type: "material", chance: 0.35 }
    ]
  }
};

export const behaviorForMonster = (assetKey: string | undefined): MonsterBehavior | null => {
  const kind = inferMonsterKind(assetKey);
  if (!kind) return null;
  const tier = inferMonsterTier(assetKey);
  if (kind === "boar" && tier >= 2) return "territorial";
  if ((kind === "wolf" || kind === "bear") && tier >= 2) return "predator";
  return MONSTER_CATALOG[kind].behavior;
};

export const isHostileCreature = (actor: Actor, world: Pick<WorldState, "timeOfDay">): boolean => {
  if (actor.kind !== "monster" || !actor.alive) return false;
  const kind = inferMonsterKind(actor.assetKey ?? "");
  const def = kind ? MONSTER_CATALOG[kind] : undefined;
  if (!def?.hostile) return false;
  const behavior = behaviorForMonster(actor.assetKey) ?? def.behavior;
  const isNight = world.timeOfDay >= 20 || world.timeOfDay < 5;
  if (behavior === "hostile_night") return isNight;
  if (behavior === "hostile_day") return !isNight;
  return behavior !== "passive";
};

export const inferMonsterKind = (assetKey: string | undefined): MonsterKind | null => {
  const ak = (assetKey ?? "").toLowerCase();
  if (ak.includes("boar")) return "boar";
  if (ak.includes("wolf")) return "wolf";
  if (ak.includes("bear")) return "bear";
  if (ak.includes("deer")) return "deer";
  if (ak.includes("slime")) return "slime";
  if (ak.includes("spirit") || ak.includes("ghost")) return "spirit";
  if (ak.includes("skeleton_warrior") || ak.includes("skeleton warrior")) return "skeleton_warrior";
  if (ak.includes("skeleton_archer") || ak.includes("skeleton archer")) return "skeleton_archer";
  if (ak.includes("skeleton")) return "skeleton";
  if (ak.includes("naga")) return "naga";
  if (ak.includes("troll")) return "troll";
  return null;
};

// 2026-05-09: Phase B.1 — 몬스터 티어 시스템. 같은 종이라도 lv1/2/3 강도 차등 → 무기 수요 자연 발생.
export type MonsterTier = 1 | 2 | 3;

/** assetKey 에 ".alpha" / ".dire" suffix 가 붙으면 해당 티어. 없으면 lv1. */
export const inferMonsterTier = (assetKey: string | undefined): MonsterTier => {
  const ak = (assetKey ?? "").toLowerCase();
  if (ak.includes(".dire")) return 3;
  if (ak.includes(".alpha")) return 2;
  return 1;
};

/** 티어별 멀티플라이어 — hp/strength/constitution/추격거리 가산. */
export const TIER_MULT: Record<MonsterTier, { hp: number; str: number; con: number; pursueBonus: number; goldMult: number; extraDropChance: number }> = {
  1: { hp: 1.0, str: 1.0, con: 1.0, pursueBonus: 0, goldMult: 1.0, extraDropChance: 0 },
  2: { hp: 1.5, str: 1.5, con: 1.3, pursueBonus: 3, goldMult: 2.0, extraDropChance: 0.4 },  // Alpha
  3: { hp: 2.5, str: 2.0, con: 1.8, pursueBonus: 6, goldMult: 4.0, extraDropChance: 0.7 }   // Dire
};

/** 표시명 prefix (시각 + 메모리 단서). 무기 압력 텍스트용. */
export const TIER_PREFIX: Record<MonsterTier, string> = { 1: "", 2: "Alpha ", 3: "Dire " };

/** 2026-05-09 v3: 위협 조정 — dire 8%, alpha 30%, common 62%. (직전 15/40 → 너무 강해서 4명 사망) */
export const rollMonsterTier = (rand: number = Math.random()): MonsterTier => {
  if (rand < 0.08) return 3;
  if (rand < 0.38) return 2;
  return 1;
};
