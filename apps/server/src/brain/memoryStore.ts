import type { Actor, Observation } from "@wiw/shared";
import { readAllRelationships, readObservations } from "../persistence/soulStore";

export type MemoryQuery = {
  text: string;
  actorId: string;
  placeId?: string;
  targetActorId?: string;
  actionType?: string;
  needs?: ("hunger" | "fatigue" | "danger" | "social" | "food" | "work" | "oracle" | "isolation")[];
  tags?: string[];
  limit?: number;
  seedCap?: number;
  lessonCap?: number;
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

const tokenize = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2));

const overlapRatio = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  const hits = a.filter((x) => bSet.has(x)).length;
  return hits / Math.max(a.length, b.length);
};

const hasAny = (obs: Observation, values: string[]): boolean =>
  values.some((value) => obs.tags.includes(value) || obs.text.toLowerCase().includes(value));

export const MemoryStore = {
  async retrieve(q: MemoryQuery, _actor: Actor, now: { tick: number; ts: number }): Promise<Observation[]> {
    const limit = q.limit ?? 5;
    const observations = await readObservations(q.actorId, 200);
    const queryTokens = [...tokenize(q.text)];
    const queryTags = q.tags ?? [];
    const needs = q.needs ?? [];
    const relationships = q.targetActorId ? await readAllRelationships() : [];
    const relationship = relationships.find((rel) => rel.from === q.actorId && rel.to === q.targetActorId);
    const relationshipBoost =
      (relationship && Math.abs(relationship.affinity) >= 30 ? 0.15 : 0) +
      (relationship?.notes.includes("이웃") ? 0.1 : 0);

    const scored = observations.map((obs) => {
      const recency = Math.max(0, Math.min(1, 1 - (now.tick - obs.tick) / 86400));
      const importance = Math.max(0, Math.min(1, obs.importance));
      const obsTokens = [...tokenize(obs.text)];
      const tagRatio = overlapRatio(queryTags, obs.tags);
      const tokenHit = overlapRatio(queryTokens, obsTokens) > 0 ? 1 : 0;
      const relevance =
        (q.placeId && hasAny(obs, [q.placeId]) ? 0.4 : 0) +
        (q.targetActorId && hasAny(obs, [q.targetActorId]) ? 0.3 : 0) +
        (q.targetActorId && hasAny(obs, [q.targetActorId]) ? relationshipBoost : 0) +
        (tagRatio > 0 ? 0.2 * tagRatio : 0) +
        (tokenHit ? 0.1 : 0);
      let needBoost = 0;
      for (const need of needs) {
        const keywords = NEED_KEYWORDS[need] ?? [];
        if (keywords.length && hasAny(obs, keywords)) needBoost += 0.25;
      }
      const beliefBoost = obs.kind === "reflection" || obs.tags.includes("belief") ? 0.1 : 0;
      const lessonBoost = obs.tags.includes("lesson") ? 0.15 : 0;
      return {
        obs,
        isSeed: obs.tags.includes("seed"),
        isLesson: obs.tags.includes("lesson"),
        score: 0.3 * recency + 0.45 * importance + 0.25 * Math.min(1, relevance) + needBoost + beliefBoost + lessonBoost
      };
    });

    const seedCap = q.seedCap ?? 2;
    const lessonCap = q.lessonCap ?? Math.max(1, Math.floor(limit * 0.3));
    const deduped: Observation[] = [];
    const prefixes = new Set<string>();
    let seedTaken = 0;
    let lessonTaken = 0;
    for (const { obs, isSeed, isLesson } of scored.sort((a, b) => b.score - a.score)) {
      const prefix = obs.text.trim().slice(0, 5);
      if (prefixes.has(prefix)) continue;
      if (isSeed && seedTaken >= seedCap) continue;
      if (isLesson && lessonTaken >= lessonCap) continue;
      prefixes.add(prefix);
      deduped.push(obs);
      if (isSeed) seedTaken += 1;
      if (isLesson) lessonTaken += 1;
      if (deduped.length >= limit) break;
    }
    return deduped;
  }
};
