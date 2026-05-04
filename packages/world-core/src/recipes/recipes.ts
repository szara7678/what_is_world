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

export const RECIPES: Recipe[] = [
  {
    id: "bread",
    name: "빵 굽기",
    station: "oven",
    inputs: [{ itemPrefix: "wheat", count: 2 }],
    output: { itemPrefix: "bread", iconKey: "item.food.bread", type: "food" },
    requiredSkillsAll: [{ skillId: "cooking", minLevel: 0 }],
    xpReward: [{ skillId: "cooking", xp: 5 }],
    tags: ["food", "starter"]
  },
  {
    id: "grilled_fish",
    name: "구운 생선",
    station: "oven",
    inputs: [{ itemPrefix: "fish", count: 1 }, { itemPrefix: "herb", count: 1 }],
    output: { itemPrefix: "cooked_fish", iconKey: "item.food.fish", type: "food" },
    requiredSkillsAll: [{ skillId: "cooking", minLevel: 0 }],
    xpReward: [{ skillId: "cooking", xp: 6 }],
    tags: ["food"]
  },
  {
    id: "healing_potion",
    name: "치유 물약",
    station: "alchemy_table",
    inputs: [{ itemPrefix: "herb", count: 2 }, { itemPrefix: "berry", count: 1 }],
    output: { itemPrefix: "healing_potion", iconKey: "item.potion.heal", type: "potion" },
    requiredSkillsAll: [{ skillId: "alchemy", minLevel: 0 }],
    xpReward: [{ skillId: "alchemy", xp: 8 }],
    tags: ["potion", "healing"]
  },
  {
    id: "stamina_potion",
    name: "활력 물약",
    station: "alchemy_table",
    inputs: [{ itemPrefix: "mushroom", count: 1 }, { itemPrefix: "berry", count: 2 }],
    output: { itemPrefix: "stamina_potion", iconKey: "item.potion.stamina", type: "potion" },
    requiredSkillsAll: [{ skillId: "alchemy", minLevel: 1 }],
    xpReward: [{ skillId: "alchemy", xp: 10 }],
    failLossRate: 0.1,
    tags: ["potion", "stamina"]
  },
  {
    id: "wooden_axe",
    name: "나무 도끼",
    station: "workbench",
    inputs: [{ itemPrefix: "wood", count: 3 }, { itemPrefix: "ore", count: 1 }],
    output: { itemPrefix: "axe", iconKey: "item.tool.axe", type: "tool" },
    requiredSkillsAny: [
      { skillId: "smithing", minLevel: 0 },
      { skillId: "architecture", minLevel: 0 }
    ],
    xpReward: [{ skillId: "smithing", xp: 5 }, { skillId: "architecture", xp: 2 }],
    tags: ["tool", "starter"]
  },
  {
    id: "pickaxe",
    name: "곡괭이",
    station: "forge",
    inputs: [{ itemPrefix: "wood", count: 2 }, { itemPrefix: "ore", count: 2 }, { itemPrefix: "coal", count: 1 }],
    output: { itemPrefix: "pickaxe", iconKey: "item.tool.pickaxe", type: "tool" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 1 }],
    xpReward: [{ skillId: "smithing", xp: 10 }],
    failLossRate: 0.15,
    tags: ["tool"]
  },
  {
    id: "iron_sword",
    name: "철검",
    station: "forge",
    inputs: [{ itemPrefix: "ore", count: 3 }, { itemPrefix: "coal", count: 2 }, { itemPrefix: "wood", count: 1 }],
    output: { itemPrefix: "iron_sword", iconKey: "item.weapon.sword", type: "weapon" },
    requiredSkillsAll: [{ skillId: "smithing", minLevel: 2 }],
    xpReward: [{ skillId: "smithing", xp: 15 }],
    failLossRate: 0.2,
    tags: ["weapon"]
  },
  {
    id: "workbench_kit",
    name: "작업대 청사진",
    station: "workbench",
    inputs: [{ itemPrefix: "wood", count: 5 }, { itemPrefix: "clay", count: 2 }],
    output: { itemPrefix: "workbench_blueprint", iconKey: "item.recipe", type: "blueprint" },
    requiredSkillsAll: [{ skillId: "architecture", minLevel: 0 }],
    xpReward: [{ skillId: "architecture", xp: 8 }],
    tags: ["blueprint", "starter"]
  },
  {
    id: "oven_kit",
    name: "오븐 청사진",
    station: "workbench",
    inputs: [{ itemPrefix: "clay", count: 4 }, { itemPrefix: "wood", count: 3 }, { itemPrefix: "coal", count: 1 }],
    output: { itemPrefix: "oven_blueprint", iconKey: "item.recipe", type: "blueprint" },
    requiredSkillsAll: [{ skillId: "architecture", minLevel: 1 }],
    xpReward: [{ skillId: "architecture", xp: 12 }],
    tags: ["blueprint"]
  },
  {
    id: "cottage_blueprint",
    name: "오두막 청사진",
    station: "workbench",
    inputs: [{ itemPrefix: "wood", count: 12 }, { itemPrefix: "clay", count: 6 }, { itemPrefix: "ore", count: 2 }],
    output: { itemPrefix: "cottage_blueprint", iconKey: "item.recipe", type: "blueprint" },
    requiredSkillsAll: [{ skillId: "architecture", minLevel: 2 }],
    xpReward: [{ skillId: "architecture", xp: 20 }],
    failLossRate: 0.15,
    tags: ["blueprint", "advanced"]
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
