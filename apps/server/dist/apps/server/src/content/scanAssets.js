import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";
const root = resolve(process.cwd(), "../../assets");
const toWebPath = (filePath) => `/static/${relative(root, filePath).replaceAll("\\", "/")}`;
const toKey = (prefix, filePath) => {
    const base = relative(root, filePath).replaceAll("\\", "/").replace(".png", "");
    return `${prefix}.${base.replaceAll("/", ".").replaceAll(" ", "_").toLowerCase()}`;
};
const walk = async (dir, acc) => {
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const e of list) {
        const p = join(dir, e.name);
        if (e.isDirectory())
            await walk(p, acc);
        else if (e.isFile() && p.toLowerCase().endsWith(".png"))
            acc.push(p);
    }
};
export const scanAssets = async () => {
    const pngs = [];
    await walk(root, pngs);
    const pick = (part, prefix) => pngs
        .filter((p) => p.replaceAll("\\", "/").includes(part))
        .map((p) => ({ key: toKey(prefix, p), path: toWebPath(p) }));
    return {
        tileSets: pick("/tile/", "tile"),
        humans: pick("/character/human/", "human"),
        animals: pick("/character/animal/", "animal"),
        items: pick("/item/", "item"),
        objects: pick("/object/", "object")
    };
};
