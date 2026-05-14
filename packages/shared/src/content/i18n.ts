/**
 * 한국어 통합 i18n. items / stations / actions / directions / results 모두 한 곳에서 lookup.
 *
 * 사용:  import { ko } from "@wiw/shared";
 *        ko.items(itemId), ko.action(type), ko.direction(dx, dy), ko.result(code) ...
 *
 * 기존 items.ts / stations.ts / actionResult.ts 의 raw catalog 는 그대로 유지하되,
 * 표시 layer 는 모두 ko.* 로 통일한다 (중복·누락 방지).
 */
import { itemKor, itemMaxStack, itemEn } from "./items";
import { stationKor, placeKindKor, stationEn, placeKindEn } from "./stations";
import { describeActionResultKo } from "./actionResult";

/** 행동 동사 한국어. observation/log 표시용. */
export const ACTION_VERB_KO: Record<string, string> = {
  MOVE: "걸었다",
  SPEAK: "말했다",
  USE: "썼다",
  PICKUP: "주웠다",
  DROP: "내려놨다",
  GIVE: "건넸다",
  ATTACK: "공격했다",
  PRAY: "기도했다",
  THINK: "떠올렸다",
  INVENTORY: "소지품을 살폈다",
  OPTIONS: "주변을 가늠했다",
  WAIT: "잠시 멈췄다"
};

/** dx, dy → 방향 한국어. 0,0 → 빈 문자열. */
export const directionKo = (dx: number, dy: number): string => {
  if (dx === 0 && dy === 0) return "";
  if (dx > 0 && dy === 0) return "동쪽";
  if (dx < 0 && dy === 0) return "서쪽";
  if (dy > 0 && dx === 0) return "남쪽";
  if (dy < 0 && dx === 0) return "북쪽";
  if (dx > 0 && dy > 0) return "남동쪽";
  if (dx > 0 && dy < 0) return "북동쪽";
  if (dx < 0 && dy > 0) return "남서쪽";
  return "북서쪽";
};

/** 짧은 방향 1글자 (감각 표현용). 8 방위. */
export const directionShortKo = (dx: number, dy: number): string => {
  if (dx === 0 && dy === 0) return "여기";
  const ax = Math.abs(dx); const ay = Math.abs(dy);
  if (ax > ay * 2) return dx > 0 ? "동" : "서";
  if (ay > ax * 2) return dy > 0 ? "남" : "북";
  return `${dy > 0 ? "남" : "북"}${dx > 0 ? "동" : "서"}`;
};

/** 통합 표시 객체. 항상 fallback 값 안전. */
export const ko = {
  /** 아이템 prefix 또는 instance id → 한국어 이름 */
  items: (itemId: string): string => itemKor(itemId),
  /** station id (oven 등) → 한국어 */
  station: (id: string): string => stationKor(id),
  /** place.kind → 한국어 라벨 */
  placeKind: (kind: string): string => placeKindKor(kind),
  /** action type → 한국어 동사 */
  action: (type: string): string => ACTION_VERB_KO[type] ?? type,
  /** dx,dy → 방향 한국어 ("동쪽" 등) */
  direction: directionKo,
  /** dx,dy → 짧은 방향 ("동" 등) */
  directionShort: directionShortKo,
  /** dispatch result code → 한국어 풀이 */
  result: (code: string | undefined | null): string => describeActionResultKo(code)
};

/** 8 방위 짧은 영문 (LLM prompt 용). N/S/E/W. */
export const directionShortEn = (dx: number, dy: number): string => {
  if (dx === 0 && dy === 0) return "here";
  const ax = Math.abs(dx); const ay = Math.abs(dy);
  if (ax > ay * 2) return dx > 0 ? "E" : "W";
  if (ay > ax * 2) return dy > 0 ? "S" : "N";
  return `${dy > 0 ? "S" : "N"}${dx > 0 ? "E" : "W"}`;
};

/** 영문 통합 표시 객체 — LLM prompt 전용. itemId/placeId/stationId 모두 canonical key 그대로. */
export const en = {
  /** 아이템 prefix 또는 instance id → canonical English prefix */
  items: (itemId: string): string => itemEn(itemId),
  /** station type → 영문 (id 자체가 영문) */
  station: (id: string): string => stationEn(id),
  /** place.kind → 영문 (kind 자체가 영문) */
  placeKind: (kind: string): string => placeKindEn(kind),
  /** action type → 영문 동사 */
  action: (type: string): string => type.toLowerCase(),
  /** dx,dy → 짧은 방향 N/S/E/W */
  directionShort: directionShortEn
};
