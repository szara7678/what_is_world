/**
 * action result.message (영어 코드) → 사용자 표시용 한국어 풀이.
 * 내부 코드는 디버깅 용으로 그대로 유지. 메모리/이벤트 표시 시 이 함수 사용.
 *
 * 매핑 누락 시 fallback 으로 "행동이 잘 되지 않았다." (raw 코드는 별도 dev log).
 */
export const ACTION_RESULT_KO: Record<string, string> = {
  // dispatch fail codes
  item_not_in_inventory:        "들고 있지 않은 물건이라 쓸 수 없었다.",
  item_required:                "쓰려는 물건이 정해지지 않아 비어 돌았다.",
  item_not_found:               "주울 만한 물건을 찾지 못했다.",
  item_too_far:                 "물건이 손에 닿지 않는 거리라 줍지 못했다.",
  inventory_full:               "짐이 가득 차서 더 들 수 없었다.",
  target_too_far:                "대상이 너무 멀어 닿지 않았다.",
  target_inventory_full:         "건네려 했지만 상대 짐이 가득 차 있었다.",
  blocked_actor:                 "그 자리에 누가 있어 지나가지 못했다.",
  out_of_bounds:                 "그 길은 마을 바깥이라 갈 수 없었다.",
  collision:                     "막힌 길이라 돌아가야 했다.",
  stamina_too_low:               "기력이 모자라 움직이지 못했다.",
  // craft
  "craft_failed_no_match station:oven":          "오븐에 맞는 재료가 없어 굽지 못했다.",
  "craft_failed_no_match station:alchemy_table": "연금대에 맞는 재료가 없어 만들지 못했다.",
  "craft_failed_no_match station:workbench":     "작업대에 맞는 재료가 없어 만들지 못했다.",
  "craft_failed_no_match station:forge":         "대장간에 맞는 재료가 없어 두드리지 못했다.",
  craft_failed_no_match:                         "여기서는 그 재료로 만들 수 없었다.",
  craft_failed_skill:                            "아직 솜씨가 모자라 만들지 못했다.",
  craft_failed_inputs:                           "재료가 모자라 만들지 못했다.",
  // bucket / water
  bucket_no_water_source:        "여기서는 물을 길을 수 없었다.",
  water_only_for_cooking:        "물은 그대로 쓸 수 없고 요리에만 쓰인다.",
  // brain / system
  ineffective_cooldown:          "같은 시도를 반복해 잠시 손을 멈췄다.",
  use_inventory_missing:         "들고 있지 않은 물건이라 쓸 수 없었다.",
  invalid_action:                "지금은 할 수 없는 행동이었다.",
  think_cap_reached:             "생각이 너무 많아져 잠시 멈췄다.",
  llm_unavailable:               "마음이 잠시 흐려져 결정을 미뤘다."
};

/**
 * 영어 result code 를 자연어 한국어로 풀이. 모르는 코드면 fallback + 원문 함께.
 */
export const describeActionResultKo = (raw: string | undefined | null): string => {
  if (!raw) return "";
  const ko = ACTION_RESULT_KO[raw];
  if (ko) return ko;
  // 부분 매치 — "craft_failed_no_match station:..." 같이 변형 코드
  const baseKey = raw.split(" ")[0]?.split(":")[0];
  if (baseKey && ACTION_RESULT_KO[baseKey]) return ACTION_RESULT_KO[baseKey];
  return `행동이 잘 되지 않았다. (${raw})`;
};
