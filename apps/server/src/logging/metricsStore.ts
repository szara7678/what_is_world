import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

const file = resolve(process.cwd(), "data/metrics.ndjson");

/**
 * 매 brain 박자 한 줄. 분석용 KPI 적재.
 * 행동 로직에 침투하지 않는 "관찰용" 레이어. KPI 최적화가 NPC 조종으로 새지 않게 분리 유지.
 */
export type MetricEntry = {
  tick: number;
  ts: number;
  actor: string;
  /** mock / chatgpt-direct/<model> / system / unknown */
  provider: string;
  /** 액션 type. system_step / no_action 도 포함 */
  action: string;
  /** USE 모드: itemId / objectId / objectId+target / skillId / null */
  useMode?: string | null;
  success: boolean;
  failReason?: string;
  cooldownBlocked?: boolean;
  staminaBlocked?: boolean;
  inventoryBlocked?: boolean;
  /** agenda 결정 직후 상태 */
  agendaState?: string;
  /** 액션 결과로 skill xp 변화 (skillId → +xp) */
  skillXp?: Record<string, number>;
  /** trade 관련 신호 */
  tradeOpened?: boolean;
  tradeClosed?: boolean;
  /** LLM 호출 했는지 (system_step 만 한 박자면 false) */
  llmCalled: boolean;
  /** 이번 박자 prompt 에 노출된 affordance kind 목록 (sparseAffordance 결과) */
  affordancesExposed?: string[];
  /** 이번 박자 행동이 노출 affordance 중 하나에 부합하면 그 kind */
  affordanceActed?: string;
};

export const appendMetric = async (m: MetricEntry): Promise<void> => {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(m)}\n`, "utf-8");
};

export type MetricFilter = {
  fromTick?: number;
  toTick?: number;
  actor?: string;
  action?: string;
  provider?: string;
};

/** 디스크에서 읽기. tail-N 가능. */
export const readMetrics = async (filter: MetricFilter = {}, tail?: number): Promise<MetricEntry[]> => {
  let content = "";
  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter(Boolean);
  const tailLines = tail && tail < lines.length ? lines.slice(-tail) : lines;
  const out: MetricEntry[] = [];
  for (const ln of tailLines) {
    try {
      const m = JSON.parse(ln) as MetricEntry;
      if (filter.fromTick !== undefined && m.tick < filter.fromTick) continue;
      if (filter.toTick !== undefined && m.tick > filter.toTick) continue;
      if (filter.actor && m.actor !== filter.actor) continue;
      if (filter.action && m.action !== filter.action) continue;
      if (filter.provider && m.provider !== filter.provider) continue;
      out.push(m);
    } catch {
      continue;
    }
  }
  return out;
};

/** 집계: groupBy 차원 별 count·success·fails 분포. */
export type RollupKey = "actor" | "action" | "provider" | "hour" | "useMode" | "agendaState";

export type Rollup = {
  key: string;
  count: number;
  success: number;
  fail: number;
  cooldownBlocked: number;
  staminaBlocked: number;
  inventoryBlocked: number;
  failReasons: Record<string, number>;
  successRate: number;
};

export const rollupMetrics = (entries: MetricEntry[], by: RollupKey | RollupKey[]): Record<string, Rollup> => {
  const dims = Array.isArray(by) ? by : [by];
  const out: Record<string, Rollup> = {};
  for (const m of entries) {
    const k = dims.map((d) => keyOf(m, d)).join("|");
    if (!out[k]) {
      out[k] = { key: k, count: 0, success: 0, fail: 0, cooldownBlocked: 0, staminaBlocked: 0, inventoryBlocked: 0, failReasons: {}, successRate: 0 };
    }
    const r = out[k];
    r.count += 1;
    if (m.success) r.success += 1; else r.fail += 1;
    if (m.cooldownBlocked) r.cooldownBlocked += 1;
    if (m.staminaBlocked) r.staminaBlocked += 1;
    if (m.inventoryBlocked) r.inventoryBlocked += 1;
    if (m.failReason) r.failReasons[m.failReason] = (r.failReasons[m.failReason] ?? 0) + 1;
  }
  for (const r of Object.values(out)) r.successRate = r.count > 0 ? r.success / r.count : 0;
  return out;
};

const keyOf = (m: MetricEntry, dim: RollupKey): string => {
  if (dim === "actor") return m.actor;
  if (dim === "action") return m.action;
  if (dim === "provider") return m.provider;
  if (dim === "useMode") return m.useMode ?? "_";
  if (dim === "agendaState") return m.agendaState ?? "_";
  if (dim === "hour") return new Date(m.ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return "_";
};

/** trade 흐름 KPI: open vs close vs expire 비율. */
export const tradeFlowKpi = (entries: MetricEntry[]): { opened: number; closed: number; expireUnclosed: number; closeRate: number } => {
  let opened = 0, closed = 0;
  for (const m of entries) {
    if (m.tradeOpened) opened += 1;
    if (m.tradeClosed) closed += 1;
  }
  const expireUnclosed = Math.max(0, opened - closed);
  return { opened, closed, expireUnclosed, closeRate: opened > 0 ? closed / opened : 0 };
};

/** affordance 노출 vs 행동 전환 KPI. */
export const affordanceKpi = (entries: MetricEntry[]): Record<string, { exposed: number; acted: number; ignored: number; rate: number }> => {
  const byKind: Record<string, { exposed: number; acted: number; ignored: number; rate: number }> = {};
  for (const m of entries) {
    if (!m.affordancesExposed || m.affordancesExposed.length === 0) continue;
    for (const k of m.affordancesExposed) {
      if (!byKind[k]) byKind[k] = { exposed: 0, acted: 0, ignored: 0, rate: 0 };
      byKind[k].exposed += 1;
      if (m.affordanceActed === k) byKind[k].acted += 1;
      else byKind[k].ignored += 1;
    }
  }
  for (const v of Object.values(byKind)) v.rate = v.exposed > 0 ? v.acted / v.exposed : 0;
  return byKind;
};

/** skill XP 일별 누적 변화 합산. */
export const skillXpKpi = (entries: MetricEntry[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const m of entries) {
    if (!m.skillXp) continue;
    for (const [k, v] of Object.entries(m.skillXp)) {
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
};
