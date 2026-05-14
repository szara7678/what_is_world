import type { GroundItem, WorldState } from "@wiw/shared";

type XY = { x: number; y: number };

const WATER_PLACE_KINDS = new Set(["pond", "well", "lake", "river", "water"]);
const WATER_TAGS = new Set(["water", "lake", "river"]);

const inBounds = (world: WorldState, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < world.map.width && y < world.map.height;

const isWaterPlaceAt = (world: WorldState, x: number, y: number): boolean =>
  Object.values(world.places ?? {}).some((place) =>
    x >= place.x &&
    x < place.x + place.width &&
    y >= place.y &&
    y < place.y + place.height &&
    (WATER_PLACE_KINDS.has(String(place.kind)) || (place.tags ?? []).some((tag) => WATER_TAGS.has(tag)))
  );

export const canPlaceItemAt = (world: WorldState, x: number, y: number): boolean =>
  inBounds(world, x, y) &&
  world.map.collision[y]?.[x] !== 1 &&
  !isWaterPlaceAt(world, x, y);

export const nearestItemPlacement = (
  world: WorldState,
  x: number,
  y: number,
  maxRadius = 3
): XY | null => {
  const start = { x: Math.floor(x), y: Math.floor(y) };
  if (canPlaceItemAt(world, start.x, start.y)) return start;

  const queue: Array<XY & { dist: number }> = [{ ...start, dist: 0 }];
  const seen = new Set<string>([`${start.x},${start.y}`]);
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 }
  ];

  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i];
    if (node.dist >= maxRadius) continue;
    for (const d of dirs) {
      const nx = node.x + d.x;
      const ny = node.y + d.y;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!inBounds(world, nx, ny)) continue;
      if (canPlaceItemAt(world, nx, ny)) return { x: nx, y: ny };
      queue.push({ x: nx, y: ny, dist: node.dist + 1 });
    }
  }
  return null;
};

export const placeGroundItemAt = (
  world: WorldState,
  item: GroundItem,
  maxRadius = 3
): boolean => {
  const xy = nearestItemPlacement(world, item.x, item.y, maxRadius);
  if (!xy) return false;
  world.groundItems[item.id] = { ...item, x: xy.x, y: xy.y };
  return true;
};

export const relocateGroundItems = (world: WorldState, maxRadius = 3): void => {
  for (const [id, item] of Object.entries(world.groundItems)) {
    const xy = nearestItemPlacement(world, item.x, item.y, maxRadius);
    if (xy) {
      world.groundItems[id] = { ...item, x: xy.x, y: xy.y };
    } else {
      delete world.groundItems[id];
    }
  }
};
