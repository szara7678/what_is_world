export type SkillType = "active" | "passive";

/**
 * SkillTrigger — Skill 이 prompt 의 `# 익숙한 일` 에 surface 되기 위한 조건.
 * 모든 조건이 충족되어야 surface. 하나라도 안 맞으면 prompt 에서 숨김.
 * 2026-05-06: cmd_hint 메모리 폐지하면서 procedural knowledge 가 여기로 이동.
 */
export interface SkillTrigger {
  stationType?: string;     // "oven" / "alchemy_table" / "forge" / "workbench"
  placeKind?: string;       // "field" / "pond" / "well" / "shop" / "shrine"
  requiredItems?: { item: string; count: number }[];  // 인벤 매칭
  /** monster prefix — combat skill 트리거. e.g. "monster" → 인접 monster 시 surface. */
  monsterNearby?: boolean;
  /** 빈 trigger = 항상 사용 가능 (basic skill). */
  always?: boolean;
}

/** SkillActionTemplate — schema 명시. prompt 한 줄 + 자동 xp 누적의 매칭 키. */
export interface SkillActionTemplate {
  type: "MOVE" | "ATTACK" | "SPEAK" | "USE" | "PICKUP" | "DROP" | "GIVE" | "GATHER" | "OFFER_TRADE" | "ACCEPT_TRADE" | "REJECT_TRADE" | "PRAY" | "THINK" | "OPTIONS" | "SLEEP" | "WAIT";
  itemId?: string;
  objectId?: string;
  targetItemId?: string;
  skillId?: string;
}

export interface Skill {
  id: string;
  name: string;
  type: SkillType;
  level: number;
  xp: number;
  lastPracticedTick: number;
  primaryStat: "strength" | "dexterity" | "constitution" | "intelligence";
  description: string;
  /** 2026-05-06 추가: procedural knowledge. */
  triggers?: SkillTrigger[];
  /** action template — schema 와 자동 xp 매칭에 모두 사용. */
  actionTemplate?: SkillActionTemplate;
  /** prompt 에 노출할 짧은 행동 안내. "오븐 옆 + 밀 두 개 → 빵 한 덩이" */
  affordanceHint?: string;
}

export const SKILL_LEVEL_THRESHOLDS: number[] = [0, 10, 30, 80, 200, 500, 1200, 3000, 7000, 15000, 30000];

export function levelForXp(xp: number): number {
  let lv = 0;
  for (let i = 1; i < SKILL_LEVEL_THRESHOLDS.length; i += 1) {
    if (xp >= SKILL_LEVEL_THRESHOLDS[i]) lv = i;
    else break;
  }
  return lv;
}

export function nextThreshold(level: number): number {
  return SKILL_LEVEL_THRESHOLDS[Math.min(level + 1, SKILL_LEVEL_THRESHOLDS.length - 1)];
}
