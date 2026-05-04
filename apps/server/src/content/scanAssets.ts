import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assetCatalog as manualCatalog } from "./assetCatalog";

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

const manualToWebPath = (path: string): string => path.replace(/^\/assets\//, "/static/");

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

const mergeManual = (auto: AssetEntry[], manual: AssetEntry[]): AssetEntry[] => {
  const seen = new Set<string>();
  const out: AssetEntry[] = [];
  for (const m of manual) {
    if (seen.has(m.key)) continue;
    seen.add(m.key);
    out.push({ key: m.key, path: manualToWebPath(m.path) });
  }
  for (const a of auto) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    out.push(a);
  }
  return out;
};

export const scanAssets = async (): Promise<AssetCatalog> => {
  const pngs: string[] = [];
  await walk(root, pngs);

  const pick = (part: string, prefix: string): AssetEntry[] =>
    pngs
      .filter((p) => p.replaceAll("\\", "/").includes(part))
      .map((p) => ({ key: toKey(prefix, p), path: toWebPath(p) }));

  return {
    tileSets: mergeManual(pick("/tile/", "tile"), manualCatalog.tileSets),
    humans: mergeManual(pick("/character/human/", "human"), manualCatalog.humans),
    animals: mergeManual(pick("/character/animal/", "animal"), manualCatalog.animals),
    items: mergeManual(pick("/item/", "item"), manualCatalog.items),
    objects: mergeManual(pick("/object/", "object"), manualCatalog.objects)
  };
};
