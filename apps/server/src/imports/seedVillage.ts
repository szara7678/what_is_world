import type { WorldState } from "@wiw/shared";
import { createMochiVillageState } from "@wiw/world-core";

export const loadMochiVillageSeed = (): WorldState => {
  const seed = createMochiVillageState();
  return {
    ...seed,
    revision: seed.revision + 1
  };
};
