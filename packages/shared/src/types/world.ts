import type { Place } from "./place";
import type { Skill } from "./skill";
import type { AttackUntilCondition } from "./action";
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
  /** 2026-05-08: hunger ceiling (stat-coupled). 미설정 시 100 implicit. */
  maxHunger?: number;
  status: ActorStatus;
  skills: Skill[];
  /** 2026-05-08: 본인이 실제 craft 성공한 recipe 만 기록 (birth/heard 제외). prompt 의 KNOWN RECIPES surface. */
  knownRecipes?: Array<{ recipeId: string; count: number; firstCraftedTick: number; lastCraftedTick: number }>;
  /** 2026-05-08: appraise 성공한 item prefix → 학습한 max level. KNOWLEDGE 블록 desc 차등. */
  appraisedItems?: Record<string, number>;
  /** 2026-05-08: appraise 성공한 station kind → 학습한 max level. */
  appraisedStations?: Record<string, number>;
  /**
   * 2026-05-09 PR-1: 본인이 방문 or admin seed 한 place 별 자원 인지.
   * locked: admin seed → age decay 면제 (mentor 의 기본 지식).
   */
  discoveredPlaces?: Record<string, { resourcesSeen: string[]; firstVisitTick: number; lastVisitTick: number; locked?: boolean }>;
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
  /** USE sticky executor. 사거리 밖 station craft/use 를 예약하고 도착 후 tickWorld 가 실제 USE 를 재시도. */
  pendingUse?: {
    objectId?: string;
    itemId?: string;
    targetItemId?: string;
    skillId?: string;
    queuedAtTick: number;
  };
  /** GATHER count 자동 반복용 stash. tickWorld 가 매 tick 이동/줍기/채집을 진행. */
  gatherIntent?: {
    item: string;
    count: number;
    area?: { placeId?: string; radius?: number };
    allowWaitSpawn?: boolean;
    startedAtTick: number;
    collected: number;
    targetId?: string;
    targetKind?: "groundItem" | "structure";
  };
  /** P0-4: ATTACK 자동 반복용 stash. tickWorld 가 매 tick cooldown 지나면 자동 공격. */
  attackTargetId?: string;
  attackUntil?: AttackUntilCondition[];
  attackStartedAtTick?: number;
  attackMaxTicks?: number;
  /** SLEEP sticky executor. tickWorld 가 매 tick 회복/interrupt/maxTicks 를 처리. */
  sleeping?: {
    startedAtTick: number;
    maxTicks: number;
    lastTick: number;
  };
  lastBlockedPlan?: { tick: number; text: string; reason: string };
  recentBlockers?: Array<{ tick: number; reason: string }>;
  alive: boolean;
};

export type GroundItem = {
  id: string;
  x: number;
  y: number;
  type: string;
  iconKey?: string;
  actorName?: string;
  claimedBy?: string;
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

export type PendingTradeItem = { item: string; count: number };

export type PendingTradeOffer = { item?: string; count?: number; gold?: number };

export type PendingTradeStatus = "pending" | "accepted" | "rejected" | "expired" | "auto_rejected";

export type PendingTrade = {
  id: string;
  from: string;
  to: string;
  wants: PendingTradeItem[];
  offers: PendingTradeOffer;
  createdAtTick: number;
  expiresAtTick: number;
  status: PendingTradeStatus;
  reason?: string;
  resolvedAtTick?: number;
  /** Legacy fields retained for snapshot migration/backward compatibility only. */
  expectedItem?: string;
  expectedCurrency?: "gold";
  amount?: number;
};

export type WorldEvent = {
  tick: number;
  actorId?: string;
  category: "action" | "world" | "brain";
  type: string;
  result: "success" | "failed" | "info";
  reason?: string;
  payload?: Record<string, unknown>;
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
  pendingTrades?: PendingTrade[];
  eventQueue?: WorldEvent[];
  spawnPoints: {
    humans: Array<{ x: number; y: number; assetKey?: string }>;
    animals: Array<{ x: number; y: number; assetKey?: string }>;
    monsters: Array<{ x: number; y: number; assetKey?: string }>;
  };
};
