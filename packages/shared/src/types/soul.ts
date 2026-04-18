export interface Soul {
  actorId: string;
  name: string;
  backstory: string;
  persona: string;
  goals: string[];
  tone: string;
  values: string[];
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
}

export type ObservationKind =
  | "perceive"
  | "action"
  | "dialogue"
  | "reflection"
  | "memory";

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
}

export interface Relationship {
  from: string;
  to: string;
  affinity: number;
  lastInteractionTick: number;
  notes: string;
}

export const DEFAULT_SOUL = (actorId: string, name: string): Soul => ({
  actorId,
  name,
  backstory: `${name}은(는) 이 마을에서 조용히 살아가는 사람입니다.`,
  persona: "호기심 많고 느긋함",
  goals: ["하루를 무사히 보낸다", "마을 사람들과 잘 지낸다"],
  tone: "따뜻하고 담백",
  values: ["안전", "호기심"],
  updatedAt: Date.now()
});

export const DEFAULT_THOUGHT = (actorId: string, tick: number): Thought => ({
  actorId,
  updatedAtTick: tick,
  updatedAtMs: Date.now(),
  recentEvents: [],
  beliefs: [],
  priority: "주변을 둘러본다",
  emotion: "평온",
  nextIntent: "WAIT"
});
