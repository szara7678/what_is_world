import type { Actor, Observation } from "@wiw/shared";
import { readAllRelationships, readObservations } from "../persistence/soulStore";
import { cosineSimilarity, embedText, getCachedObsEmbedding, setCachedObsEmbedding } from "./embeddings";

/**
 * MemoryQuery — 2026-05-06 상황 결합 retrieve 확장.
 * 기존 추상 needs (hunger/food/...) + 구체 신호 (인벤·인접 station·시야 식량·hp 등) 동반.
 * 직업 라벨(role) 안 받음 — 차별화는 시작 위치·인벤·페르소나·이후 episodic 으로 emergent.
 */
export type MemoryQuery = {
  text: string;
  actorId: string;
  placeId?: string;
  targetActorId?: string;
  actionType?: string;
  needs?: ("hunger" | "fatigue" | "danger" | "social" | "food" | "work" | "oracle" | "isolation")[];
  tags?: string[];
  limit?: number;
  lessonCap?: number;
  // 상황 결합 신호 (NEW)
  inventoryPrefixes?: string[];
  nearbyStationTypes?: string[];
  visibleFoodPrefixes?: string[];
  nearbyFieldDist?: number;
  hunger?: number;
  hp?: number;
  maxHp?: number;
  // agenda 결합 신호 (NEW 2026-05-06)
  agenda?: {
    intent?: string;
    targetItemPrefix?: string;
    targetActorId?: string;
    failureSig?: string;
    failureCount?: number;
  };
  goalTokens?: string[];
};

const NEED_KEYWORDS: Record<string, string[]> = {
  hunger: ["허기", "굶주", "배고", "음식", "food", "hunger", "먹"],
  food: ["음식", "food", "wheat", "carrot", "berry", "mushroom", "fish", "bread", "herb", "corpse"],
  fatigue: ["피로", "stamina", "탈진", "지친"],
  danger: ["danger", "attack", "monster", "보어", "boar", "공격", "위협"],
  social: ["대화", "speak", "친구", "이웃", "관계", "도움", "부탁"],
  work: ["work", "field", "텃밭", "수확", "광산", "노동"],
  oracle: ["oracle", "divine", "신탁"],
  isolation: ["혼자", "고립", "외로"]
};

// 상황 결합 매칭용 키워드 — memory.text 안에 들어있을 수 있는 표현.
const STATION_KEYWORDS: Record<string, string[]> = {
  oven: ["오븐", "빵집", "structure-oven"],
  alchemy_table: ["연금대", "잡화점", "structure-alchemy"],
  forge: ["화덕", "대장간", "모루", "structure-forge"],
  workbench: ["작업대", "structure-workbench"]
};
// station 별 입력 재료 매칭 — 인벤이 메모리 hint 와 맞물릴 때 큰 boost
const STATION_INPUT_PREFIXES: Record<string, string[]> = {
  oven: ["wheat", "fish", "herb", "eggs", "meat"],
  alchemy_table: ["herb", "berry", "mushroom", "essence"],
  forge: ["ore", "wood", "coal", "sword", "axe", "pickaxe", "iron_sword", "hide"],
  workbench: ["wood", "clay", "ore", "hide", "fang", "coal", "iron_axe", "essence"]
};
const SEED_PREFIXES = ["wheat_seed", "carrot_seed", "berry_seed"];
const FOOD_PREFIXES = ["herb","berry","mushroom","apple","pineapple","wheat","carrot","bread","fish","meat","cooked_fish","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"];
const SURVIVAL_RULE_TAG = "survival_rule";

const overlapRatio = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  const hits = a.filter((x) => bSet.has(x)).length;
  return hits / Math.max(a.length, b.length);
};

const hasAny = (obs: Observation, values: string[]): boolean =>
  values.some((value) => obs.tags.includes(value) || obs.text.toLowerCase().includes(value));

const textIncludesAny = (text: string, needles: string[]): boolean => {
  const lower = text.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
};

const isNoopObservation = (obs: Observation): boolean =>
  obs.text.trim().startsWith("Waited") || obs.tags.some((tag) => tag === "noop" || tag === "wait_noop");

const speechTagBoost = (obs: Observation, queryTags: string[]): number => {
  let boost = 0;
  if (queryTags.includes("speech.to_me") && obs.tags.includes("speech.to_me")) boost += 0.35;
  if (queryTags.includes("speech.self") && obs.tags.includes("speech.self")) boost += 0.25;
  if (queryTags.includes("speech.ambient") && obs.tags.includes("speech.ambient")) boost += 0.10;
  return boost;
};

const tagValue = (tags: string[], prefix: string): string | undefined => {
  const tag = tags.find((entry) => entry.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : undefined;
};

const actorMatchIds = (q: MemoryQuery, queryTags: string[]): string[] => {
  const ids = new Set<string>();
  if (q.targetActorId) ids.add(q.targetActorId);
  for (const tag of queryTags) {
    if (tag.startsWith("from:")) ids.add(tag.slice("from:".length));
    if (tag.startsWith("to:")) ids.add(tag.slice("to:".length));
  }
  return [...ids].filter(Boolean);
};

const speechActorMatchBoost = (obs: Observation, ids: string[]): number => {
  if (!ids.length) return 0;
  return ids.some((id) => obs.tags.includes(`from:${id}`) || obs.tags.includes(`to:${id}`)) ? 0.25 : 0;
};

const normalizedMessagePrefix = (text: string): string =>
  text
    .replace(/^.*?"([\s\S]*)"\s*$/, "$1")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);

const dialogueDedupeKey = (obs: Observation): string => {
  const fromId = tagValue(obs.tags, "from:");
  const toId = tagValue(obs.tags, "to:");
  const textActorId = obs.text.match(/actorId=([A-Za-z0-9_-]+)/)?.[1];
  const speakerId = fromId ?? (obs.tags.includes("speech.self") ? obs.actorId : textActorId ?? obs.actorId);
  const recipientId = toId ?? (obs.tags.includes("speech.to_me") ? obs.actorId : "unknown");
  return `dialogue:${speakerId}|${recipientId}:${normalizedMessagePrefix(obs.text)}`;
};

const observationDedupeKey = (obs: Observation): string =>
  obs.kind === "dialogue" ? dialogueDedupeKey(obs) : obs.text.trim().slice(0, 5);

export const MemoryStore = {
  async retrieve(q: MemoryQuery, _actor: Actor, now: { tick: number; ts: number }): Promise<Observation[]> {
    const limit = q.limit ?? 24;
    const observations = await readObservations(q.actorId, 300);
    const queryEmbedding = await embedText(q.text);
    const queryTags = q.tags ?? [];
    const needs = q.needs ?? [];
    const relationships = q.targetActorId ? await readAllRelationships() : [];
    const relationship = relationships.find((rel) => rel.from === q.actorId && rel.to === q.targetActorId);
    const relationshipBoost =
      (relationship && Math.abs(relationship.affinity) >= 30 ? 0.15 : 0) +
      (relationship?.notes.includes("이웃") ? 0.1 : 0);

    const inv = q.inventoryPrefixes ?? [];
    const stations = q.nearbyStationTypes ?? [];
    const visibleFood = q.visibleFoodPrefixes ?? [];
    const fieldDist = q.nearbyFieldDist ?? Infinity;
    const hunger = q.hunger ?? 0;
    const hp = q.hp ?? 100;
    const maxHp = q.maxHp ?? 100;
    const lowHp = hp < maxHp * 0.5;
    const speechPartnerIds = actorMatchIds(q, queryTags);
    let lazyEmbeddingMiss: Observation | undefined;

    const scored = observations.map((obs) => {
      const recency = Math.max(0, Math.min(1, 1 - (now.tick - obs.tick) / 86400));
      const importance = Math.max(0, Math.min(1, obs.importance));
      const tagRatio = overlapRatio(queryTags, obs.tags);
      const obsEmbedding = getCachedObsEmbedding(obs.id);
      if (!obsEmbedding && !lazyEmbeddingMiss && obs.text.trim().length >= 10) lazyEmbeddingMiss = obs;
      const semanticSimilarity = queryEmbedding && obsEmbedding ? Math.max(0, cosineSimilarity(queryEmbedding, obsEmbedding)) : 0;
      const relevance =
        (q.placeId && hasAny(obs, [q.placeId]) ? 0.4 : 0) +
        (q.targetActorId && hasAny(obs, [q.targetActorId]) ? 0.3 : 0) +
        (q.targetActorId && hasAny(obs, [q.targetActorId]) ? relationshipBoost : 0) +
        (tagRatio > 0 ? 0.2 * tagRatio : 0);
      let needBoost = 0;
      for (const need of needs) {
        const keywords = NEED_KEYWORDS[need] ?? [];
        if (keywords.length && hasAny(obs, keywords)) needBoost += 0.20;
      }
      // ── 상황 결합 boost (NEW, 2026-05-06) ─────────────────────────
      let situationalBoost = 0;
      // station 매칭: memory text 가 인접 station 을 언급
      for (const stType of stations) {
        const stKeys = STATION_KEYWORDS[stType] ?? [];
        if (stKeys.length && textIncludesAny(obs.text, stKeys)) {
          situationalBoost += 0.20;
          // station 입력 재료 동시 보유 — 강력 boost
          const requiredInputs = STATION_INPUT_PREFIXES[stType] ?? [];
          const hasInput = requiredInputs.some((p) => inv.includes(p));
          if (hasInput) situationalBoost += 0.30;
        }
      }
      // 인벤 prefix 가 memory text 에 직접 등장 — "USE itemId=wheat_seed" 류
      for (const p of inv) {
        if (p && obs.text.toLowerCase().includes(p.toLowerCase())) {
          situationalBoost += 0.12;
          break; // 한 번만
        }
      }
      // field 인접 + seed 보유 — 농사 cmd_hint surface
      const hasSeed = inv.some((p) => SEED_PREFIXES.includes(p) || p.endsWith("_seed"));
      if (fieldDist <= 8 && hasSeed && (obs.text.includes("씨앗") || obs.text.includes("심") || obs.text.includes("seed") || obs.text.includes("farmland"))) {
        situationalBoost += 0.40;
      }
      // 시야 식량 + hunger ≥ 60 — 채집 cmd_hint surface
      if (hunger >= 60 && visibleFood.length > 0) {
        for (const fp of visibleFood) {
          if (obs.text.toLowerCase().includes(fp)) {
            situationalBoost += 0.25;
            break;
          }
        }
      }
      // 인벤 edible + hunger ≥ 60 — USE 회상 surface
      if (hunger >= 60) {
        const hasEdibleInInv = inv.some((p) => FOOD_PREFIXES.includes(p));
        if (hasEdibleInInv && (obs.text.includes("입에") || obs.text.includes("먹") || obs.text.includes("USE itemId"))) {
          situationalBoost += 0.20;
        }
      }
      // 사망 규칙 + 위기 (hunger>=80 or low hp)
      if (obs.tags.includes(SURVIVAL_RULE_TAG) && (hunger >= 80 || lowHp)) {
        situationalBoost += 0.30;
      }
      // ──────────────────────────────────────────────────────────────
      // agenda 결합 boost (NEW 2026-05-06)
      let agendaBoost = 0;
      if (q.agenda) {
        const ag = q.agenda;
        if (ag.intent && obs.text.includes(ag.intent.split(/\s+/)[0] ?? "")) agendaBoost += 0.30;
        if (ag.targetItemPrefix && obs.text.toLowerCase().includes(ag.targetItemPrefix.toLowerCase())) agendaBoost += 0.25;
        if (ag.targetActorId && hasAny(obs, [ag.targetActorId])) agendaBoost += 0.20;
        // failureSig boost — 같은 실패 sig 가 메모리에 기록된 경우 1순위로 떠오름 (회피 학습)
        if (ag.failureSig && obs.text.includes(ag.failureSig.split(":")[0] ?? "")) {
          agendaBoost += 0.50;
        }
        // 같은 sig 4회 이상 실패 — 동일 메모리만 끌려오는 루프 방지
        if (ag.failureCount && ag.failureCount >= 4 && ag.failureSig && obs.text.includes(ag.failureSig.split(":")[0] ?? "")) {
          agendaBoost -= 0.20;
        }
      }
      situationalBoost += agendaBoost;
      const goalTokens = q.goalTokens ?? [];
      const goalBoost = goalTokens.length && textIncludesAny(obs.text, goalTokens)
        ? Math.min(0.12, 0.04 * goalTokens.filter((token) => obs.text.toLowerCase().includes(token)).length)
        : 0;
      const beliefBoost = obs.tags.includes("belief") || obs.tags.includes("lesson") ? 0.1 : 0;
      const lessonBoost = obs.tags.includes("lesson") ? 0.15 : 0;
      const speechBoost = speechTagBoost(obs, queryTags) + speechActorMatchBoost(obs, speechPartnerIds);
      // 2026-05-06: 출처 신뢰도 — 직접 경험 > 들은 이야기 > 세대 상속.
      // heard_memory / oral_history 는 약간 감점 (확신도 낮음).
      let sourceConfidence = 0;
      if (obs.tags.includes("heard_memory") || obs.tags.includes("heard_from_neighbor")) sourceConfidence -= 0.05;
      if (obs.tags.includes("oral_history") || obs.tags.includes("legacy")) sourceConfidence -= 0.10;
      return {
        obs,
        isLesson: obs.tags.includes("lesson"),
        recency,
        importance,
        score: 0.20 * recency + 0.28 * importance + 0.18 * Math.min(1, relevance) + 0.18 * semanticSimilarity + needBoost + situationalBoost + goalBoost + beliefBoost + lessonBoost + speechBoost + sourceConfidence
      };
    });
    if (lazyEmbeddingMiss) {
      const miss = lazyEmbeddingMiss;
      void embedText(miss.text).then((vec) => {
        if (vec) setCachedObsEmbedding(miss.id, vec);
      }).catch(() => {});
    }

    const lessonCap = q.lessonCap ?? Math.max(6, Math.floor(limit * 0.5));
    const deduped: Observation[] = [];
    const taken = new Set<string>();
    const dedupeKeys = new Set<string>();
    let lessonTaken = 0;
    for (const { obs, isLesson } of scored.sort((a, b) => b.score - a.score)) {
      const dedupeKey = observationDedupeKey(obs);
      if (dedupeKeys.has(dedupeKey)) continue;
      if (isLesson && lessonTaken >= lessonCap) continue;
      dedupeKeys.add(dedupeKey);
      deduped.push(obs);
      taken.add(obs.id);
      if (isLesson) lessonTaken += 1;
      if (deduped.length >= limit) break;
    }
    if (deduped.length < limit) {
      const backfill = scored
        .filter(({ obs }) => !taken.has(obs.id) && !isNoopObservation(obs))
        .sort((a, b) => ((0.20 * b.recency + 0.28 * b.importance) - (0.20 * a.recency + 0.28 * a.importance)));
      for (const { obs } of backfill) {
        const dedupeKey = observationDedupeKey(obs);
        if (dedupeKeys.has(dedupeKey)) continue;
        dedupeKeys.add(dedupeKey);
        deduped.push(obs);
        taken.add(obs.id);
        if (deduped.length >= limit) break;
      }
    }
    return deduped;
  }
};
