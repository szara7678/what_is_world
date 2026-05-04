import type { Actor, Observation, Soul } from "@wiw/shared";
import { levelForXp } from "@wiw/shared";
import { getBrainConfig, onBrainConfigChange, LOCAL_PROXY_DEFAULTS, type BrainConfig } from "../config/brainConfig";
import { getWorld, setWorld } from "../state/worldStore";
import {
  readSoul, writeSoul,
  readObservations, appendObservation
} from "../persistence/soulStore";
import { appendRawEvent } from "../logging/eventLogStore";
import { bumpAffinity } from "./relationships";
import { enqueueLlmRequest } from "./llmQueue";

interface ReflectionResult {
  summary: string;
  beliefs: string[];
  values: string[];
  goals: string[];
  relationshipChanges?: RelationshipChange[];
  skillProgress?: SkillProgressChange[];
  lessons?: ActionLesson[];
}

interface ActionLesson {
  text: string;
  evidence: string[];
  importance: number;
  tags?: string[];
}

interface RelationshipChange {
  targetId: string;
  delta: number;
  reason: string;
}

interface SkillProgressChange {
  skillId: string;
  delta: number;
  reason: string;
}

const lastReflectedAt: Map<string, number> = new Map(); // actorId -> Date.now()
const MIN_NEW_OBS = 3;
const MAX_REFLECTIONS_PER_CYCLE = 2;
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
  let reflected = 0;
  for (const me of actors) {
    if (me.kind === "monster") continue;
    if (reflected >= MAX_REFLECTIONS_PER_CYCLE) break;
    const recent = await readObservations(me.id, 30);
    if (recent.length < MIN_NEW_OBS) continue;
    const lastTs = lastReflectedAt.get(me.id) ?? 0;
    const fresh = recent.filter((o) => o.timestamp > lastTs);
    if (fresh.length < MIN_NEW_OBS) continue;

    const soul = await readSoul(me.id, me.name);
    let result: ReflectionResult | null = null;
    let providerUsed = "mock";
    if (shouldUseLlmReflection(fresh)) {
      if (cfg.provider === "openrouter" && cfg.apiKey) {
        result = await reflectWithLLM(cfg, soul, fresh).catch(() => null);
        if (result) providerUsed = "openrouter";
      } else if (cfg.provider === "local-proxy") {
        result = await reflectWithLLM({
          ...cfg,
          baseUrl: cfg.baseUrl || LOCAL_PROXY_DEFAULTS.baseUrl,
          apiKey: cfg.apiKey || LOCAL_PROXY_DEFAULTS.apiKey,
          model: cfg.model || LOCAL_PROXY_DEFAULTS.model
        }, soul, fresh).catch(() => null);
        if (result) providerUsed = "local-proxy";
      }
    }
    if (!result) result = reflectWithMock(soul, fresh);
    if (!result) continue;

    await applyReflection(me, soul, result, providerUsed);
    lastReflectedAt.set(me.id, Date.now());
    reflected += 1;
  }
}

function shouldUseLlmReflection(obs: Observation[]): boolean {
  return obs.some((o) =>
    o.importance >= 0.55 ||
    o.kind === "dialogue" ||
    o.tags.includes("oracle") ||
    o.tags.includes("give") ||
    o.tags.includes("attack")
  );
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
    goals: [],
    relationshipChanges: mockRelationshipChanges(obs),
    skillProgress: mockSkillPractice(obs)
  };
}

async function reflectWithLLM(cfg: BrainConfig, soul: Soul, obs: Observation[]): Promise<ReflectionResult | null> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const system = [
    "너는 작은 마을의 한 주민이 자신의 하루를 잠깐 되돌아보는 내면의 서술자야.",
    "아래의 '영혼'과 '최근 관찰'을 보고, 이 주민이 스스로 새롭게 깨달은 것을 JSON 하나로 정리해.",
    "",
    "JSON 스키마:",
    '{ "summary": "2~3문장 한국어 요약", "beliefs": ["0~3개 믿음"], "values": ["0~2개 새로 강화된 가치"], "goals": ["0~2개 조정된 목표"], "relationshipChanges": [{ "targetId": "npc-X", "delta": -3.0, "reason": "한국어 한 문장" }], "skillProgress": [{ "skillId": "running", "delta": 0.08, "reason": "한국어 한 문장" }], "lessons": [{ "text": "구체 상황에서 통한 행동 한 줄", "evidence": ["obs_id1"], "importance": 0.65 }] }',
    "",
    "규칙:",
    "- 기존 가치/목표와 중복되는 항목은 넣지 마.",
    "- 허구 사건을 만들지 말고 실제 관찰에 기반해.",
    "- relationshipChanges는 0~3개. 정말 마음에 변화가 있을 때만.",
    "- relationshipChanges.delta는 작게: 일반 인사 +0.5, 깊은 대화 +2, 공격 받음 -3, 사과 +1.5, 큰 선물 +4.",
    "- relationshipChanges.reason은 한국어 한 문장.",
    "- 변화 없으면 relationshipChanges는 빈 배열.",
    "- skillProgress는 행동 성공의 보너스다. 의미 있는 경험일 때만 0~2개.",
    "- skillProgress.delta는 0.03~0.08 사이. 가능한 skillId: running, swordsmanship, gathering, cooking, conversation, farming, meditation, fishing, foraging.",
    "- 단순 반복, 실패만 있는 행동, OPTIONS/INVENTORY/THINK만으로는 skillProgress를 주지 마.",
    "- lessons는 0~1개. 정말 새로 배운 구체 패턴이 있을 때만 1개.",
    "- lesson.text 는 일반론 금지. 나쁜 예: \"SPEAK는 관계에 효과적이다.\" 좋은 예: \"배고플 때 가까운 이웃이 있고 이전 호의가 있으면 부탁이 받아들여질 수 있다.\"",
    "- lesson.evidence 는 위 관찰 목록의 obs_id 1개 이상 필수. 없으면 lesson 자체를 만들지 마.",
    "- lesson.importance 는 0.55~0.75.",
    "- 바깥 설명 없이 JSON 하나만 반환."
  ].join("\n");

  const world = getWorld();
  const candidates = Object.values(world.actors)
    .filter((actor) => actor.id !== soul.actorId)
    .map((actor) => `- ${actor.id}: ${actor.name}`)
    .join("\n") || "- 없음";

  const user = [
    `# 영혼`,
    `이름: ${soul.name} · 성격: ${soul.persona} · 어조: ${soul.tone}`,
    `가치: ${soul.values.join(", ") || "-"} · 목표: ${soul.goals.join(", ") || "-"}`,
    ``,
    `# 관계 후보`,
    candidates,
    ``,
    `# 최근 관찰 (${obs.length}개)`,
    ...obs.slice(-12).map((o) => `- [${o.id}] [tick ${o.tick}] (${o.kind}, 중요도 ${o.importance.toFixed(2)}) ${o.text}`),
    ``,
    `위 관찰을 기반으로 스스로 되돌아본 결과를 JSON으로.`
  ].join("\n");

  try {
    const res = await enqueueLlmRequest({
      priority: "reflection",
      url,
      timeoutMs: 25000,
      init: {
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
      })
      }
    });
    if (!res.ok) return null;
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content ?? "";
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<ReflectionResult>;
    const validObsIds = new Set(obs.map((o) => o.id));
    return {
      summary: (parsed.summary ?? "").slice(0, 400),
      beliefs: (parsed.beliefs ?? []).filter((x) => typeof x === "string").slice(0, 3),
      values:  (parsed.values  ?? []).filter((x) => typeof x === "string").slice(0, 2),
      goals:   (parsed.goals   ?? []).filter((x) => typeof x === "string").slice(0, 2),
      relationshipChanges: normalizeRelationshipChanges(parsed.relationshipChanges),
      skillProgress: normalizeSkillProgress(parsed.skillProgress),
      lessons: normalizeLessons(parsed.lessons, validObsIds)
    };
  } catch {
    return null;
  }
}

async function applyReflection(me: Actor, soul: Soul, r: ReflectionResult, provider: string): Promise<void> {
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

  for (const lesson of (r.lessons ?? [])) {
    await appendObservation({
      id: `obs_lesson_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: now + 2,
      kind: "memory",
      text: lesson.text,
      tags: lesson.tags ?? ["lesson", "belief"],
      importance: lesson.importance
    });
  }

  const relationshipChanges = normalizeRelationshipChanges(r.relationshipChanges)
    .filter((change) => change.targetId !== me.id && Boolean(world.actors[change.targetId]));
  const conversationFactor = 1 + getSkillLevel(me, "conversation") * 0.05;
  for (const change of relationshipChanges) {
    bumpAffinity(me.id, change.targetId, clamp(change.delta * conversationFactor, -10, 10), world.tick, change.reason);
  }
  const skillProgress = applySkillProgress(me, normalizeSkillProgress(r.skillProgress));
  if (skillProgress.length) setWorld(world);

  await appendRawEvent({
    tick: world.tick,
    timestamp: now,
    actorId: me.id,
    category: "reflection",
    type: r.summary || "되돌아봄",
    result: "info",
    payload: { provider, values: r.values, goals: r.goals, beliefs: r.beliefs, relationshipChanges, skillProgress }
  });
}

function getSkillLevel(actor: Actor, skillId: string): number {
  return actor.skills?.find((skill) => skill.id === skillId)?.level ?? 0;
}

function applySkillProgress(actor: Actor, changes: SkillProgressChange[]): SkillProgressChange[] {
  const applied: SkillProgressChange[] = [];
  for (const change of changes) {
    const skill = actor.skills?.find((s) => s.id === change.skillId);
    if (!skill) continue;
    if (change.delta > 0 && skill.level < 10) {
      const xpGain = Math.max(1, Math.round(change.delta * 5));
      skill.xp = (skill.xp ?? 0) + xpGain;
      const newLevel = levelForXp(skill.xp);
      if (newLevel > skill.level) skill.level = Math.min(10, newLevel);
    }
    applied.push({ ...change, delta: change.delta > 0 ? change.delta : 0 });
  }
  return applied;
}

function mockSkillPractice(obs: Observation[]): SkillProgressChange[] {
  const skillId = inferSkillId(obs);
  return skillId ? [{ skillId, delta: 0, reason: "mock fallback은 연습 시각만 갱신한다." }] : [];
}

function inferSkillId(obs: Observation[]): string | null {
  for (const o of obs.slice().reverse()) {
    const tags = new Set(o.tags);
    const text = o.text;
    if (tags.has("move")) return "running";
    if (tags.has("attack")) return "swordsmanship";
    if (tags.has("use") && /field|yielded|carrot|wheat|wood|ore|채집|텃밭/.test(text)) return "gathering";
    if (tags.has("use") && /carrot|wheat|음식|빵/.test(text)) return "cooking";
    if (tags.has("speak") || o.kind === "dialogue") return "conversation";
    if (tags.has("use") && /field|yielded|텃밭|농/.test(text)) return "farming";
    if (tags.has("pray") || tags.has("wait")) return "meditation";
  }
  return null;
}

function mockRelationshipChanges(obs: Observation[]): RelationshipChange[] {
  const world = getWorld();
  const changes: RelationshipChange[] = [];
  for (const o of obs.slice().reverse()) {
    const actorId = inferSourceActorId(o.text, world);
    if (!actorId) continue;
    if (/나를 공격했다/.test(o.text)) {
      changes.push({ targetId: actorId, delta: -2, reason: "공격을 받아 경계심이 커졌다." });
    } else if (/나에게 '.+'라고 말했다/.test(o.text)) {
      changes.push({ targetId: actorId, delta: 1, reason: "말을 걸어 준 일이 기억에 남았다." });
    }
    if (changes.length >= 3) break;
  }
  return dedupRelationshipChanges(changes);
}

function inferSourceActorId(text: string, world: ReturnType<typeof getWorld>): string | null {
  for (const actor of Object.values(world.actors)) {
    if (text.startsWith(`${actor.name}이(가) 나`)) return actor.id;
  }
  return null;
}

function normalizeRelationshipChanges(input: unknown): RelationshipChange[] {
  if (!Array.isArray(input)) return [];
  return dedupRelationshipChanges(input
    .filter((x): x is Partial<RelationshipChange> => typeof x === "object" && x !== null)
    .map((x) => ({
      targetId: typeof x.targetId === "string" ? x.targetId : "",
      delta: typeof x.delta === "number" ? x.delta : Number(x.delta ?? 0),
      reason: typeof x.reason === "string" ? x.reason.slice(0, 120) : "관찰을 되돌아본 결과 관계 감정이 달라졌다."
    }))
    .filter((x) => x.targetId && Number.isFinite(x.delta) && x.delta !== 0)
    .slice(0, 3));
}

function normalizeLessons(input: unknown, validObsIds: Set<string>): ActionLesson[] {
  if (!Array.isArray(input)) return [];
  const out: ActionLesson[] = [];
  for (const x of input) {
    if (!x || typeof x !== "object") continue;
    const r = x as Partial<ActionLesson>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (text.length < 12 || text.length > 240) continue;
    const generic = /(SPEAK는|GIVE는|친교는|행동이 효과적|관계가 좋아진다|중요하다)$/.test(text);
    if (generic) continue;
    const evidence = Array.isArray(r.evidence)
      ? r.evidence.filter((e): e is string => typeof e === "string" && validObsIds.has(e)).slice(0, 3)
      : [];
    if (evidence.length === 0) continue;
    const importance = typeof r.importance === "number" ? r.importance : 0.6;
    out.push({
      text,
      evidence,
      importance: clamp(importance, 0.55, 0.75),
      tags: ["lesson", "belief"]
    });
    if (out.length >= 1) break;
  }
  return out;
}

function normalizeSkillProgress(input: unknown): SkillProgressChange[] {
  const allowed = new Set(["running", "swordsmanship", "gathering", "cooking", "conversation", "farming", "meditation", "fishing", "foraging"]);
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: SkillProgressChange[] = [];
  for (const x of input) {
    if (!x || typeof x !== "object") continue;
    const record = x as Partial<SkillProgressChange>;
    const skillId = typeof record.skillId === "string" ? record.skillId : "";
    if (!allowed.has(skillId) || seen.has(skillId)) continue;
    const rawDelta = typeof record.delta === "number" ? record.delta : Number(record.delta ?? 0);
    if (!Number.isFinite(rawDelta)) continue;
    seen.add(skillId);
    out.push({
      skillId,
      delta: rawDelta <= 0 ? 0 : clamp(rawDelta, 0.03, 0.08),
      reason: typeof record.reason === "string" ? record.reason.slice(0, 120) : "경험을 통해 숙련이 조금 쌓였다."
    });
    if (out.length >= 2) break;
  }
  return out;
}

function dedupRelationshipChanges(changes: RelationshipChange[]): RelationshipChange[] {
  const seen = new Set<string>();
  const out: RelationshipChange[] = [];
  for (const change of changes) {
    if (seen.has(change.targetId)) continue;
    seen.add(change.targetId);
    out.push(change);
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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
