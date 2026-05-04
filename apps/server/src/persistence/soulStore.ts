import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { Soul, SoulRole, Thought, Observation, Relationship } from "@wiw/shared";
import { DEFAULT_SOUL, DEFAULT_THOUGHT, enrichSoulFromSeed, isDefaultSoulText } from "@wiw/shared";

export const soulBus = new EventEmitter();
soulBus.setMaxListeners(100);

const soulsDir   = resolve(process.cwd(), "data/souls");
const thoughtsDir = resolve(process.cwd(), "data/thoughts");
const memoriesDir = resolve(process.cwd(), "data/memories");
const relFile    = resolve(process.cwd(), "data/relationships.json");

const jsonSafe = (p: string) => p.replace(/[^\w\-]/g, "_");

const inferRole = (actorId: string, name: string): SoulRole | undefined => {
  if (actorId === "player-1") return "hero";
  if (actorId === "npc-1") return "farmer";
  if (actorId === "npc-2" || name.toLowerCase().includes("baker")) return "baker";
  if (actorId === "npc-3") return "merchant";
  if (actorId === "npc-4") return "guard";
  return undefined;
};

export const readSoul = async (actorId: string, name: string): Promise<Soul> => {
  const path = `${soulsDir}/${jsonSafe(actorId)}.json`;
  try {
    const raw = await fs.readFile(path, "utf-8");
    let soul = JSON.parse(raw) as Soul;
    const role = soul.role ?? inferRole(actorId, soul.name ?? name);
    if (role && soul.role !== role) {
      soul.role = role;
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
    const fresh = DEFAULT_SOUL(actorId, name, inferRole(actorId, name));
    await writeSoul(fresh);
    return fresh;
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

export const appendObservation = async (obs: Observation): Promise<void> => {
  await fs.mkdir(memoriesDir, { recursive: true });
  const path = `${memoriesDir}/${jsonSafe(obs.actorId)}.jsonl`;
  await fs.appendFile(path, `${JSON.stringify(obs)}\n`, "utf-8");
  soulBus.emit("observation", obs);
};

export const readObservations = async (actorId: string, limit = 50): Promise<Observation[]> => {
  const path = `${memoriesDir}/${jsonSafe(actorId)}.jsonl`;
  try {
    const raw = await fs.readFile(path, "utf-8");
    const all = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Observation);
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
