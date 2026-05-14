export type AssetCatalog = {
  tileSets: Array<{ key: string; path: string }>;
  humans: Array<{ key: string; path: string }>;
  animals: Array<{ key: string; path: string }>;
  items: Array<{ key: string; path: string }>;
  objects: Array<{ key: string; path: string }>;
};

export const assetCatalog: AssetCatalog = {
  tileSets: [
    { key: "pipoya.base", path: "/static/tile/Pipoya RPG Tileset 16x16/[Base]BaseChip_pipo.png" }
  ],
  humans: [
    { key: "human.default", path: "/static/character/human/game_RESOURCES_cha_spr/기본/남/기본남_걷기_001.png" },
    { key: "human.villager", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin002.png" },
    { key: "human.farmer", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin003.png" },
    { key: "human.baker", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin024.png" },
    { key: "human.merchant", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin001.png" },
    { key: "human.guard", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin012.png" },
    { key: "human.smith", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin006.png" },
    { key: "human.alchemist", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin009.png" },
    { key: "human.traveler", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin017.png" },
    { key: "human.miner", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin020.png" },
    { key: "human.healer", path: "/static/character/PIPOYA FREE RPG Character Sprites NEKONIN/pipo-nekonin028.png" }
  ],
  animals: [
    { key: "animal.boar", path: "/static/character/animal/boar/walk/boar_1_walk1.png" },
    { key: "animal.wolf", path: "/static/character/animal/wolf/walk/wolf_1_walk1.png" },
    { key: "animal.bear", path: "/static/character/animal/bear/walk/bear_1_walk1.png" },
    { key: "animal.deer", path: "/static/character/animal/deer/walk/deer_1_walk1.png" },
    { key: "monster.slime.green", path: "/static/character/monster/나이트제로/01. Slime/일반/Green Slime/Green Slime.png" },
    { key: "monster.slime.blue", path: "/static/character/monster/나이트제로/01. Slime/일반/Blue Slime/Blue Slime.png" },
    { key: "monster.slime.yellow", path: "/static/character/monster/나이트제로/01. Slime/일반/Yellow Slime/Yellow Slime.png" },
    { key: "monster.spirit", path: "/static/character/monster/나이트제로/04. Magician/일반/Ghost/04.Ghost.png" },
    { key: "monster.skeleton", path: "/static/character/monster/나이트제로/03. Skeleton/일반/Skeleton/03.Skeleton.png" },
    { key: "monster.skeleton_warrior", path: "/static/character/monster/나이트제로/03. Skeleton/일반/Skeleton Warrior/03.Skeleton Warrior.png" },
    { key: "monster.skeleton_archer", path: "/static/character/monster/나이트제로/03. Skeleton/일반/Skeleton Archer/03.Skeleton Archer.png" },
    { key: "monster.naga", path: "/static/character/monster/나이트제로/08. Naga/일반/Naga/08.Naga.png" },
    { key: "monster.troll", path: "/static/character/monster/나이트제로/09. Giant/일반/Troll/09.Troll.png" }
  ],
  items: [
    { key: "item.food.carrot", path: "/static/item/농장생활/crop_carrot.png" },
    { key: "item.food.wheat", path: "/static/item/농장생활/crop_wheat.png" },
    // 2026-05-12: seed 전용 텍스처 없음. crop alias 유지하되 catalog key 로 구분.
    { key: "item.material.carrot_seed", path: "/static/item/농장생활/crop_carrot.png" },
    { key: "item.material.wheat_seed",  path: "/static/item/농장생활/crop_wheat.png" },
    { key: "item.food.herb", path: "/static/object/outdoor/자연/weed01_1.png" },
    { key: "item.food.berry", path: "/static/item/농장생활/crop_strawberry.png" },
    { key: "item.food.mushroom", path: "/static/item/농장생활/crop_mushroom.png" },
    { key: "item.food.fish", path: "/static/item/Food/Fish.png" },
    // (legacy) wood 매핑 — 위에서 custom 으로 override. 이 줄은 보존 목적상 남김.
    { key: "item.material.ore", path: "/static/item/드워프/01.Material/21201.png" },
    { key: "item.material.clay", path: "/static/item/드워프/01.Material/21101.png" },
    { key: "item.material.coal", path: "/static/item/드워프/01.Material/21401.png" },
    { key: "item.tool.fishing_rod", path: "/static/item/custom/fishing_rod.png" },
    { key: "item.food.meat", path: "/static/item/Food/Boar.png" },
    { key: "item.material.hide", path: "/static/item/농장생활/livestock_cow_cowhide.png" },
    { key: "item.material.fang", path: "/static/item/농장생활/monster_wolf_teeth.png" },
    { key: "item.material.tusk", path: "/static/item/custom/boar_tusk.png" },
    { key: "item.material.bone", path: "/static/item/custom/bone.png" },
    { key: "item.material.claw", path: "/static/item/custom/claw.png" },
    { key: "item.material.gel", path: "/static/item/드워프/01.Material/21301.png" },
    { key: "item.material.essence", path: "/static/item/드워프/01.Material/22501.png" },
    { key: "item.recipe", path: "/static/item/농장생활/sell_magic_scroll01.png" },
    { key: "item.food.bread", path: "/static/item/Food/Bread.png" },
    // 사용자 결정: 새로 그린 픽셀 아트 (assets/item/custom/) 사용. Food/Apple.png 등은 이상함.
    { key: "item.food.apple", path: "/static/item/custom/apple.png" },
    { key: "item.food.pineapple", path: "/static/item/custom/pineapple.png" },
    { key: "item.food.cheese", path: "/static/item/Food/Cheese.png" },
    { key: "item.food.eggs", path: "/static/item/Food/Eggs.png" },
    { key: "item.food.cooked_eggs", path: "/static/item/Food/PickledEggs.png" },
    { key: "item.food.chicken_leg", path: "/static/item/Food/ChickenLeg.png" },
    { key: "item.food.steak", path: "/static/item/Food/Steak.png" },
    { key: "item.food.honey", path: "/static/item/Food/Honey.png" },
    { key: "item.food.tomato", path: "/static/item/Food/Tomato.png" },
    { key: "item.food.potato", path: "/static/item/Food/Potato.png" },
    { key: "item.food.onion", path: "/static/item/Food/Onion.png" },
    { key: "item.food.cherry", path: "/static/item/Food/Cherry.png" },
    { key: "item.food.peach", path: "/static/item/Food/Peach.png" },
    { key: "item.food.sushi", path: "/static/item/Food/Sushi.png" },
    { key: "item.food.shrimp", path: "/static/item/Food/Shrimp.png" },
    { key: "item.food.sardines", path: "/static/item/Food/Sardines.png" },
    { key: "item.food.sashimi", path: "/static/item/Food/Sashimi.png" },
    // 2026-05-12: 사용자 피드백 — log_wood.png 32x32 가 100% 불투명. log_good.png 1024x1024 (86.6% 투명배경) 로 되돌림. client displayScale 로 작게 표시 OK.
    { key: "item.material.wood", path: "/static/item/custom/log_good.png" },
    { key: "item.potion.heal", path: "/static/item/농장생활/sell_magic_Hpotion01.png" },
    { key: "item.potion.stamina", path: "/static/item/농장생활/sell_magic_Spotion01.png" },
    { key: "item.tool.axe", path: "/static/item/농장생활/Farm_ax.png" },
    { key: "item.tool.pickaxe", path: "/static/item/농장생활/Farm_pickax.png" },
    { key: "item.tool.leather_armor", path: "/static/item/드워프/06.Armor/ARLT2_01.png" },
    { key: "item.weapon.sword", path: "/static/item/나이트제로/Weapon/Sword/3.Long sword.png" },
    { key: "item.weapon.bone_dagger", path: "/static/item/나이트제로/Weapon/Sword/1.Dagger.png" },
    { key: "item.tool.bucket", path: "/static/object/outdoor/인공물/bucket01.png" },
    { key: "item.trinket", path: "/static/item/드워프/09.Necklace/NELT5_01.png" },
    { key: "item.trinket.charm", path: "/static/item/드워프/09.Necklace/NELT5_01.png" },
    { key: "item.letter", path: "/static/item/농장생활/sell_magic_scroll02.png" }
  ],
  objects: [
    { key: "object.chest", path: "/static/object/custom/wooden_chest.png" },
    { key: "object.bakery", path: "/static/object/모찌마을/bakery-front.png" },
    { key: "object.cottage", path: "/static/object/모찌마을/cottage-front.png" },
    { key: "object.well", path: "/static/object/모찌마을/well.png" },
    { key: "object.streetlamp", path: "/static/object/outdoor/인공물/streetlamp01.png" },
    { key: "object.streetlamp.variant", path: "/static/object/outdoor/인공물/streetlamp02.png" },
    { key: "object.bench", path: "/static/object/outdoor/인공물/bench01_01.png" },
    { key: "object.bench.variant", path: "/static/object/outdoor/인공물/bench02_01.png" },
    { key: "object.flowerpot", path: "/static/object/outdoor/인공물/flowerpot01_01.png" },
    { key: "object.flowerpot.02", path: "/static/object/outdoor/인공물/flowerpot01_02.png" },
    { key: "object.flowerpot.03", path: "/static/object/outdoor/인공물/flowerpot01_03.png" },
    { key: "object.flowerpot.04", path: "/static/object/outdoor/인공물/flowerpot01_04.png" },
    { key: "object.flowerpot.05", path: "/static/object/outdoor/인공물/flowerpot01_05.png" },
    { key: "object.scarecrow", path: "/static/object/outdoor/인공물/scarecrow01.png" },
    { key: "object.scarecrow.variant", path: "/static/object/outdoor/인공물/scarecrow02.png" },
    { key: "object.signpost", path: "/static/object/outdoor/인공물/signpost01.png" },
    { key: "object.signpost.variant", path: "/static/object/outdoor/인공물/signpost02.png" },
    { key: "object.noticeboard", path: "/static/object/outdoor/인공물/noticeboard01.png" },
    { key: "object.feedbox", path: "/static/object/outdoor/인공물/feedbox01_01.png" },
    { key: "object.bucket.variant", path: "/static/object/outdoor/인공물/bucket02.png" },
    { key: "object.letterbox", path: "/static/object/outdoor/인공물/letterbox01.png" },
    { key: "object.grave", path: "/static/object/outdoor/인공물/grave01.png" },
    // workbench 전용 png — 사용자 직접 추가 (2026-05-08).
    { key: "object.workbench", path: "/static/object/스테이션/wooden_table_pixel_art.png" },
    // forge anvil 전용 png — 사용자 직접 추가 (2026-05-08).
    { key: "object.forge", path: "/static/object/스테이션/anvil_pixel_art_v2.png" },
    { key: "object.tree.large", path: "/static/object/outdoor/자연/tree01_1.png" },
    { key: "object.tree.medium", path: "/static/object/outdoor/자연/tree02_1.png" },
    { key: "object.tree.small", path: "/static/object/outdoor/자연/tree03.png" },
    // 과일나무: 새 픽셀 아트. 사용자 "나무 안 보임" 처방.
    { key: "object.tree.apple", path: "/static/item/custom/tree_apple.png" },
    { key: "object.tree.pineapple", path: "/static/item/custom/tree_pineapple.png" },
    { key: "object.tree.cut", path: "/static/object/outdoor/자연/cut tree01.png" },
    { key: "object.bush", path: "/static/object/outdoor/자연/bush01.png" },
    { key: "object.bush.01_2", path: "/static/object/outdoor/자연/bush01_2.png" },
    { key: "object.bush.01_3", path: "/static/object/outdoor/자연/bush01_3.png" },
    { key: "object.bush.01_4", path: "/static/object/outdoor/자연/bush01_4.png" },
    { key: "object.bush.01_5", path: "/static/object/outdoor/자연/bush01_5.png" },
    { key: "object.bush.01_6", path: "/static/object/outdoor/자연/bush01_6.png" },
    { key: "object.bush.01_7", path: "/static/object/outdoor/자연/bush01_7.png" },
    { key: "object.bush.02_1", path: "/static/object/outdoor/자연/bush02_1.png" },
    { key: "object.rock", path: "/static/object/outdoor/자연/rock01.png" }
  ]
};
