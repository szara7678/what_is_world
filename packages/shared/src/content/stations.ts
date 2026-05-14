/**
 * Station / Place 카탈로그 — 단일 출처.
 * 2026-05-08: 영어 통일 + desc 추가. 새 station/place 추가 시 desc 도 같이 작성.
 */

export interface StationDef {
  /** structure.type id (oven / alchemy_table / workbench / forge) */
  id: string;
  korName: string;
  /** 권장 craft 카테고리 (recipe.station 일치) */
  category?: "cooking" | "alchemy" | "wood" | "metal";
  /** appraise + prompt 노출용 정확 설명 — recipes.ts 와 정합 유지 필수 */
  desc?: string;
}

export const STATION_CATALOG: Record<string, StationDef> = {
  oven:          { id: "oven",          korName: "oven",          category: "cooking", desc: "Cooking station. Bake or roast food using flour-grain or fish-and-herb. USE objectId+targetItemId to craft." },
  alchemy_table: { id: "alchemy_table", korName: "alchemy table", category: "alchemy", desc: "Alchemy station. Brew potions from herbs, berries, mushrooms. USE objectId+targetItemId to craft." },
  workbench:     { id: "workbench",     korName: "workbench",     category: "wood",    desc: "Wood-and-metal crafting station. Build tools and blueprint kits. USE objectId+targetItemId to craft." },
  forge:         { id: "forge",         korName: "forge",         category: "metal",   desc: "Smithing station. Hammer ore + wood + coal into pickaxes and weapons. USE objectId+targetItemId to craft." }
};

/** 모든 station id (Set 으로 lookup) */
export const STATION_TYPES = new Set(Object.keys(STATION_CATALOG));

/** id → 표시 이름. 모르면 id 그대로 */
export const stationKor = (id: string): string => STATION_CATALOG[id]?.korName ?? id;

/** id → 영문 (LLM prompt 용). station id 자체가 영문. */
export const stationEn = (id: string): string => id;

/** id → desc (없으면 빈 문자열). */
export const stationDesc = (id: string): string => STATION_CATALOG[id]?.desc ?? "";

/** place.kind → 표시 이름 라벨. 모르면 kind 그대로 */
export const PLACE_KIND_LABEL: Record<string, string> = {
  shop:        "shop",
  home:        "home",
  shrine:      "shrine",
  tavern:      "tavern",
  field:       "field",
  well:        "well",
  pond:        "pond",
  plaza:       "plaza",
  forest_edge: "forest edge",
  forest:      "forest",
  mine:        "mine",
  smithy:      "smithy",
  alchemy:     "alchemy",
  noticeboard: "noticeboard",
  road:        "road"
};
export const placeKindKor = (kind: string): string => PLACE_KIND_LABEL[kind] ?? kind;
/** place.kind 영문 (LLM prompt 용). kind 자체가 영문이라 통과. */
export const placeKindEn = (kind: string): string => kind;
