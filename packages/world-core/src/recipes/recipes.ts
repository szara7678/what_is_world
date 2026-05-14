export type StationKind = "oven" | "alchemy_table" | "workbench" | "forge";

export type Recipe = {
  id: string;
  name: string;
  station: StationKind;
  inputs: { itemPrefix: string; count: number }[];
  output: { itemPrefix: string; iconKey: string; type: string };
  requiredSkillsAll?: { skillId: string; minLevel: number }[];
  requiredSkillsAny?: { skillId: string; minLevel: number }[];
  xpReward: { skillId: string; xp: number }[];
  failLossRate?: number;
  tags: string[];
};

// 2026-05-08: P1 — 모든 recipe 의 base failLossRate 1.0 (lv0 시 전부 실패).
// 실제 fail rate = base * max(0.05, 1 - skillLevel * 0.1) 으로 dispatch 단계에서 감소.
// minLevel 은 tier 차등: starter(0) / mid(1~2) / advanced(3~5).
export const RECIPES: Recipe[] = [
  // ── cooking tier (oven) ─────────────────────
  {
    id: "bread",
    name: "bread",
    station: "oven",
    inputs: [{ itemPrefix: "wheat", count: 2 }],
    output: { itemPrefix: "bread", iconKey: "item.food.bread", type: "food" },
    requiredSkillsAll: [{ skillId: "cooking", minLevel: 0 }],
    xpReward: [{ skillId: "cooking", xp: 5 }],
    failLossRate: 0.5,
    tags: ["food", "tier1"]
  },
  {
    id: "grilled_fish",
    name: "grilled fish",
    station: "oven",
    inputs: [{ itemPrefix: "fish", count: 1 }, { itemPrefix: "herb", count: 1 }],
    output: { itemPrefix: "cooked_fish", iconKey: "item.food.fish", type: "food" },
    requiredSkillsAll: [{ skillId: "cooking", minLevel: 2 }],
    xpReward: [{ skillId: "cooking", xp: 8 }],
    failLossRate: 0.5,
    tags: ["food", "tier2"]
  },
  {
    id: "cooked_eggs",
    name: "cooked eggs",
    station: "oven",
    inputs: [{ itemPrefix: "eggs", count: 1 }],
    output: { itemPrefix: "cooked_eggs", iconKey: "item.food.cooked_eggs", type: "food" },
    requiredSkillsAll: [{ skillId: "cooking", minLevel: 0 }],
    xpReward: [{ skillId: "cooking", xp: 4 }],
    failLossRate: 0.4,
    tags: ["food", "tier1"]
  },
  {
    id: "cooked_meat",
    name: "cooked meat",
    station: "oven",
    inputs: [{ itemPrefix: "meat", count: 1 }],
    output: { itemPrefix: "cooked_meat", iconKey: "item.food.steak", type: "food" },
    requiredSkillsAll: [{ skillId: "cooking", minLevel: 1 }],
    xpReward: [{ skillId: "cooking", xp: 7 }],
    failLossRate: 0.45,
    tags: ["food", "tier2"]
  },
  {
    id: "fish_stew",
    name: "fish stew",
    station: "oven",
    inputs: [{ itemPrefix: "fish", count: 2 }, { itemPrefix: "herb", count: 1 }],
    output: { itemPrefix: "fish_stew", iconKey: "item.food.fish", type: "food" },
    requiredSkillsAll: [{ skillId: "cooking", minLevel: 2 }],
    xpReward: [{ skillId: "cooking", xp: 12 }],
    failLossRate: 0.4,
    tags: ["food", "tier2", "healing"]
  },
  // ── alchemy tier (alchemy_table) ────────────
  {
    id: "healing_potion",
    name: "healing potion",
    station: "alchemy_table",
    inputs: [{ itemPrefix: "herb", count: 2 }, { itemPrefix: "berry", count: 1 }],
    output: { itemPrefix: "healing_potion", iconKey: "item.potion.heal", type: "potion" },
    requiredSkillsAll: [{ skillId: "alchemy", minLevel: 0 }],
    xpReward: [{ skillId: "alchemy", xp: 8 }],
    failLossRate: 0.5,
    tags: ["potion", "tier1"]
  },
  {
    id: "stamina_potion",
    name: "stamina potion",
    station: "alchemy_table",
    inputs: [{ itemPrefix: "mushroom", count: 1 }, { itemPrefix: "berry", count: 2 }],
    output: { itemPrefix: "stamina_potion", iconKey: "item.potion.stamina", type: "potion" },
    requiredSkillsAll: [{ skillId: "alchemy", minLevel: 3 }],
    xpReward: [{ skillId: "alchemy", xp: 12 }],
    failLossRate: 0.5,
    tags: ["potion", "tier2"]
  },
  // ── architecture tier (workbench) ───────────
  {
    id: "workbench_kit",
    name: "workbench blueprint",
    station: "workbench",
    inputs: [{ itemPrefix: "wood", count: 5 }, { itemPrefix: "clay", count: 2 }],
    output: { itemPrefix: "workbench_blueprint", iconKey: "item.recipe", type: "blueprint" },
    requiredSkillsAll: [{ skillId: "architecture", minLevel: 0 }],
    xpReward: [{ skillId: "architecture", xp: 8 }],
    failLossRate: 0.5,
    tags: ["blueprint", "tier1"]
  },
  {
    id: "wooden_axe",
    name: "wooden axe",
    station: "workbench",
    inputs: [{ itemPrefix: "wood", count: 3 }, { itemPrefix: "ore", count: 1 }],
    output: { itemPrefix: "axe", iconKey: "item.tool.axe", type: "tool" },
    // 2026-05-08: minLevel 0 복귀 (gpt-5.5 P0 권고). lv1 게이트가 Jin 진입을 막아 craft 12.5% 회귀 원인.
    requiredSkillsAny: [
      { skillId: "smithing", minLevel: 0 },
      { skillId: "architecture", minLevel: 0 }
    ],
    xpReward: [{ skillId: "smithing", xp: 5 }, { skillId: "architecture", xp: 4 }],
    failLossRate: 0.5,
    tags: ["tool", "tier1"]
  },
  // 2026-05-09: 몬스터 drop 활용 recipes — hide/fang 가치 부여.
  {
    id: "leather_armor",
    name: "leather armor",
    station: "workbench",
    inputs: [{ itemPrefix: "hide", count: 3 }, { itemPrefix: "wood", count: 1 }],
    output: { itemPrefix: "leather_armor", iconKey: "item.tool.leather_armor", type: "tool" },
    requiredSkillsAny: [{ skillId: "architecture", minLevel: 0 }, { skillId: "smithing", minLevel: 0 }],
    xpReward: [{ skillId: "architecture", xp: 6 }],
    failLossRate: 0.3,
    tags: ["armor", "tier1"]
  },
  {
    id: "leather",
    name: "leather",
    station: "workbench",
    inputs: [{ itemPrefix: "hide", count: 2 }],
    output: { itemPrefix: "leather", iconKey: "item.material.leather", type: "material" },
    requiredSkillsAll: [{ skillId: "tailoring", minLevel: 0 }],
    xpReward: [{ skillId: "tailoring", xp: 5 }],
    failLossRate: 0.25,
    tags: ["material", "tier2", "intermediate"]
  },
  {
    id: "leather_helmet",
    name: "leather helmet",
    station: "workbench",
    inputs: [{ itemPrefix: "hide", count: 2 }, { itemPrefix: "wood", count: 1 }],
    output: { itemPrefix: "leather_helmet", iconKey: "item.tool.leather_armor", type: "tool" },
    requiredSkillsAll: [{ skillId: "tailoring", minLevel: 1 }],
    xpReward: [{ skillId: "tailoring", xp: 8 }],
    failLossRate: 0.35,
    tags: ["armor", "tier2"]
  },
  {
    id: "leather_boots",
    name: "leather boots",
    station: "workbench",
    inputs: [{ itemPrefix: "hide", count: 2 }, { itemPrefix: "fang", count: 1 }],
    output: { itemPrefix: "leather_boots", iconKey: "item.tool.leather_armor", type: "tool" },
    requiredSkillsAll: [{ skillId: "tailoring", minLevel: 2 }],
    xpReward: [{ skillId: "tailoring", xp: 10 }],
    failLossRate: 0.35,
    tags: ["armor", "tier2", "mobility"]
  },
  {
    id: "bone_dagger",
    name: "bone dagger",
    station: "workbench",
    inputs: [{ itemPrefix: "fang", count: 3 }, { itemPrefix: "wood", count: 1 }],
    output: { itemPrefix: "bone_dagger", iconKey: "item.weapon.bone_dagger", type: "weapon" },
    requiredSkillsAny: [{ skillId: "smithing", minLevel: 0 }, { skillId: "architecture", minLevel: 0 }],
    xpReward: [{ skillId: "smithing", xp: 6 }],
    failLossRate: 0.3,
    tags: ["weapon", "tier1"]
  },
  {
    id: "oven_kit",
    name: "oven blueprint",
    station: "workbench",
    inputs: [{ itemPrefix: "clay", count: 4 }, { itemPrefix: "wood", count: 3 }, { itemPrefix: "coal", count: 1 }],
    output: { itemPrefix: "oven_blueprint", iconKey: "item.recipe", type: "blueprint" },
    requiredSkillsAll: [{ skillId: "architecture", minLevel: 3 }],
    xpReward: [{ skillId: "architecture", xp: 14 }],
    failLossRate: 0.5,
    tags: ["blueprint", "tier3"]
  },
  {
    id: "cottage_blueprint",
    name: "cottage blueprint",
    station: "workbench",
    inputs: [{ itemPrefix: "wood", count: 12 }, { itemPrefix: "clay", count: 6 }, { itemPrefix: "ore", count: 2 }],
    output: { itemPrefix: "cottage_blueprint", iconKey: "item.recipe", type: "blueprint" },
    requiredSkillsAll: [{ skillId: "architecture", minLevel: 5 }],
    xpReward: [{ skillId: "architecture", xp: 22 }],
    failLossRate: 0.5,
    tags: ["blueprint", "tier4"]
  },
  // ── smithing tier (forge) ───────────────────
  {
    id: "pickaxe",
    name: "pickaxe",
    station: "forge",
    inputs: [{ itemPrefix: "wood", count: 2 }, { itemPrefix: "ore", count: 2 }, { itemPrefix: "coal", count: 1 }],
    output: { itemPrefix: "pickaxe", iconKey: "item.tool.pickaxe", type: "tool" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 0 }],
    xpReward: [{ skillId: "smithing", xp: 10 }],
    failLossRate: 0.5,
    tags: ["tool", "tier1"]
  },
  {
    id: "sword",
    name: "sword",
    station: "forge",
    inputs: [{ itemPrefix: "ore", count: 2 }, { itemPrefix: "wood", count: 1 }],
    output: { itemPrefix: "sword", iconKey: "item.weapon.sword", type: "weapon" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 1 }],
    xpReward: [{ skillId: "smithing", xp: 10 }],
    failLossRate: 0.45,
    tags: ["weapon", "tier1"]
  },
  {
    id: "iron_ingot",
    name: "iron ingot",
    station: "forge",
    inputs: [{ itemPrefix: "ore", count: 1 }, { itemPrefix: "coal", count: 1 }],
    output: { itemPrefix: "iron_ingot", iconKey: "item.material.ore", type: "material" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 1 }],
    xpReward: [{ skillId: "smithing", xp: 7 }, { skillId: "mining", xp: 2 }],
    failLossRate: 0.35,
    tags: ["material", "tier2", "intermediate"]
  },
  {
    id: "iron_sword",
    name: "iron sword",
    station: "forge",
    inputs: [{ itemPrefix: "ore", count: 3 }, { itemPrefix: "coal", count: 1 }, { itemPrefix: "wood", count: 1 }, { itemPrefix: "sword", count: 1 }],
    output: { itemPrefix: "iron_sword", iconKey: "item.weapon.sword", type: "weapon" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 2 }],
    xpReward: [{ skillId: "smithing", xp: 18 }],
    failLossRate: 0.5,
    tags: ["weapon", "tier2"]
  },
  {
    id: "iron_axe",
    name: "iron axe",
    station: "forge",
    inputs: [{ itemPrefix: "ore", count: 2 }, { itemPrefix: "coal", count: 1 }, { itemPrefix: "axe", count: 1 }],
    output: { itemPrefix: "iron_axe", iconKey: "item.tool.axe", type: "tool" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 2 }],
    xpReward: [{ skillId: "smithing", xp: 14 }, { skillId: "woodcutting", xp: 3 }],
    failLossRate: 0.45,
    tags: ["tool", "tier2"]
  },
  {
    id: "iron_pickaxe",
    name: "iron pickaxe",
    station: "forge",
    inputs: [{ itemPrefix: "ore", count: 2 }, { itemPrefix: "coal", count: 1 }, { itemPrefix: "pickaxe", count: 1 }],
    output: { itemPrefix: "iron_pickaxe", iconKey: "item.tool.pickaxe", type: "tool" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 2 }],
    xpReward: [{ skillId: "smithing", xp: 14 }, { skillId: "mining", xp: 3 }],
    failLossRate: 0.45,
    tags: ["tool", "tier2"]
  },
  {
    id: "magic_essence",
    name: "magic essence",
    station: "alchemy_table",
    inputs: [{ itemPrefix: "essence", count: 2 }],
    output: { itemPrefix: "magic_essence", iconKey: "item.material.essence", type: "material" },
    requiredSkillsAll: [{ skillId: "alchemy", minLevel: 3 }],
    xpReward: [{ skillId: "alchemy", xp: 14 }],
    failLossRate: 0.45,
    tags: ["material", "tier3", "intermediate"]
  },
  {
    id: "steel_sword",
    name: "steel sword",
    station: "forge",
    inputs: [{ itemPrefix: "iron_sword", count: 2 }, { itemPrefix: "ore", count: 2 }, { itemPrefix: "coal", count: 2 }],
    output: { itemPrefix: "steel_sword", iconKey: "item.weapon.sword", type: "weapon" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 5 }],
    xpReward: [{ skillId: "smithing", xp: 30 }],
    failLossRate: 0.55,
    tags: ["weapon", "tier3"]
  },
  {
    id: "chainmail",
    name: "chainmail",
    station: "forge",
    inputs: [{ itemPrefix: "ore", count: 4 }, { itemPrefix: "hide", count: 3 }, { itemPrefix: "coal", count: 1 }],
    output: { itemPrefix: "chainmail", iconKey: "item.tool.leather_armor", type: "tool" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 4 }],
    requiredSkillsAny: [{ skillId: "tailoring", minLevel: 2 }],
    xpReward: [{ skillId: "smithing", xp: 22 }, { skillId: "tailoring", xp: 10 }],
    failLossRate: 0.5,
    tags: ["armor", "tier3"]
  },
  {
    id: "master_axe",
    name: "master axe",
    station: "workbench",
    inputs: [{ itemPrefix: "iron_axe", count: 2 }, { itemPrefix: "essence", count: 1 }],
    output: { itemPrefix: "master_axe", iconKey: "item.tool.axe", type: "tool" },
    requiredSkillsAll: [{ skillId: "woodcutting", minLevel: 4 }],
    requiredSkillsAny: [{ skillId: "smithing", minLevel: 3 }, { skillId: "tailoring", minLevel: 3 }],
    xpReward: [{ skillId: "woodcutting", xp: 22 }, { skillId: "smithing", xp: 10 }],
    failLossRate: 0.5,
    tags: ["tool", "tier3"]
  }
];

export function findRecipesForStation(station: StationKind): Recipe[] {
  return RECIPES.filter((r) => r.station === station);
}

export function getRecipeById(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export function checkSkillRequirements(
  recipe: Recipe,
  skillLevels: Record<string, number>
): { ok: boolean; missing?: string[] } {
  if (recipe.requiredSkillsAll && recipe.requiredSkillsAll.length > 0) {
    const missing = recipe.requiredSkillsAll
      .filter((req) => (skillLevels[req.skillId] ?? 0) < req.minLevel)
      .map((req) => `${req.skillId} ${req.minLevel}`);
    if (missing.length > 0) return { ok: false, missing };
  }
  if (recipe.requiredSkillsAny && recipe.requiredSkillsAny.length > 0) {
    const any = recipe.requiredSkillsAny.some((req) => (skillLevels[req.skillId] ?? 0) >= req.minLevel);
    if (!any) {
      return {
        ok: false,
        missing: recipe.requiredSkillsAny.map((req) => `${req.skillId} ${req.minLevel}`)
      };
    }
  }
  return { ok: true };
}

import type { InventorySlot } from "@wiw/shared";

export function checkInputs(
  recipe: Recipe,
  inventory: InventorySlot[]
): { ok: boolean; needed: { itemPrefix: string; have: number; want: number }[] } {
  const counts: Record<string, number> = {};
  for (const slot of inventory) {
    counts[slot.item] = (counts[slot.item] ?? 0) + (slot.kind === "stack" ? slot.count : 1);
  }
  const needed = recipe.inputs.map((i) => ({
    itemPrefix: i.itemPrefix,
    have: counts[i.itemPrefix] ?? 0,
    want: i.count
  }));
  const ok = needed.every((n) => n.have >= n.want);
  return { ok, needed };
}
