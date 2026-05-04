export const ITEM_PRICES: Record<string, number> = {
  carrot: 2,
  wheat: 1,
  herb: 3,
  wood: 1,
  ore: 4,
  "potion-heal": 20
};

export const itemTypeFromId = (itemId: string): string =>
  itemId.replace(/-\d+$/, "");
