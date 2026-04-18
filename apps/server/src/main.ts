import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { resolve } from "node:path";
import { importSeed } from "./imports/importSeed";
import { eventBus, readRecentEvents, toNarrative } from "./logging/eventLogStore";
import { loadSnapshot, saveSnapshot } from "./persistence/snapshotStore";
import {
  listSouls, listThoughts, readSoul, writeSoul,
  readThought, writeThought, readObservations, appendObservation,
  readAllRelationships
} from "./persistence/soulStore";
import { WorldRoom } from "./rooms/WorldRoom";
import { scanAssets } from "./content/scanAssets";
import type { AssetCatalog } from "./content/assetCatalog";
import { getWorld, setWorld } from "./state/worldStore";
import { placeGroundItem, spawnActor } from "./world/spawn";
import {
  loadBrainConfig, getBrainConfig, updateBrainConfig,
  publicBrainConfig, MODEL_PRESETS
} from "./config/brainConfig";
import { startBrainLoop } from "./brain/loop";
import type { ActionRequest, NarrativeEvent, RawEvent, Soul, Thought } from "@wiw/shared";
import { dispatchAction } from "@wiw/world-core";

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
await loadBrainConfig();

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

fastify.get<{ Querystring: { limit?: string } }>("/events", async (req) => {
  const limit = Number(req.query.limit ?? 200);
  const raws = await readRecentEvents(limit);
  const narratives: NarrativeEvent[] = raws.map(toNarrative).filter((n): n is NarrativeEvent => Boolean(n));
  return { raws, narratives };
});

fastify.get("/events/tail", async (req, reply) => {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.write(": hello\n\n");

  const onNarrative = (n: NarrativeEvent) => {
    reply.raw.write(`event: narrative\ndata: ${JSON.stringify(n)}\n\n`);
  };
  const onRaw = (e: RawEvent) => {
    reply.raw.write(`event: raw\ndata: ${JSON.stringify(e)}\n\n`);
  };
  eventBus.on("narrative", onNarrative);
  eventBus.on("raw", onRaw);

  const heartbeat = setInterval(() => {
    try { reply.raw.write(`: hb\n\n`); } catch {}
  }, 15000);

  req.raw.on("close", () => {
    clearInterval(heartbeat);
    eventBus.off("narrative", onNarrative);
    eventBus.off("raw", onRaw);
  });
  // keep open
  return reply;
});

// ── Config ────────────────────────────────────────────────────
fastify.get("/config/brain", async () => ({
  config: publicBrainConfig(),
  models: MODEL_PRESETS
}));

fastify.post<{ Body: Partial<import("./config/brainConfig").BrainConfig> } >("/config/brain", async (req) => {
  const patch = req.body ?? {};
  const allowed: Array<keyof import("./config/brainConfig").BrainConfig> = [
    "provider", "apiKey", "model", "baseUrl", "tickIntervalMs", "maxActorsPerTick", "enabled"
  ];
  const sanitized: Partial<import("./config/brainConfig").BrainConfig> = {};
  for (const k of allowed) {
    if (k in patch) (sanitized as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
  }
  const next = await updateBrainConfig(sanitized);
  return { ok: true, config: publicBrainConfig(next) };
});

// ── Souls / Thoughts / Observations ───────────────────────────
fastify.get("/souls", async () => ({ souls: await listSouls() }));
fastify.get<{ Params: { id: string } }>("/souls/:id", async (req) => {
  const world = getWorld();
  const actor = world.actors[req.params.id];
  return { soul: await readSoul(req.params.id, actor?.name ?? req.params.id) };
});
fastify.post<{ Params: { id: string }, Body: Partial<Soul> }>("/souls/:id", async (req) => {
  const world = getWorld();
  const actor = world.actors[req.params.id];
  const current = await readSoul(req.params.id, actor?.name ?? req.params.id);
  const merged: Soul = { ...current, ...req.body, actorId: req.params.id, updatedAt: Date.now() };
  await writeSoul(merged);
  return { ok: true, soul: merged };
});

fastify.get("/thoughts", async () => ({ thoughts: await listThoughts() }));
fastify.get<{ Params: { id: string } }>("/thoughts/:id", async (req) => {
  const world = getWorld();
  return { thought: await readThought(req.params.id, world.tick) };
});
fastify.post<{ Params: { id: string }, Body: Partial<Thought> }>("/thoughts/:id", async (req) => {
  const world = getWorld();
  const current = await readThought(req.params.id, world.tick);
  const merged: Thought = { ...current, ...req.body, actorId: req.params.id, updatedAtMs: Date.now() };
  await writeThought(merged);
  return { ok: true, thought: merged };
});

fastify.get<{ Params: { id: string } }>("/observations/:id", async (req) => ({
  observations: await readObservations(req.params.id, 100)
}));
fastify.post<{ Params: { id: string }, Body: { text: string; tags?: string[]; importance?: number; kind?: "perceive"|"action"|"dialogue"|"reflection"|"memory" } }>(
  "/observations/:id",
  async (req) => {
    const world = getWorld();
    const obs = {
      id: `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: req.params.id,
      tick: world.tick,
      timestamp: Date.now(),
      kind: req.body.kind ?? "perceive",
      text: req.body.text,
      tags: req.body.tags ?? [],
      importance: req.body.importance ?? 0.5
    };
    await appendObservation(obs);
    return { ok: true, observation: obs };
  }
);

fastify.get("/relationships", async () => ({ relationships: await readAllRelationships() }));

// ── Brain action submit (used by brain service) ───────────────
fastify.post<{ Body: { actorId: string; action: { type: string; [k: string]: unknown }; thought?: Partial<Thought> } }>(
  "/brain/act",
  async (req) => {
    const world = getWorld();
    const { actorId, action, thought } = req.body;
    const result = dispatchAction(world, { actorId, action: action as ActionRequest["action"] });
    setWorld(world);
    const { appendRawEvent } = await import("./logging/eventLogStore");
    await appendRawEvent({
      tick: world.tick,
      timestamp: Date.now(),
      actorId,
      category: "brain",
      type: action.type,
      result: result.ok ? "success" : "failed",
      reason: result.ok ? undefined : result.message,
      payload: { action, thought }
    });
    if (thought) {
      const merged: Thought = {
        ...(await readThought(actorId, world.tick)),
        ...thought,
        actorId,
        updatedAtTick: world.tick,
        updatedAtMs: Date.now()
      };
      await writeThought(merged);
    }
    return { ok: result.ok, message: result.ok ? undefined : result.message };
  }
);

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

const unifiedPort = Number(process.env.UNIFIED_PORT ?? apiPort);
const serveUnified = process.env.UNIFIED !== "0";

if (serveUnified) {
  // Serve built client + share a single HTTP server with Colyseus for WS upgrades.
  const clientDist = process.env.CLIENT_DIST
    ? resolve(process.env.CLIENT_DIST)
    : resolve(process.cwd(), "../client/dist");
  const { readFile } = await import("node:fs/promises");
  let indexHtml: string | null = null;
  try {
    indexHtml = await readFile(`${clientDist}/index.html`, "utf-8");
    console.log(`[server] client dist loaded from ${clientDist}`);
  } catch (e) {
    console.warn("[server] client dist index.html not found:", e);
  }
  if (indexHtml) {
    const finalHtml = indexHtml;
    // Serve asset files directly from dist/assets
    fastify.get<{ Params: { "*": string } }>("/assets/*", async (req, reply) => {
      const name = (req.params as { "*": string })["*"];
      try {
        const buf = await readFile(`${clientDist}/assets/${name}`);
        const mt = name.endsWith(".js") ? "application/javascript"
                 : name.endsWith(".css") ? "text/css"
                 : name.endsWith(".svg") ? "image/svg+xml"
                 : name.endsWith(".png") ? "image/png"
                 : "application/octet-stream";
        reply.type(mt).send(buf);
      } catch {
        reply.code(404).send({ error: "not_found" });
      }
    });
    fastify.get("/", async (_req, reply) => { reply.type("text/html").send(finalHtml); });
    fastify.setNotFoundHandler((req, reply) => {
      const url = req.url.split("?")[0];
      const apiPrefixes = ["/health", "/world", "/config", "/souls", "/thoughts",
        "/observations", "/events", "/spawn", "/brain", "/snapshot", "/relationships",
        "/import-seed", "/static", "/assets"];
      if (apiPrefixes.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.type("text/html").send(finalHtml);
    });
  }
  await fastify.listen({ host: "0.0.0.0", port: unifiedPort });
  console.log(`api + client listening on http://0.0.0.0:${unifiedPort}`);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: fastify.server })
  });
  gameServer.define("world", WorldRoom);
  console.log(`colyseus attached to same port :${unifiedPort}`);
} else {
  await fastify.listen({ host: "0.0.0.0", port: apiPort });
  console.log(`api listening on http://0.0.0.0:${apiPort}`);
  const gameServer = new Server({
    transport: new WebSocketTransport()
  });
  gameServer.define("world", WorldRoom);
  gameServer.listen(port);
  console.log(`colyseus listening on ws://0.0.0.0:${port}`);
}

startBrainLoop();
console.log(`brain loop ready (enabled=${getBrainConfig().enabled}, provider=${getBrainConfig().provider})`);
