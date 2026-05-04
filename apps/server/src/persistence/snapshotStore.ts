import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDefaultWorldContext, migrateInventoryFromStringArray, type WorldState } from "@wiw/shared";
import { createDefaultSkills } from "@wiw/world-core";

const file = resolve(process.cwd(), "data/snapshot.json");
const legacyWorldFile = resolve(process.cwd(), "data/world.json");
const snapshotsDir = resolve(process.cwd(), "data/snapshots");

const withSnapshotDefaults = (world: WorldState): WorldState => {
  for (const actor of Object.values(world.actors ?? {})) {
    actor.skills = mergeDefaultSkills(actor.skills);
    // 인벤 마이그레이션 — 구버전 string[] → InventorySlot[]. 신버전이면 통과.
    actor.inventory = migrateInventoryFromStringArray(actor.inventory as unknown);
  }
  return {
    ...world,
    places: world.places ?? {},
    context: world.context ?? createDefaultWorldContext(world.tick ?? 0)
  };
};

const mergeDefaultSkills = (skills = createDefaultSkills()) => {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return createDefaultSkills().map((skill) => ({ ...skill, ...byId.get(skill.id) }));
};

export const saveSnapshot = async (world: WorldState): Promise<void> => {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(world, null, 2), "utf-8");
};

export const loadSnapshot = async (): Promise<WorldState | null> => {
  const candidates = [file, legacyWorldFile];
  try {
    const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
    const snapshots = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => resolve(snapshotsDir, entry.name));
    candidates.push(...snapshots.sort().reverse());
  } catch {
    // Optional compatibility path.
  }

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      return withSnapshotDefaults(JSON.parse(content) as WorldState);
    } catch {
      // Try the next compatible snapshot path.
    }
  }
  return null;
};

export const loadSnapshotFrom = async (path: string): Promise<WorldState | null> => {
  try {
    const content = await fs.readFile(path, "utf-8");
    return withSnapshotDefaults(JSON.parse(content) as WorldState);
  } catch {
    return null;
  }
};
