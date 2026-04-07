import { createWorldState } from "@wiw/world-core";
let world = createWorldState();
export const getWorld = () => world;
export const setWorld = (next) => {
    world = next;
};
