/**
 * 아이템 카탈로그 — 단일 출처. id prefix → 한국어 이름·카테고리·설명.
 * dispatchAction 의 효과 코드는 itemEffects.ts 에 그대로 두되, 표현·분류는 여기서.
 *
 * 새 아이템 추가 시 이 파일만 수정. prompt/event/log 표시는 자동 적용.
 */

export type ItemCategory =
  | "food"      // 먹는 것
  | "material"  // 채집 자원, craft 재료
  | "tool"      // 들고 다니며 USE 하는 도구
  | "weapon"    // 공격용
  | "potion"    // 마시는 효과 물약
  | "recipe"    // 제작법·설계도
  | "trinket"   // 선물용 장식·부적
  | "letter"    // 단서·서신
  | "drop";     // 몬스터 드랍

export interface ItemDef {
  /** catalog key (split("-")[0]) */
  id: string;
  /** 화면·메모리 노출 한국어 */
  korName: string;
  /** 카테고리 */
  category: ItemCategory;
  /** prompt 의 itemHint 또는 설명. 공백 가능 */
  desc?: string;
  /** 인벤 한 슬롯에 최대 몇 개 겹칠 수 있는지. 기본은 카테고리 default. */
  maxStack?: number;
  /**
   * stack 가능 여부. true 면 같은 prefix 끼리 한 슬롯 (stack slot).
   * false 면 instance slot — 개별 id·meta 보존 (corpse, letter, 도구).
   * 미지정이면 카테고리로 결정 (food/material/potion/drop/recipe/trinket=true, tool/weapon/letter=false).
   */
  stackable?: boolean;
}

/** 카테고리별 default 최대 stack. 개별 item def 가 override 가능. */
export const DEFAULT_MAX_STACK: Record<ItemCategory, number> = {
  food:     99,
  material: 99,
  potion:   20,
  drop:     50,
  trinket:   1,
  letter:    1,
  recipe:    1,
  tool:      1,
  weapon:    1
};

/** 카테고리별 default stackable 여부. 개별 item def 가 override 가능. */
export const DEFAULT_STACKABLE: Record<ItemCategory, boolean> = {
  food:     true,
  material: true,
  potion:   true,
  drop:     true,
  trinket:  true,
  recipe:   true,
  letter:   false, // 편지는 보내는 사람·내용 별로 instance
  tool:     false,
  weapon:   false
};

export const ITEM_CATALOG: Record<string, ItemDef> = {
  // ── food ─────────────────────────────────────────
  carrot:       { id: "carrot",       korName: "당근",     category: "food" },
  wheat:        { id: "wheat",        korName: "밀",       category: "food" },
  herb:         { id: "herb",         korName: "약초",     category: "food", desc: "회복 효과 있음" },
  berry:        { id: "berry",        korName: "산열매",   category: "food" },
  mushroom:     { id: "mushroom",     korName: "버섯",     category: "food" },
  fish:         { id: "fish",         korName: "물고기",   category: "food" },
  corpse:       { id: "corpse",       korName: "사체",     category: "food" },
  bread:        { id: "bread",        korName: "빵",       category: "food" },
  cooked_fish:  { id: "cooked_fish",  korName: "구운 생선", category: "food" },
  meat:         { id: "meat",         korName: "고기",     category: "food" },

  // ── seed ─────────────────────────────────────────
  wheat_seed:  { id: "wheat_seed",  korName: "밀 씨앗",   category: "material", desc: "텃밭에서 USE 시 밀이 자라기 시작" },
  carrot_seed: { id: "carrot_seed", korName: "당근 씨앗", category: "material", desc: "텃밭에서 USE 시 당근이 자라기 시작" },

  // ── material ─────────────────────────────────────
  wood:    { id: "wood",   korName: "목재",   category: "material" },
  ore:     { id: "ore",    korName: "광석",   category: "material" },
  clay:    { id: "clay",   korName: "점토",   category: "material" },
  coal:    { id: "coal",   korName: "석탄",   category: "material" },
  hide:    { id: "hide",   korName: "가죽",   category: "material" },
  fang:    { id: "fang",   korName: "이빨",   category: "material" },
  tusk:    { id: "tusk",   korName: "이빨",   category: "material" },
  bone:    { id: "bone",   korName: "뼈",     category: "material" },
  claw:    { id: "claw",   korName: "발톱",   category: "material" },
  gel:     { id: "gel",    korName: "젤",     category: "material" },
  water:   { id: "water",  korName: "물",     category: "material", desc: "요리 재료. USE 단독은 효과 없음" },

  // ── tool ─────────────────────────────────────────
  fishing_rod: { id: "fishing_rod", korName: "낚싯대",  category: "tool", desc: "우물·연못에서 USE 시 물고기" },
  bucket:      { id: "bucket",      korName: "양동이",  category: "tool", desc: "우물·연못에서 USE 시 물 1개" },
  axe:         { id: "axe",         korName: "도끼",    category: "tool" },
  pickaxe:     { id: "pickaxe",     korName: "곡괭이",  category: "tool" },

  // ── weapon ───────────────────────────────────────
  iron_sword: { id: "iron_sword", korName: "철검", category: "weapon" },

  // ── potion ───────────────────────────────────────
  healing_potion: { id: "healing_potion", korName: "회복약", category: "potion" },
  stamina_potion: { id: "stamina_potion", korName: "활력약", category: "potion" },
  "potion-heal":  { id: "potion-heal",    korName: "회복약", category: "potion" },

  // ── recipe / blueprint ───────────────────────────
  recipe:    { id: "recipe",    korName: "제작법",  category: "recipe" },
  blueprint: { id: "blueprint", korName: "설계도",  category: "recipe" },

  // ── trinket / letter ─────────────────────────────
  trinket:      { id: "trinket",      korName: "장식품", category: "trinket" },
  simple_charm: { id: "simple_charm", korName: "부적",   category: "trinket" },
  charm:        { id: "charm",        korName: "부적",   category: "trinket" },
  letter:       { id: "letter",       korName: "편지",   category: "letter" }
};

/** 아이템 인스턴스 ID ("wheat-7") → prefix ("wheat") */
export const itemPrefix = (itemId: string): string => (itemId ?? "").split("-")[0] ?? itemId ?? "";

/** prefix 또는 instance id 양쪽에서 정의 lookup */
export const itemDef = (itemId: string): ItemDef | undefined => {
  if (!itemId) return undefined;
  return ITEM_CATALOG[itemId] ?? ITEM_CATALOG[itemPrefix(itemId)];
};

/** 한국어 이름. 모르면 prefix 그대로 */
export const itemKor = (itemId: string): string => itemDef(itemId)?.korName ?? itemPrefix(itemId) ?? "물건";

/** 카테고리. 모르면 undefined */
export const itemCategory = (itemId: string): ItemCategory | undefined => itemDef(itemId)?.category;

/** 아이템 prefix 의 maxStack. 개별 def override 우선, 없으면 카테고리 default, 모르면 1. */
export const itemMaxStack = (itemId: string): number => {
  const def = itemDef(itemId);
  if (!def) return 1;
  if (def.maxStack !== undefined) return def.maxStack;
  return DEFAULT_MAX_STACK[def.category] ?? 1;
};

/** stackable 여부. def override 우선, 없으면 카테고리 default, 모르면 false. */
export const itemStackable = (itemId: string): boolean => {
  const def = itemDef(itemId);
  if (!def) return false;
  if (def.stackable !== undefined) return def.stackable;
  return DEFAULT_STACKABLE[def.category] ?? false;
};

/** 카테고리별 prefix 목록 (prompt vision 분류 등에서 사용) */
export const itemsByCategory = (): Record<ItemCategory, string[]> => {
  const out = {} as Record<ItemCategory, string[]>;
  for (const def of Object.values(ITEM_CATALOG)) {
    if (!out[def.category]) out[def.category] = [];
    out[def.category].push(def.id);
  }
  return out;
};
