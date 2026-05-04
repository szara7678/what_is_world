export type SkillType = "active" | "passive";

export interface Skill {
  id: string;
  name: string;
  type: SkillType;
  level: number;
  xp: number;
  lastPracticedTick: number;
  primaryStat: "strength" | "dexterity" | "constitution" | "intelligence";
  description: string;
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
