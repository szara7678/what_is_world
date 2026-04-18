import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { NarrativeEvent, RawEvent } from "@wiw/shared";

const file = resolve(process.cwd(), "apps/server/data/events.ndjson");
const legacyFile = resolve(process.cwd(), "apps/server/data/events.log");

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

export const appendRawEvent = async (event: RawEvent): Promise<void> => {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf-8");
  const narrative = toNarrative(event);
  eventBus.emit("raw", event);
  if (narrative) eventBus.emit("narrative", narrative);
};

export const readRawEvents = async (): Promise<RawEvent[]> => {
  let content = "";
  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    try {
      content = await fs.readFile(legacyFile, "utf-8");
    } catch {
      return [];
    }
  }
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as RawEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is RawEvent => e !== null);
};

export const readRecentEvents = async (limit = 200): Promise<RawEvent[]> => {
  const all = await readRawEvents();
  return all.slice(-limit);
};

const nextId = () => `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export const toNarrative = (ev: RawEvent): NarrativeEvent | null => {
  if (ev.category === "action") {
    const p = ev.payload as { action?: { type?: string; message?: string } } | undefined;
    const type = p?.action?.type ?? ev.type;
    if (type === "SPEAK") {
      return mk(ev, "💬", `${ev.actorId}: "${p?.action?.message ?? "…"}"`, "warm");
    }
    if (type === "MOVE") {
      return mk(ev, "🚶", `${ev.actorId}이(가) 걸음을 옮겼어요.`, "calm");
    }
    if (type === "USE") {
      return mk(ev, "🖐️", `${ev.actorId}이(가) 무언가를 사용했어요.`, "calm");
    }
    return mk(ev, "✨", `${ev.actorId}: ${type}`, ev.result === "failed" ? "warn" : "calm");
  }
  if (ev.category === "edit") {
    return mk(ev, "🛠", `편집: ${ev.type}`, "cool");
  }
  if (ev.category === "brain") {
    return mk(ev, "🧠", `${ev.actorId}: ${ev.type}`, "cool");
  }
  if (ev.category === "world") {
    return mk(ev, "🌿", ev.type, "calm");
  }
  if (ev.category === "reflection") {
    return mk(ev, "🪞", `${ev.actorId}: ${ev.type}`, "warm");
  }
  return null;
};

const mk = (ev: RawEvent, icon: string, text: string, tone: NarrativeEvent["tone"]): NarrativeEvent => ({
  id: nextId(),
  tick: ev.tick,
  timestamp: ev.timestamp,
  icon,
  text,
  tone,
  actorIds: [ev.actorId],
  raw: ev
});
