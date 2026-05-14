// ── PR1: plan-driven hierarchical sub-intent ────────────────────────────
/**
 * WAIT_UNTIL condition — structured object only. DSL 금지 (파싱 안전).
 * 모든 WAIT 에 maxTicks 강제.
 */
export type WaitCondition =
  | { kind: "tick_at"; tick: number }
  | { kind: "tick_after"; ticks: number }
  | { kind: "time_of_day"; hour: number }
  | { kind: "actor_within"; actorId: string; distance: number }
  | { kind: "crop_mature"; cropId?: string }   // cropId 미지정 시 last_planted (executor가 step context에서 해석)
  | { kind: "weather"; weather: string }
  | { kind: "inventory_has"; item: string; count: number }
  | { kind: "idle"; ticks: number };

export type GatherLocation = { placeId?: string; xy?: { x: number; y: number }; radius?: number };
export type CraftStation = { objectId?: string; stationType?: string; placeId?: string };
export type TalkIntent = "request" | "inform" | "greet" | "trade" | "apologize";

export type PlanStep =
  | { kind: "GO_TO"; placeId?: string; xy?: { x: number; y: number }; nearItem?: string; nearActor?: string }
  | { kind: "GATHER"; item: string; count: number; location?: GatherLocation; allowWaitSpawn?: boolean; maxTicks?: number }
  | { kind: "CRAFT"; output: string; count?: number; station?: CraftStation }
  | { kind: "TALK_TO"; actorId?: string; topic?: string; intent?: TalkIntent; message?: string }
  | { kind: "USE"; item?: string; objectId?: string; targetItemId?: string }
  | { kind: "WAIT_UNTIL"; condition: WaitCondition; maxTicks: number };

export type PlanStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface PlanStepRuntime {
  status: PlanStepStatus;
  /** step 시작 tick. plan progress 계측용. */
  startedAtTick?: number;
  /** step 종료 tick (done/failed). */
  endedAtTick?: number;
  /** retry 카운트 */
  retryCount?: number;
  /** 마지막 실패 사유 */
  lastFailReason?: string;
  /** executor 가 step 진행 중 보존하는 보조 상태 (예: USE seed 후 cropId, 이동 중 좌표) */
  context?: Record<string, unknown>;
}

/**
 * Plan — LLM 이 만드는 멀티스텝 의도. 시스템(executor)이 한 step 씩 자동 실행.
 * planMode: "off" | "shadow" | "assist" | "full" 로 점진 활성화.
 */
export interface Plan {
  id: string;
  goal: string;
  reason?: string;
  /** plan 자체 만료. clamp(estimatedCost*3, 100, 1200) 권장. */
  ttlTicks: number;
  startedAtTick: number;
  steps: PlanStep[];
  /** 각 step 의 runtime status. 길이 = steps.length */
  stepRuntimes: PlanStepRuntime[];
  currentStep: number;
  status: "active" | "paused" | "done" | "failed" | "abandoned";
  pauseReason?: string;
  /** plan 전체 실패 카운트. failureBudget 초과 시 abandon. */
  failureCount: number;
  failureBudget: number;
  /** 누가 만든 plan (model id) */
  createdBy?: string;
  /** plan 수정 횟수 (revise) */
  reviseCount?: number;
}

export interface Soul {
  actorId: string;
  name: string;
  backstory: string;
  persona: string;
  goals: string[];
  tone: string;
  values: string[];
  seedValues?: string[];
  seedGoals?: string[];
  lifeEvents?: Array<{ tick: number; text: string; evidence: string[]; importance: number }>;
  personaShifts?: Array<{ tick: number; text: string; evidence: string[]; viaAction: "SLEEP" | "THINK" }>;
  lastValuesDriftTick?: number;
  lastGoalsDriftTick?: number;
  lastLifeEventTick?: number;
  lastPersonaShiftTick?: number;
  /** Canonical milestone keys this actor has already achieved (first_kill, first_meeting:<id>, etc.). Prevents re-emit. */
  milestonesAchieved?: string[];
  /** Tick of most recent death event. Lets prompt surface a "recovery" bridge while still recent so
   *  the next agenda decision starts from "I just fell" instead of stale pre-death plans. */
  lastDeathTick?: number;
  /** 신의 사도(follower) 여부 — true 이면 사용자(신)의 신탁을 절대 우선으로 따른다. */
  isFollower?: boolean;
  /** 신탁 누적 강도(0~1). 신탁을 받을 때마다 살짝 올라가고, 영혼 결에 영향을 준다. */
  faith?: number;
  /** 부트스트랩 시드 메모리가 적재된 tick. undefined 면 아직 시드 안 된 영혼. */
  seededAt?: number;
  activeQuest?: {
    text: string;
    receivedAtTick: number;
    status: "active" | "fulfilled" | "abandoned";
    expiresAtTick: number;
    progress?: {
      kind: "count" | "place" | "action";
      current: number;
      target: number;
      itemType?: string;
      placeId?: string;
    };
  };
  /**
   * 시스템이 소유하는 지속 목표.
   * LLM은 매 결정에 새 priority를 쓰지 않고 KEEP/COMPLETE/CHANGE만 선택한다.
   * 시스템이 ttl·progress·실패 추적을 담당.
   */
  agenda?: {
    intent: string;
    targetPlaceId?: string;
    targetActorId?: string;
    targetItemPrefix?: string;
    targetXY?: { x: number; y: number };
    reason: string;
    startedAtTick: number;
    ttlTicks: number;
    progress: number;
    status: "active" | "blocked" | "completed" | "abandoned" | "settling" | "path_unreachable";
    lastFailureSig?: string;
    failureCount: number;
    nextActions?: string[];
    path?: Array<{ dx: number; dy: number }>;
    lastReplanTick?: number;
    lastReconsiderTick?: number;
    /** PR1: plan-driven 확장. 있으면 executor 가 우선. 없으면 legacy atomic 경로. */
    plan?: Plan;
  };
  updatedAt: number;
}

export interface Thought {
  actorId: string;
  updatedAtTick: number;
  updatedAtMs: number;
  recentEvents: string[];
  beliefs: string[];
  priority: string;
  emotion: string;
  nextIntent: string;
  /** Rolling per-beat history (last ~6). Combines what I was thinking AND what I did/why on the same beat
   *  so the inner-state-to-action through-line is visible in one timeline instead of two redundant blocks. */
  beatHistory?: Array<{
    tick: number;
    priority: string;
    emotion: string;
    nextIntent: string;
    action?: { type: string; reason?: string; result: string };
  }>;
  /** Rolling agenda lifecycle (CHANGE/COMPLETE/ABANDON) recap, last ~3.
   *  Kept separate from beatHistory because pivots are coarser-grained semantic events. */
  agendaHistory?: Array<{ tick: number; kind: "CHANGE" | "COMPLETE" | "ABANDON"; intent: string; reason?: string }>;
  activePath?: {
    targetXY: { x: number; y: number };
    targetPlaceId?: string;
    remaining: Array<{ dx: number; dy: number }>;
  };
}

export type ObservationKind =
  | "perceive"
  | "action"
  | "dialogue"
  | "reflection"
  | "memory"
  | "oracle";

export interface Observation {
  id: string;
  actorId: string;
  tick: number;
  timestamp: number;
  kind: ObservationKind;
  text: string;
  tags: string[];
  importance: number;
  embedding?: number[];
  /** 2026-05-09 PR-1: heard_claim 메타. tags에 "heard_claim" 포함 시 활용. */
  claimKey?: string;        // "craft:iron_sword|forge", "place:forest-east", "resource:wood@forest-east"
  claimType?: "recipe_hint" | "place_hint" | "resource_location" | "danger_warning";
  speaker?: string;         // 발언한 actor id
  factPayload?: Record<string, unknown>;
}

export interface Relationship {
  from: string;
  to: string;
  affinity: number;
  /** 2026-05-09: information trust (0..1). affinity 와 직교 — "싫어하지만 정확한 정보를 주는 NPC" 표현 가능. mentor seed 시 1.0. */
  trust?: number;
  /** trust 검증 이벤트 누적 (claim → 실제 결과 비교). 0 일 때 "근거 없음 중립". */
  trustEvidenceCount?: number;
  lastInteractionTick: number;
  notes: string;
}

/**
 * actor 별 풍부한 페르소나 시드. master-plan v3.1 정수 유지: 직업·스킬 강제 X,
 * 환경 단서와 생활감만 살림. NPC 가 그 결을 따라 자연스럽게 행동하되 다른 길도 열려 있도록.
 */
const PERSONA_SEEDS: Record<string, Partial<Soul>> = {
  "player-1": {
    backstory: "A new visitor who wandered into the village from an unfamiliar road. Few possessions; finds his place slowly by watching people and landscapes.",
    persona: "Cautious and kind; touches every new object once before trusting it.",
    tone: "Polite and plain.",
    values: ["learning", "trust", "survival", "choice"],
    goals: ["become familiar with the village", "build trustworthy relationships", "find his own path"]
  },
  "npc-1": {
    backstory: "Lives by a field of wheat and carrots. First to notice each turn of the season. Hands earth-stained, yet always offers a guest a cup of tea.",
    persona: "Easygoing and observant; loves to talk about the weather.",
    tone: "Warm and gentle.",
    values: ["stability", "sharing", "patience", "nature"],
    goals: ["tend the field well", "keep up with village news", "pick up a new hobby"]
  },
  "npc-2": {
    backstory: "Owner of the Sunny Bakery; hears the village wake each morning by the oven. Skilled at baking, but easily drawn to a guest's story or an unfamiliar ingredient.",
    persona: "Warm and playful; fidgets with the apron when thinking.",
    tone: "Cozy with a touch of humor.",
    values: ["hospitality", "care", "experiment", "memory"],
    goals: ["make a place where people can rest", "try new combinations", "engage in matters beyond the bakery"]
  },
  "npc-3": {
    backstory: "Finds purpose for small things between the corner shop and the alchemy table. Sharp at numbers on the surface, but names old vials and odd seeds with affection.",
    persona: "Clever and curious; arranges items in neat rows.",
    tone: "Crisp and bright.",
    values: ["discovery", "fairness", "independence", "possibility"],
    goals: ["collect useful objects", "notice what people need", "explore new recipes"]
  },
  "npc-4": {
    backstory: "Lives in a small cabin near the mine and the forge; ears tuned to the village's night sounds. Looks tough, but mends old tools with great care.",
    persona: "Calm and responsible; nods before speaking.",
    tone: "Short and dependable.",
    values: ["protection", "restraint", "responsibility", "craft"],
    goals: ["watch over dangerous places", "master needed tools", "close the distance with the villagers"]
  },
  "traveler-1": {
    backstory: "A wanderer at the village edge; rarely promises to stay long. Instead, holds the scents and songs of past roads and lets them out by the campfire.",
    persona: "Free and capricious; sometimes reads maps upside-down.",
    tone: "Light and quietly poetic.",
    values: ["freedom", "story", "chance", "survival"],
    goals: ["pick the next road", "hear the village's secrets", "find a reason to linger a while"]
  }
};

export const DEFAULT_SOUL = (actorId: string, name: string): Soul => {
  const seed = PERSONA_SEEDS[actorId];
  return {
    actorId,
    name,
    backstory: seed?.backstory ?? `${name} lives quietly in this village.`,
    persona: seed?.persona ?? "Curious and easygoing",
    goals: seed?.goals ?? ["get through the day safely", "stay on good terms with the villagers"],
    tone: seed?.tone ?? "Warm and plain",
    values: seed?.values ?? ["safety", "curiosity"],
    updatedAt: Date.now()
  };
};

/** Helper to detect default-text souls and refresh them with rich seeds. */
export const isDefaultSoulText = (s: Soul): boolean => {
  return (s.persona === "호기심 많고 느긋함" || s.persona === "Curious and easygoing")
    && ((s.backstory ?? "").includes("조용히 살아가는 사람") || (s.backstory ?? "").includes("lives quietly in this village"));
};
export const enrichSoulFromSeed = (s: Soul): Soul => {
  const seed = PERSONA_SEEDS[s.actorId];
  if (!seed) return s;
  return { ...s, ...seed, actorId: s.actorId, name: s.name, updatedAt: Date.now() };
};

export const DEFAULT_THOUGHT = (actorId: string, tick: number): Thought => ({
  actorId,
  updatedAtTick: tick,
  updatedAtMs: Date.now(),
  recentEvents: [],
  beliefs: [],
  priority: "pause briefly and decide what to do next",
  emotion: "calm",
  nextIntent: "WAIT"
});
