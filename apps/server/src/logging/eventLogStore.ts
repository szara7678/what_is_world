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
        return mk(ev, "🚶", `${name}이(가) 이동을 시작했어요.`, tone, name);
      }
      return mk(ev, "🚶", failed ? `${name}이(가) 가려 했지만 막혔어요${dir ? ` (${dir})` : ""}.` : `${name}이(가) ${dir ? `${dir}으로 ` : ""}한 칸 옮겼어요.`, tone, name);
    }
    if (type === "PICKUP") {
      return mk(ev, "✋", failed ? `${name}이(가) ${itemPretty ?? "무언가"}을(를) 줍지 못했어요.` : `${name}이(가) ${itemPretty ?? "물건"}을(를) 주웠어요.`, tone, name);
    }
    if (type === "GATHER") {
      // 2026-05-07: GATHER narrative 추가 — 직전 frontend 가 catch-all 로 "Aaron: GATHER" 만 표시되던 버그 수정.
      const ax = a as { gatherItem?: string; item?: string; gatherCount?: number; count?: number; gatherArea?: { placeId?: string; radius?: number } };
      const what = ax.gatherItem ?? ax.item;
      const itemP = what ? prettifyItem(what) : p?.item ? prettifyItem(p.item) : "자원";
      const cnt = ax.gatherCount ?? ax.count ?? p?.count ?? 1;
      const area = ax.gatherArea?.placeId ? ` (${ax.gatherArea.placeId})` : "";
      if (failed) return mk(ev, "🌾", `${name}이(가) ${itemP} 모으기에 실패했어요${area}.`, tone, name);
      if (ev.type === "gather:progress" || resultMsg?.startsWith("gather_progress:")) {
        return mk(ev, "🌾", `${name}이(가) ${itemP} ${cnt}개를 모았어요${area}.`, tone, name);
      }
      if (ev.type === "gather:done" || resultMsg?.startsWith("gather_done:")) {
        return mk(ev, "🌾", `${name}이(가) ${itemP} ${cnt}개 채집을 마쳤어요${area}.`, tone, name);
      }
      return mk(ev, "🌾", `${name}이(가) ${itemP} 채집을 시작했어요${area}.`, tone, name);
    }
    if (type === "DROP") {
      return mk(ev, "📤", `${name}이(가) ${itemPretty ?? "무언가"}을(를) 내려놨어요.`, tone, name);
    }
    if (type === "USE") {
      // USE 모드별 narrative — "무언가" 두루뭉술 제거
      const ax = a as { skillId?: string; objectId?: string; targetItemId?: string };
      let what: string;
      if (ax.skillId) {
        what = ax.skillId === "pray" ? "기도를 올렸어요" : ax.skillId === "appraise" ? "주변을 감정했어요" : `${ax.skillId} 스킬을 썼어요`;
        return mk(ev, "🖐️", failed ? `${name}이(가) ${what.replace(/요\.$/, "지 못했어요.")}` : `${name}이(가) ${what}.`, tone, name);
      }
      if (ax.objectId && ax.targetItemId) {
        const station = ax.objectId.replace(/^structure-/, "");
        const out = prettifyItem(ax.targetItemId);
        what = failed ? `${station}에서 ${out} 만들기에 실패했어요` : `${station}에서 ${out}을(를) 만들었어요`;
        return mk(ev, "🛠", `${name}이(가) ${what}.`, tone, name);
      }
      if (ax.objectId) {
        const station = ax.objectId.replace(/^structure-/, "");
        what = failed ? `${station}을(를) 살피지 못했어요` : `${station}을(를) 살폈어요`;
        return mk(ev, "🛠", `${name}이(가) ${what}.`, tone, name);
      }
      const usedItem = itemPretty ?? "무언가";
      return mk(ev, "🖐️", failed ? `${name}이(가) ${usedItem} 사용에 실패했어요.` : `${name}이(가) ${usedItem}을(를) 사용했어요.`, tone, name);
    }
    if (type === "OFFER_TRADE") {
      const ax = a as { targetId?: string; wantItem?: string; offerGold?: number; offerItem?: string };
      const targetName2 = ax.targetId ? actorName(ax.targetId) : undefined;
      const want = ax.wantItem ? prettifyItem(ax.wantItem) : null;
      const offer = ax.offerGold ? `금화 ${ax.offerGold}` : ax.offerItem ? prettifyItem(ax.offerItem) : null;
      const txt = `${want ?? "무언가"} ↔ ${offer ?? "대가"}`;
      return mk(ev, "🤝", failed ? `${name}이(가) ${targetName2 ?? "상대"}에게 거래 제안 못 했어요.` : `${name}이(가) ${targetName2 ?? "상대"}에게 ${txt} 거래를 제안했어요.`, "warm", name);
    }
    if (type === "GIVE") {
      const gift = a?.currency && a?.amount ? `${a.amount}${a.currency}` : (itemPretty ?? "선물");
      const to = targetName ? ` → ${targetName}` : "";
      return mk(ev, "🎁", `${name}이(가) ${gift}${to}을(를) 건넸어요.`, "warm", name);
    }
    if (type === "ATTACK") {
      const to = targetName ? ` → ${targetName}` : "";
      if (ev.type === "attack:stop") return mk(ev, "⚔️", `${name}이(가)${to} 공격을 멈췄어요.`, "calm", name);
      if (ev.type === "attack:done") return mk(ev, "⚔️", `${name}이(가)${to} 공격을 끝냈어요.`, "danger", name);
      if (!failed && resultMsg === "attack_approach") return mk(ev, "⚔️", `${name}이(가)${to} 공격하러 다가갔어요.`, "danger", name);
      return mk(ev, "⚔️", `${name}이(가)${to} 공격했어요.`, "danger", name);
    }
    if (type === "SLEEP" || ev.type.startsWith("sleep:")) {
      if (ev.type === "sleep:end") return mk(ev, "💤", `${name}이(가) 잠을 마쳤어요.`, "calm", name);
      if (ev.type === "sleep:interrupt") return mk(ev, "💤", `${name}이(가) 잠에서 깼어요.`, "warn", name);
      return mk(ev, "💤", failed ? `${name}이(가) 잠들지 못했어요.` : `${name}이(가) 잠을 자기 시작했어요.`, tone, name);
    }
    if (type === "PRAY") return mk(ev, "🙏", `${name}이(가) 기도를 올렸어요.`, "warm", name);
    if (type === "THINK") return mk(ev, "💭", `${name}이(가) 생각에 잠겼어요.`, "cool", name);
    if (type === "INVENTORY" || type === "OPTIONS") return mk(ev, "📋", `${name}이(가) 가진 것을 살폈어요.`, "calm", name);
    if (type === "WAIT") return mk(ev, "⏸", `${name}이(가) 잠시 멈췄어요.`, "calm", name);
    if (type === "AGENDA_PATH_FAIL") return mk(ev, "🚧", `${name}: 길이 막혀 다른 길을 찾는 중`, "warn", name);
    if (type === "SYSTEM_SKIP" || type === "LLM_skip") return null; // 너무 잦은 디버그 이벤트는 narrative 에서 제외
    return mk(ev, "✨", `${name}: ${type}`, tone, name);
  }
  if (ev.category === "edit") {
    return mk(ev, "🛠", `편집: ${ev.type}`, "cool", name);
  }
  if (ev.category === "world") {
    return mk(ev, "🌿", ev.type, "calm", name);
  }
  if (ev.category === "reflection") {
    return mk(ev, "🪞", `${name}이(가) 잠시 자기 마음을 살펴봤어요.`, "warm", name);
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
