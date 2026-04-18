import type { Actor, Observation, Soul } from "@wiw/shared";
import { getBrainConfig, onBrainConfigChange, type BrainConfig } from "../config/brainConfig";
import { getWorld } from "../state/worldStore";
import {
  readSoul, writeSoul,
  readObservations, appendObservation
} from "../persistence/soulStore";
import { appendRawEvent } from "../logging/eventLogStore";

interface ReflectionResult {
  summary: string;
  beliefs: string[];
  values: string[];
  goals: string[];
}

const lastReflectedAt: Map<string, number> = new Map(); // actorId -> Date.now()
const MIN_NEW_OBS = 3;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startReflectionLoop(): void {
  const schedule = () => {
    const cfg = getBrainConfig();
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, Math.max(15000, cfg.reflectIntervalMs));
  };

  onBrainConfigChange(() => schedule());

  const tick = async () => {
    if (running) { schedule(); return; }
    const cfg = getBrainConfig();
    if (!cfg.enabled) { schedule(); return; }
    running = true;
    try {
      await runOne(cfg);
    } catch (e) {
      console.warn("[reflect] tick error", e);
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();
}

async function runOne(cfg: BrainConfig): Promise<void> {
  const world = getWorld();
  const actors: Actor[] = Object.values(world.actors).filter((a) => a.alive);
  for (const me of actors) {
    const recent = await readObservations(me.id, 30);
    if (recent.length < MIN_NEW_OBS) continue;
    const lastTs = lastReflectedAt.get(me.id) ?? 0;
    const fresh = recent.filter((o) => o.timestamp > lastTs);
    if (fresh.length < MIN_NEW_OBS) continue;

    const soul = await readSoul(me.id, me.name);
    let result: ReflectionResult | null = null;
    if (cfg.provider === "openrouter" && cfg.apiKey) {
      result = await reflectWithLLM(cfg, soul, fresh).catch(() => null);
    }
    if (!result) result = reflectWithMock(soul, fresh);
    if (!result) continue;

    await applyReflection(me, soul, result);
    lastReflectedAt.set(me.id, Date.now());
  }
}

function reflectWithMock(soul: Soul, obs: Observation[]): ReflectionResult {
  const counts: Record<string, number> = {};
  for (const o of obs) {
    for (const t of o.tags) counts[t] = (counts[t] ?? 0) + 1;
  }
  const topTags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);

  const highImportance = [...obs].sort((a, b) => b.importance - a.importance).slice(0, 2);
  const beliefs = highImportance.map((o) => o.text).slice(0, 2);

  const values: string[] = [];
  if (topTags.includes("attack") || topTags.includes("monster")) values.push("경계");
  if (topTags.includes("speak")) values.push("친교");
  if (topTags.includes("move")) values.push("탐험");
  if (values.length === 0 && !soul.values.includes("호기심")) values.push("호기심");

  const summary = `최근 ${obs.length}개의 일 중 ${topTags.join("·") || "이런저런"} 경험이 두드러졌다.`;

  return {
    summary,
    beliefs,
    values,
    goals: []
  };
}

async function reflectWithLLM(cfg: BrainConfig, soul: Soul, obs: Observation[]): Promise<ReflectionResult | null> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const system = [
    "너는 작은 마을의 한 주민이 자신의 하루를 잠깐 되돌아보는 내면의 서술자야.",
    "아래의 '영혼'과 '최근 관찰'을 보고, 이 주민이 스스로 새롭게 깨달은 것을 JSON 하나로 정리해.",
    "",
    "JSON 스키마:",
    '{ "summary": "2~3문장 한국어 요약", "beliefs": ["0~3개 믿음"], "values": ["0~2개 새로 강화된 가치"], "goals": ["0~2개 조정된 목표"] }',
    "",
    "규칙:",
    "- 기존 가치/목표와 중복되는 항목은 넣지 마.",
    "- 허구 사건을 만들지 말고 실제 관찰에 기반해.",
    "- 바깥 설명 없이 JSON 하나만 반환."
  ].join("\n");

  const user = [
    `# 영혼`,
    `이름: ${soul.name} · 성격: ${soul.persona} · 어조: ${soul.tone}`,
    `가치: ${soul.values.join(", ") || "-"} · 목표: ${soul.goals.join(", ") || "-"}`,
    ``,
    `# 최근 관찰 (${obs.length}개)`,
    ...obs.slice(-12).map((o) => `- [tick ${o.tick}] (${o.kind}, 중요도 ${o.importance.toFixed(2)}) ${o.text}`),
    ``,
    `위 관찰을 기반으로 스스로 되돌아본 결과를 JSON으로.`
  ].join("\n");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
        "HTTP-Referer": "https://github.com/szara7678/what_is_world",
        "X-Title": "what is world"
      },
      body: JSON.stringify({
        model: cfg.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.7
      }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content ?? "";
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<ReflectionResult>;
    return {
      summary: (parsed.summary ?? "").slice(0, 400),
      beliefs: (parsed.beliefs ?? []).filter((x) => typeof x === "string").slice(0, 3),
      values:  (parsed.values  ?? []).filter((x) => typeof x === "string").slice(0, 2),
      goals:   (parsed.goals   ?? []).filter((x) => typeof x === "string").slice(0, 2)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function applyReflection(me: Actor, soul: Soul, r: ReflectionResult): Promise<void> {
  const world = getWorld();
  const now = Date.now();

  const mergedValues = dedupCap([...soul.values, ...r.values], 6);
  const mergedGoals  = dedupCap([...soul.goals,  ...r.goals ], 4);
  const nextSoul: Soul = { ...soul, values: mergedValues, goals: mergedGoals, updatedAt: now };
  await writeSoul(nextSoul);

  await appendObservation({
    id: `obs_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick: world.tick,
    timestamp: now,
    kind: "reflection",
    text: r.summary || "스스로를 돌아봤다.",
    tags: ["reflection"],
    importance: 0.7
  });

  for (const b of r.beliefs) {
    await appendObservation({
      id: `obs_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: now + 1,
      kind: "memory",
      text: b,
      tags: ["belief", "reflection"],
      importance: 0.6
    });
  }

  await appendRawEvent({
    tick: world.tick,
    timestamp: now,
    actorId: me.id,
    category: "reflection",
    type: r.summary || "되돌아봄",
    result: "info",
    payload: { values: r.values, goals: r.goals, beliefs: r.beliefs }
  });
}

function dedupCap(arr: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.slice(-cap);
}
