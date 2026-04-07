import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { resolve } from "node:path";
import { importSeed } from "./imports/importSeed";
import { readRawEvents } from "./logging/eventLogStore";
import { loadSnapshot, saveSnapshot } from "./persistence/snapshotStore";
import { WorldRoom } from "./rooms/WorldRoom";
import { scanAssets } from "./content/scanAssets";
import type { AssetCatalog } from "./content/assetCatalog";
import { getWorld, setWorld } from "./state/worldStore";
import { placeGroundItem, spawnActor } from "./world/spawn";

const port = Number(process.env.PORT ?? 2567);
const apiPort = Number(process.env.API_PORT ?? 3001);
const fastify = Fastify();
let assetCatalog: AssetCatalog = { tileSets: [], humans: [], animals: [], items: [], objects: [] };

await fastify.register(fastifyCors, { origin: true });

await fastify.register(fastifyStatic, {
  root: resolve(process.cwd(), "../../assets"),
  prefix: "/static/"
});
assetCatalog = await scanAssets();

fastify.get("/health", async () => ({ ok: true }));
fastify.get("/world", async () => getWorld());
fastify.get("/assets/catalog", async () => assetCatalog);
fastify.post("/assets/rescan", async () => {
  assetCatalog = await scanAssets();
  return { ok: true, counts: Object.fromEntries(Object.entries(assetCatalog).map(([k, v]) => [k, v.length])) };
});
fastify.get("/assets/rescan", async () => {
  assetCatalog = await scanAssets();
  return { ok: true, counts: Object.fromEntries(Object.entries(assetCatalog).map(([k, v]) => [k, v.length])) };
});
fastify.post("/snapshot/save", async () => {
  await saveSnapshot(getWorld());
  return { ok: true };
});
fastify.get("/snapshot/save", async () => {
  await saveSnapshot(getWorld());
  return { ok: true };
});
fastify.post("/snapshot/load", async () => {
  const loaded = await loadSnapshot();
  if (loaded) setWorld(loaded);
  return { ok: Boolean(loaded) };
});
fastify.get("/snapshot/load", async () => {
  const loaded = await loadSnapshot();
  if (loaded) setWorld(loaded);
  return { ok: Boolean(loaded) };
});
fastify.get("/logs", async () => readRawEvents());
fastify.post<{ Body: { path: string } }>("/import-seed", async (req) => {
  const data = await importSeed(req.body.path);
  setWorld({ ...getWorld(), ...data });
  return { ok: true };
});
fastify.post<{ Body: { kind: "player" | "npc" | "monster"; name: string; x: number; y: number; assetKey?: string } }>(
  "/spawn/actor",
  async (req) => {
    const world = getWorld();
    const created = spawnActor(world, req.body.kind, req.body.name, req.body.x, req.body.y, req.body.assetKey);
    setWorld(world);
    return { ok: true, actor: created };
  }
);
fastify.post<{ Body: { type: string; x: number; y: number; iconKey?: string } }>("/spawn/item", async (req) => {
  const world = getWorld();
  const created = placeGroundItem(world, req.body.type, req.body.x, req.body.y, req.body.iconKey);
  setWorld(world);
  return { ok: true, item: created };
});

const gameServer = new Server({
  transport: new WebSocketTransport()
});
gameServer.define("world", WorldRoom);

fastify.listen({ port: apiPort }).then(() => {
  console.log(`api listening on http://localhost:${apiPort}`);
});

gameServer.listen(port);
console.log(`colyseus listening on ws://localhost:${port}`);
