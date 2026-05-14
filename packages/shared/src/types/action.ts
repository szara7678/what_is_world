/**
 * MOVE — 1칸 인접 이동 (atomic) 또는 멀티tick 자동 이동.
 *  - dx,dy 명시: 1칸. 기존 호환.
 *  - to 명시: 시스템이 path 깔고 자동 진행. AutoMovePolicy 적용.
 *    interruptOn: hostile_seen / attacked / hunger_critical / stamina_critical / direct_speech / trade_offer / place_exit_required
 */
export type MoveAction = {
  type: "MOVE";
  dx?: number;
  dy?: number;
  to?: { placeId?: string; xy?: { x: number; y: number }; towardItem?: string; towardActor?: string };
  maxTicks?: number;
};

/**
 * ATTACK — 인접 공격. until 도달 또는 maxTicks 까지 자동 반복.
 * default until: target_dead OR self_hp_below 0.35 OR self_stamina_below 20 OR target_lost OR max_ticks 100.
 * LLM 은 단순 ATTACK { targetId } 만 보내도 충분.
 */
export type AttackUntilCondition =
  | { kind: "target_dead" }
  | { kind: "self_hp_below"; ratio: number }
  | { kind: "self_stamina_below"; value: number }
  | { kind: "target_hp_below"; ratio: number }
  | { kind: "target_lost" }
  | { kind: "max_ticks"; value: number };

export type AttackAction = {
  type: "ATTACK";
  targetId: string;
  until?: AttackUntilCondition[];
  maxTicks?: number;
};

/**
 * GATHER — 채집 의도. count 만큼 자동 반복.
 *  area 미명시 시 radius 12 안의 source 를 자동 탐색한다.
 *  area 명시 시 그 영역 안에서만 자동 이동.
 *  visibleOnly 기본 true — 시야 범위 밖 자원 자동 탐색 X.
 */
export type GatherAction = {
  type: "GATHER";
  item: string;
  count: number;
  area?: { placeId?: string; radius?: number };
  maxTicks?: number;
  allowWaitSpawn?: boolean;
};

export type SocialClaim = {
  type: "recipe_hint" | "place_hint" | "resource_location" | "danger_warning";
  claimKey: string;
  factPayload: Record<string, unknown>;
};

/**
 * SPEAK — 일반 발화. 거래 제안은 OFFER_TRADE 액션으로 분리됨.
 * intent 는 사회적 톤만 (대화·도움요청·경고·칭찬·사과). trade_request 는 deprecated.
 */
export type SpeakAction = {
  type: "SPEAK";
  message: string;
  /** 명시적 청자. 미설정 시 dispatch 가 가장 가까운 말 가능한 actor 자동 선택. */
  targetId?: string;
  intent?: "small_talk" | "help_request" | "warn" | "praise" | "apology";
  /** System-attached only. LLM-authored claims are ignored by policy at prompt level. */
  claim?: SocialClaim;
};

/**
 * OFFER_TRADE — 명시적 거래 제안. 인접 (1칸) 대상에게.
 * pendingTrade open. 상대가 GIVE 로 닫으면 trade.done.
 * pair cooldown 적용 (요청자 30tick, 만료 60tick).
 */
export type OfferTradeAction = {
  type: "OFFER_TRADE";
  targetId: string;
  /** 받고 싶은 아이템 catalog key */
  wantItem?: string;
  wantCount?: number;
  /** 내가 줄 아이템 또는 gold */
  offerItem?: string;
  offerCount?: number;
  offerGold?: number;
  /** 자연스러운 한국어 발화 (옵션). 없으면 시스템 기본 멘트. */
  message?: string;
};

export type AcceptTradeAction = { type: "ACCEPT_TRADE"; tradeId: string };
export type RejectTradeAction = { type: "REJECT_TRADE"; tradeId: string };

export type SleepAction = {
  type: "SLEEP";
  /** default 30 ticks */
  maxTicks?: number;
};
/**
 * USE 는 4 가지 모드:
 *  1) USE itemId (count?)   → 인벤 아이템 효과 발동 (먹기/포션/도구). count 만큼 반복 (최대 stack).
 *  2) USE objectId          → 그 구조물(station) 의 사용 가능 레시피 정보 반환
 *  3) USE objectId targetItemId (count?) → 그 station 으로 targetItemId 를 count 개 제작
 *  4) USE skillId (+ targetId/x/y) → 액티브 스킬 발동 (pray, appraise 등)
 * 우선순위: skillId > objectId+target > objectId > itemId.
 */
export type UseAction = {
  type: "USE";
  itemId?: string;
  objectId?: string;
  targetItemId?: string;
  skillId?: string;
  targetId?: string;
  /** USE itemId / USE objectId+targetItemId 시 갯수 (기본 1, max 32) */
  count?: number;
  x?: number;
  y?: number;
};
export type PickupAction = { type: "PICKUP"; itemId: string; count?: number };
export type DropAction = { type: "DROP"; itemId: string; count?: number; x?: number; y?: number };
export type GiveAction =
  | { type: "GIVE"; targetId: string; itemId: string; count?: number }
  | { type: "GIVE"; targetId: string; currency: "gold"; amount: number };
export type PrayAction = { type: "PRAY" };
export type ThinkAction = { type: "THINK"; query: string };
export type OptionsAction = { type: "OPTIONS" };
export type WaitAction = { type: "WAIT" };

export type ActionRequest = {
  actorId: string;
  action:
    | MoveAction
    | AttackAction
    | SpeakAction
    | UseAction
    | GatherAction
    | PickupAction
    | DropAction
    | GiveAction
    | PrayAction
    | ThinkAction
    | OptionsAction
    | OfferTradeAction
    | AcceptTradeAction
    | RejectTradeAction
    | SleepAction
    | WaitAction;
};
