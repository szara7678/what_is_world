export type MoveAction = { type: "MOVE"; dx: number; dy: number };
export type AttackAction = { type: "ATTACK"; targetId: string };
/**
 * SPEAK — 일반 발화. 거래 제안은 OFFER_TRADE 액션으로 분리됨.
 * intent 는 사회적 톤만 (대화·도움요청·경고·칭찬·사과). trade_request 는 deprecated.
 */
export type SpeakAction = {
  type: "SPEAK";
  message: string;
  intent?: "small_talk" | "help_request" | "warn" | "praise" | "apology";
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
export type BuyAction = { type: "BUY"; targetId: string; itemType: string };
export type SellAction = { type: "SELL"; targetId: string; itemId: string };
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
    | PickupAction
    | DropAction
    | GiveAction
    | BuyAction
    | SellAction
    | PrayAction
    | ThinkAction
    | OptionsAction
    | OfferTradeAction
    | WaitAction;
};
