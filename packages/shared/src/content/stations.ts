/**
 * Station / Place 카탈로그 — 단일 출처.
 * structure.type → 한국어 라벨, place.kind → 한국어 라벨.
 */

export interface StationDef {
  /** structure.type id (oven / alchemy_table / workbench / forge) */
  id: string;
  korName: string;
  /** 권장 craft 카테고리 (recipe.station 일치) */
  category?: "cooking" | "alchemy" | "wood" | "metal";
}

export const STATION_CATALOG: Record<string, StationDef> = {
  oven:          { id: "oven",          korName: "오븐",     category: "cooking" },
  alchemy_table: { id: "alchemy_table", korName: "연금대",   category: "alchemy" },
  workbench:     { id: "workbench",     korName: "작업대",   category: "wood" },
  forge:         { id: "forge",         korName: "대장간",   category: "metal" }
};

/** 모든 station id (Set 으로 lookup) */
export const STATION_TYPES = new Set(Object.keys(STATION_CATALOG));

/** id → 한국어. 모르면 id 그대로 */
export const stationKor = (id: string): string => STATION_CATALOG[id]?.korName ?? id;

/** place.kind → 한국어 라벨. 알려진 kind 만, 모르면 kind 그대로 */
export const PLACE_KIND_LABEL: Record<string, string> = {
  shop:        "가게",
  home:        "집",
  shrine:      "사당",
  tavern:      "선술집",
  field:       "텃밭",
  well:        "우물",
  pond:        "연못",
  plaza:       "광장",
  forest_edge: "숲가",
  forest:      "숲",
  mine:        "광산",
  smithy:      "대장간",
  alchemy:     "연금실",
  noticeboard: "게시판",
  road:        "길"
};
export const placeKindKor = (kind: string): string => PLACE_KIND_LABEL[kind] ?? kind;
