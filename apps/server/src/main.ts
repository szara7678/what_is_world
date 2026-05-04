import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { importSeed } from "./imports/importSeed";
import { loadMochiVillageSeed } from "./imports/seedVillage";
import { eventBus, readRecentEvents, toNarrative } from "./logging/eventLogStore";
import { readRecentKpiSnapshots, startKpiSnapshotLoop } from "./logging/kpiStore";
import { readMetrics, rollupMetrics, tradeFlowKpi, skillXpKpi, affordanceKpi, type RollupKey } from "./logging/metricsStore";
import { readRecentHistory, recordHistory } from "./logging/historyLogStore";
import { loadSnapshot, saveSnapshot } from "./persistence/snapshotStore";
import {
  listSouls, listThoughts, readSoul, writeSoul,
  readThought, writeThought, readObservations, appendObservation,
  readAllRelationships, soulBus
} from "./persistence/soulStore";
import { WorldRoom } from "./rooms/WorldRoom";
import { scanAssets } from "./content/scanAssets";
import type { AssetCatalog } from "./content/assetCatalog";
import { getWorld, setWorld } from "./state/worldStore";
import { placeGroundItem, spawnActor } from "./world/spawn";
import { ensureChroniclePages, listChroniclePages, maybeEnsureOnTick } from "./chronicle/chronicleService";
import {
  loadBrainConfig, getBrainConfig, updateBrainConfig,
  publicBrainConfig, MODEL_PRESETS
} from "./config/brainConfig";
import { startBrainLoop } from "./brain/loop";
import { startReflectionLoop } from "./brain/reflect";
import type { ActionRequest, NarrativeEvent, Observation, RawEvent, Soul, Thought } from "@wiw/shared";
import { dispatchAction, tickWorld } from "@wiw/world-core";

const port = Number(process.env.PORT ?? 2568);
const apiPort = Number(process.env.API_PORT ?? 3011);
const fastify = Fastify();
let assetCatalog: AssetCatalog = { tileSets: [], humans: [], animals: [], items: [], objects: [] };
const villageSeedMarker = resolve(process.cwd(), "data/.has-seeded-village");
let serverTickTimer: NodeJS.Timeout | null = null;
let knownAlive = new Map<string, boolean>();
let knownThreatPairs = new Set<string>();

const writeVillageSeedMarker = async (): Promise<void> => {
  await fs.mkdir(dirname(villageSeedMarker), { recursive: true });
  await fs.writeFile(villageSeedMarker, `${new Date().toISOString()}\n`, "utf-8");
};

const initializeWorld = async (): Promise<void> => {
  try {
    await fs.access(villageSeedMarker);
    const loaded = await loadSnapshot();
    if (loaded) setWorld(loaded);
    return;
  } catch {
    const seeded = loadMochiVillageSeed();
    setWorld(seeded);
    await saveSnapshot(seeded);
    await writeVillageSeedMarker();
  }
};

let snapshotSaveCounter = 0;
const SNAPSHOT_SAVE_INTERVAL_TICKS = 50; // 100ms × 50 = 5초마다 snapshot 저장 (debounce)

function startServerTick(): void {
  if (serverTickTimer) return;
  knownAlive = new Map(Object.values(getWorld().actors).map((actor) => [actor.id, actor.alive]));
  knownThreatPairs = new Set();

  serverTickTimer = setInterval(() => {
    const world = getWorld();
    const beforeTime = world.timeOfDay;
    tickWorld(world);
    setWorld(world);

    // auto-save snapshot: 5초마다. server restart 후에도 actor skills/inventory/hp 유지
    snapshotSaveCounter += 1;
    if (snapshotSaveCounter >= SNAPSHOT_SAVE_INTERVAL_TICKS) {
      snapshotSaveCounter = 0;
      void saveSnapshot(getWorld()).catch((e) => console.warn("[snapshot] save error:", e));
    }

    if (beforeTime > world.timeOfDay) {
      void recordHistory({
        tick: world.tick,
        ts: Date.now(),
        kind: "day.rollover",
        text: `새 하루가 시작되었어요. tick ${world.tick}`,
        meta: { previousTimeOfDay: beforeTime, timeOfDay: world.timeOfDay }
      });
    }

    for (const actor of Object.values(world.actors)) {
      const wasAlive = knownAlive.get(actor.id);
      if (wasAlive === true && !actor.alive) {
        void recordHistory({
          tick: world.tick,
          ts: Date.now(),
          actorId: actor.id,
          kind: "actor.death",
          text: `${actor.name} 이(가) 쓰러졌어요.`,
          meta: { actorId: actor.id }
        });
      }
      knownAlive.set(actor.id, actor.alive);
    }

    const currentThreatPairs = new Set<string>();
    const villageActors = Object.values(world.actors).filter((actor) => actor.alive && (actor.kind === "npc" || actor.kind === "player"));
    const monsters = Object.values(world.actors).filter((actor) => actor.alive && actor.kind === "monster");
    for (const monster of monsters) {
      for (const victim of villageActors) {
        const adjacent = Math.max(Math.abs(monster.x - victim.x), Math.abs(monster.y - victim.y)) <= 1;
        if (!adjacent) continue;
        const key = `${monster.id}:${victim.id}`;
        currentThreatPairs.add(key);
        if (!knownThreatPairs.has(key)) {
          void recordHistory({
            tick: world.tick,
            ts: Date.now(),
            actorId: victim.id,
            kind: "threat.detected",
            text: `${monster.name}이(가) ${victim.name}에게 다가갔어요.`,
            meta: { monsterId: monster.id, victimId: victim.id }
          });
        }
      }
    }
    knownThreatPairs = currentThreatPairs;

    // chronicle: day boundary 도달 시 비동기 페이지 생성
    void maybeEnsureOnTick(world.tick);
  }, 100);
}

await fastify.register(fastifyCors, { origin: true });

await fastify.register(fastifyStatic, {
  root: resolve(process.cwd(), "../../assets"),
  prefix: "/static/"
});
assetCatalog = await scanAssets();
await loadBrainConfig();
await initializeWorld();
startServerTick();
startKpiSnapshotLoop();

fastify.get("/health", async () => ({ ok: true }));
fastify.get("/world", async () => getWorld());
fastify.get("/places", async () => Object.values(getWorld().places ?? {}));
fastify.get("/assets/catalog", async () => assetCatalog);
fastify.get("/chronicle/pages", async () => ({ pages: await listChroniclePages() }));
fastify.post("/chronicle/regenerate", async () => {
  const tick = getWorld().tick;
  const pages = await ensureChroniclePages(tick);
  return { ok: true, tick, pages: pages.length };
});

fastify.get<{ Querystring: { limit?: string } }>("/history", async (req) => {
  const limit = Number(req.query.limit ?? 30);
  return { history: await readRecentHistory(limit) };
});

fastify.get<{ Querystring: { limit?: string } }>("/kpi", async (req) => {
  const limit = Number(req.query.limit ?? 20);
  return { snapshots: await readRecentKpiSnapshots(limit) };
});

/**
 * /metrics — 분석용 KPI. 추이·집계 표.
 *  query:
 *    actor=<id>  action=<TYPE>  provider=<...>
 *    fromTick=<n>  toTick=<n>  tail=<n>
 *    groupBy=actor,action  또는 actor / action / provider / hour / useMode / agendaState (콤마 분리)
 *    raw=1   → 집계 X 원본 entries 반환
 */
fastify.get<{ Querystring: {
  actor?: string; action?: string; provider?: string;
  fromTick?: string; toTick?: string; tail?: string; groupBy?: string; raw?: string;
} }>("/metrics", async (req) => {
  const filter = {
    actor: req.query.actor,
    action: req.query.action,
    provider: req.query.provider,
    fromTick: req.query.fromTick !== undefined ? Number(req.query.fromTick) : undefined,
    toTick: req.query.toTick !== undefined ? Number(req.query.toTick) : undefined
  };
  const tail = req.query.tail !== undefined ? Number(req.query.tail) : undefined;
  const entries = await readMetrics(filter, tail);
  if (req.query.raw === "1") {
    return { count: entries.length, entries };
  }
  const groupBy = (req.query.groupBy ?? "action").split(",").filter(Boolean) as RollupKey[];
  const rollup = rollupMetrics(entries, groupBy);
  return {
    count: entries.length,
    rollup: Object.values(rollup).sort((a, b) => b.count - a.count),
    trade: tradeFlowKpi(entries),
    skillXp: skillXpKpi(entries),
    affordance: affordanceKpi(entries)
  };
});

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
  const onObs = (o: Observation) => {
    reply.raw.write(`event: observation\ndata: ${JSON.stringify(o)}\n\n`);
  };
  eventBus.on("narrative", onNarrative);
  eventBus.on("raw", onRaw);
  soulBus.on("observation", onObs);

  const heartbeat = setInterval(() => {
    try { reply.raw.write(`: hb\n\n`); } catch {}
  }, 15000);

  req.raw.on("close", () => {
    clearInterval(heartbeat);
    eventBus.off("narrative", onNarrative);
    eventBus.off("raw", onRaw);
    soulBus.off("observation", onObs);
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
    "provider", "apiKey", "model", "baseUrl", "tickIntervalMs", "maxActorsPerTick", "enabled", "fallbackToMock", "reflectIntervalMs", "modelOverrides"
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
fastify.get("/thoughts/summary", async () => {
  const thoughts = await listThoughts();
  return {
    intents: Object.fromEntries(thoughts.map((thought) => [
      thought.actorId,
      {
        intent: thought.nextIntent,
        emotion: thought.emotion,
        updatedAtTick: thought.updatedAtTick
      }
    ]))
  };
});
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

fastify.get<{ Params: { id: string } }>("/agent/:id/snapshot", async (req, reply) => {
  const world = getWorld();
  const actor = world.actors[req.params.id];
  if (!actor) {
    reply.code(404);
    return { error: "actor_not_found" };
  }

  const [soul, thought, recentObservations, relationships] = await Promise.all([
    readSoul(actor.id, actor.name),
    readThought(actor.id, world.tick),
    readObservations(actor.id, 8),
    readAllRelationships()
  ]);
  const topRelationships = relationships
    .filter((rel) => rel.from === actor.id || rel.to === actor.id)
    .sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity))
    .slice(0, 3);

  return { actor, soul, thought, recentObservations, topRelationships };
});

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
  const current = getWorld();
  setWorld({ ...current, ...data, places: data.places ?? current.places ?? {} });
  return { ok: true };
});
fastify.post("/import-seed-village", async () => {
  const seeded = loadMochiVillageSeed();
  setWorld(seeded);
  await saveSnapshot(seeded);
  await writeVillageSeedMarker();
  return { ok: true, places: Object.keys(seeded.places).length };
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

// ── User → NPC speak (개입) ────────────────────────────────────
fastify.post<{ Params: { id: string }; Body: { message: string; from?: string } }>(
  "/agent/:id/speak",
  async (req) => {
    const world = getWorld();
    const target = world.actors[req.params.id];
    if (!target || !target.alive) return { ok: false, message: "target_not_found" };
    const text = (req.body.message ?? "").slice(0, 240).trim();
    if (!text) return { ok: false, message: "empty_message" };
    const fromLabel = req.body.from ?? "방문자";
    const obs: Observation = {
      id: `obs_user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actorId: req.params.id,
      tick: world.tick,
      timestamp: Date.now(),
      kind: "dialogue",
      text: `${fromLabel}이(가) 나에게 "${text}"라고 말했다.`,
      tags: ["dialogue", "visitor"],
      importance: 0.85
    };
    await appendObservation(obs);
    const { appendRawEvent } = await import("./logging/eventLogStore");
    await appendRawEvent({
      tick: world.tick,
      timestamp: Date.now(),
      actorId: "visitor",
      category: "action",
      type: `방문자→${target.name}: ${text}`,
      result: "success",
      payload: { from: fromLabel, to: req.params.id, message: text }
    });
    return { ok: true, observation: obs };
  }
);

// ── 신탁(Oracle) — 사도로 임명한 NPC만 받음 (절대 우선) ──────────
fastify.post<{ Params: { id: string } }>("/agent/:id/follow", async (req) => {
  const world = getWorld();
  const a = world.actors[req.params.id];
  if (!a) return { ok: false, message: "actor_not_found" };
  const soul = await readSoul(req.params.id, a.name);
  const next: Soul = { ...soul, isFollower: true, faith: soul.faith ?? 0.05, updatedAt: Date.now() };
  await writeSoul(next);
  return { ok: true, soul: next };
});
fastify.post<{ Params: { id: string } }>("/agent/:id/unfollow", async (req) => {
  const world = getWorld();
  const a = world.actors[req.params.id];
  if (!a) return { ok: false, message: "actor_not_found" };
  const soul = await readSoul(req.params.id, a.name);
  const next: Soul = { ...soul, isFollower: false, updatedAt: Date.now() };
  await writeSoul(next);
  return { ok: true, soul: next };
});

fastify.post<{ Params: { id: string }; Body: { message: string } }>("/agent/:id/oracle", async (req) => {
  const world = getWorld();
  const target = world.actors[req.params.id];
  if (!target || !target.alive) return { ok: false, message: "target_not_found" };
  const text = (req.body.message ?? "").slice(0, 240).trim();
  if (!text) return { ok: false, message: "empty_message" };
  const soul = await readSoul(req.params.id, target.name);
  if (!soul.isFollower) return { ok: false, message: "not_follower" };
  // 신탁 메모리: kind=oracle, importance 1.0, tags ['oracle','divine']
  const obs: Observation = {
    id: `obs_oracle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: req.params.id,
    tick: world.tick,
    timestamp: Date.now(),
    kind: "oracle",
    text: `[신탁] 신께서 나에게 명하셨다 — "${text}"`,
    tags: ["oracle", "divine", "priority"],
    importance: 1
  };
  await appendObservation(obs);
  // 영혼: 신탁 누적 시 faith 살짝 상승 (cap 1.0), goals 리스트 맨 앞에 신탁 추가 (8개 cap)
  const nextSoul: Soul = {
    ...soul,
    faith: Math.min(1, (soul.faith ?? 0.1) + 0.08),
    activeQuest: {
      text,
      receivedAtTick: world.tick,
      status: "active",
      expiresAtTick: world.tick + 2400,
      progress: /음식|당근|밀|약초/.test(text) && /(나누|나눠|거저|주어|줘|베풀|가난)/.test(text)
        ? { kind: "count", current: 0, target: 1, itemType: "food" }
        : undefined
    },
    goals: [`[신탁] ${text}`, ...soul.goals.filter((g) => !g.startsWith("[신탁]"))].slice(0, 8),
    updatedAt: Date.now()
  };
  await writeSoul(nextSoul);
  const { appendRawEvent } = await import("./logging/eventLogStore");
  await appendRawEvent({
    tick: world.tick,
    timestamp: Date.now(),
    actorId: "god",
    category: "action",
    type: `⚡ 신탁→${target.name}: ${text}`,
    result: "success",
    payload: { to: req.params.id, message: text, faith: nextSoul.faith }
  });
  return { ok: true, observation: obs, soul: nextSoul };
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
    const readFreshIndex = async (): Promise<string> => {
      try { return await readFile(`${clientDist}/index.html`, "utf-8"); }
      catch { return indexHtml ?? ""; }
    };
    fastify.get("/", async (_req, reply) => {
      reply.header("cache-control", "no-cache, no-store, must-revalidate");
      reply.type("text/html").send(await readFreshIndex());
    });
    fastify.setNotFoundHandler(async (req, reply) => {
      const url = req.url.split("?")[0];
      const apiPrefixes = ["/health", "/world", "/config", "/souls", "/thoughts",
        "/observations", "/events", "/history", "/kpi", "/spawn", "/brain", "/snapshot", "/relationships",
        "/agent", "/import-seed", "/import-seed-village", "/places", "/static", "/assets"];
      if (apiPrefixes.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.header("cache-control", "no-cache, no-store, must-revalidate");
      reply.type("text/html").send(await readFreshIndex());
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
startReflectionLoop();
console.log(`brain loop ready (enabled=${getBrainConfig().enabled}, provider=${getBrainConfig().provider}, reflectIntervalMs=${getBrainConfig().reflectIntervalMs})`);
