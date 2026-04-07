import type { WorldState } from "@wiw/shared";
import { createWorldState } from "@wiw/world-core";

let world: WorldState = createWorldState();

export const getWorld = (): WorldState => world;
export const setWorld = (next: WorldState): void => {
  world = next;
};
