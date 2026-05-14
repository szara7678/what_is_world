import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HistoryEntry } from "../logging/historyLogStore";
import { readRecentHistory } from "../logging/historyLogStore";
import { listSouls, readObservations } from "../persistence/soulStore";

/**
 * 연대기 (마을의 기록): 일별로 사건을 LLM이 정리한 짧은 일기.
 * - milestone: 결정론적으로 추출 (history.ndjson 의 의미 있는 사건)
 * - page: gpt-5.4 가 milestone + 인용 가능한 dialogue 를 받아 작성
 * - 호출: chatgpt-direct (Responses API). 일별 1회 idempotent.
 */

const PAGES_FILE = resolve(process.cwd(), "data/chronicle_pages.json");
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const AUTH_PATH = `${process.env.HOME}/.codex/auth.json`;
const TICKS_PER_DAY = 1440; // 2026-05-06: server tickWorld 1 tick = 1 game min, 1 day = 1440 tick

export interface ChroniclePage {
  dayId: string;          // "day-1", "day-2", ... ("week-3", "month-1" for rollups)
  dayIndex: number;       // 1-based (week index for week pages, month index for month pages)
  startTick: number;
  endTick: number;
  generatedAt: number;
  generatedAtTick: number;
  model: string;
  title: string;
  body: string;
  quotes: string[];
  milestoneCount: number;
  milestones: Array<{ tick: number; kind: string; text: string; actorId?: string }>;
  /** Rollup discriminator. Daily pages default to undefined (treated as "day"); weekly/monthly rollup pages set this explicitly. */
  kind?: "day" | "week" | "month";
}

interface PagesFile { pages: ChroniclePage[] }

async function readPages(): Promise<ChroniclePage[]> {
  try {
    const raw = await fs.readFile(PAGES_FILE, "utf-8");
    const data = JSON.parse(raw) as PagesFile;
    return data.pages ?? [];
  } catch {
    return [];
  }
}

async function writePages(pages: ChroniclePage[]): Promise<void> {
  await fs.mkdir(dirname(PAGES_FILE), { recursive: true });
  await fs.writeFile(PAGES_FILE, JSON.stringify({ pages }, null, 2), "utf-8");
}

export async function listChroniclePages(): Promise<ChroniclePage[]> {
  return readPages();
}

/**
 * milestone 결정론적 추출. history.ndjson 에서 의미 있는 kind 만 추출.
 * 추후 reflection lesson, agenda completed/blocked, level-up 등 확장.
 */
function extractMilestones(history: HistoryEntry[], startTick: number, endTick: number): HistoryEntry[] {
  // day.rollover 는 의미 없는 시간 표시라 제외. 나머지 의미 있는 사건은 다 포함.
  const SKIP = ["day.rollover"];
  return history.filter((h) => h.tick >= startTick && h.tick < endTick && !SKIP.includes(h.kind));
}

interface AuthCache { token: string; accountId: string; loadedAt: number }
let authCache: AuthCache | null = null;
async function readAuth(): Promise<AuthCache | null> {
  if (authCache && Date.now() - authCache.loadedAt < 60_000) return authCache;
  try {
    const raw = await fs.readFile(AUTH_PATH, "utf-8");
    const data = JSON.parse(raw);
    const token = data?.tokens?.access_token;
    const accountId = data?.tokens?.account_id;
    if (typeof token !== "string" || typeof accountId !== "string") return null;
    authCache = { token, accountId, loadedAt: Date.now() };
    return authCache;
  } catch { return null; }
}

interface LlmPage { title: string; body: string; quotes: string[] }

async function callChatgptResponses(model: string, instructions: string, userText: string): Promise<string | null> {
  const auth = await readAuth();
  if (!auth) return null;
  const body = {
    model,
    instructions,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
    store: false,
    stream: true,
  };
  try {
    const res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.token}`,
        "chatgpt-account-id": auth.accountId,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[chronicle] gpt ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status === 401) authCache = null;
      return null;
    }
    return await readStreamText(res);
  } catch (e) {
    console.warn("[chronicle] gpt error:", e);
    return null;
  }
}

async function readStreamText(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
          parts.push(evt.delta);
        }
      } catch {}
    }
  }
  return parts.join("");
}

function parseLlmJson(text: string): LlmPage | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const obj = t.match(/\{[\s\S]*\}/);
  if (!obj) return null;
  try {
    const parsed = JSON.parse(obj[0]);
    const title = String(parsed.title ?? "").slice(0, 80) || "이름 없는 하루";
    const body = String(parsed.body ?? "").slice(0, 2000);
    const quotes = Array.isArray(parsed.quotes) ? parsed.quotes.map(String).slice(0, 3) : [];
    if (!body) return null;
    return { title, body, quotes };
  } catch {
    return null;
  }
}

const INSTRUCTIONS = `You are the chronicler of a small village. You receive a list of events that actually happened yesterday and turn them into a short diary entry in English (2-3 paragraphs).

Rules:
- Do not invent events that are not in the input. Do not introduce people, items, or places not listed.
- Do not imagine NPC inner thoughts. Describe only their real actions, dialogue, and outcomes.
- Tone: warm and grounded short-story prose, first person of the chronicler or quiet observer.
- title is one sentence summarizing the day (e.g. "A morning the sun arrived late").
- quotes are 1-2 short lines that appeared directly in the input. Never invent dialogue.

Output one JSON object only:
{"title":"...","body":"2-3 paragraph diary in English","quotes":["...","..."]}`;

interface BuildOptions {
  dayIndex: number;
  startTick: number;
  endTick: number;
  history: HistoryEntry[];
  observations: { actorId: string; text: string; tick: number; tags: string[] }[];
  souls: { name: string; persona?: string }[];
  model: string;
  generatedAtTick: number;
}

async function buildPage(opts: BuildOptions): Promise<ChroniclePage | null> {
  const milestones = extractMilestones(opts.history, opts.startTick, opts.endTick).slice(0, 40);
  const dialogue = opts.observations
    .filter((o) => o.tick >= opts.startTick && o.tick < opts.endTick && o.tags.includes("speak"))
    .slice(-12);
  const lessonObs = opts.observations
    .filter((o) => o.tick >= opts.startTick && o.tick < opts.endTick && o.tags.includes("lesson"))
    .slice(-6);

  if (milestones.length === 0 && dialogue.length === 0 && lessonObs.length === 0) {
    return null; // 그날 적을 게 없으면 페이지 생성하지 않음
  }

  const lines: string[] = [];
  lines.push(`# Yesterday (day ${opts.dayIndex}) — villagers`);
  for (const s of opts.souls.slice(0, 8)) lines.push(`- ${s.name}${s.persona ? ` (${s.persona.slice(0, 30)})` : ""}`);
  lines.push("");
  lines.push(`# What happened yesterday (tick ${opts.startTick}~${opts.endTick})`);
  if (milestones.length === 0) lines.push("- (no major events)");
  for (const m of milestones) lines.push(`- [tick ${m.tick}] ${m.kind}: ${m.text}${m.actorId ? ` (${m.actorId})` : ""}`);
  if (dialogue.length) {
    lines.push("");
    lines.push("# Things people said");
    for (const d of dialogue) lines.push(`- [tick ${d.tick}] ${d.actorId}: ${d.text}`);
  }
  if (lessonObs.length) {
    lines.push("");
    lines.push("# What the village learned");
    for (const o of lessonObs) lines.push(`- [tick ${o.tick}] ${o.actorId}: ${o.text}`);
  }
  lines.push("");
  lines.push("Turn the events above into a short diary entry in English (2-3 paragraphs). Output one JSON object only.");

  const userText = lines.join("\n");
  const raw = await callChatgptResponses(opts.model, INSTRUCTIONS, userText);
  if (!raw) return null;
  const llm = parseLlmJson(raw);
  if (!llm) return null;

  return {
    dayId: `day-${opts.dayIndex}`,
    dayIndex: opts.dayIndex,
    startTick: opts.startTick,
    endTick: opts.endTick,
    generatedAt: Date.now(),
    generatedAtTick: opts.generatedAtTick,
    model: opts.model,
    title: llm.title,
    body: llm.body,
    quotes: llm.quotes,
    milestoneCount: milestones.length,
    milestones: milestones.map((m) => ({ tick: m.tick, kind: m.kind, text: m.text, actorId: m.actorId })),
  };
}

export async function ensureChroniclePages(currentTick: number, model = "gpt-5.4"): Promise<ChroniclePage[]> {
  const pages = await readPages();
  const completedDays = Math.floor(currentTick / TICKS_PER_DAY); // day 1 은 tick 2400 도달 시 생성 가능
  if (completedDays === 0) return pages;

  // 이미 있는 dayIndex set
  const existing = new Set(pages.map((p) => p.dayIndex));
  const allHistory = await readRecentHistory(2000);
  const allSouls = await listSouls();
  // monster 는 chronicle 본문에서 등장 인물에서 빼자 (사람 NPC + player 만)
  const peopleSouls = allSouls.filter((s) => !s.actorId.startsWith("monster-"));
  const souls = peopleSouls.map((s) => ({ name: s.name, persona: s.persona, actorId: s.actorId }));

  // 관찰: speak/lesson 태그 만 모아서 (전체는 비싸니까)
  const allObs: { actorId: string; text: string; tick: number; tags: string[] }[] = [];
  for (const s of souls) {
    const obs = await readObservations(s.actorId, 200);
    for (const o of obs) {
      if (o.tags.includes("speak") || o.tags.includes("lesson")) {
        allObs.push({ actorId: s.actorId, text: o.text, tick: o.tick, tags: o.tags });
      }
    }
  }

  let updated = false;
  for (let day = 1; day <= completedDays; day++) {
    if (existing.has(day)) continue;
    const startTick = (day - 1) * TICKS_PER_DAY;
    const endTick = day * TICKS_PER_DAY;
    const page = await buildPage({
      dayIndex: day,
      startTick, endTick,
      history: allHistory,
      observations: allObs,
      souls,
      model,
      generatedAtTick: currentTick,
    });
    if (page) {
      pages.push(page);
      updated = true;
      console.log(`[chronicle] day-${day} page generated (${page.milestoneCount} milestones, model=${model})`);
    }
  }
  if (updated) await writePages(pages);
  return pages;
}

/**
 * Generate a rollup page summarizing a range of daily pages.
 * kind="week" expects 7 daily pages, kind="month" expects ~30.
 * If a rollup with the same kind+index already exists it is replaced.
 */
export async function generateChronicleRollup(
  kind: "week" | "month",
  index: number,
  currentTick: number,
  model = "gpt-5.4"
): Promise<ChroniclePage | null> {
  const pages = await readPages();
  const daysPerUnit = kind === "week" ? 7 : 30;
  const startDay = (index - 1) * daysPerUnit + 1;
  const endDay = startDay + daysPerUnit - 1;
  const dailyInRange = pages
    .filter((p) => (p.kind ?? "day") === "day" && p.dayIndex >= startDay && p.dayIndex <= endDay)
    .sort((a, b) => a.dayIndex - b.dayIndex);
  if (dailyInRange.length === 0) return null;

  const startTick = dailyInRange[0].startTick;
  const endTick = dailyInRange[dailyInRange.length - 1].endTick;
  const lines: string[] = [];
  lines.push(`# ${kind === "week" ? "Week" : "Month"} ${index} — day pages ${dailyInRange[0].dayIndex}-${dailyInRange[dailyInRange.length - 1].dayIndex}`);
  lines.push("");
  for (const p of dailyInRange) {
    lines.push(`## Day ${p.dayIndex}: ${p.title}`);
    lines.push(p.body);
    if (p.quotes.length) {
      lines.push("Quotes:");
      for (const q of p.quotes) lines.push(`- "${q}"`);
    }
    lines.push("");
  }
  lines.push(`Write a single ${kind === "week" ? "weekly" : "monthly"} reflection in English (3-5 paragraphs) that captures the arc of these ${dailyInRange.length} days. Identify recurring threads, relationship shifts, lessons that compounded, and the village's overall mood at the end of the period. Output one JSON object: {"title":"...","body":"3-5 paragraphs","quotes":["...","..."]}`);

  const systemInstr = `You are the chronicler of a small village writing a ${kind}-long reflection in English. You receive a series of daily diary entries from the period. Synthesize them into a single longer reflection that names recurring threads and arcs.

Rules:
- Do not invent events not present in the input.
- Tone: warm, grounded prose. 3-5 paragraphs.
- title is one short phrase summarizing the period.
- quotes are 1-3 short lines that appeared in the daily entries.

Output one JSON object only:
{"title":"...","body":"3-5 paragraph reflection","quotes":["...","..."]}`;

  const raw = await callChatgptResponses(model, systemInstr, lines.join("\n"));
  if (!raw) return null;
  const llm = parseLlmJson(raw);
  if (!llm) return null;

  const page: ChroniclePage = {
    dayId: `${kind}-${index}`,
    dayIndex: index,
    startTick,
    endTick,
    generatedAt: Date.now(),
    generatedAtTick: currentTick,
    model,
    title: llm.title,
    body: llm.body,
    quotes: llm.quotes,
    milestoneCount: dailyInRange.reduce((sum, p) => sum + p.milestoneCount, 0),
    milestones: [],
    kind,
  };

  const filtered = pages.filter((p) => !(p.kind === kind && p.dayIndex === index));
  filtered.push(page);
  await writePages(filtered);
  return page;
}

let lastEnsureAtTick = 0;
const ENSURE_COOLDOWN_TICKS = 60; // 같은 tick 군에서 중복 호출 방지

export async function maybeEnsureOnTick(currentTick: number, model = "gpt-5.4"): Promise<void> {
  if (currentTick - lastEnsureAtTick < ENSURE_COOLDOWN_TICKS) return;
  lastEnsureAtTick = currentTick;
  await ensureChroniclePages(currentTick, model).catch((e) => console.warn("[chronicle] ensure error:", e));
}
