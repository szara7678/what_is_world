import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
const file = resolve(process.cwd(), "apps/server/data/snapshot.json");
export const saveSnapshot = async (world) => {
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(world, null, 2), "utf-8");
};
export const loadSnapshot = async () => {
    try {
        const content = await fs.readFile(file, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return null;
    }
};
