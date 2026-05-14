import type { Actor, WorldState } from "@wiw/shared";
import { createDefaultSkills, placeGroundItemAt } from "@wiw/world-core";

const id = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export const spawnActor = (
  world: WorldState,
  kind: Actor["kind"],
  name: string,
  x: number,
  y: number,
  assetKey?: string
): Actor => {
  const status = kind === "monster"
    ? { strength: 5, dexterity: 5, constitution: 5, intelligence: 1 }
    : { strength: 5, dexterity: 5, constitution: 5, intelligence: 5 };
  const maxStamina = 50 + status.constitution * 5;
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
    stamina: maxStamina,
    maxStamina,
    hunger: 0,
    status,
    skills: createDefaultSkills(),
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
  if (placeGroundItemAt(world, item)) world.revision += 1;
  return world.groundItems[item.id] ?? item;
};
