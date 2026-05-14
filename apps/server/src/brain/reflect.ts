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
import { callChatgptDirectJson, type ChatgptDirectMessage } from "./chatgptDirect";

interface ReflectionResult {
  summary: string;
  durableLessons?: ActionLesson[];
  relationshipChanges?: RelationshipChange[];
  identityValues?: IdentityValueChange[];
  newGoal?: IdentityGoalChange;
  lifeEventToRemember?: LifeEventChange;
  personaShift?: PersonaShiftChange;
  skillProgress?: SkillProgressChange[];
  /** Optional first-person narrative line — "Lately I find myself..." or similar.
   *  Captures how the actor sees themselves evolving from their own recent decisions.
   *  Codex 4차 권고 (H). Free-form, evidence-gated, rate-limited to ~1/day. */
  selfNarrative?: SelfNarrativeChange;
}

interface SelfNarrativeChange {
  text: string;
  evidence: string[];
  reason?: string;
}

interface ActionLesson {
  text: string;
  evidence: string[];
  importance: number;
}

interface RelationshipChange {
  targetId: string;
  delta: number;
  reason: string;
}

interface IdentityValueChange {
  text: string;
  evidence: string[];
  reason: string;
}

interface IdentityGoalChange {
  text: string;
  evidence: string[];
  reason: string;
}

interface LifeEventChange {
  text: string;
  evidence: string[];
  importance: number;
  reason?: string;
}

interface PersonaShiftChange {
  text: string;
  evidence: string[];
  reason?: string;
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
const sleepReflectionQueue = new Set<string>();

type ReflectionMode = {
  includePersonaShift?: boolean;
  viaAction?: "SLEEP" | "THINK";
};

export async function shouldRequestSleepPersonaReflection(actorId: string, name: string, tick: number): Promise<boolean> {
  const soul = await readSoul(actorId, name);
  if ((soul.personaShifts?.length ?? 0) >= 2) return false;
  return tick - (soul.lastPersonaShiftTick ?? -Infinity) >= 43200;
}

export function enqueueSleepPersonaReflection(actorId: string): void {
  sleepReflectionQueue.add(actorId);
}

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
  if (await runQueuedSleepReflection(cfg, actors)) return;
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
      } else if (cfg.provider === "chatgpt-direct") {
        result = await reflectWithChatgptDirect(cfg, soul, fresh).catch(() => null);
        if (result) providerUsed = "chatgpt-direct";
      }
    }
    if (!result) result = reflectWithMock(soul, fresh);
    if (!result) continue;

    await applyReflection(me, soul, result, providerUsed);
    lastReflectedAt.set(me.id, Date.now());
    reflected += 1;
  }
}

async function runQueuedSleepReflection(cfg: BrainConfig, actors: Actor[]): Promise<boolean> {
  for (const actorId of [...sleepReflectionQueue]) {
    sleepReflectionQueue.delete(actorId);
    const me = actors.find((actor) => actor.id === actorId);
    if (!me || me.kind === "monster") continue;
    const world = getWorld();
    if (!(await shouldRequestSleepPersonaReflection(me.id, me.name, world.tick))) continue;
    const recent = await readObservations(me.id, 30);
    if (recent.length < MIN_NEW_OBS) continue;
    const soul = await readSoul(me.id, me.name);
    const mode: ReflectionMode = { includePersonaShift: true, viaAction: "SLEEP" };
    let result: ReflectionResult | null = null;
    let providerUsed = "mock";
    if (shouldUseLlmReflection(recent)) {
      if (cfg.provider === "openrouter" && cfg.apiKey) {
        result = await reflectWithLLM(cfg, soul, recent, mode).catch(() => null);
        if (result) providerUsed = "openrouter";
      } else if (cfg.provider === "local-proxy") {
        result = await reflectWithLLM({
          ...cfg,
          baseUrl: cfg.baseUrl || LOCAL_PROXY_DEFAULTS.baseUrl,
          apiKey: cfg.apiKey || LOCAL_PROXY_DEFAULTS.apiKey,
          model: cfg.model || LOCAL_PROXY_DEFAULTS.model
        }, soul, recent, mode).catch(() => null);
        if (result) providerUsed = "local-proxy";
      } else if (cfg.provider === "chatgpt-direct") {
        result = await reflectWithChatgptDirect(cfg, soul, recent, mode).catch(() => null);
        if (result) providerUsed = "chatgpt-direct";
      }
    }
    if (!result) result = reflectWithMock(soul, recent);
    await applyReflection(me, soul, result, providerUsed, mode);
    lastReflectedAt.set(me.id, Date.now());
    return true;
  }
  return false;
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

// 2026-05-08: reflect summary 에 노출하면 안 되는 메타 태그 (actorId, provider, system 마커).
//   - npc-/player-/monster-/animal-/traveler- prefix: actor id (sender or target marker)
//   - chatgpt-/gpt-/claude-/openai-/qwen/glm/composer/o3/o4 등: provider/model strings
//   - received: dialogue listener marker
//   - auto_promoted: system flag
//   - attempted:*, fail:*: 내부 분류 태그 (이미 다른 형태로 표현됨)
const REFLECT_TAG_BLOCKLIST = new Set([
  "received", "auto_promoted", "system", "info"
]);
const REFLECT_TAG_PREFIX_BLOCKLIST = ["npc-","player-","monster-","animal-","traveler-","attempted:","fail:","from:"];
function isMeaningfulReflectTag(tag: string): boolean {
  if (!tag) return false;
  if (REFLECT_TAG_BLOCKLIST.has(tag)) return false;
  if (REFLECT_TAG_PREFIX_BLOCKLIST.some((p) => tag.startsWith(p))) return false;
  // provider/model strings: "chatgpt-direct/gpt-5.4" 등 슬래시 포함하면 메타.
  if (tag.includes("/")) return false;
  // 단일 letter 이거나 너무 일반적인 marker
  if (tag.length < 2) return false;
  return true;
}

function reflectWithMock(_soul: Soul, obs: Observation[]): ReflectionResult {
  const counts: Record<string, number> = {};
  for (const o of obs) {
    for (const t of o.tags) {
      if (!isMeaningfulReflectTag(t)) continue;
      counts[t] = (counts[t] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);

  const summary = topTags.length > 0
    ? `Looking back at the last ${obs.length} moments — ${topTags.join(", ")} stand out.`
    : `Looking back at the last ${obs.length} moments — a quiet stretch of small things.`;

  return {
    summary,
    relationshipChanges: mockRelationshipChanges(obs),
    skillProgress: mockSkillPractice(obs)
  };
}

function buildReflectionMessages(soul: Soul, obs: Observation[], mode: ReflectionMode = {}): ChatgptDirectMessage[] {
  const identityCommon = '"identityValues": [{ "text": "0-1 rarely; newly-strengthened value name", "evidence": ["obs_id"], "reason": "one short sentence" }], "newGoal": { "text": "0-1 rare concrete goal", "evidence": ["obs_id"], "reason": "one short sentence" }, "lifeEventToRemember": { "text": "0-1 rare major event", "evidence": ["obs_id"], "importance": 0.9 }';
  const selfNarrativeSchema = ', "selfNarrative": { "text": "0-1 first-person line — VARY the opening across emissions instead of always using \"Lately I find myself...\". Pick whichever feels natural this beat: \"Lately I find myself...\" / \"These days I...\" / \"I\'m starting to notice...\" / \"When this keeps happening...\" / \"I seem to be becoming...\" / \"More and more I...\" / \"It strikes me that...\". Only emit if recent decisions reveal a genuine evolving sense of self, otherwise omit.", "evidence": ["obs_id"], "reason": "one short sentence" }';
  const identitySchema = mode.includePersonaShift
    ? `${identityCommon}, "personaShift": { "text": "0-1 only if sleep reveals a repeated lived pattern", "evidence": ["obs_id"] }${selfNarrativeSchema}`
    : `${identityCommon}${selfNarrativeSchema}`;
  const system = [
    "You are the inner narrator of a single villager pausing to look back on the day.",
    "Read the SOUL and RECENT OBSERVATIONS below and capture what this villager has newly noticed for themselves, as one JSON object.",
    "",
    "JSON schema:",
    `{ "summary": "1-2 sentence first-person, NON-durable", "durableLessons": [{ "text": "concrete pattern in a specific situation, not a generality", "evidence": ["obs_id"], "importance": 0.65 }], "relationshipChanges": [{ "targetId": "npc-X", "delta": -3.0, "reason": "one short sentence" }], ${identitySchema} }`,
    "",
    "Rules:",
    "- Do not add items already present in existing values.",
    "- newGoal 0-1 and rare. Only propose it when at least two observations directly support it.",
    "- lifeEventToRemember 0-1 and rare. Only for major events, danger, fulfilled commands, first meetings, death, or oracle moments.",
    mode.includePersonaShift
      ? "- personaShift 0-1. Include only for SLEEP:start reflections when three or more observations show a durable lived pattern; do not restate persona or values."
      : "- Do not emit personaShift in this reflection.",
    "- Never propose beliefs or skillProgress.",
    "- Do not invent events; ground every line in the actual observations.",
    "- relationshipChanges 0-3. Only when something actually shifted the heart.",
    "- relationshipChanges.delta scale: casual greeting +0.5, deep talk +2, being attacked -3, apology +1.5, large gift +4.",
    "- relationshipChanges.reason: one short English sentence.",
    "- If nothing changed, return [] for relationshipChanges.",
    "- durableLessons 0-1. Only one if a truly new specific pattern was learned.",
    "- durableLessons.text must be concrete, not a generality. Bad: \"SPEAK builds relationships.\" Good: \"When hungry and a familiar neighbor is near, asking with a small offer often works.\"",
    "- durableLessons.evidence must include at least one obs_id from the observation list above. If none fits, omit the lesson.",
    "- durableLessons.importance in 0.55~0.75.",
    "- identityValues 0-1 and rare. Use object form only: short value name, evidence, and reason.",
    "- selfNarrative is OPTIONAL and rare. Only emit when at least two recent observations together suggest a real shift in how you see yourself (e.g., 'I am becoming the person Mira leans on', 'These days I keep choosing the steadier path over the dramatic one'). Never restate seed persona or values verbatim. Vary the opening phrase across emissions; do not start every line with 'Lately I find myself'. Omit if nothing has shifted or if it would simply refine your existing selfNarrative — return that one instead.",
    "- Return one JSON object only, no surrounding text."
  ].join("\n");

  const world = getWorld();
  const candidates = Object.values(world.actors)
    .filter((actor) => actor.id !== soul.actorId)
    .map((actor) => `- ${actor.id}: ${actor.name}`)
    .join("\n") || "- (none)";

  const user = [
    `# SOUL`,
    `name: ${soul.name} · persona: ${soul.persona} · tone: ${soul.tone}`,
    `values: ${soul.values.join(", ") || "-"} · goals: ${soul.goals.join(", ") || "-"}`,
    ``,
    `# RELATIONSHIP CANDIDATES`,
    candidates,
    ``,
    `# RECENT OBSERVATIONS (${obs.length})`,
    ...obs.slice(-12).map((o) => `- [${o.id}] [tick ${o.tick}] (${o.kind}, importance ${o.importance.toFixed(2)}) ${o.text}`),
    ``,
    `Reflect on the above and return one JSON object as specified.`
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

async function reflectWithChatgptDirect(cfg: BrainConfig, soul: Soul, obs: Observation[], mode: ReflectionMode = {}): Promise<ReflectionResult | null> {
  const text = await callChatgptDirectJson(buildReflectionMessages(soul, obs, mode), cfg);
  if (!text) return null;
  return parseReflectionResult(text, obs, false, mode.includePersonaShift === true);
}

async function reflectWithLLM(cfg: BrainConfig, soul: Soul, obs: Observation[], mode: ReflectionMode = {}): Promise<ReflectionResult | null> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const messages = buildReflectionMessages(soul, obs, mode);

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
        messages,
        temperature: 0.7
      })
      }
    });
    if (!res.ok) return null;
    const j = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = j.choices?.[0]?.message?.content ?? "";
    return parseReflectionResult(text, obs, false, mode.includePersonaShift === true);
  } catch {
    return null;
  }
}

function parseReflectionResult(text: string, obs: Observation[], includeSkillProgress: boolean, includePersonaShift = false): ReflectionResult | null {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as Partial<ReflectionResult>;
  const validObsIds = new Set(obs.map((o) => o.id));
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 400) : "",
    durableLessons: normalizeLessons(parsed.durableLessons, validObsIds, obs),
    relationshipChanges: normalizeRelationshipChanges(parsed.relationshipChanges),
    identityValues: normalizeIdentityValueChanges(parsed.identityValues, validObsIds),
    newGoal: normalizeIdentityGoal(parsed.newGoal, validObsIds),
    lifeEventToRemember: normalizeLifeEvent(parsed.lifeEventToRemember, validObsIds),
    personaShift: includePersonaShift ? normalizePersonaShift(parsed.personaShift, validObsIds) : undefined,
    selfNarrative: normalizeSelfNarrative(parsed.selfNarrative, validObsIds),
    skillProgress: includeSkillProgress ? normalizeSkillProgress(parsed.skillProgress) : []
  };
}

async function applyReflection(me: Actor, soul: Soul, r: ReflectionResult, provider: string, mode: ReflectionMode = {}): Promise<void> {
  const world = getWorld();
  const now = Date.now();

  const identityValues = normalizeIdentityValueChanges(r.identityValues, new Set());
  for (const change of identityValues) {
    if (change.evidence.length < 1) continue;
    const fresh = backfillIdentitySeeds(await readSoul(me.id, me.name));
    const beforeValues = fresh.values ?? [];
    const normalized = normalizeIdentityText(change.text, 40);
    if (!normalized) continue;
    const nextValues = dedupCapPinned([...beforeValues, normalized], 6, fresh.seedValues ?? []);
    const newAdd = !containsNormalized(beforeValues, normalized) && containsNormalized(nextValues, normalized);
    const pushedOut = beforeValues.some((value) => !containsNormalized(nextValues, value));
    if (!newAdd && !pushedOut) continue;
    await writeSoul({ ...fresh, values: nextValues, lastValuesDriftTick: world.tick, updatedAt: now });
    await appendIdentityShift(me.id, world.tick, "values", normalized, change.evidence, change.reason);
  }

  const newGoal = normalizeIdentityGoal(r.newGoal, new Set());
  if (newGoal && newGoal.evidence.length >= 2 && distinct(newGoal.evidence).length >= 2) {
    const fresh = backfillIdentitySeeds(await readSoul(me.id, me.name));
    const goalEvidenceInfo = await readEvidenceTagInfo(me.id, newGoal.evidence);
    const failureOnly = evidenceIsFailureOnly(goalEvidenceInfo);
    if (
      world.tick - (fresh.lastGoalsDriftTick ?? -Infinity) >= 2880 &&
      isGoalGrounded(newGoal.text, me, fresh, world) &&
      !failureOnly
    ) {
      const beforeGoals = fresh.goals ?? [];
      const normalized = normalizeIdentityText(newGoal.text, 120);
      const oracleGoals = beforeGoals.filter(isOracleGoal);
      const pinnedGoals = [...(fresh.seedGoals ?? []), ...oracleGoals];
      const nextGoals = dedupCapPinned([...beforeGoals, normalized], 5, pinnedGoals);
      const newAdd = !containsNormalized(beforeGoals, normalized) && containsNormalized(nextGoals, normalized);
      const pushedOut = beforeGoals.some((goal) => !containsNormalized(nextGoals, goal));
      if (normalized && (newAdd || pushedOut)) {
        await writeSoul({ ...fresh, goals: nextGoals, lastGoalsDriftTick: world.tick, updatedAt: now });
        await appendIdentityShift(me.id, world.tick, "goals", normalized, newGoal.evidence, newGoal.reason);
      }
    }
  }

  const lifeEvent = normalizeLifeEvent(r.lifeEventToRemember, new Set());
  if (lifeEvent) {
    const fresh = backfillIdentitySeeds(await readSoul(me.id, me.name));
    const tagInfo = await readEvidenceTagInfo(me.id, lifeEvent.evidence);
    const milestone = hasMilestoneTagFromInfo(tagInfo);
    const deathOracleBypass = anyEvidenceObsTagsInFromInfo(tagInfo, new Set(["death", "oracle", "milestone:death", "milestone:oracle_received", "milestone:oracle_fulfilled"]));
    const majorTagged = milestone && lifeEvent.importance >= 0.7;
    const highRisk = lifeEvent.importance >= 0.9 && anyEvidenceObsTagsInFromInfo(tagInfo, new Set(["death", "oracle", "threat", "threat:auto", "kill", "milestone:first_kill"]));
    const cooldownOk = deathOracleBypass || world.tick - (fresh.lastLifeEventTick ?? -Infinity) >= 1440;
    const text = normalizeIdentityText(lifeEvent.text, 180);
    if (text && cooldownOk && (majorTagged || highRisk)) {
      const nextEvents = pruneLifeEvents([...(fresh.lifeEvents ?? []), {
        tick: world.tick,
        text,
        evidence: lifeEvent.evidence,
        importance: clamp(lifeEvent.importance, 0, 1)
      }]);
      await writeSoul({ ...fresh, lifeEvents: nextEvents, lastLifeEventTick: world.tick, updatedAt: now });
      await appendIdentityShift(me.id, world.tick, "lifeEvent", text, lifeEvent.evidence, lifeEvent.reason);
    }
  }

  // Codex 4차 (H) + 7차 (gate 완화) + 8차 (K modified): selfNarrative — 자기 결정·관찰에서 LLM이 1줄.
  // - evidence ≥ 2, rich tag (milestone/agenda/lesson/relationship_moment/death) 한 줄 이상
  // - 점진 cooldown: 1번째 1440 / 2번째 2160 / 3+번째 2880 tick (같은 actor가 surface 독점하지 못하게)
  // - actor 분산 gate: 같은 4-5 actor 라이브에서 다른 actor 가 selfNarrative 0건이고 ≥3000 tick 지났으면 이 actor는 defer
  // - same-root merge: 직전 selfNarrative와 의미 같으면 update 대신 evidence 누적만
  const selfNarrative = normalizeSelfNarrative(r.selfNarrative, new Set());
  if (selfNarrative && selfNarrative.evidence.length >= 2 && distinct(selfNarrative.evidence).length >= 2) {
    const fresh = backfillIdentitySeeds(await readSoul(me.id, me.name));
    const text = normalizeIdentityText(selfNarrative.text, 180);
    // 점진 cooldown — emit 수에 따라 backs off geometrically.
    // 1st→2nd: 1440 (1 day) / 2nd→3rd: 2160 / 3rd→4th: 4320 / 4th+: 8640.
    const ownEmitCount = recentSelfNarrativeEmits(me.id).length;
    const requiredCooldown = ownEmitCount === 0 ? 1440 : ownEmitCount === 1 ? 2160 : ownEmitCount === 2 ? 4320 : 8640;
    const cooldownOk = world.tick - (fresh.lastSelfNarrativeTick ?? -Infinity) >= requiredCooldown;
    const restatesIdentity = text ? substantivelyRestates(text, [fresh.persona, ...(fresh.values ?? []), ...((fresh.personaShifts ?? []).map((s) => s.text))]) : true;
    const evidenceInfo = await readEvidenceTagInfo(me.id, selfNarrative.evidence);
    const hasRichEvidence = evidenceInfo.some((obs) =>
      obs.tags.some((tag) =>
        tag.startsWith("milestone:") ||
        tag === "agenda" || tag === "completed" || tag === "abandoned" ||
        tag === "relationship_moment" || tag === "lesson" || tag === "death"
      )
    );
    // Actor 분산 gate: 이 actor ≥ 2 emits + 살아있는 다른 villager 중 0건이면 defer.
    const distributionDefer = shouldDeferForDistribution(me.id, ownEmitCount);
    // Same-root merge: 직전 selfNarrative와 의미 같으면 (substantivelyRestates) update X — evidence만 누적.
    const refinesPrior = fresh.selfNarrative?.text && substantivelyRestates(text ?? "", [fresh.selfNarrative.text]);
    if (text && cooldownOk && !restatesIdentity && hasRichEvidence && !distributionDefer) {
      if (refinesPrior) {
        // merge evidence, keep prior text, do not bump lastSelfNarrativeTick (avoid stealing slot)
        const mergedEvidence = Array.from(new Set([...(fresh.selfNarrative?.evidence ?? []), ...selfNarrative.evidence])).slice(0, 8);
        await writeSoul({
          ...fresh,
          selfNarrative: { text: fresh.selfNarrative!.text, updatedAtTick: fresh.selfNarrative!.updatedAtTick, evidence: mergedEvidence },
          updatedAt: now
        });
      } else {
        await writeSoul({
          ...fresh,
          selfNarrative: { text, updatedAtTick: world.tick, evidence: selfNarrative.evidence },
          lastSelfNarrativeTick: world.tick,
          updatedAt: now
        });
        recordSelfNarrativeEmit(me.id, world.tick);
        await appendIdentityShift(me.id, world.tick, "selfNarrative", text, selfNarrative.evidence, selfNarrative.reason);
      }
    }
  }

  const personaShift = normalizePersonaShift(r.personaShift, new Set());
  if (mode.includePersonaShift && mode.viaAction && personaShift) {
    const fresh = backfillIdentitySeeds(await readSoul(me.id, me.name));
    const observations = await evidenceObservations(me.id, personaShift.evidence);
    const ticks = new Set(observations.map((obs) => obs.tick));
    const kinds = new Set(observations.map((obs) => obs.kind));
    const evidenceSpreadOk = personaShift.evidence.length >= 3 && distinct(personaShift.evidence).length >= 3 && (ticks.size >= 2 || kinds.size >= 2);
    const text = normalizeIdentityText(personaShift.text, 180);
    const restatesIdentity = text ? substantivelyRestates(text, [fresh.persona, ...(fresh.values ?? [])]) : true;
    if (
      text &&
      evidenceSpreadOk &&
      world.tick - (fresh.lastPersonaShiftTick ?? -Infinity) >= 43200 &&
      (fresh.personaShifts?.length ?? 0) < 2 &&
      !restatesIdentity
    ) {
      const nextShifts = [...(fresh.personaShifts ?? []), {
        tick: world.tick,
        text,
        evidence: personaShift.evidence,
        viaAction: mode.viaAction
      }].slice(0, 2);
      await writeSoul({ ...fresh, personaShifts: nextShifts, lastPersonaShiftTick: world.tick, updatedAt: now });
      await appendIdentityShift(me.id, world.tick, "persona", text, personaShift.evidence, personaShift.reason, mode.viaAction);
    }
  }

  for (const lesson of (r.durableLessons ?? [])) {
    await appendObservation({
      id: `obs_lesson_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: now + 1,
      kind: "memory",
      text: lesson.text,
      tags: ["lesson", "reflection"],
      importance: lesson.importance
    });
  }

  const relationshipChanges = normalizeRelationshipChanges(r.relationshipChanges)
    .filter((change) => change.targetId !== me.id && Boolean(world.actors[change.targetId]));
    const conversationFactor = 1 + getSkillLevel(me, "conversation") * 0.05 + getSkillLevel(me, "diplomacy") * 0.03;
  for (const change of relationshipChanges) {
    bumpAffinity(me.id, change.targetId, clamp(change.delta * conversationFactor, -10, 10), world.tick, change.reason);
    await appendObservation({
      id: `obs_rel_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: me.id,
      tick: world.tick,
      timestamp: now + 3,
      kind: "memory",
      text: change.reason,
      tags: ["relationship_moment", "social", `with:${change.targetId}`],
      importance: Math.min(0.85, 0.55 + Math.abs(change.delta) * 0.04)
    });
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
    payload: { provider, identityValues, newGoal, lifeEventToRemember: lifeEvent, personaShift, durableLessons: r.durableLessons ?? [], relationshipChanges, skillProgress }
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
    if (tags.has("combat") || tags.has("monster")) return "hunting";
    if (tags.has("trade")) return "trading";
    if (tags.has("diplomacy") || tags.has("heard_claim")) return "diplomacy";
    if (tags.has("mining")) return "mining";
    if (tags.has("woodcutting")) return "woodcutting";
    if (tags.has("tailoring")) return "tailoring";
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
    if (/나를 공격했다|attacked me/i.test(o.text)) {
      changes.push({ targetId: actorId, delta: -2, reason: "공격을 받아 경계심이 커졌다." });
    } else if (/나에게 '.+'라고 말했다|said to me:/i.test(o.text)) {
      changes.push({ targetId: actorId, delta: 1, reason: "말을 걸어 준 일이 기억에 남았다." });
    } else if (/gave me (?:itemId=|[\d]+ gold)/i.test(o.text)) {
      changes.push({ targetId: actorId, delta: 2, reason: "They shared something useful with me." });
    }
    if (changes.length >= 3) break;
  }
  return dedupRelationshipChanges(changes);
}

function inferSourceActorId(text: string, world: ReturnType<typeof getWorld>): string | null {
  const inbound = text.match(/^actorId=([^\s(]+)\s+\([^)]+\)\s+(?:said to me|attacked me|gave me)/i);
  if (inbound?.[1] && world.actors[inbound[1]]) return inbound[1];
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

function normalizeLessons(input: unknown, validObsIds: Set<string>, sourceObs: Observation[]): ActionLesson[] {
  if (!Array.isArray(input)) return [];
  const byId = new Map(sourceObs.map((obs) => [obs.id, obs]));
  const out: ActionLesson[] = [];
  let socialTaken = false;
  let mechanicalTaken = false;
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
    const isSocial = isRelationalLesson(text, evidence.map((id) => byId.get(id)).filter((obs): obs is Observation => Boolean(obs)));
    if (isSocial && socialTaken) continue;
    if (!isSocial && mechanicalTaken) continue;
    out.push({
      text,
      evidence,
      importance: clamp(importance, 0.55, 0.75)
    });
    if (isSocial) socialTaken = true;
    else mechanicalTaken = true;
    if (socialTaken && mechanicalTaken) break;
  }
  return out;
}

function normalizeIdentityValueChanges(input: unknown, validObsIds: Set<string>): IdentityValueChange[] {
  if (!Array.isArray(input)) return [];
  const out: IdentityValueChange[] = [];
  const seen = new Set<string>();
  for (const x of input) {
    const record = typeof x === "string"
      ? { text: x, evidence: [], reason: "Experience made this value more salient." }
      : x && typeof x === "object" ? x as Partial<IdentityValueChange> : null;
    if (!record) continue;
    const text = normalizeIdentityText(record.text, 40);
    const key = normalizeKey(text);
    if (!text || seen.has(key)) continue;
    const evidence = normalizeEvidence(record.evidence, validObsIds, 3);
    seen.add(key);
    out.push({
      text,
      evidence,
      reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 160) : "Experience made this value more salient."
    });
    if (out.length >= 1) break;
  }
  return out;
}

function normalizeIdentityGoal(input: unknown, validObsIds: Set<string>): IdentityGoalChange | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<IdentityGoalChange>;
  const text = normalizeIdentityText(record.text, 120);
  if (!text) return undefined;
  return {
    text,
    evidence: normalizeEvidence(record.evidence, validObsIds, 4),
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 160) : "Recent experience made this goal concrete."
  };
}

function normalizeLifeEvent(input: unknown, validObsIds: Set<string>): LifeEventChange | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<LifeEventChange>;
  const text = normalizeIdentityText(record.text, 180);
  const importance = typeof record.importance === "number" ? record.importance : Number(record.importance ?? 0);
  if (!text || !Number.isFinite(importance)) return undefined;
  return {
    text,
    evidence: normalizeEvidence(record.evidence, validObsIds, 5),
    importance: clamp(importance, 0, 1),
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 160) : undefined
  };
}

function normalizePersonaShift(input: unknown, validObsIds: Set<string>): PersonaShiftChange | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<PersonaShiftChange>;
  const text = normalizeIdentityText(record.text, 180);
  if (!text) return undefined;
  return {
    text,
    evidence: normalizeEvidence(record.evidence, validObsIds, 5),
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 160) : undefined
  };
}

function normalizeSelfNarrative(input: unknown, validObsIds: Set<string>): SelfNarrativeChange | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<SelfNarrativeChange>;
  const text = normalizeIdentityText(record.text, 180);
  if (!text) return undefined;
  return {
    text,
    evidence: normalizeEvidence(record.evidence, validObsIds, 5),
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 160) : undefined
  };
}

function normalizeEvidence(input: unknown, validObsIds: Set<string>, cap: number): string[] {
  if (!Array.isArray(input)) return [];
  const requireValid = validObsIds.size > 0;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    if (requireValid && !validObsIds.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

function normalizeIdentityText(input: unknown, cap: number): string {
  if (typeof input !== "string") return "";
  return input.trim().replace(/\s+/g, " ").slice(0, cap);
}

function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function containsNormalized(items: string[], text: string): boolean {
  const key = normalizeKey(text);
  return Boolean(key) && items.some((item) => normalizeKey(item) === key);
}

function distinct<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isOracleGoal(goal: string): boolean {
  return goal.startsWith("[oracle]") || goal.startsWith("[신탁]");
}

function backfillIdentitySeeds(soul: Soul): Soul {
  return {
    ...soul,
    seedValues: Array.isArray(soul.seedValues) ? soul.seedValues : [...(soul.values ?? [])],
    seedGoals: Array.isArray(soul.seedGoals) ? soul.seedGoals : (soul.goals ?? []).filter((goal) => !isOracleGoal(goal))
  };
}

function dedupCapPinned(items: string[], cap: number, pinned: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const item of items) {
    const text = normalizeIdentityText(item, 180);
    const key = normalizeKey(text);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, text);
  }
  for (const item of pinned) {
    const text = normalizeIdentityText(item, 180);
    const key = normalizeKey(text);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, text);
  }

  const pinnedKeys = new Set(pinned.map(normalizeKey).filter(Boolean));
  const out = [...byKey.entries()];
  while (out.length > cap) {
    const dropIndex = out.findIndex(([key]) => !pinnedKeys.has(key));
    if (dropIndex < 0) break;
    out.splice(dropIndex, 1);
  }
  return out.map(([, value]) => value);
}

type EvidenceTagInfo = {
  id: string;
  tick: number;
  kind: Observation["kind"];
  tags: string[];
};

async function evidenceObservations(actorId: string, evidence: string[]): Promise<Observation[]> {
  const ids = distinct(evidence);
  if (ids.length === 0) return [];
  const byId = new Map((await readObservations(actorId, 200)).map((obs) => [obs.id, obs]));
  return ids.map((id) => byId.get(id)).filter((obs): obs is Observation => Boolean(obs));
}

async function readEvidenceTagInfo(actorId: string, evidence: string[]): Promise<EvidenceTagInfo[]> {
  return (await evidenceObservations(actorId, evidence)).map((obs) => ({
    id: obs.id,
    tick: obs.tick,
    kind: obs.kind,
    tags: obs.tags
  }));
}

function hasMilestoneTagFromInfo(info: EvidenceTagInfo[]): boolean {
  return info.some((obs) => obs.tags.some((tag) => tag.startsWith("milestone:")));
}

/**
 * Codex 2차/3차 권고: identity_shift goal 승격이 "실패-only evidence" 위에서 일어나면 위험.
 * 예) alchemy_table 실패만 6번 → newGoal "Use alchemy table to make herb" 승격.
 * 한 evidence라도 success/positive 행동/관찰을 갖고 있어야 newGoal 승격 허용.
 */
const FAILURE_ONLY_TAGS = new Set([
  "failure_fact", "confirmed_invalid", "use:aborted", "use:timeout",
  "trade:expired", "trade:rejected", "path_unreachable", "blocked_tile", "blocked_actor"
]);
function evidenceIsFailureOnly(info: EvidenceTagInfo[]): boolean {
  if (info.length === 0) return true;
  return info.every((obs) =>
    obs.tags.some((tag) => FAILURE_ONLY_TAGS.has(tag) || tag.startsWith("fail:"))
  );
}

function anyEvidenceObsTagsInFromInfo(info: EvidenceTagInfo[], tags: Set<string>): boolean {
  return info.some((obs) => tags.has(obs.kind) || obs.tags.some((tag) => tags.has(tag)));
}

function pruneLifeEvents(events: NonNullable<Soul["lifeEvents"]>): NonNullable<Soul["lifeEvents"]> {
  const byKey = new Map<string, NonNullable<Soul["lifeEvents"]>[number]>();
  for (const event of events) {
    const text = normalizeIdentityText(event.text, 180);
    const key = normalizeKey(text);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || event.importance > existing.importance || (event.importance === existing.importance && event.tick > existing.tick)) {
      byKey.set(key, { ...event, text, importance: clamp(event.importance, 0, 1) });
    }
  }
  const kept = [...byKey.values()];
  if (kept.length <= 10) return kept.sort((a, b) => a.tick - b.tick);

  const remove = new Set(
    kept
      .slice()
      .sort((a, b) => (a.importance - b.importance) || (a.tick - b.tick))
      .slice(0, kept.length - 10)
      .map((event) => `${event.tick}:${normalizeKey(event.text)}`)
  );
  return kept
    .filter((event) => !remove.has(`${event.tick}:${normalizeKey(event.text)}`))
    .sort((a, b) => a.tick - b.tick);
}

function identityTokens(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(Boolean);
}

function substantivelyRestates(text: string, against: string[]): boolean {
  const tokens = new Set(identityTokens(text));
  if (tokens.size === 0) return false;
  return against.some((item) => {
    const other = new Set(identityTokens(item));
    if (other.size === 0) return false;
    let overlap = 0;
    for (const token of tokens) {
      if (other.has(token)) overlap += 1;
    }
    return overlap / tokens.size > 0.5;
  });
}

function isGoalGrounded(text: string, actor: Actor, soul: Soul, world: ReturnType<typeof getWorld>): boolean {
  const tokens = new Set(identityTokens(text));
  if (tokens.size < 2) return false;

  const localTerms = [
    actor.name,
    soul.persona,
    ...soul.values,
    ...actor.inventory.map((item) => itemKeyOfInventoryItem(item)),
    ...Object.values(world.actors).map((other) => other.name),
    ...Object.values(world.places ?? {}).flatMap((place) => [place.id, place.name, place.kind])
  ];
  const localTokens = new Set(localTerms.flatMap(identityTokens).filter((token) => token.length >= 3));
  for (const token of tokens) {
    if (localTokens.has(token)) return true;
  }
  return /\b(build|craft|gather|collect|find|learn|help|protect|trade|talk|speak|farm|mine|bake|cook|explore|reach|visit|pray|rest|share|tend)\b/i.test(text);
}

function itemKeyOfInventoryItem(item: Actor["inventory"][number]): string {
  return item.item;
}

// Codex 8차 K modified: selfNarrative actor 분산 트래커.
// 같은 actor 가 surface 독점하지 않도록 emit 시각을 actor 별로 기록.
const selfNarrativeEmits = new Map<string, number[]>();
function recentSelfNarrativeEmits(actorId: string): number[] {
  return selfNarrativeEmits.get(actorId) ?? [];
}
function recordSelfNarrativeEmit(actorId: string, tick: number): void {
  const arr = selfNarrativeEmits.get(actorId) ?? [];
  arr.push(tick);
  while (arr.length > 8) arr.shift();
  selfNarrativeEmits.set(actorId, arr);
}
/**
 * Defer 조건: 이 actor 가 emit 2+ 이고, 다른 살아있는 villager (npc-*, player-1) 중 한 명도 emit 안 했으면 defer.
 * → 조용한 actor 에게 surface slot 양보. world.actors 직접 조회.
 */
function shouldDeferForDistribution(actorId: string, ownEmitCount: number): boolean {
  if (ownEmitCount < 2) return false;
  const world = getWorld();
  const otherSilent = Object.values(world.actors).filter((a) =>
    a.id !== actorId &&
    a.alive &&
    (a.id.startsWith("npc-") || a.id === "player-1") &&
    (selfNarrativeEmits.get(a.id) ?? []).length === 0
  );
  return otherSilent.length > 0;
}

async function appendIdentityShift(
  actorId: string,
  tick: number,
  kind: "values" | "goals" | "lifeEvent" | "persona" | "selfNarrative",
  text: string,
  evidence: string[],
  reason?: string,
  viaAction?: "SLEEP" | "THINK"
): Promise<void> {
  await appendRawEvent({
    tick,
    timestamp: Date.now(),
    actorId,
    category: "identity_shift",
    type: kind,
    result: "info",
    payload: { text, evidence, reason, viaAction }
  });
}

function isRelationalLesson(text: string, evidence: Observation[]): boolean {
  if (/(speak|talk|neighbor|relationship|friend|trust|give|trade|ask|apology|social)/i.test(text)) return true;
  return evidence.some((obs) =>
    obs.kind === "dialogue"
    || obs.tags.some((tag) => ["speak", "give", "trade", "received", "social", "relationship_moment"].includes(tag))
  );
}

function normalizeSkillProgress(input: unknown): SkillProgressChange[] {
  const allowed = new Set(["running", "swordsmanship", "archery", "hunting", "gathering", "mining", "woodcutting", "cooking", "conversation", "diplomacy", "trading", "tailoring", "farming", "meditation", "fishing", "foraging"]);
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
