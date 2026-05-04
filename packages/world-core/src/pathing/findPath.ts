import type { WorldState } from "@wiw/shared";

export type XY = { x: number; y: number };
export type PathStep = { dx: number; dy: number };

const dirs: PathStep[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 }
];

const keyOf = (x: number, y: number): string => `${x},${y}`;

const inBounds = (world: WorldState, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < world.map.width && y < world.map.height;

const actorAt = (world: WorldState, x: number, y: number, exceptActorId?: string): boolean =>
  Object.values(world.actors).some((a) =>
    a.alive && a.id !== exceptActorId && a.x === x && a.y === y
  );

const passable = (world: WorldState, x: number, y: number, exceptActorId?: string): boolean =>
  inBounds(world, x, y) &&
  world.map.collision[y]?.[x] !== 1 &&
  !actorAt(world, x, y, exceptActorId);

export const findPath = (
  world: WorldState,
  fromXY: XY,
  toXY: XY,
  maxSteps = 60
): PathStep[] | null => {
  const start = { x: Math.trunc(fromXY.x), y: Math.trunc(fromXY.y) };
  const target = { x: Math.trunc(toXY.x), y: Math.trunc(toXY.y) };
  if (!inBounds(world, start.x, start.y) || !inBounds(world, target.x, target.y)) return null;

  const startActor = Object.values(world.actors)
    .find((a) => a.alive && a.x === start.x && a.y === start.y);
  const exceptActorId = startActor?.id;
  const targetHasActor = actorAt(world, target.x, target.y, exceptActorId);
  const goals = new Set<string>();

  if (targetHasActor) {
    for (const d of dirs) {
      const gx = target.x + d.dx;
      const gy = target.y + d.dy;
      if (passable(world, gx, gy, exceptActorId)) goals.add(keyOf(gx, gy));
    }
  } else if (passable(world, target.x, target.y, exceptActorId)) {
    goals.add(keyOf(target.x, target.y));
  }

  if (goals.size === 0) return null;
  if (goals.has(keyOf(start.x, start.y))) return [];

  const queue: Array<{ x: number; y: number; path: PathStep[] }> = [{ ...start, path: [] }];
  const seen = new Set<string>([keyOf(start.x, start.y)]);

  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i];
    if (node.path.length >= maxSteps) continue;

    for (const d of dirs) {
      const nx = node.x + d.dx;
      const ny = node.y + d.dy;
      const key = keyOf(nx, ny);
      if (seen.has(key) || !passable(world, nx, ny, exceptActorId)) continue;

      const path = [...node.path, d];
      if (goals.has(key)) return path;

      seen.add(key);
      queue.push({ x: nx, y: ny, path });
    }
  }

  return null;
};
