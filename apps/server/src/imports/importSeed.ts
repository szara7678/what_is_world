import { promises as fs } from "node:fs";
import type { WorldState } from "@wiw/shared";

export const importSeed = async (filePath: string): Promise<Partial<WorldState>> => {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<WorldState>;
  return parsed;
};
