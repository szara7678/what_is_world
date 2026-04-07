import { promises as fs } from "node:fs";
export const importSeed = async (filePath) => {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed;
};
