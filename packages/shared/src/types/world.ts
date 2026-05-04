import type { Place } from "./place";
import type { Skill } from "./skill";
import type { WorldContext } from "./world-context";

export type LayerName = "terrain" | "collision" | "decor";

export type Structure = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  assetKey?: string;
  props: Record<string, unknown>;
};

export type ActorKind = "player" | "npc" | "monster";

export type ActorStatus = {
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
};

/**
 * 인벤토리 슬롯. 두 가지 종류:
 *  - stack: 같은 catalog key 끼리 합친 슬롯 (count 포함). 음식·재료·물약·드랍 등.
 *  - instance: 개별 id·meta 보존 슬롯. 도구·무기·편지 등 개별 아이템.
 */
export type InventoryStackSlot = {
  kind: "stack";
  /** catalog key (items.ts ITEM_CATALOG 의 prefix) */
  item: string;
  count: number;
};

export type InventoryInstanceSlot = {
  kind: "instance";
  /** 고유 instance id (groundItem id 와 호환 가능). DROP 시 같은 id 로 ground 복귀 가능. */
  id: string;
  /** catalog key */
  item: string;
  meta?: Record<string, unknown>;
};

export type InventorySlot = InventoryStackSlot | InventoryInstanceSlot;

export type Actor = {
  id: string;
  kind: ActorKind;
  name: string;
  assetKey?: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  stamina: number;
  maxStamina: number;
  hunger: number;
  status: ActorStatus;
  skills: Skill[];
  gold: number;
  inventory: InventorySlot[];
  consecutiveThinks?: number;
  lastInventoryTick?: number;
  lastSkillTick?: number;
  lastAttackedAtTick?: number;
  lastAttackerId?: string;
  /** 마지막 MOVE 가 dispatch 된 tick. 다음 MOVE cooldown 검사에 사용. */
  lastMoveTick?: number;
  /** target 좌표까지의 path. tickWorld 가 매 tick cooldown 지나면 1칸씩 진행. */
  movePath?: Array<{ dx: number; dy: number }>;
  movePathTarget?: { x: number; y: number };
  alive: boolean;
};

export type GroundItem = {
  id: string;
  x: number;
  y: number;
  type: string;
  iconKey?: string;
  actorName?: string;
};

/**
 * 텃밭에 심긴 작물. tickWorld 가 매 tick growth 진행.
 * mature 시 ground item 으로 변환되어 PICKUP 가능.
 */
export type Crop = {
  id: string;
  x: number;
  y: number;
  /** 출력 prefix (wheat / carrot 등) */
  itemPrefix: string;
  /** seed prefix (wheat_seed 등) */
  seedPrefix: string;
  /** 심은 actor (xp 분배·소유 정보용) */
  plantedBy: string;
  /** 심은 tick */
  plantedAtTick: number;
  /** 자라기 완료 임계 tick — plantedAtTick + growthTicks(레벨 보정) */
  matureAtTick: number;
  /** 수확 시 떨굴 ground item 갯수 (1~3, farming 보정) */
  yieldCount: number;
  iconKey?: string;
};

export type WorldState = {
  revision: number;
  tick: number;
  timeOfDay: number;
  context: WorldContext;
  map: {
    width: number;
    height: number;
    tileSize: number;
    terrain: number[][];
    collision: number[][];
    decor: number[][];
  };
  structures: Record<string, Structure>;
  places: Record<string, Place>;
  actors: Record<string, Actor>;
  groundItems: Record<string, GroundItem>;
  crops?: Record<string, Crop>;
  pendingTrades?: Array<{
    from: string;
    to: string;
    expectedItem?: string;
    expectedCurrency?: "gold";
    amount?: number;
    expiresAtTick: number;
  }>;
  spawnPoints: {
    humans: Array<{ x: number; y: number; assetKey?: string }>;
    animals: Array<{ x: number; y: number; assetKey?: string }>;
    monsters: Array<{ x: number; y: number; assetKey?: string }>;
  };
};
