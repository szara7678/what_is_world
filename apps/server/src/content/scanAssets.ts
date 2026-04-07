import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";

type AssetEntry = { key: string; path: string };
type AssetCatalog = {
  tileSets: AssetEntry[];
  humans: AssetEntry[];
  animals: AssetEntry[];
  items: AssetEntry[];
  objects: AssetEntry[];
};

const root = resolve(process.cwd(), "../../assets");

const toWebPath = (filePath: string): string => `/static/${relative(root, filePath).replaceAll("\\", "/")}`;

const toKey = (prefix: string, filePath: string): string => {
  const base = relative(root, filePath).replaceAll("\\", "/").replace(".png", "");
  return `${prefix}.${base.replaceAll("/", ".").replaceAll(" ", "_").toLowerCase()}`;
};

const walk = async (dir: string, acc: string[]): Promise<void> => {
  const list = await fs.readdir(dir, { withFileTypes: true });
  for (const e of list) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (e.isFile() && p.toLowerCase().endsWith(".png")) acc.push(p);
  }
};

export const scanAssets = async (): Promise<AssetCatalog> => {
  const pngs: string[] = [];
  await walk(root, pngs);

  const pick = (part: string, prefix: string): AssetEntry[] =>
    pngs
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
