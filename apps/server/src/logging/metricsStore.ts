import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const file = resolve(process.cwd(), "data/metrics.ndjson");
const METRICS_MAX_BYTES = 50 * 1024 * 1024;
const ROTATION_CHECK_INTERVAL_MS = 60_000;
let lastRotationCheck = 0;

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
  /** deterministic Aaron mentor action, separated from player-1 LLM autonomy */
  mentor?: boolean;
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
  trade_accept_invalid_id?: boolean;
  trade_reject_invalid_id?: boolean;
  heard_claim_written?: boolean;
  heard_claim_skipped_reason?: string;
  /** LLM 호출 했는지 (system_step 만 한 박자면 false) */
  llmCalled: boolean;
  /** LLM usage/cost telemetry. Wrapper-level rows use action=LLM_CALL. */
  llm_model?: string;
  tokens_in?: number;
  tokens_out?: number;
  duration_ms?: number;
  llm_cost_usd?: number;
  /** 이번 박자 prompt 에 노출된 affordance kind 목록 (sparseAffordance 결과) */
  affordancesExposed?: string[];
  /** 이번 박자 행동이 노출 affordance 중 하나에 부합하면 그 kind */
  affordanceActed?: string;
  // ── PR1: plan-driven 관측 ─────────────────────
  /** plan 이벤트 종류 (plan.created/step_started/step_done/completed/abandoned/paused/resumed/failure/fallback_atomic/validation_failed) */
  planEvent?: string;
  /** plan id */
  planId?: string;
  /** plan 의 현재 step kind (실행 중인 것) */
  planStepKind?: string;
  /** plan 진행도 0..1 */
  planProgress?: number;
  /** plan 사유코드 (실패·중단 사유) */
  planReason?: string;
};

const rotationStartOffset = async (path: string, size: number): Promise<number> => {
  const fh = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = Math.floor(size / 2);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead <= 0) break;
      const newline = buf.subarray(0, bytesRead).indexOf(10);
      if (newline >= 0) return pos + newline + 1;
      pos += bytesRead;
    }
    return size;
  } finally {
    await fh.close();
  }
};

const trimOldestHalf = async (path: string, size: number): Promise<void> => {
  const start = await rotationStartOffset(path, size);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  if (start >= size) {
    await fs.writeFile(tmp, "", "utf-8");
  } else {
    await pipeline(createReadStream(path, { start }), createWriteStream(tmp));
  }
  await fs.rename(tmp, path);
};

const maybeRotate = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastRotationCheck < ROTATION_CHECK_INTERVAL_MS) return;
  lastRotationCheck = now;
  try {
    const stat = await fs.stat(file);
    if (stat.size <= METRICS_MAX_BYTES) return;
    await trimOldestHalf(file, stat.size);
    console.log(`[metricsStore] rotated metrics.ndjson: ${stat.size} bytes -> newest ~50%`);
  } catch { /* ignore */ }
};

/** plan KPI: created vs done vs abandoned vs paused/resumed 비율, step kind 별 success/fail. */
export const planKpi = (entries: MetricEntry[]): {
  created: number; completed: number; abandoned: number; failed: number;
  paused: number; resumed: number; fallbackAtomic: number; validationFailed: number;
  byStep: Record<string, { started: number; done: number; failed: number }>;
  reasons: Record<string, number>;
} => {
  let created = 0, completed = 0, abandoned = 0, failed = 0, paused = 0, resumed = 0, fallbackAtomic = 0, validationFailed = 0;
  const byStep: Record<string, { started: number; done: number; failed: number }> = {};
  const reasons: Record<string, number> = {};
  const bumpStep = (k: string, field: "started" | "done" | "failed") => {
    if (!byStep[k]) byStep[k] = { started: 0, done: 0, failed: 0 };
    byStep[k][field] += 1;
  };
  for (const m of entries) {
    if (!m.planEvent) continue;
    const e = m.planEvent;
    if (e === "plan.created") created += 1;
    else if (e === "plan.completed") completed += 1;
    else if (e === "plan.abandoned") abandoned += 1;
    else if (e === "plan.failure") failed += 1;
    else if (e === "plan.paused") paused += 1;
    else if (e === "plan.resumed") resumed += 1;
    else if (e === "plan.fallback_atomic") fallbackAtomic += 1;
    else if (e === "plan.validation_failed") validationFailed += 1;
    else if (e === "plan.step_started") bumpStep(m.planStepKind ?? "?", "started");
    else if (e === "plan.step_done") bumpStep(m.planStepKind ?? "?", "done");
    else if (e === "plan.step_failed") bumpStep(m.planStepKind ?? "?", "failed");
    if (m.planReason) reasons[m.planReason] = (reasons[m.planReason] ?? 0) + 1;
  }
  return { created, completed, abandoned, failed, paused, resumed, fallbackAtomic, validationFailed, byStep, reasons };
};

export const appendMetric = async (m: MetricEntry): Promise<void> => {
  await fs.mkdir(dirname(file), { recursive: true });
  const entry: MetricEntry = { ...m, mentor: m.mentor ?? m.provider === "mentor" };
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
  await maybeRotate();
};

export type MetricFilter = {
  fromTick?: number;
  toTick?: number;
  actor?: string;
  action?: string;
  provider?: string;
  mentor?: boolean;
  excludeMentor?: boolean;
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
      const parsed = JSON.parse(ln) as MetricEntry;
      const m: MetricEntry = { ...parsed, mentor: parsed.mentor ?? parsed.provider === "mentor" };
      if (filter.fromTick !== undefined && m.tick < filter.fromTick) continue;
      if (filter.toTick !== undefined && m.tick > filter.toTick) continue;
      if (filter.actor && m.actor !== filter.actor) continue;
      if (filter.action && m.action !== filter.action) continue;
      if (filter.provider && m.provider !== filter.provider) continue;
      if (filter.mentor !== undefined && Boolean(m.mentor) !== filter.mentor) continue;
      if (filter.excludeMentor && m.mentor) continue;
      out.push(m);
    } catch {
      continue;
    }
  }
  return out;
};

/** 집계: groupBy 차원 별 count·success·fails 분포. */
export type RollupKey = "actor" | "action" | "provider" | "mentor" | "hour" | "useMode" | "agendaState";

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
  if (dim === "mentor") return m.mentor ? "mentor" : "autonomous";
  if (dim === "useMode") return m.useMode ?? "_";
  if (dim === "agendaState") return m.agendaState ?? "_";
  if (dim === "hour") return new Date(m.ts).toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return "_";
};

export const mentorKpi = (entries: MetricEntry[]): { mentor: number; autonomous: number; byActor: Record<string, { mentor: number; autonomous: number }> } => {
  let mentor = 0, autonomous = 0;
  const byActor: Record<string, { mentor: number; autonomous: number }> = {};
  for (const m of entries) {
    byActor[m.actor] ??= { mentor: 0, autonomous: 0 };
    if (m.mentor) {
      mentor += 1;
      byActor[m.actor].mentor += 1;
    } else {
      autonomous += 1;
      byActor[m.actor].autonomous += 1;
    }
  }
  return { mentor, autonomous, byActor };
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

const GPT_54_MINI_INPUT_USD_PER_1M = 0.15;
const GPT_54_MINI_OUTPUT_USD_PER_1M = 0.60;

export const estimateLlmCostUsd = (tokensIn = 0, tokensOut = 0): number =>
  (tokensIn / 1_000_000) * GPT_54_MINI_INPUT_USD_PER_1M +
  (tokensOut / 1_000_000) * GPT_54_MINI_OUTPUT_USD_PER_1M;

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
};

export type LlmCostSummary = {
  calls: number;
  actors: number;
  models: Record<string, number>;
  avg_tokens_in_per_call: number;
  avg_tokens_out_per_call: number;
  avg_tokens_total_per_call: number;
  duration_ms_p50: number;
  duration_ms_p95: number;
  tokens_in_total: number;
  tokens_out_total: number;
  cost_usd_total: number;
  observed_hours: number;
  calls_per_actor_hour: number;
  cost_per_actor_hour_usd: number;
  scenario_5npc_1player_1monitor_hourly_usd: number;
  pricing: { model: "gpt-5.4-mini"; input_usd_per_1m: number; output_usd_per_1m: number };
};

export const llmCostSummary = (entries: MetricEntry[]): LlmCostSummary => {
  const llm = entries.filter((m) =>
    m.action === "LLM_CALL" ||
    m.tokens_in !== undefined ||
    m.tokens_out !== undefined ||
    m.duration_ms !== undefined
  );
  const calls = llm.length;
  const tokensIn = llm.reduce((sum, m) => sum + (m.tokens_in ?? 0), 0);
  const tokensOut = llm.reduce((sum, m) => sum + (m.tokens_out ?? 0), 0);
  const durations = llm.map((m) => m.duration_ms).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const cost = llm.reduce((sum, m) => sum + (m.llm_cost_usd ?? estimateLlmCostUsd(m.tokens_in ?? 0, m.tokens_out ?? 0)), 0);
  const actors = new Set(llm.map((m) => m.actor));
  const models: Record<string, number> = {};
  for (const m of llm) {
    const model = m.llm_model ?? m.provider;
    models[model] = (models[model] ?? 0) + 1;
  }
  const minTs = calls ? Math.min(...llm.map((m) => m.ts)) : 0;
  const maxTs = calls ? Math.max(...llm.map((m) => m.ts)) : 0;
  const observedHours = calls > 1 ? Math.max((maxTs - minTs) / 3_600_000, 1 / 60) : 0;
  const actorCount = Math.max(actors.size, 1);
  const callsPerActorHour = observedHours > 0 ? calls / observedHours / actorCount : 0;
  const costPerActorHour = observedHours > 0 ? cost / observedHours / actorCount : 0;
  return {
    calls,
    actors: actors.size,
    models,
    avg_tokens_in_per_call: calls ? tokensIn / calls : 0,
    avg_tokens_out_per_call: calls ? tokensOut / calls : 0,
    avg_tokens_total_per_call: calls ? (tokensIn + tokensOut) / calls : 0,
    duration_ms_p50: percentile(durations, 50),
    duration_ms_p95: percentile(durations, 95),
    tokens_in_total: tokensIn,
    tokens_out_total: tokensOut,
    cost_usd_total: cost,
    observed_hours: observedHours,
    calls_per_actor_hour: callsPerActorHour,
    cost_per_actor_hour_usd: costPerActorHour,
    scenario_5npc_1player_1monitor_hourly_usd: costPerActorHour * 7,
    pricing: {
      model: "gpt-5.4-mini",
      input_usd_per_1m: GPT_54_MINI_INPUT_USD_PER_1M,
      output_usd_per_1m: GPT_54_MINI_OUTPUT_USD_PER_1M
    }
  };
};
