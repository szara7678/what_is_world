import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RawEvent } from "@wiw/shared";
import { getWorld } from "../state/worldStore";
import { readRawEvents } from "./eventLogStore";
import { readRecentHistory } from "./historyLogStore";
import { listSouls } from "../persistence/soulStore";
import { getLlmQueueStats } from "../brain/llmQueue";

const file = resolve(process.cwd(), "data/kpi.ndjson");

type KpiActor = {
  actionEntropy: number;
  lastSpeakTick: number | null;
  speakIntervalAvg: number | null;
  providerSplit: Record<string, number>;
  oracleCompliance: number | null;
  killCount: number;
};

const entropy = (values: string[]): number => {
  if (values.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => {
    const p = count / values.length;
    return sum - p * Math.log2(p);
  }, 0);
};

const actionType = (event: RawEvent): string | null => {
  const payload = event.payload as { action?: { type?: string } } | undefined;
  const explicit = payload?.action?.type;
  if (explicit) return explicit;
  return event.type.split(":")[0]?.trim().toUpperCase() || null;
};

export const recordKpiSnapshot = async (): Promise<void> => {
  const world = getWorld();
  const [events, souls, history] = await Promise.all([readRawEvents(), listSouls(), readRecentHistory(10000)]);
  const recent = events.slice(-1000);
  const now = Date.now();
  const recent5m = recent.filter((event) => now - event.timestamp <= 5 * 60 * 1000);
  const soulByActor = new Map(souls.map((soul) => [soul.actorId, soul]));
  const perActor: Record<string, KpiActor> = {};

  for (const actor of Object.values(world.actors)) {
    const actorEvents = recent.filter((event) => event.actorId === actor.id && (event.category === "brain" || event.category === "action"));
    const actions = actorEvents.map(actionType).filter((type): type is string => Boolean(type));
    const speakTicks = actorEvents
      .filter((event) => actionType(event) === "SPEAK")
      .map((event) => event.tick)
      .sort((a, b) => a - b);
    const intervals = speakTicks.slice(1).map((tick, index) => tick - speakTicks[index]);
    const providerSplit: Record<string, number> = {};
    for (const event of actorEvents) {
      const provider = (event.payload as { provider?: string } | undefined)?.provider;
      if (provider) providerSplit[provider] = (providerSplit[provider] ?? 0) + 1;
    }
    const soul = soulByActor.get(actor.id);
    const quest = soul?.activeQuest;
    const oracleCompliance = quest ? quest.status === "fulfilled" ? 1 : quest.status === "active" ? 0 : null : null;
    perActor[actor.id] = {
      actionEntropy: Number(entropy(actions).toFixed(3)),
      lastSpeakTick: speakTicks.at(-1) ?? null,
      speakIntervalAvg: intervals.length ? Number((intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(1)) : null,
      providerSplit,
      oracleCompliance,
      killCount: 0
    };
  }

  const allActions = recent
    .filter((event) => event.category === "brain" || event.category === "action")
    .map(actionType)
    .filter((type): type is string => Boolean(type));
  const actionCounts = new Map<string, number>();
  for (const action of allActions) actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
  const top3 = [...actionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => ({ type, count }));

  const livingActors = Object.values(world.actors).filter((actor) => actor.alive);
  const reflectionEvents = recent.filter((event) => event.category === "reflection");
  const brainEvents5m = recent5m.filter((event) => event.category === "brain");
  const decisionIntervals: number[] = [];
  const npcDecisionInterval: Record<string, number | null> = {};
  const actionLLMSplit: Record<string, number> = {};
  const reflectionLLMSplit: Record<string, number> = {};
  const skillProgressCount = recent5m.reduce((sum, event) => {
    const payload = event.payload as { skillProgress?: unknown[] } | undefined;
    return sum + (Array.isArray(payload?.skillProgress) ? payload.skillProgress.length : 0);
  }, 0);
  const history5m = history.filter((entry) => now - entry.ts <= 5 * 60 * 1000);

  for (const actor of Object.values(world.actors).filter((actor) => actor.kind === "npc")) {
    const ticks = brainEvents5m
      .filter((event) => event.actorId === actor.id)
      .map((event) => event.timestamp)
      .sort((a, b) => a - b);
    const intervals = ticks.slice(1).map((ts, index) => ts - ticks[index]);
    npcDecisionInterval[actor.id] = intervals.length
      ? Number((intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(1))
      : null;
    decisionIntervals.push(...intervals);
  }

  for (const event of recent5m) {
    const provider = (event.payload as { provider?: string } | undefined)?.provider ?? "unknown";
    if (event.category === "brain") actionLLMSplit[provider] = (actionLLMSplit[provider] ?? 0) + 1;
    if (event.category === "reflection") reflectionLLMSplit[provider] = (reflectionLLMSplit[provider] ?? 0) + 1;
  }

  const reflectionWithChange = reflectionEvents.filter((event) => {
    const payload = event.payload as { relationshipChanges?: unknown[] } | undefined;
    return Array.isArray(payload?.relationshipChanges) && payload.relationshipChanges.length > 0;
  }).length;

  const snapshot = {
    tick: world.tick,
    ts: Date.now(),
    perActor,
    survivalPressure: {
      hungerCriticalCount: livingActors.filter((actor) => actor.hunger >= 90).length,
      staminaCriticalCount: livingActors.filter((actor) => actor.stamina <= 30).length,
      hpDamagedCount: livingActors.filter((actor) => actor.hp < actor.maxHp).length
    },
    actionDiversity: {
      distinct: actionCounts.size,
      total: allActions.length,
      top3
    },
    throughput: {
      decisionsPer5min: brainEvents5m.length,
      npcDecisionInterval,
      npcDecisionIntervalAvg: decisionIntervals.length
        ? Number((decisionIntervals.reduce((a, b) => a + b, 0) / decisionIntervals.length).toFixed(1))
        : null
    },
    providerSplit: {
      actionLLMSplit,
      reflectionLLMSplit
    },
    skills: {
      skillProgressCount,
      skillLevelUpCount: history5m.filter((entry) => entry.kind === "skill.level_up").length
    },
    history: {
      nonRolloverHistoryCount: history5m.filter((entry) => entry.kind !== "day.rollover").length
    },
    llmQueue: getLlmQueueStats(),
    affinityActivity: {
      reflectionWithChange,
      totalReflections: reflectionEvents.length
    },
    world: {
      weather: world.context.weather,
      marketDay: world.context.marketDayActive,
      issue: world.context.activeIssue?.kind ?? null,
      resources: world.context.resources,
      alive: Object.values(world.actors).filter((actor) => actor.alive).length
    }
  };
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(snapshot)}\n`, "utf-8");
};

export const readRecentKpiSnapshots = async (limit = 20): Promise<unknown[]> => {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
};

export const startKpiSnapshotLoop = (): void => {
  setInterval(() => {
    void recordKpiSnapshot().catch((error) => console.warn("[kpi] snapshot failed", error));
  }, 5 * 60 * 1000);
};
