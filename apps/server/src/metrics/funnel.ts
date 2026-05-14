/**
 * Funnel metrics — 2026-05-06 신설.
 *
 * Skill 별로 단계별 진행 카운트:
 *   step0: agenda/intent activated     (현재는 skill trigger 충족 = activation 으로 간주)
 *   step1: first relevant pickup       (skill 의 requiredItems 중 하나 첫 인벤 진입)
 *   step2: ingredients complete        (모든 requiredItems 충족)
 *   step3: station/place adjacent      (skill trigger station/place 인접)
 *   step4: valid action attempted      (skill.actionTemplate 매칭 action dispatch)
 *   step5: success
 *
 * 라이브 종료 또는 /metrics/funnel 호출 시 단계별 카운트 + conversion 계산.
 */
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const file = resolve(process.cwd(), "data/funnel.ndjson");

export type FunnelStep = "step0_activate" | "step1_first_pickup" | "step2_ingredients_complete" | "step3_station_adjacent" | "step4_attempt" | "step5_success" | "step5_fail";

export interface FunnelEvent {
  ts: number;
  tick: number;
  actorId: string;
  skillId: string;
  step: FunnelStep;
  detail?: string;
}

let queue: FunnelEvent[] = [];
let flushing = false;

export async function recordFunnel(ev: FunnelEvent): Promise<void> {
  queue.push(ev);
  if (queue.length > 50 && !flushing) await flush();
}

export async function flush(): Promise<void> {
  if (queue.length === 0 || flushing) return;
  flushing = true;
  try {
    const batch = queue;
    queue = [];
    const text = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.appendFile(file, text, "utf-8");
  } catch (e) {
    console.warn("[funnel] append failed", e);
  } finally {
    flushing = false;
  }
}

export async function readRecent(limit = 5000): Promise<FunnelEvent[]> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    return tail.map((l) => {
      try { return JSON.parse(l) as FunnelEvent; } catch { return null; }
    }).filter((e): e is FunnelEvent => Boolean(e));
  } catch {
    return [];
  }
}

/** Funnel report — 라이브 timestamp 이후 events 만 집계 + skill·actor 별 단계별 카운트. */
export interface FunnelReport {
  liveStartTs: number;
  bySkillActor: Record<string, Record<FunnelStep, number>>;
  /** skill 단위 conversion rate */
  conversionBySkill: Record<string, { step1to2: number; step2to3: number; step3to4: number; step4to5: number; e2e: number }>;
}

export async function buildReport(liveStartTs: number): Promise<FunnelReport> {
  const events = await readRecent(20000);
  const filtered = events.filter((e) => e.ts >= liveStartTs);
  const bySkillActor: Record<string, Record<FunnelStep, number>> = {};
  const skillCounts: Record<string, Record<FunnelStep, number>> = {};
  for (const e of filtered) {
    const k = `${e.skillId}/${e.actorId}`;
    bySkillActor[k] = bySkillActor[k] ?? { step0_activate: 0, step1_first_pickup: 0, step2_ingredients_complete: 0, step3_station_adjacent: 0, step4_attempt: 0, step5_success: 0, step5_fail: 0 };
    bySkillActor[k][e.step] += 1;
    skillCounts[e.skillId] = skillCounts[e.skillId] ?? { step0_activate: 0, step1_first_pickup: 0, step2_ingredients_complete: 0, step3_station_adjacent: 0, step4_attempt: 0, step5_success: 0, step5_fail: 0 };
    skillCounts[e.skillId][e.step] += 1;
  }
  const conversionBySkill: Record<string, { step1to2: number; step2to3: number; step3to4: number; step4to5: number; e2e: number }> = {};
  for (const [skillId, c] of Object.entries(skillCounts)) {
    const ratio = (a: number, b: number): number => b > 0 ? a / b : 0;
    conversionBySkill[skillId] = {
      step1to2: ratio(c.step2_ingredients_complete, c.step1_first_pickup),
      step2to3: ratio(c.step3_station_adjacent, c.step2_ingredients_complete),
      step3to4: ratio(c.step4_attempt, c.step3_station_adjacent),
      step4to5: ratio(c.step5_success, c.step4_attempt),
      e2e: ratio(c.step5_success, c.step1_first_pickup)
    };
  }
  return { liveStartTs, bySkillActor, conversionBySkill };
}
