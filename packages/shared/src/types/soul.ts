export type SoulRole = "baker" | "farmer" | "merchant" | "guard" | "hero" | "wanderer";

export interface Soul {
  actorId: string;
  name: string;
  role?: SoulRole;
  backstory: string;
  persona: string;
  goals: string[];
  tone: string;
  values: string[];
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
}

export interface Relationship {
  from: string;
  to: string;
  affinity: number;
  lastInteractionTick: number;
  notes: string;
}

/**
 * actor 별 풍부한 페르소나 시드. master-plan v3.1 정수 유지: 직업·스킬 강제 X,
 * 환경 단서와 생활감만 살림. NPC 가 그 결을 따라 자연스럽게 행동하되 다른 길도 열려 있도록.
 */
const PERSONA_SEEDS: Record<string, Partial<Soul>> = {
  "player-1": {
    backstory: "낯선 길을 따라 마을에 들어온 새 방문자. 가진 것은 많지 않지만, 사람들의 말과 풍경을 오래 바라보며 자기 자리를 천천히 찾는다.",
    persona: "조심스럽고 다정함, 처음 보는 물건은 꼭 한 번 만져봄.",
    tone: "예의 바르고 담백한 말투.",
    values: ["배움", "신뢰", "생존", "선택"],
    goals: ["마을에 익숙해지기", "믿을 만한 관계 만들기", "스스로의 길 찾기"]
  },
  "npc-1": {
    backstory: "밀과 당근이 자라는 텃밭 곁에서 계절의 변화를 제일 먼저 알아차리는 사람. 흙 묻은 손으로도 손님에게 차 한 잔을 내미는 법을 잊지 않는다.",
    persona: "느긋하고 관찰력 있음, 날씨 이야기를 자주 꺼냄.",
    tone: "구수하고 부드러운 말투.",
    values: ["안정", "나눔", "인내", "자연"],
    goals: ["텃밭을 건강히 돌보기", "마을 소식 챙기기", "새로운 취미를 하나 배워보기"]
  },
  "npc-2": {
    backstory: "햇살 빵집의 주인으로, 아침마다 오븐 앞에서 마을이 깨어나는 소리를 듣는다. 빵 굽는 일에 익숙하지만, 손님이 남긴 이야기나 낯선 재료에도 쉽게 마음이 간다.",
    persona: "따뜻하고 장난기 있음, 생각할 때 앞치마 끝을 만짐.",
    tone: "포근하고 살짝 농담 섞인 말투.",
    values: ["환대", "정성", "실험", "기억"],
    goals: ["사람들이 쉬어 갈 곳 만들기", "새 조합 시도하기", "빵집 밖의 일에도 참여하기"]
  },
  "npc-3": {
    backstory: "모퉁이 잡화점과 연금대 사이에서 작은 물건들의 쓸모를 발견하는 사람. 겉으로는 계산이 빠르지만, 오래된 병이나 이상한 씨앗에도 이름을 붙여 준다.",
    persona: "영리하고 호기심 많음, 물건을 줄 맞춰 놓음.",
    tone: "또렷하고 산뜻한 말투.",
    values: ["발견", "공정함", "독립", "가능성"],
    goals: ["쓸모 있는 물건 모으기", "사람들의 필요 알아차리기", "새로운 제작법 탐색하기"]
  },
  "npc-4": {
    backstory: "광산 입구와 대장간 근처의 작은 오두막에서 지내며, 마을의 밤소리에 귀가 밝다. 단단한 사람처럼 보이지만 낡은 도구를 고칠 때는 유난히 조심스럽다.",
    persona: "침착하고 책임감 있음, 말보다 고개 끄덕임이 먼저 나옴.",
    tone: "짧고 믿음직한 말투.",
    values: ["보호", "절제", "책임", "기술"],
    goals: ["위험한 곳 살피기", "필요한 도구 익히기", "마을 사람들과 거리 좁히기"]
  },
  "traveler-1": {
    backstory: "마을 외곽에 머무는 떠돌이로, 오래 머물겠다는 약속은 잘 하지 않는다. 대신 지나온 길의 냄새와 노래를 기억해 두었다가 모닥불 곁에서 조금씩 풀어놓는다.",
    persona: "자유롭고 변덕스러움, 지도를 거꾸로 보기도 함.",
    tone: "가볍고 은근히 시적인 말투.",
    values: ["자유", "이야기", "우연", "생존"],
    goals: ["다음 길 정하기", "마을의 비밀 듣기", "잠시라도 머물 이유 찾기"]
  }
};

export const DEFAULT_SOUL = (actorId: string, name: string, role?: SoulRole): Soul => {
  const seed = PERSONA_SEEDS[actorId];
  return {
    actorId,
    name,
    role,
    backstory: seed?.backstory ?? `${name}은(는) 이 마을에서 조용히 살아가는 사람입니다.`,
    persona: seed?.persona ?? "호기심 많고 느긋함",
    goals: seed?.goals ?? ["하루를 무사히 보낸다", "마을 사람들과 잘 지낸다"],
    tone: seed?.tone ?? "따뜻하고 담백",
    values: seed?.values ?? ["안전", "호기심"],
    updatedAt: Date.now()
  };
};

/** 기존 default 텍스트로 저장된 soul 을 풍부한 시드로 갱신할 때 쓰는 헬퍼. */
export const isDefaultSoulText = (s: Soul): boolean => {
  return s.persona === "호기심 많고 느긋함"
    && (s.backstory ?? "").includes("조용히 살아가는 사람");
};
export const enrichSoulFromSeed = (s: Soul): Soul => {
  const seed = PERSONA_SEEDS[s.actorId];
  if (!seed) return s;
  return { ...s, ...seed, actorId: s.actorId, name: s.name, role: s.role, updatedAt: Date.now() };
};

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
