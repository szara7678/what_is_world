import type { Actor, WorldState } from "@wiw/shared";

const id = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export const spawnActor = (
  world: WorldState,
  kind: Actor["kind"],
  name: string,
  x: number,
  y: number,
  assetKey?: string
): Actor => {
  const actor: Actor = {
    id: id(kind),
    kind,
    name,
    assetKey,
    x,
    y,
    hp: 100,
    maxHp: 100,
    mp: 20,
    maxMp: 20,
    stamina: 100,
    maxStamina: 100,
    hunger: 0,
    gold: 0,
    inventory: [],
    alive: true
  };
  world.actors[actor.id] = actor;
  world.revision += 1;
  return actor;
};

export const placeGroundItem = (
  world: WorldState,
  type: string,
  x: number,
  y: number,
  iconKey?: string
): { id: string; x: number; y: number; type: string; iconKey?: string } => {
  const item = { id: id("item"), x, y, type, iconKey };
  world.groundItems[item.id] = item;
  world.revision += 1;
  return item;
};
