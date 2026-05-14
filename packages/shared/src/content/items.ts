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

// 2026-05-08: 모든 이름·설명 영어 통일 + 실제 itemEffects 코드 기반으로 desc 정밀화.
// desc 형식: "Edible. USE: -X hunger, +Y stamina." | "Material. ..." | "Tool. ..." 등.
// 새 아이템 추가/효과 변경 시 itemEffects.ts 와 함께 desc 도 동기화 필수.
export const ITEM_CATALOG: Record<string, ItemDef> = {
  // ── food (USE itemId → hunger 감소 + 부수 효과) ─────────────────
  carrot:       { id: "carrot",       korName: "carrot",      category: "food", desc: "Edible root. USE: −10 hunger, +2 stamina." },
  wheat:        { id: "wheat",        korName: "wheat",       category: "food", desc: "Raw grain. USE itemId=wheat on field soil to plant (matures into more wheat by farming skill). USE objectId=structure-oven targetItemId=bread to bake. Not eaten directly." },
  herb:         { id: "herb",         korName: "herb",        category: "food", desc: "Restorative leaf. USE: +5 hp, +3 stamina. Also used in healing_potion recipe." },
  berry:        { id: "berry",        korName: "berry",       category: "food", desc: "Edible. USE: −12 hunger, +1 stamina. Also used in potion recipes." },
  mushroom:     { id: "mushroom",     korName: "mushroom",    category: "food", desc: "Edible. USE: −8 hunger, +2 mp. Also used in stamina_potion recipe." },
  fish:         { id: "fish",         korName: "fish",        category: "food", desc: "Raw fish. USE: −20 hunger, +4 stamina. Also recipe input for cooked_fish." },
  corpse:       { id: "corpse",       korName: "corpse",      category: "food", desc: "Raw meat from a slain creature. USE: −28 hunger, +4 stamina." },
  bread:        { id: "bread",        korName: "bread",       category: "food", desc: "Baked. USE: −20 hunger, +3 stamina." },
  apple:        { id: "apple",        korName: "apple",       category: "food", desc: "Orchard fruit. USE: −14 hunger, +2 stamina." },
  pear:         { id: "pear",         korName: "pear",        category: "food", desc: "[DEPRECATED — remapped to apple visuals/content] Legacy orchard fruit. USE: same as apple." },
  pineapple:    { id: "pineapple",    korName: "pineapple",   category: "food", desc: "Orchard fruit. USE: −15 hunger, +2 stamina." },
  cooked_fish:  { id: "cooked_fish",  korName: "cooked fish", category: "food", desc: "Cooked. USE: −28 hunger, +6 stamina." },
  meat:         { id: "meat",         korName: "meat",        category: "food", desc: "Cured/cooked meat. USE: −22 hunger, +5 stamina." },
  cooked_meat:  { id: "cooked_meat",  korName: "cooked meat", category: "food", desc: "Cooked. USE: −28 hunger, +6 stamina." },
  fish_stew:    { id: "fish_stew",    korName: "fish stew",   category: "food", desc: "Hot stew. USE: −32 hunger, +8 stamina, +8 hp." },
  cheese:       { id: "cheese",       korName: "cheese",      category: "food", desc: "Dairy food. USE: −16 hunger, +3 stamina." },
  eggs:         { id: "eggs",         korName: "eggs",        category: "food", desc: "Protein food. USE: −12 hunger, +2 stamina. Oven recipe input for cooked eggs." },
  cooked_eggs:  { id: "cooked_eggs",  korName: "cooked eggs", category: "food", desc: "Cooked. USE: −18 hunger, +4 stamina." },
  chicken_leg:  { id: "chicken_leg",  korName: "chicken leg", category: "food", desc: "Cooked meat. USE: −24 hunger, +5 stamina." },
  steak:        { id: "steak",        korName: "steak",       category: "food", desc: "Cooked meat. USE: −26 hunger, +5 stamina." },
  honey:        { id: "honey",        korName: "honey",       category: "food", desc: "Sweet food. USE: −10 hunger, +4 stamina." },
  tomato:       { id: "tomato",       korName: "tomato",      category: "food", desc: "Fresh produce. USE: −11 hunger, +2 stamina." },
  potato:       { id: "potato",       korName: "potato",      category: "food", desc: "Starchy produce. USE: −13 hunger, +2 stamina." },
  onion:        { id: "onion",        korName: "onion",       category: "food", desc: "Fresh produce. USE: −8 hunger, +1 stamina." },
  cherry:       { id: "cherry",       korName: "cherry",      category: "food", desc: "Small fruit. USE: −9 hunger, +2 stamina." },
  peach:        { id: "peach",        korName: "peach",       category: "food", desc: "Orchard fruit. USE: −14 hunger, +2 stamina." },
  sushi:        { id: "sushi",        korName: "sushi",       category: "food", desc: "Prepared fish dish. USE: −24 hunger, +6 stamina." },
  shrimp:       { id: "shrimp",       korName: "shrimp",      category: "food", desc: "Seafood. USE: −16 hunger, +4 stamina." },
  sardines:     { id: "sardines",     korName: "sardines",    category: "food", desc: "Seafood. USE: −18 hunger, +4 stamina." },
  sashimi:      { id: "sashimi",      korName: "sashimi",     category: "food", desc: "Prepared fish. USE: −22 hunger, +5 stamina." },

  // ── seed (planting only — no eat effect) ──────────────────────
  wheat_seed:  { id: "wheat_seed",  korName: "wheat seed",  category: "material", desc: "[DEPRECATED — use itemId=wheat instead] Legacy seed slot. USE on field soil still plants for back-compat." },
  carrot_seed: { id: "carrot_seed", korName: "carrot seed", category: "material", desc: "Plant only. USE on field soil to start growing carrots. No effect when USE'd off-field." },

  // ── material (no USE effect alone — used as craft inputs) ─────
  wood:    { id: "wood",   korName: "wood",  category: "material", desc: "Crafting material. Recipe input at workbench/forge. No USE effect alone." },
  ore:     { id: "ore",    korName: "ore",   category: "material", desc: "Crafting material. Recipe input at workbench/forge. No USE effect alone." },
  clay:    { id: "clay",   korName: "clay",  category: "material", desc: "Crafting material. USE alone fails (material_only_for_craft) — use as workbench/oven input." },
  coal:    { id: "coal",   korName: "coal",  category: "material", desc: "Fuel material. USE alone fails (material_only_for_craft) — use as forge/oven input." },
  hide:    { id: "hide",   korName: "hide",  category: "material", desc: "Monster drop. Crafting material. No USE effect alone." },
  leather: { id: "leather", korName: "leather", category: "material", desc: "Processed hide. Tailoring intermediate for armor and boots." },
  fang:    { id: "fang",   korName: "fang",  category: "material", desc: "Monster drop. Decorative material. No USE effect alone." },
  tusk:    { id: "tusk",   korName: "tusk",  category: "material", desc: "Monster drop. Decorative material. No USE effect alone." },
  bone:    { id: "bone",   korName: "bone",  category: "material", desc: "Monster drop. Decorative material. No USE effect alone." },
  claw:    { id: "claw",   korName: "claw",  category: "material", desc: "Monster drop. Decorative material. No USE effect alone." },
  gel:     { id: "gel",    korName: "gel",   category: "material", desc: "Slime drop. Decorative material. No USE effect alone." },
  essence: { id: "essence", korName: "essence", category: "material", desc: "Spirit drop. Alchemy material. Refine into magic_essence." },
  magic_essence: { id: "magic_essence", korName: "magic essence", category: "material", desc: "Refined mystical material for tier 3 crafting." },
  iron_ingot: { id: "iron_ingot", korName: "iron ingot", category: "material", desc: "Refined ore and coal. Intermediate for metal crafting." },
  water:   { id: "water",  korName: "water", category: "material", desc: "Drawn from well/pond with bucket. Cooking ingredient. No USE effect alone." },

  // ── tool (held; USE has special behavior) ─────────────────────
  fishing_rod: { id: "fishing_rod", korName: "fishing rod", category: "tool", desc: "Tool. USE at well/pond to attempt catching a fish (success scales with fishing skill)." },
  bucket:      { id: "bucket",      korName: "bucket",      category: "tool", desc: "Tool. USE at well/pond to draw 1 water into inventory." },
  axe:         { id: "axe",         korName: "axe",         category: "tool", desc: "Tool. USE objectId=structure-tree-X (adjacent) to chop wood. Held in inventory: ATTACK damage +4." },
  pickaxe:     { id: "pickaxe",     korName: "pickaxe",     category: "tool", desc: "Tool. USE objectId=structure-rock-X (adjacent) to mine ore/coal. Held in inventory: ATTACK damage +2." },
  iron_axe:    { id: "iron_axe",    korName: "iron axe",    category: "tool", desc: "Tier 2 axe. Chops extra wood and counts as an axe. Held in inventory: ATTACK damage +5." },
  iron_pickaxe:{ id: "iron_pickaxe",korName: "iron pickaxe",category: "tool", desc: "Tier 2 pickaxe. Mines extra ore and counts as a pickaxe. Held in inventory: ATTACK damage +3." },
  master_axe:  { id: "master_axe",  korName: "master axe",  category: "tool", desc: "Tier 3 axe. Doubles tree chop yield. Held in inventory: ATTACK damage +6." },

  // ── weapon ──────────────────────────────────────────────────
  sword:      { id: "sword",      korName: "sword",      category: "weapon", desc: "Tier 1 weapon. Held in inventory: ATTACK damage +6. Forge recipe: 2 ore + 1 wood." },
  iron_sword: { id: "iron_sword", korName: "iron sword", category: "weapon", desc: "Tier 2 weapon. Held in inventory: ATTACK damage +8. Forge recipe: 3 ore + 1 coal + 1 wood + 1 sword." },
  steel_sword:{ id: "steel_sword",korName: "steel sword",category: "weapon", desc: "Tier 3 weapon. Held in inventory: ATTACK damage +15. Forge recipe: 2 iron_sword + 2 ore + 2 coal." },
  wooden_axe: { id: "wooden_axe", korName: "wooden axe", category: "tool", desc: "Tool. USE objectId=structure-tree-X (adjacent) to chop wood. Held in inventory: ATTACK damage +4. Workbench recipe: 3 wood + 1 ore." },
  // 2026-05-09: 몬스터 drop 활용 — hide/fang 가치 부여.
  bone_dagger:   { id: "bone_dagger",   korName: "bone dagger",   category: "weapon", desc: "Weapon. Held in inventory: ATTACK damage +5. Workbench recipe: 3 fang + 1 wood." },
  leather_armor: { id: "leather_armor", korName: "leather armor", category: "tool",   desc: "Armor. Held in inventory: max HP +15. Workbench recipe: 3 hide + 1 wood." },
  leather_helmet:{ id: "leather_helmet",korName: "leather helmet",category: "tool",   desc: "Armor. Held in inventory: max HP +5. Workbench recipe: 2 hide + 1 wood." },
  leather_boots: { id: "leather_boots", korName: "leather boots", category: "tool",   desc: "Armor. Held in inventory: effective dexterity +1. Workbench recipe: 2 hide + 1 fang." },
  chainmail:     { id: "chainmail",     korName: "chainmail",     category: "tool",   desc: "Tier 3 armor. Held in inventory: max HP +25. Forge recipe: 4 ore + 3 hide + 1 coal." },

  // ── potion (USE = consume for effect) ────────────────────────
  healing_potion: { id: "healing_potion", korName: "healing potion", category: "potion", desc: "Potion. USE: +35 hp." },
  stamina_potion: { id: "stamina_potion", korName: "stamina potion", category: "potion", desc: "Potion. USE: +30 stamina, +5 mp." },
  "potion-heal":  { id: "potion-heal",    korName: "healing potion", category: "potion", desc: "Potion variant. USE: +30 hp." },

  // ── recipe / blueprint (USE to place / read) ─────────────────
  recipe:              { id: "recipe",    korName: "recipe", category: "recipe", desc: "Paper note describing a recipe. (Placeholder.)" },
  blueprint:           { id: "blueprint", korName: "blueprint", category: "recipe", desc: "Generic building plan. (Placeholder.)" },
  workbench_blueprint: { id: "workbench_blueprint", korName: "workbench blueprint", category: "recipe", desc: "USE to place a workbench on an open adjacent tile." },
  oven_blueprint:      { id: "oven_blueprint", korName: "oven blueprint", category: "recipe", desc: "USE to place an oven on an open adjacent tile." },
  cottage_blueprint:   { id: "cottage_blueprint", korName: "cottage blueprint", category: "recipe", desc: "USE to place a 4×4 cottage with a home place on an open adjacent area." },

  // ── trinket / letter ────────────────────────────────────────
  trinket:      { id: "trinket",      korName: "trinket", category: "trinket", desc: "Decoration. Gift-ready (no USE effect; consumed only by GIVE)." },
  simple_charm: { id: "simple_charm", korName: "charm",   category: "trinket", desc: "Decorative charm. Gift-ready." },
  charm:        { id: "charm",        korName: "charm",   category: "trinket", desc: "Decorative charm. Gift-ready." },
  letter:       { id: "letter",       korName: "letter",  category: "letter", desc: "A letter from another village. USE to read." }
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

/** 영문 (LLM prompt 용). itemId prefix 자체가 영문 canonical key. */
export const itemEn = (itemId: string): string => itemPrefix(itemId);

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
