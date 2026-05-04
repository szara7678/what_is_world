import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

export type HistoryEntry = {
  tick: number;
  ts: number;
  actorId?: string;
  kind: string;
  text: string;
  meta?: Record<string, unknown>;
};

const file = resolve(process.cwd(), "data/history.ndjson");

export async function recordHistory(entry: HistoryEntry): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

export async function readRecentHistory(limit = 30): Promise<HistoryEntry[]> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is HistoryEntry => entry !== null)
      .slice(-limit);
  } catch {
    return [];
  }
}
