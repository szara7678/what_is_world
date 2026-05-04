import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { NarrativeEvent, RawEvent } from "@wiw/shared";
import { ko } from "@wiw/shared";
import { getWorld } from "../state/worldStore";

const file = resolve(process.cwd(), "data/events.ndjson");
const legacyFile = resolve(process.cwd(), "data/events.log");

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
  const name = actorName(ev.actorId);
  if (ev.category === "action" || ev.category === "brain") {
    const p = ev.payload as
      | { action?: { type?: string; message?: string; reason?: string; itemId?: string; targetId?: string; currency?: string; amount?: number; dx?: number; dy?: number } }
      | undefined;
    const a = p?.action;
    const type = a?.type ?? ev.type.split(":")[0].split(/\s/)[0];
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
      return mk(ev, "🚶", failed ? `${name}이(가) 가려 했지만 막혔어요${dir ? ` (${dir})` : ""}.` : `${name}이(가) ${dir ? `${dir}으로 ` : ""}한 칸 옮겼어요.`, tone, name);
    }
    if (type === "PICKUP") {
      return mk(ev, "✋", failed ? `${name}이(가) ${itemPretty ?? "무언가"}을(를) 줍지 못했어요.` : `${name}이(가) ${itemPretty ?? "물건"}을(를) 주웠어요.`, tone, name);
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
      return mk(ev, "⚔️", `${name}이(가)${to} 공격했어요.`, "danger", name);
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
