import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { Soul, Thought, Observation, Relationship } from "@wiw/shared";
import { DEFAULT_SOUL, DEFAULT_THOUGHT, enrichSoulFromSeed, isDefaultSoulText } from "@wiw/shared";
import { embedText, setCachedObsEmbedding } from "../brain/embeddings";
import { recordImportanceObservation } from "../brain/importance";

export const soulBus = new EventEmitter();
soulBus.setMaxListeners(100);

const soulsDir   = resolve(process.cwd(), "data/souls");
const thoughtsDir = resolve(process.cwd(), "data/thoughts");
const memoriesDir = resolve(process.cwd(), "data/memories");
const relFile    = resolve(process.cwd(), "data/relationships.json");

const jsonSafe = (p: string) => p.replace(/[^\w\-]/g, "_");

const isOracleGoal = (goal: string): boolean => goal.startsWith("[oracle]") || goal.startsWith("[신탁]");

const ensureIdentitySeeds = (soul: Soul): { soul: Soul; changed: boolean } => {
  let changed = false;
  const next = { ...soul };
  if (!Array.isArray(next.seedValues)) {
    next.seedValues = [...(next.values ?? [])];
    changed = true;
  }
  if (!Array.isArray(next.seedGoals)) {
    next.seedGoals = (next.goals ?? []).filter((goal) => !isOracleGoal(goal));
    changed = true;
  }
  return { soul: next, changed };
};

export const readSoul = async (actorId: string, name: string): Promise<Soul> => {
  const path = `${soulsDir}/${jsonSafe(actorId)}.json`;
  try {
    const raw = await fs.readFile(path, "utf-8");
    let soul = JSON.parse(raw) as Soul;
    const seeded = ensureIdentitySeeds(soul);
    if (seeded.changed) {
      soul = seeded.soul;
      await writeSoul(soul);
    }
    // one-time migration: default 텍스트로 만들어진 soul → 풍부 페르소나 시드로 갱신
    if (isDefaultSoulText(soul)) {
      const enriched = enrichSoulFromSeed(soul);
      if (enriched !== soul) {
        soul = enriched;
        await writeSoul(soul);
      }
    }
    return soul;
  } catch {
    const fresh = DEFAULT_SOUL(actorId, name);
    const seeded = ensureIdentitySeeds(fresh).soul;
    await writeSoul(seeded);
    return seeded;
  }
};

export const writeSoul = async (soul: Soul): Promise<void> => {
  await fs.mkdir(soulsDir, { recursive: true });
  soul.updatedAt = Date.now();
  await fs.writeFile(`${soulsDir}/${jsonSafe(soul.actorId)}.json`, JSON.stringify(soul, null, 2), "utf-8");
};

export const listSouls = async (): Promise<Soul[]> => {
  try {
    const files = await fs.readdir(soulsDir);
    const out: Soul[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(`${soulsDir}/${f}`, "utf-8");
        out.push(JSON.parse(raw));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
};

export const readThought = async (actorId: string, tick: number): Promise<Thought> => {
  const path = `${thoughtsDir}/${jsonSafe(actorId)}.json`;
  try {
    const raw = await fs.readFile(path, "utf-8");
    return JSON.parse(raw) as Thought;
  } catch {
    const fresh = DEFAULT_THOUGHT(actorId, tick);
    await writeThought(fresh);
    return fresh;
  }
};

export const writeThought = async (thought: Thought): Promise<void> => {
  await fs.mkdir(thoughtsDir, { recursive: true });
  thought.updatedAtMs = Date.now();
  await fs.writeFile(`${thoughtsDir}/${jsonSafe(thought.actorId)}.json`, JSON.stringify(thought, null, 2), "utf-8");
};

export const listThoughts = async (): Promise<Thought[]> => {
  try {
    const files = await fs.readdir(thoughtsDir);
    const out: Thought[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(`${thoughtsDir}/${f}`, "utf-8");
        out.push(JSON.parse(raw));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
};

// 2026-05-08: memory rotation — actor 당 50MB cap, 초과 시 oldest 50% trim.
// (retrieve 는 importance + recency 조합이라 oldest 절반은 손실 영향 작음.)
const MEMORY_MAX_BYTES = 50 * 1024 * 1024;
const memoryRotationLast: Record<string, number> = {};
const MEM_ROTATION_INTERVAL_MS = 120_000; // 2분 throttle

const maybeRotateMemory = async (path: string, actorId: string): Promise<void> => {
  const now = Date.now();
  if ((memoryRotationLast[actorId] ?? 0) > now - MEM_ROTATION_INTERVAL_MS) return;
  memoryRotationLast[actorId] = now;
  try {
    const stat = await fs.stat(path);
    if (stat.size <= MEMORY_MAX_BYTES) return;
    const content = await fs.readFile(path, "utf-8");
    const lines = content.split("\n");
    const keep = lines.slice(Math.floor(lines.length / 2));
    await fs.writeFile(path, keep.join("\n"), "utf-8");
    console.log(`[soulStore] rotated ${actorId} memory: ${stat.size} bytes → ~half (${keep.length} lines)`);
  } catch { /* ignore */ }
};

export const appendObservation = async (obs: Observation): Promise<void> => {
  await fs.mkdir(memoriesDir, { recursive: true });
  const path = `${memoriesDir}/${jsonSafe(obs.actorId)}.jsonl`;
  if (obs.embedding) setCachedObsEmbedding(obs.id, obs.embedding);
  const { embedding: _drop, ...record } = obs;
  await fs.appendFile(path, `${JSON.stringify(record)}\n`, "utf-8");
  try { recordImportanceObservation(obs.actorId, obs.importance, obs.kind); } catch {}
  void maybeRotateMemory(path, obs.actorId);
  soulBus.emit("observation", record);
  if (!obs.embedding && obs.text.trim().length >= 10) {
    void embedText(obs.text).then((vec) => {
      if (vec) setCachedObsEmbedding(obs.id, vec);
    }).catch(() => {});
  }
};

export const readObservations = async (actorId: string, limit = 50): Promise<Observation[]> => {
  const path = `${memoriesDir}/${jsonSafe(actorId)}.jsonl`;
  try {
    const raw = await fs.readFile(path, "utf-8");
    const all = raw.split("\n").filter(Boolean).map((l) => {
      const obs = JSON.parse(l) as Observation;
      if (Array.isArray(obs.embedding)) setCachedObsEmbedding(obs.id, obs.embedding);
      const { embedding: _drop, ...record } = obs;
      return record;
    });
    return all.slice(-limit);
  } catch {
    return [];
  }
};

export const readAllRelationships = async (): Promise<Relationship[]> => {
  try {
    const raw = await fs.readFile(relFile, "utf-8");
    return JSON.parse(raw) as Relationship[];
  } catch {
    return [];
  }
};

export const writeRelationships = async (rels: Relationship[]): Promise<void> => {
  await fs.mkdir(dirname(relFile), { recursive: true });
  await fs.writeFile(relFile, JSON.stringify(rels, null, 2), "utf-8");
};
