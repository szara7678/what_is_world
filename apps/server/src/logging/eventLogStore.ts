import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { pipeline } from "node:stream/promises";
import type { NarrativeEvent, RawEvent } from "@wiw/shared";
import { ko } from "@wiw/shared";
import { getWorld } from "../state/worldStore";

const dataDir = resolve(process.cwd(), "data");
const legacyNdjsonFile = join(dataDir, "events.ndjson");
const legacyLogFile = join(dataDir, "events.log");

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

// 2026-05-08: log rotation — events.ndjson 100MB cap, 초과 시 oldest 50% trim.
const EVENTS_MAX_BYTES = 100 * 1024 * 1024;
let lastRotationCheck = 0;
const ROTATION_CHECK_INTERVAL_MS = 60_000;

const dateKey = (ts: number): string => {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const eventFileFor = (ts: number): string => join(dataDir, `events-${dateKey(ts)}.ndjson`);

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

const maybeRotate = async (path: string): Promise<void> => {
  const now = Date.now();
  if (now - lastRotationCheck < ROTATION_CHECK_INTERVAL_MS) return;
  lastRotationCheck = now;
  try {
    const stat = await fs.stat(path);
    if (stat.size <= EVENTS_MAX_BYTES) return;
    await trimOldestHalf(path, stat.size);
    console.log(`[eventLogStore] rotated ${path}: ${stat.size} bytes -> newest ~50%`);
  } catch { /* ignore */ }
};

export const appendRawEvent = async (event: RawEvent): Promise<void> => {
  const path = eventFileFor(event.timestamp ?? Date.now());
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, `${JSON.stringify(event)}\n`, "utf-8");
  void maybeRotate(path);
  const narrative = toNarrative(event);
  eventBus.emit("raw", event);
  if (narrative) eventBus.emit("narrative", narrative);
};

const listEventFiles = async (days?: number): Promise<string[]> => {
  const files: string[] = [];
  try {
    await fs.access(legacyNdjsonFile);
    files.push(legacyNdjsonFile);
  } catch { /* ignore */ }
  try {
    const names = (await fs.readdir(dataDir))
      .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
      .sort();
    const picked = days && days > 0 ? names.slice(-days) : names;
    files.push(...picked.map((name) => join(dataDir, name)));
  } catch { /* ignore */ }
  if (files.length === 0) {
    try {
      await fs.access(legacyLogFile);
      files.push(legacyLogFile);
    } catch { /* ignore */ }
  }
  return files;
};

export const readRawEvents = async (days?: number): Promise<RawEvent[]> => {
  const out: RawEvent[] = [];
  for (const path of await listEventFiles(days)) {
    let content = "";
    try {
      content = await fs.readFile(path, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as RawEvent);
      } catch { /* ignore corrupt/truncated line */ }
    }
  }
  return out.sort((a, b) => (a.tick - b.tick) || (a.timestamp - b.timestamp));
};

export const readRecentEvents = async (limit = 200, days = 3): Promise<RawEvent[]> => {
  const all = await readRawEvents(days);
  return all.slice(-limit);
};

const nextId = () => `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export const toNarrative = (ev: RawEvent): NarrativeEvent | null => {
  const name = actorName(ev.actorId);
  if (ev.category === "action" || ev.category === "brain") {
    const p = ev.payload as
      | { resultMsg?: string; item?: string; count?: number; total?: number; elapsed?: number; action?: { type?: string; message?: string; reason?: string; itemId?: string; targetId?: string; currency?: string; amount?: number; dx?: number; dy?: number; gatherItem?: string; item?: string; gatherCount?: number; count?: number; gatherArea?: { placeId?: string; radius?: number } } }
      | undefined;
    const a = p?.action;
    const type = a?.type ?? ev.type.split(":")[0].split(/\s/)[0];
    const resultMsg = p?.resultMsg;
    const failed = ev.result === "failed";
    const tone: NarrativeEvent["tone"] = failed ? "warn" : "calm";

    const targetName = a?.targetId ? actorName(a.targetId) : undefined;
    const itemPretty = a?.itemId ? prettifyItem(a.itemId) : undefined;

    if (type === "SPEAK") {
      const msg = a?.message?.trim() || a?.reason?.trim() || "…";
      const to = targetName ? ` → ${targetName}` : "";
      return mk(ev, "💬", `${name}${to}: "${msg}"`, "warm", name);
    }
    if (type === "MOVE") {
      const dir = directionWord(a?.dx ?? 0, a?.dy ?? 0);
      if (!failed && (resultMsg?.startsWith("move_path_set:") || resultMsg?.startsWith("move_detour_set:"))) {
        return mk(ev, "🚶", `${name} set off on a path.`, tone, name);
      }
      return mk(ev, "🚶", failed ? `${name} tried to move${dir ? ` ${dir}` : ""} but was blocked.` : `${name} stepped${dir ? ` ${dir}` : ""}.`, tone, name);
    }
    if (type === "PICKUP") {
      return mk(ev, "✋", failed ? `${name} couldn't pick up ${itemPretty ?? "anything"}.` : `${name} picked up ${itemPretty ?? "an item"}.`, tone, name);
    }
    if (type === "GATHER") {
      const ax = a as { gatherItem?: string; item?: string; gatherCount?: number; count?: number; gatherArea?: { placeId?: string; radius?: number } };
      const what = ax.gatherItem ?? ax.item;
      const itemP = what ? prettifyItem(what) : p?.item ? prettifyItem(p.item) : "resources";
      const cnt = ax.gatherCount ?? ax.count ?? p?.count ?? 1;
      const area = ax.gatherArea?.placeId ? ` at ${ax.gatherArea.placeId}` : "";
      if (failed) return mk(ev, "🌾", `${name} failed to gather ${itemP}${area}.`, tone, name);
      if (ev.type === "gather:progress" || resultMsg?.startsWith("gather_progress:")) {
        return mk(ev, "🌾", `${name} gathered ${itemP} ×${cnt}${area}.`, tone, name);
      }
      if (ev.type === "gather:done" || resultMsg?.startsWith("gather_done:")) {
        return mk(ev, "🌾", `${name} finished gathering ${itemP} ×${cnt}${area}.`, tone, name);
      }
      return mk(ev, "🌾", `${name} started gathering ${itemP}${area}.`, tone, name);
    }
    if (type === "DROP") {
      return mk(ev, "📤", `${name} dropped ${itemPretty ?? "an item"}.`, tone, name);
    }
    if (type === "USE") {
      const ax = a as { skillId?: string; objectId?: string; targetItemId?: string };
      if (ax.skillId) {
        const skillVerb = ax.skillId === "pray" ? "prayed" : ax.skillId === "appraise" ? "appraised the surroundings" : `used skill ${ax.skillId}`;
        return mk(ev, "🖐️", failed ? `${name} tried to ${skillVerb} but failed.` : `${name} ${skillVerb}.`, tone, name);
      }
      if (ax.objectId && ax.targetItemId) {
        const station = ax.objectId.replace(/^structure-/, "");
        const out = prettifyItem(ax.targetItemId);
        return mk(ev, "🛠", failed ? `${name} failed to make ${out} at ${station}.` : `${name} made ${out} at ${station}.`, tone, name);
      }
      if (ax.objectId) {
        const station = ax.objectId.replace(/^structure-/, "");
        return mk(ev, "🛠", failed ? `${name} couldn't inspect ${station}.` : `${name} inspected ${station}.`, tone, name);
      }
      const usedItem = itemPretty ?? "an item";
      return mk(ev, "🖐️", failed ? `${name} failed to use ${usedItem}.` : `${name} used ${usedItem}.`, tone, name);
    }
    if (type === "OFFER_TRADE") {
      const ax = a as { targetId?: string; wantItem?: string; offerGold?: number; offerItem?: string };
      const targetName2 = ax.targetId ? actorName(ax.targetId) : undefined;
      const want = ax.wantItem ? prettifyItem(ax.wantItem) : null;
      const offer = ax.offerGold ? `${ax.offerGold} gold` : ax.offerItem ? prettifyItem(ax.offerItem) : null;
      const txt = `${want ?? "something"} ↔ ${offer ?? "something"}`;
      return mk(ev, "🤝", failed ? `${name} couldn't propose a trade to ${targetName2 ?? "someone"}.` : `${name} offered ${targetName2 ?? "someone"} a trade: ${txt}.`, "warm", name);
    }
    if (type === "GIVE") {
      const gift = a?.currency && a?.amount ? `${a.amount} ${a.currency}` : (itemPretty ?? "a gift");
      const to = targetName ? ` to ${targetName}` : "";
      return mk(ev, "🎁", `${name} gave ${gift}${to}.`, "warm", name);
    }
    if (type === "ATTACK") {
      const to = targetName ? ` ${targetName}` : "";
      if (ev.type === "attack:stop") return mk(ev, "⚔️", `${name} stopped attacking${to}.`, "calm", name);
      if (ev.type === "attack:done") return mk(ev, "⚔️", `${name} finished the fight${to}.`, "danger", name);
      if (!failed && resultMsg === "attack_approach") return mk(ev, "⚔️", `${name} closed in on${to}.`, "danger", name);
      return mk(ev, "⚔️", `${name} attacked${to}.`, "danger", name);
    }
    if (type === "SLEEP" || ev.type.startsWith("sleep:")) {
      if (ev.type === "sleep:end") return mk(ev, "💤", `${name} woke up.`, "calm", name);
      if (ev.type === "sleep:interrupt") return mk(ev, "💤", `${name} was startled awake.`, "warn", name);
      return mk(ev, "💤", failed ? `${name} couldn't fall asleep.` : `${name} lay down to sleep.`, tone, name);
    }
    if (type === "PRAY") return mk(ev, "🙏", `${name} offered a prayer.`, "warm", name);
    if (type === "THINK") return mk(ev, "💭", `${name} paused to think.`, "cool", name);
    if (type === "INVENTORY" || type === "OPTIONS") return mk(ev, "📋", `${name} checked what they were carrying.`, "calm", name);
    if (type === "WAIT") return mk(ev, "⏸", `${name} paused for a beat.`, "calm", name);
    if (type === "AGENDA_PATH_FAIL") return mk(ev, "🚧", `${name}: path blocked, looking for another way`, "warn", name);
    if (type === "SYSTEM_SKIP" || type === "LLM_skip") return null;
    return mk(ev, "✨", `${name}: ${type}`, tone, name);
  }
  if (ev.category === "edit") {
    return mk(ev, "🛠", `edit: ${ev.type}`, "cool", name);
  }
  if (ev.category === "world") {
    return mk(ev, "🌿", ev.type, "calm", name);
  }
  if (ev.category === "reflection") {
    return mk(ev, "🪞", `${name} took a moment to look inward.`, "warm", name);
  }
  return null;
};

// 방향·아이템 한국어는 packages/shared/src/content/i18n.ts ko 단일 출처
const directionWord = (dx: number, dy: number): string => ko.direction(dx, dy);
const prettifyItem = (id: string): string => ko.items(id);

function actorName(actorId: string): string {
  return getWorld().actors[actorId]?.name ?? actorId;
}

const mk = (ev: RawEvent, icon: string, text: string, tone: NarrativeEvent["tone"], actorNameValue?: string): NarrativeEvent => ({
  id: nextId(),
  tick: ev.tick,
  timestamp: ev.timestamp,
  icon,
  text,
  actorName: actorNameValue,
  tone,
  actorIds: [ev.actorId],
  raw: ev
});
