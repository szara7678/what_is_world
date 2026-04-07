export type AssetCatalog = {
  tileSets: Array<{ key: string; path: string }>;
  humans: Array<{ key: string; path: string }>;
  animals: Array<{ key: string; path: string }>;
  items: Array<{ key: string; path: string }>;
  objects: Array<{ key: string; path: string }>;
};

export const assetCatalog: AssetCatalog = {
  tileSets: [{ key: "pipoya.base", path: "/assets/tile/Pipoya RPG Tileset 16x16/[Base]BaseChip_pipo.png" }],
  humans: [{ key: "human.default", path: "/assets/character/human/default.png" }],
  animals: [{ key: "animal.boar", path: "/assets/character/animal/boar.png" }],
  items: [{ key: "item.food.bread", path: "/assets/item/Food/Bread.png" }],
  objects: [{ key: "object.chest", path: "/assets/object/chest.png" }]
};
