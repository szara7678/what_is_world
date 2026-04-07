import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RawEvent } from "@wiw/shared";

const file = resolve(process.cwd(), "apps/server/data/events.log");

export const appendRawEvent = async (event: RawEvent): Promise<void> => {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf-8");
};

export const readRawEvents = async (): Promise<RawEvent[]> => {
  try {
    const content = await fs.readFile(file, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RawEvent);
  } catch {
    return [];
  }
};
