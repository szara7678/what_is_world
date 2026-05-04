export type AssetCatalog = {
  tileSets: Array<{ key: string; path: string }>;
  humans: Array<{ key: string; path: string }>;
  animals: Array<{ key: string; path: string }>;
  items: Array<{ key: string; path: string }>;
  objects: Array<{ key: string; path: string }>;
};

export const assetCatalog: AssetCatalog = {
  tileSets: [
    { key: "pipoya.base", path: "/assets/tile/Pipoya RPG Tileset 16x16/[Base]BaseChip_pipo.png" }
  ],
  humans: [
    { key: "human.default", path: "/assets/character/human/game_RESOURCES_cha_spr/기본/남/기본남_걷기_001.png" },
    { key: "human.villager", path: "/assets/character/human/game_RESOURCES_cha_spr/기본/녀/기본녀_걷기_001.png" },
    { key: "human.baker", path: "/assets/character/human/game_RESOURCES_cha_spr/기본/녀/기본녀_걷기_001.png" },
    { key: "human.merchant", path: "/assets/character/human/game_RESOURCES_cha_spr/기본/남/기본남_걷기_001.png" },
    { key: "human.guard", path: "/assets/character/human/game_RESOURCES_cha_spr/기본/남/기본남_걷기_001.png" }
  ],
  animals: [
    { key: "animal.boar", path: "/assets/character/animal/boar/walk/boar_1_walk1.png" },
    { key: "animal.wolf", path: "/assets/character/animal/wolf/walk/wolf_1_walk1.png" },
    { key: "animal.bear", path: "/assets/character/animal/bear/walk/bear_1_walk1.png" },
    { key: "animal.deer", path: "/assets/character/animal/deer/walk/deer_1_walk1.png" },
    { key: "monster.slime.green", path: "/assets/character/monster/나이트제로/01. Slime/일반/Green Slime/Green Slime.png" },
    { key: "monster.slime.blue", path: "/assets/character/monster/나이트제로/01. Slime/일반/Blue Slime/Blue Slime.png" },
    { key: "monster.slime.yellow", path: "/assets/character/monster/나이트제로/01. Slime/일반/Yellow Slime/Yellow Slime.png" }
  ],
  items: [
    { key: "item.food.carrot", path: "/assets/item/농장생활/crop_carrot.png" },
    { key: "item.food.wheat", path: "/assets/item/농장생활/crop_wheat.png" },
    { key: "item.food.herb", path: "/assets/object/outdoor/자연/weed01_1.png" },
    { key: "item.food.berry", path: "/assets/item/농장생활/crop_strawberry.png" },
    { key: "item.food.mushroom", path: "/assets/item/농장생활/crop_mushroom.png" },
    { key: "item.food.fish", path: "/assets/item/Food/Fish.png" },
    { key: "item.material.wood", path: "/assets/item/드워프/01.Material/21202.png" },
    { key: "item.material.ore", path: "/assets/item/드워프/01.Material/21201.png" },
    { key: "item.material.clay", path: "/assets/item/드워프/01.Material/21101.png" },
    { key: "item.material.coal", path: "/assets/item/드워프/01.Material/21401.png" },
    { key: "item.tool.fishing_rod", path: "/assets/item/custom/fishing_rod.png" },
    { key: "item.food.meat", path: "/assets/item/Food/Boar.png" },
    { key: "item.food.fish", path: "/assets/item/Food/Fish.png" },
    { key: "item.material.hide", path: "/assets/item/드워프/01.Material/22301.png" },
    { key: "item.material.fang", path: "/assets/item/드워프/01.Material/22201.png" },
    { key: "item.material.tusk", path: "/assets/item/드워프/01.Material/22202.png" },
    { key: "item.material.bone", path: "/assets/item/드워프/01.Material/22203.png" },
    { key: "item.material.claw", path: "/assets/item/드워프/01.Material/22204.png" },
    { key: "item.material.gel", path: "/assets/item/드워프/01.Material/21301.png" },
    { key: "item.material.essence", path: "/assets/item/드워프/01.Material/22501.png" },
    { key: "item.recipe", path: "/assets/item/농장생활/Play_Othello.png" },
    { key: "item.food.bread", path: "/assets/item/Food/Bread.png" },
    { key: "item.potion.heal", path: "/assets/item/농장생활/sell_magic_Hpotion01.png" },
    { key: "item.potion.stamina", path: "/assets/item/농장생활/sell_magic_Spotion01.png" },
    { key: "item.tool.axe", path: "/assets/item/농장생활/Farm_ax.png" },
    { key: "item.tool.pickaxe", path: "/assets/item/농장생활/Farm_pickax.png" },
    { key: "item.weapon.sword", path: "/assets/item/드워프/03.Axe/AXLT3_01.png" },
    { key: "item.tool.bucket", path: "/assets/object/outdoor/인공물/bucket01.png" },
    { key: "item.trinket", path: "/assets/item/드워프/09.Necklace/NELT5_01.png" },
    { key: "item.trinket.charm", path: "/assets/item/드워프/09.Necklace/NELT5_01.png" },
    { key: "item.letter", path: "/assets/item/농장생활/Play_Othello.png" }
  ],
  objects: [
    { key: "object.chest", path: "/assets/object/모찌마을/cottage-front.png" },
    { key: "object.bakery", path: "/assets/object/모찌마을/bakery-front.png" },
    { key: "object.cottage", path: "/assets/object/모찌마을/cottage-front.png" },
    { key: "object.well", path: "/assets/object/모찌마을/well.png" },
    { key: "object.streetlamp", path: "/assets/object/outdoor/인공물/streetlamp01.png" },
    { key: "object.bench", path: "/assets/object/outdoor/인공물/bench01_01.png" },
    { key: "object.flowerpot", path: "/assets/object/outdoor/인공물/flowerpot01_01.png" },
    { key: "object.scarecrow", path: "/assets/object/outdoor/인공물/scarecrow01.png" },
    { key: "object.signpost", path: "/assets/object/outdoor/인공물/signpost01.png" },
    { key: "object.noticeboard", path: "/assets/object/outdoor/인공물/noticeboard01.png" },
    { key: "object.feedbox", path: "/assets/object/outdoor/인공물/feedbox01_01.png" },
    { key: "object.tree.large", path: "/assets/object/outdoor/자연/tree01_1.png" },
    { key: "object.tree.medium", path: "/assets/object/outdoor/자연/tree02_1.png" },
    { key: "object.tree.small", path: "/assets/object/outdoor/자연/tree03.png" },
    { key: "object.bush", path: "/assets/object/outdoor/자연/bush01.png" },
    { key: "object.rock", path: "/assets/object/outdoor/자연/rock01.png" }
  ]
};
