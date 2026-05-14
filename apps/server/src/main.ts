import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { mkdirSync, readFileSync, writeFileSync, promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { importSeed } from "./imports/importSeed";
import { loadMochiVillageSeed } from "./imports/seedVillage";
import { appendRawEvent, eventBus, readRecentEvents, toNarrative } from "./logging/eventLogStore";
import { readRecentKpiSnapshots, startKpiSnapshotLoop } from "./logging/kpiStore";
import { readMetrics, rollupMetrics, tradeFlowKpi, skillXpKpi, affordanceKpi, planKpi, mentorKpi, llmCostSummary, type RollupKey } from "./logging/metricsStore";
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
import { ensureChroniclePages, generateChronicleRollup, listChroniclePages, maybeEnsureOnTick } from "./chronicle/chronicleService";
import {
  loadBrainConfig, getBrainConfig, updateBrainConfig,
  publicBrainConfig, MODEL_PRESETS
} from "./config/brainConfig";
import { startBrainLoop } from "./brain/loop";
import { startReflectionLoop } from "./brain/reflect";
import { warmEmbeddingModel } from "./brain/embeddings";
import { getImportanceHistogram } from "./brain/importance";
import type { ActionRequest, NarrativeEvent, Observation, RawEvent, Soul, Thought } from "@wiw/shared";
import { dispatchAction, placeGroundItemAt, tickWorld } from "@wiw/world-core";

const port = Number(process.env.PORT ?? 2568);
const apiPort = Number(process.env.API_PORT ?? 3011);
const fastify = Fastify();
let assetCatalog: AssetCatalog = { tileSets: [], humans: [], animals: [], items: [], objects: [] };

const catalogWithFlat = (catalog: AssetCatalog): AssetCatalog & { flat: Record<string, string> } => {
  const flat: Record<string, string> = {};
  for (const group of Object.values(catalog)) {
    for (const item of group) flat[item.key] = item.path;
  }
  return { ...catalog, flat };
};
const villageSeedMarker = resolve(process.cwd(), "data/.has-seeded-village");
const pauseStateFile = resolve(process.cwd(), "data/pause.json");
let serverTickTimer: NodeJS.Timeout | null = null;
let knownAlive = new Map<string, boolean>();
let knownThreatPairs = new Set<string>();

const readPauseState = (): boolean => {
  try {
    const raw = readFileSync(pauseStateFile, "utf-8");
    const parsed = JSON.parse(raw) as { paused?: unknown };
    return typeof parsed.paused === "boolean" ? parsed.paused : false;
  } catch {
    return false;
  }
};

const writePauseState = (paused: boolean): void => {
  try {
    mkdirSync(dirname(pauseStateFile), { recursive: true });
    writeFileSync(pauseStateFile, `${JSON.stringify({ paused, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort admin state persistence; route behavior must not depend on disk I/O.
  }
};

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
    if (tickPaused) return;
    const world = getWorld();
    const beforeTime = world.timeOfDay;
    tickWorld(world);
    drainWorldEventQueue(world);
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
        text: `A new day begins at tick ${world.tick}.`,
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
          text: `${actor.name} fell.`,
          meta: { actorId: actor.id }
        });
        if (actor.kind !== "monster") {
          void appendObservation({
            id: `obs_death_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            actorId: actor.id,
            tick: world.tick,
            timestamp: Date.now(),
            kind: "memory",
            text: `Fell at tick ${world.tick}.`,
            tags: ["death", "milestone:death"],
            importance: 0.95
          });
          // Codex 5차 권고: 사망 시 lastDeathTick 기록 → prompt가 "recover and reassess" bridge 노출.
          void (async () => {
            try {
              const soul = await readSoul(actor.id, actor.name);
              await writeSoul({ ...soul, lastDeathTick: world.tick, updatedAt: Date.now() });
            } catch {
              // best-effort; failed write should not interrupt tick.
            }
          })();
        }
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
            text: `${monster.name} closed in on ${victim.name}.`,
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

// Codex 2차 quick win: trade_settled (and other lifecycle events) seen multiple times in events.ndjson
// for the same tradeId — stale-world replay was emitting duplicates. Track recently-seen idempotency
// keys for the trade lifecycle events here so we drop replays at the drain edge.
const recentSettledKeys = new Map<string, number>();
const SETTLED_DEDUP_TTL_MS = 30_000;

function drainWorldEventQueue(world: ReturnType<typeof getWorld>): void {
  const queue = world.eventQueue ?? [];
  if (queue.length === 0) return;
  world.eventQueue = [];
  const now = Date.now();
  for (const [key, ts] of recentSettledKeys) {
    if (now - ts > SETTLED_DEDUP_TTL_MS) recentSettledKeys.delete(key);
  }
  for (const event of queue) {
    const isTradeLifecycle = event.type === "trade_settled" || event.type === "trade:accepted" || event.type === "trade:rejected";
    if (isTradeLifecycle) {
      const tradeId = String(event.payload?.tradeId ?? "");
      if (tradeId) {
        const key = `${event.type}:${tradeId}`;
        if (recentSettledKeys.has(key)) continue;
        recentSettledKeys.set(key, now);
      }
    }
    void appendRawEvent({
      tick: event.tick,
      timestamp: Date.now(),
      actorId: event.actorId ?? "system",
      category: event.category,
      type: event.type,
      result: event.result,
      reason: event.reason,
      payload: { provider: "system", ...(event.payload ?? {}) }
    });
    if (event.type === "trade:expired" && event.actorId) {
      const tradeId = String(event.payload?.tradeId ?? "");
      const to = String(event.payload?.to ?? "");
      const other = world.actors[to]?.name ?? to;
      void appendObservation({
        id: `obs_trade_expired_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        actorId: event.actorId,
        tick: event.tick,
        timestamp: Date.now(),
        kind: "memory",
        text: `Trade ${tradeId} offered to actorId=${to} (${other}) expired without acceptance.`,
        tags: ["trade", "expired", to],
        importance: 0.45
      });
    }
    if (event.type.startsWith("trade_accept_failed:")) {
      const reason = event.reason ?? event.type.slice("trade_accept_failed:".length);
      const tradeId = String(event.payload?.tradeId ?? "");
      const fromId = String(event.payload?.from ?? "");
      const toId = String(event.payload?.to ?? "");
      const proposer = world.actors[fromId];
      const acceptor = world.actors[toId];
      if (proposer && acceptor && fromId) {
        const detail = reason.startsWith("missing_want:")
          ? `${acceptor.name} couldn't provide ${reason.slice("missing_want:".length)} you wanted.`
          : reason.startsWith("missing_offer:")
          ? `You no longer had the ${reason.slice("missing_offer:".length)} you offered.`
          : reason === "trade_actor_not_found"
          ? `${acceptor.name} or you became unavailable before the trade closed.`
          : `Trade failed (${reason}).`;
        void appendObservation({
          id: `obs_trade_fail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          actorId: fromId,
          tick: event.tick,
          timestamp: Date.now(),
          kind: "memory",
          text: `Trade ${tradeId} with ${acceptor.name} could not settle: ${detail}`,
          tags: ["trade", "accept_failed", toId, reason],
          importance: 0.55
        });
      }
    }
  }
}

await fastify.register(fastifyCors, { origin: true });

const adminToken = (process.env.WIW_ADMIN_TOKEN ?? "").trim();
if (!adminToken) {
  console.warn("[wiw] WIW_ADMIN_TOKEN is empty — admin routes are OPEN. Set this env var for production.");
}

const PUBLIC_ROUTES = new Set([
  "GET /health",
  "GET /world",
  "GET /places",
  "GET /assets/catalog",
  "GET /chronicle/pages",
  "GET /history",
  "GET /kpi",
  "GET /events",
  "GET /events/tail",
  "GET /relationships",
  "GET /souls",
  "GET /thoughts",
  "GET /thoughts/summary",
  "GET /config/brain",
  "GET /admin/world/pause"
]);
const PUBLIC_PREFIXES = [
  "/static/",
  "/assets/",
  "/wiw/assets/",
  "/metrics/",
  "/souls/",
  "/thoughts/",
  "/observations/",
  "/agent/"
];
const PUBLIC_GET_PARAMS = new Set([
  "/agent/:id/snapshot",
  "/observations/:id",
  "/souls/:id",
  "/thoughts/:id"
]);
const PUBLIC_EXACT_PATHS = new Set(["/", "/wiw", "/wiw/"]);

const isPublicGet = (url: string): boolean => {
  const path = url.split("?")[0] ?? url;
  if (PUBLIC_EXACT_PATHS.has(path)) return true;
  if (PUBLIC_ROUTES.has(`GET ${path}`)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (path.startsWith(prefix)) {
      if (path.startsWith("/agent/") && !path.endsWith("/snapshot")) return false;
      if (path.startsWith("/observations/") && path.split("/").length !== 3) return false;
      if (path.startsWith("/souls/") && path.split("/").length !== 3) return false;
      if (path.startsWith("/thoughts/") && path.split("/").length !== 3) return false;
      return true;
    }
  }
  return false;
};
void PUBLIC_GET_PARAMS;

fastify.addHook("preHandler", async (req, reply) => {
  if (!adminToken) return;
  if (req.method === "OPTIONS") return;
  if (req.method === "GET" && isPublicGet(req.url)) return;
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (presented !== adminToken) {
    reply.code(401).send({ ok: false, error: "admin_token_required" });
  }
});

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
fastify.get("/assets/catalog", async () => catalogWithFlat(assetCatalog));
fastify.get("/chronicle/pages", async () => ({ pages: await listChroniclePages() }));
fastify.post("/chronicle/regenerate", async () => {
  const tick = getWorld().tick;
  const pages = await ensureChroniclePages(tick);
  return { ok: true, tick, pages: pages.length };
});

fastify.post<{ Body: { kind?: "week" | "month"; index?: number } }>("/chronicle/rollup", async (req) => {
  const kind = req.body?.kind;
  if (kind !== "week" && kind !== "month") return { ok: false, reason: "kind_required" };
  const index = Math.max(1, Math.floor(Number(req.body?.index ?? 1)));
  const tick = getWorld().tick;
  const page = await generateChronicleRollup(kind, index, tick);
  return { ok: Boolean(page), page };
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
 *    actor=<id>  action=<TYPE>  provider=<...>  mentor=0|1  excludeMentor=1
 *    fromTick=<n>  toTick=<n>  tail=<n>
 *    groupBy=actor,action  또는 actor / action / provider / mentor / hour / useMode / agendaState (콤마 분리)
 *    raw=1   → 집계 X 원본 entries 반환
 */
fastify.get<{ Querystring: { since?: string } }>("/metrics/funnel", async (req) => {
  const { buildReport, flush } = await import("./metrics/funnel");
  await flush();
  const since = req.query.since !== undefined ? Number(req.query.since) : 0;
  const report = await buildReport(since);
  return report;
});

fastify.get<{ Querystring: { actorId?: string } }>("/metrics/importance-histogram", async (req) => {
  const aid = req.query.actorId;
  return getImportanceHistogram(aid && aid !== "all" ? aid : undefined);
});

fastify.get<{ Querystring: {
  actor?: string; action?: string; provider?: string;
  mentor?: string; excludeMentor?: string;
  fromTick?: string; toTick?: string; tail?: string; groupBy?: string; raw?: string;
} }>("/metrics", async (req) => {
  const filter = {
    actor: req.query.actor,
    action: req.query.action,
    provider: req.query.provider,
    mentor: req.query.mentor === undefined ? undefined : req.query.mentor === "1" || req.query.mentor === "true",
    excludeMentor: req.query.excludeMentor === "1" || req.query.excludeMentor === "true",
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
    affordance: affordanceKpi(entries),
    plan: planKpi(entries),
    mentor: mentorKpi(entries)
  };
});

fastify.get<{ Querystring: {
  actor?: string; provider?: string; fromTick?: string; toTick?: string; tail?: string;
} }>("/metrics/summary", async (req) => {
  const filter = {
    actor: req.query.actor,
    provider: req.query.provider,
    fromTick: req.query.fromTick !== undefined ? Number(req.query.fromTick) : undefined,
    toTick: req.query.toTick !== undefined ? Number(req.query.toTick) : undefined
  };
  const tail = req.query.tail !== undefined ? Number(req.query.tail) : undefined;
  const entries = await readMetrics(filter, tail);
  return {
    count: entries.length,
    llm: llmCostSummary(entries)
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
/**
 * /admin/oracle — 신의 목소리. 살아있는 모든 humanoid actor 에게 dialogue obs 자연 생성.
 * 메모리 직접 주입이 아니라 SPEAK 흐름과 동일한 형식 (kind: dialogue, tags: received·heard·from:zara).
 * 동시에 raw event 발행 → SSE feed 에 narrative 로 표시됨.
 *  body: { message: string, restoreActors?: boolean }
 *    restoreActors: true 면 모든 actor hp/stamina/hunger 회복 + agenda 초기화.
 */
/**
 * /admin/unstuck — 특정 actor 의 ineffective mask + agenda + movePath 리셋. 라이브 보존.
 * body: { actorId: string }
 */
/**
 * /admin/world/reseed — 2026-05-07 신설.
 * snapshot 만 새 createMochiVillageState() 로 교체. 메모리/soul/관계 보존.
 *  body: { message?: string, oracleSay?: boolean }
 *  - oracleSay=true 면 message 를 모든 humanoid 에게 dialogue obs 로 전파.
 *
 * 사용 패턴: 월드 / 자원 / station 변경 후 라이브에서 메모리 유지한 채 맵만 재생성.
 */
/**
 * /admin/debug/prompt — 2026-05-07 신설.
 * 특정 actor 의 다음 결정을 위해 build 될 prompt 와 retrieve 결과를 노출 (LLM 호출 X).
 *  query: actorId
 *  반환: systemPrompt, userPrompt, tokensApprox (chars/4), memoriesRetrieved
 */
fastify.get<{ Querystring: { actorId?: string } }>("/admin/debug/prompt", async (req) => {
  const aid = String(req.query.actorId ?? "");
  if (!aid) return { ok: false, reason: "actorId_missing" };
  const w = getWorld();
  const me = w.actors[aid];
  if (!me) return { ok: false, reason: "actor_not_found" };
  const { readSoul, readThought } = await import("./persistence/soulStore");
  const { MemoryStore } = await import("./brain/memoryStore");
  const { buildUserPrompt, buildSystemPrompt } = await import("./brain/prompt");
  const soul = await readSoul(aid, me.name);
  const thought = await readThought(aid, w.tick);
  // retrieve with same situational signals as loop
  const inventoryPrefixes = Array.from(new Set(me.inventory.map((s) => s.item)));
  const nearbyStationTypes = Array.from(new Set(
    Object.values(w.structures ?? {})
      .filter((s) => Math.abs(s.x - me.x) + Math.abs(s.y - me.y) <= 4)
      .map((s) => s.type)
  ));
  const visibleFoodPrefixes = Array.from(new Set(
    Object.values(w.groundItems ?? {})
      .filter((g) => Math.abs(g.x - me.x) + Math.abs(g.y - me.y) <= 20)
      .map((g) => (g.id ?? "").split("-")[0])
      .filter((p) => ["berry","mushroom","herb","apple","pineapple","wheat","carrot","bread","fish","meat","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"].includes(p))
  ));
  const fields = Object.values(w.places ?? {}).filter((p) => p.kind === "field");
  const nearbyFieldDist = fields.length === 0 ? Infinity : Math.min(...fields.map((p) => {
    const dx = me.x < p.x ? p.x - me.x : me.x >= p.x + p.width ? me.x - (p.x + p.width - 1) : 0;
    const dy = me.y < p.y ? p.y - me.y : me.y >= p.y + p.height ? me.y - (p.y + p.height - 1) : 0;
    return dx + dy;
  }));
  const memories = await MemoryStore.retrieve({
    text: `${soul.agenda?.intent ?? ""} ${thought.priority} ${soul.activeQuest?.text ?? ""}`,
    actorId: me.id,
    placeId: undefined,
    targetActorId: undefined,
    needs: undefined,
    inventoryPrefixes, nearbyStationTypes, visibleFoodPrefixes, nearbyFieldDist,
    hunger: me.hunger, hp: me.hp, maxHp: me.maxHp,
    agenda: soul.agenda?.status === "active" ? {
      intent: soul.agenda.intent,
      targetItemPrefix: soul.agenda.targetItemPrefix,
      targetActorId: soul.agenda.targetActorId,
      failureSig: soul.agenda.lastFailureSig,
      failureCount: soul.agenda.failureCount
    } : undefined,
    limit: 16
  }, me, { tick: w.tick, ts: Date.now() });
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ world: w, me, soul, thought, memories });
  // Approx token count (English+Korean 평균: 4 chars/token)
  const sysChars = systemPrompt.length;
  const userChars = userPrompt.length;
  const total = sysChars + userChars;
  return {
    ok: true,
    actor: { id: me.id, name: me.name, x: me.x, y: me.y, hp: me.hp, hunger: me.hunger, inventory: me.inventory },
    systemPrompt,
    userPrompt,
    chars: { system: sysChars, user: userChars, total },
    tokensApprox: { system: Math.ceil(sysChars / 4), user: Math.ceil(userChars / 4), total: Math.ceil(total / 4) },
    memoriesRetrieved: memories.length,
    memorySamples: memories.slice(0, 3).map((m) => ({ tags: m.tags, importance: m.importance, text: m.text.slice(0, 100) }))
  };
});

fastify.post<{ Body: { message?: string; oracleSay?: boolean } }>("/admin/world/reseed", async (req) => {
  const seeded = loadMochiVillageSeed();
  setWorld(seeded);
  await saveSnapshot(seeded);
  await writeVillageSeedMarker();
  const result: { ok: boolean; recipients?: string[]; message?: string } = { ok: true };
  if (req.body?.oracleSay && req.body?.message) {
    const message = String(req.body.message).slice(0, 1200);
    const targets = Object.values(seeded.actors).filter((a) => a.alive && a.kind !== "monster");
    const { appendObservation } = await import("./persistence/soulStore");
    const ts = Date.now();
    const tick = seeded.tick;
    for (const t of targets) {
      await appendObservation({
        id: `obs_speak_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}_${t.id}`,
        actorId: t.id,
        tick, timestamp: ts,
        kind: "dialogue",
        text: `Heard a voice from above (Zara): "${message}"`,
        tags: ["dialogue", "received", "heard", "from:zara", "oracle"],
        importance: 0.95
      });
    }
    result.recipients = targets.map((t) => t.id);
    result.message = message;
  }
  return result;
});

// 2026-05-08: wheat_seed → wheat 일괄 마이그레이션. inventory 슬롯 + ground items 1:1 변환.
fastify.post("/admin/world/migrate-wheat-seed", async () => {
  const w = getWorld();
  let invMigrated = 0; let groundMigrated = 0;
  for (const a of Object.values(w.actors)) {
    for (const slot of a.inventory) {
      if (slot.item === "wheat_seed") { slot.item = "wheat"; invMigrated += 1; }
    }
  }
  for (const id of Object.keys(w.groundItems)) {
    const g = w.groundItems[id];
    if (id.startsWith("wheat_seed-") || g.type === "wheat_seed") {
      const newId = id.replace(/^wheat_seed-/, "wheat-mig-");
      delete w.groundItems[id];
      if (placeGroundItemAt(w, { ...g, id: newId, type: "wheat", iconKey: "item.food.wheat" })) {
        groundMigrated += 1;
      }
    }
  }
  w.revision += 1;
  return { ok: true, invSlotsMigrated: invMigrated, groundItemsMigrated: groundMigrated };
});

// 2026-05-09: 누락 iconKey 일괄 보강 (DROP/사망 경로 누락 fallback).
fastify.post("/admin/world/fix-iconkeys", async () => {
  const { itemDef } = await import("@wiw/shared");
  const w = getWorld();
  let fixed = 0;
  for (const g of Object.values(w.groundItems)) {
    if (g.iconKey) continue;
    const prefix = (g.id.split("-")[0]) || g.type || "";
    const def = itemDef(prefix);
    g.iconKey = def ? `item.${def.category}.${prefix}` : "item.recipe";
    fixed += 1;
  }
  w.revision += 1;
  return { ok: true, fixed };
});

// 2026-05-09 v3: forest-east 안에 trees + rocks 동적 주입 (snapshot 누락 보강).
fastify.post("/admin/world/seed-forest-east", async () => {
  const w = getWorld();
  const additions = [
    { id: "structure-tree-fe1",  type: "tree", x: 72, y: 38, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe2",  type: "tree", x: 76, y: 39, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe3",  type: "tree", x: 80, y: 37, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe4",  type: "tree", x: 84, y: 39, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe5",  type: "tree", x: 88, y: 37, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe6",  type: "tree", x: 73, y: 44, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe7",  type: "tree", x: 78, y: 45, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe8",  type: "tree", x: 83, y: 46, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe9",  type: "tree", x: 87, y: 44, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe10", type: "tree", x: 91, y: 39, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-tree-fe11", type: "tree", x: 91, y: 45, width: 2, height: 3, assetKey: "object.tree.large",  props: { placeId: "forest-east" } },
    { id: "structure-tree-fe12", type: "tree", x: 75, y: 50, width: 2, height: 3, assetKey: "object.tree.medium", props: { placeId: "forest-east" } },
    { id: "structure-rock-fe1", type: "rock", x: 81, y: 50, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "forest-east" } },
    { id: "structure-rock-fe2", type: "rock", x: 86, y: 50, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "forest-east" } },
    { id: "structure-rock-fe3", type: "rock", x: 91, y: 51, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "forest-east" } },
    { id: "structure-rock-fe4", type: "rock", x: 88, y: 41, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "forest-east" } }
  ];
  let added = 0;
  for (const s of additions) {
    if (w.structures[s.id]) continue;
    w.structures[s.id] = s as typeof w.structures[string];
    added += 1;
  }
  w.revision += 1;
  return { ok: true, added };
});

// 2026-05-09 PR-1: actor 의 사회적 학습 시드 — knownRecipes / discoveredPlaces / trust set.
// mentor (Aaron) 에 마을 메커니즘 일괄 시드 후 SPEAK 로 다른 NPC 가 자연 학습.
fastify.post<{ Body: { actorId?: string; knownRecipes?: string[]; discoveredPlaces?: Array<{ placeId: string; resourcesSeen: string[] }>; trustToAll?: number; locked?: boolean } }>("/admin/actor/seed-knowledge", async (req) => {
  const aid = String(req.body?.actorId ?? "");
  if (!aid) return { ok: false, reason: "actorId_missing" };
  const w = getWorld();
  const a = w.actors[aid];
  if (!a) return { ok: false, reason: "actor_not_found" };
  // knownRecipes
  if (req.body?.knownRecipes?.length) {
    if (!a.knownRecipes) a.knownRecipes = [];
    for (const rid of req.body.knownRecipes) {
      if (!a.knownRecipes.find((r) => r.recipeId === rid)) {
        a.knownRecipes.push({ recipeId: rid, count: 1, firstCraftedTick: w.tick, lastCraftedTick: w.tick });
      }
    }
  }
  // discoveredPlaces
  if (req.body?.discoveredPlaces?.length) {
    if (!a.discoveredPlaces) a.discoveredPlaces = {};
    for (const p of req.body.discoveredPlaces) {
      a.discoveredPlaces[p.placeId] = {
        resourcesSeen: p.resourcesSeen,
        firstVisitTick: w.tick,
        lastVisitTick: w.tick,
        locked: req.body?.locked ?? true
      };
    }
  }
  // trustToAll: 다른 모든 NPC 가 이 actor 를 신뢰. relationships 갱신.
  let trustUpdated = 0;
  if (typeof req.body?.trustToAll === "number") {
    const { readAllRelationships, writeRelationships } = await import("./persistence/soulStore");
    const rels = await readAllRelationships();
    const trustVal = Math.max(0, Math.min(1, req.body.trustToAll));
    const targets = Object.values(w.actors).filter((other) => other.id !== aid && other.kind !== "monster" && other.alive);
    for (const other of targets) {
      const rel = rels.find((r) => r.from === other.id && r.to === aid);
      if (rel) {
        rel.trust = trustVal;
        rel.trustEvidenceCount = (rel.trustEvidenceCount ?? 0);
      } else {
        rels.push({ from: other.id, to: aid, affinity: 0, trust: trustVal, trustEvidenceCount: 0, lastInteractionTick: w.tick, notes: "seeded mentor trust" });
      }
      trustUpdated += 1;
    }
    await writeRelationships(rels);
  }
  w.revision += 1;
  return { ok: true, knownRecipes: a.knownRecipes?.length ?? 0, discoveredPlaces: Object.keys(a.discoveredPlaces ?? {}).length, trustUpdated };
});

// 2026-05-09 v4: NPC 시작 도구·자원 일괄 배포 — bootstrap. axe + pickaxe + wood/ore/coal seed.
fastify.post("/admin/world/bootstrap-loadout", async () => {
  const w = getWorld();
  const targets = ["player-1","npc-1","npc-2","npc-3","npc-4"];
  const seed: Array<{ item: string; count: number }> = [
    { item: "axe", count: 1 },
    { item: "pickaxe", count: 1 },
    { item: "wood", count: 5 },
    { item: "ore", count: 5 },
    { item: "coal", count: 3 }
  ];
  let updated = 0;
  for (const id of targets) {
    const a = w.actors[id];
    if (!a) continue;
    for (const { item, count } of seed) {
      // 동일 prefix stack 슬롯 있으면 추가, 없으면 새 슬롯
      const def = await import("@wiw/shared").then(m => m.itemDef(item));
      const stackable = def?.stackable !== false && (def?.category === "material" || def?.category === "food" || def?.category === "potion");
      if (stackable) {
        const existing = a.inventory.find((s) => s.kind === "stack" && s.item === item);
        if (existing && existing.kind === "stack") {
          existing.count += count;
        } else if (a.inventory.length < 14) {
          a.inventory.push({ kind: "stack", item, count });
        }
      } else {
        // tool/weapon → instance slot
        for (let i = 0; i < count; i += 1) {
          if (a.inventory.length >= 14) break;
          a.inventory.push({ kind: "instance", id: `${item}-bs-${id}-${i}`, item });
        }
      }
    }
    updated += 1;
  }
  w.revision += 1;
  return { ok: true, updated };
});

// 2026-05-09 v4: 죽은 monster 잔존 actor 일괄 정리 (이제 신규 사망은 즉시 삭제됨, 기존 잔존만 청소).
fastify.post("/admin/world/cleanup-dead-monsters", async () => {
  const w = getWorld();
  let removed = 0;
  for (const id of Object.keys(w.actors)) {
    const a = w.actors[id];
    if (a.kind === "monster" && !a.alive) { delete w.actors[id]; removed += 1; }
  }
  w.revision += 1;
  return { ok: true, removed };
});

// 2026-05-09 v3: 살아있는 모든 monster name 정규화 — 기존 "Wolf2", "Boar-r352367-0" 등 → "Wolf"/"Alpha Wolf"/"Dire Bear" 등 종+티어 만.
fastify.post("/admin/world/normalize-monster-names", async () => {
  const w = getWorld();
  let updated = 0;
  for (const a of Object.values(w.actors)) {
    if (a.kind !== "monster") continue;
    const ak = (a.assetKey ?? "").toLowerCase();
    let species = "";
    for (const k of ["boar","wolf","bear","deer","slime","spirit"]) if (ak.includes(k)) { species = k.charAt(0).toUpperCase() + k.slice(1); break; }
    if (!species) continue;
    const tier = ak.includes(".dire") ? "Dire " : ak.includes(".alpha") ? "Alpha " : "";
    const newName = `${tier}${species}`;
    if (a.name !== newName) { a.name = newName; updated += 1; }
  }
  w.revision += 1;
  return { ok: true, updated };
});

// 2026-05-09 v3: 모든 monster wipe (hostile + neutral). respawn 시 forest-east 에서 점진 spawn.
fastify.post("/admin/world/wipe-monsters", async () => {
  const w = getWorld();
  let wiped = 0;
  for (const id of Object.keys(w.actors)) {
    if (w.actors[id].kind === "monster") {
      delete w.actors[id];
      wiped += 1;
    }
  }
  // 인접 ground corpse/drop도 무관 — 자연 PICKUP/decay.
  w.revision += 1;
  return { ok: true, wiped };
});

// 2026-05-09 Phase B.1: 디버그용 — 살아있는 hostile boar 일부를 alpha/dire 로 즉시 승격 + wolf/bear 강제 spawn.
fastify.post<{ Body: { promoteAlphaCount?: number; promoteDireCount?: number; spawnWolves?: number; spawnBears?: number } }>("/admin/world/monster-stress", async (req) => {
  const w = getWorld();
  const promoteAlpha = req.body?.promoteAlphaCount ?? 0;
  const promoteDire = req.body?.promoteDireCount ?? 0;
  const spawnWolves = req.body?.spawnWolves ?? 0;
  const spawnBears = req.body?.spawnBears ?? 0;
  let promoted = 0;

  // 1) 기존 boar 승격
  const boars = Object.values(w.actors).filter((a) => a.alive && a.kind === "monster" && (a.assetKey ?? "").includes("boar") && !(a.assetKey ?? "").includes(".alpha") && !(a.assetKey ?? "").includes(".dire"));
  for (let i = 0; i < Math.min(promoteAlpha, boars.length); i += 1) {
    const a = boars[i];
    a.assetKey = (a.assetKey ?? "monster.boar") + ".alpha";
    a.name = `Alpha ${a.name}`;
    a.status = { ...a.status, strength: Math.round(a.status.strength * 1.5), constitution: Math.round(a.status.constitution * 1.3) };
    a.maxHp = Math.round(a.maxHp * 1.5); a.hp = a.maxHp;
    promoted += 1;
  }
  for (let i = promoteAlpha; i < Math.min(promoteAlpha + promoteDire, boars.length); i += 1) {
    const a = boars[i];
    a.assetKey = (a.assetKey ?? "monster.boar") + ".dire";
    a.name = `Dire ${a.name}`;
    a.status = { ...a.status, strength: Math.round(a.status.strength * 2), constitution: Math.round(a.status.constitution * 1.8) };
    a.maxHp = Math.round(a.maxHp * 2.5); a.hp = a.maxHp;
    promoted += 1;
  }

  // 2) wolf/bear 강제 spawn (마을 외곽)
  const VC = { x: 32, y: 25 };
  const spawnedNames: string[] = [];
  const spawn = (kindKey: string, namePrefix: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 28 + Math.floor(Math.random() * 10);
      const x = Math.max(1, Math.min(w.map.width - 2, Math.round(VC.x + Math.cos(angle) * dist)));
      const y = Math.max(1, Math.min(w.map.height - 2, Math.round(VC.y + Math.sin(angle) * dist)));
      const id = `monster-${kindKey}-stress-${w.tick}-${i}`;
      const status = { strength: 4, dexterity: 5, constitution: 4, intelligence: 1 };
      const maxHp = 80 + status.constitution * 4;
      w.actors[id] = {
        id, kind: "monster",
        name: `${namePrefix}-s${w.tick}-${i}`,
        assetKey: `monster.${kindKey}`,
        x, y,
        hp: maxHp, maxHp,
        mp: 0, maxMp: 0,
        stamina: 50 + status.constitution * 5, maxStamina: 50 + status.constitution * 5,
        hunger: 0, maxHunger: 80 + status.constitution * 4,
        status,
        skills: [], gold: 0,
        inventory: [],
        alive: true
      };
      spawnedNames.push(id);
    }
  };
  spawn("wolf", "Wolf", spawnWolves);
  spawn("bear", "Bear", spawnBears);

  w.revision += 1;
  return { ok: true, promoted, spawned: spawnedNames };
});

// 2026-05-09: legacy `item-XXX` ground items 정리. id prefix=item 인 항목을 g.type 기준 정상 ID 로 재배정.
// type 도 모르면 삭제 (orphan).
fastify.post("/admin/world/fix-orphan-ids", async () => {
  const { itemDef } = await import("@wiw/shared");
  const w = getWorld();
  let migrated = 0; let removed = 0;
  for (const id of Object.keys(w.groundItems)) {
    if (!id.startsWith("item-")) continue;
    const g = w.groundItems[id];
    const tp = g.type || "";
    const def = itemDef(tp);
    if (!def) {
      delete w.groundItems[id];
      removed += 1;
      continue;
    }
    delete w.groundItems[id];
    const newId = `${tp}-mig-${id.split("-")[1] ?? Math.random().toString(36).slice(2,7)}`;
    if (placeGroundItemAt(w, { ...g, id: newId, iconKey: `item.${def.category}.${tp}` })) {
      migrated += 1;
    }
  }
  w.revision += 1;
  return { ok: true, migrated, removed };
});

// 2026-05-08: 분석/디버그용 tick freeze. paused=true → setInterval 콜백이 tick 한 칸도 안 굴림.
let tickPaused = readPauseState();
fastify.post<{ Body: { paused?: boolean } }>("/admin/world/pause", async (req) => {
  tickPaused = Boolean(req.body?.paused);
  writePauseState(tickPaused);
  return { ok: true, paused: tickPaused, tick: getWorld().tick };
});
fastify.get("/admin/world/pause", async () => ({ ok: true, paused: tickPaused, tick: getWorld().tick }));
export const isWorldPaused = (): boolean => tickPaused;

fastify.post<{ Body: { actorId?: string } }>("/admin/unstuck", async (req) => {
  const aid = String(req.body?.actorId ?? "");
  if (!aid) return { ok: false, reason: "actorId_missing" };
  const w = getWorld();
  const a = w.actors[aid];
  if (!a) return { ok: false, reason: "actor_not_found" };
  // movePath / attack stash 청소
  a.movePath = undefined;
  a.movePathTarget = undefined;
  a.attackTargetId = undefined;
  a.attackUntil = undefined;
  a.attackStartedAtTick = undefined;
  a.lastMoveTick = undefined; // cooldown 도 리셋
  // ineffectiveMask 청소 (loop 내부 map)
  const { resetActorMasks } = await import("./brain/loop");
  resetActorMasks(aid);
  // soul.agenda null
  const { readSoul, writeSoul } = await import("./persistence/soulStore");
  const soul = await readSoul(aid, a.name);
  if (soul.agenda) {
    await writeSoul({ ...soul, agenda: undefined, updatedAt: Date.now() });
  }
  w.revision += 1;
  return { ok: true, actorId: aid };
});

fastify.post<{ Body: { message?: string; restoreActors?: boolean; placeAtHome?: boolean } }>("/admin/oracle", async (req) => {
  const message = String(req.body?.message ?? "").slice(0, 1200);
  if (!message) return { ok: false, reason: "message_missing" };
  const w = getWorld();
  const restored: string[] = [];
  // 각 humanoid 의 집/시작 좌표 (relationships.ts 기준 + bakery 거주 Mira).
  const homeSpawn: Record<string, { x: number; y: number }> = {
    "player-1": { x: 19, y: 31 }, // home-mochi
    "npc-1":    { x: 20, y: 31 }, // Peter — home-mochi
    "npc-2":    { x: 24, y: 20 }, // Mira — bakery 거주
    "npc-3":    { x: 32, y: 32 }, // Lia — home-yui
    "npc-4":    { x: 44, y: 31 }  // Jin — home-jin
  };
  if (req.body?.restoreActors) {
    const previouslyDead = new Set(Object.values(w.actors).filter((a) => !a.alive).map((a) => a.id));
    for (const a of Object.values(w.actors)) {
      a.alive = true;
      a.hp = a.maxHp;
      a.stamina = a.maxStamina;
      a.hunger = 0;
      a.movePath = undefined;
      a.movePathTarget = undefined;
      a.attackTargetId = undefined;
      a.attackUntil = undefined;
      a.attackStartedAtTick = undefined;
      a.attackMaxTicks = undefined;
      if (req.body?.placeAtHome && homeSpawn[a.id]) {
        a.x = homeSpawn[a.id].x;
        a.y = homeSpawn[a.id].y;
      }
      restored.push(a.id);
    }
    // 부활한 actor (이전에 dead 였던) 의 stale agenda 정리: 죽기 전 plan은 더이상 의미 없음.
    // oracle message가 이미 강한 dialogue observation으로 적립되니, 다음 LLM beat에서 새 agenda 자율 결정.
    for (const id of previouslyDead) {
      const a = w.actors[id];
      if (!a || a.kind === "monster") continue;
      try {
        const soul = await readSoul(id, a.name);
        if (soul.agenda) {
          await writeSoul({ ...soul, agenda: { ...soul.agenda, status: "abandoned", lastFailureSig: "died_before_completion" }, updatedAt: Date.now() });
        }
      } catch {
        // best-effort
      }
    }
    w.revision += 1;
  }
  const targets = Object.values(w.actors).filter((a) => a.alive && a.kind !== "monster");
  const { appendObservation } = await import("./persistence/soulStore");
  const { appendRawEvent } = await import("./logging/eventLogStore");
  const ts = Date.now();
  const tick = w.tick;
  for (const t of targets) {
    await appendObservation({
      id: `obs_speak_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}_${t.id}`,
      actorId: t.id,
      tick,
      timestamp: ts,
      kind: "dialogue",
      text: `Heard a voice from above (Zara): "${message}"`,
      tags: ["dialogue", "received", "heard", "from:zara", "oracle"],
      importance: 0.95
    });
  }
  await appendRawEvent({
    tick,
    timestamp: ts,
    actorId: "zara",
    category: "world",
    type: `oracle: ${message.slice(0, 80)}`,
    result: "info",
    payload: { provider: "system", oracle: true, recipients: targets.map((t) => t.id), message }
  });
  return { ok: true, recipients: targets.map((t) => t.id), restored };
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

fastify.get<{ Querystring: { limit?: string; days?: string } }>("/events", async (req) => {
  const limit = Number(req.query.limit ?? 200);
  const days = req.query.days !== undefined ? Number(req.query.days) : 3;
  const raws = await readRecentEvents(limit, days);
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
      payload: { action, thought, resultMsg: result.message }
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
      text: `${fromLabel} said to me: "${text}"`,
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
      expiresAtTick: world.tick + 1440,
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
    // Serve asset files directly from dist/assets — both /assets/* and /wiw/assets/* (vite base="/wiw/")
    // 2026-05-07: Caddy 는 prod 에서 /wiw 를 strip 하지만, localhost 직접 접속 시 strip 없이 옴.
    const serveDistAsset = async (params: { "*": string }, reply: import("fastify").FastifyReply): Promise<void> => {
      const name = params["*"];
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
    };
    fastify.get<{ Params: { "*": string } }>("/assets/*", async (req, reply) => serveDistAsset(req.params, reply));
    fastify.get<{ Params: { "*": string } }>("/wiw/assets/*", async (req, reply) => serveDistAsset(req.params, reply));
    const readFreshIndex = async (): Promise<string> => {
      try { return await readFile(`${clientDist}/index.html`, "utf-8"); }
      catch { return indexHtml ?? ""; }
    };
    fastify.get("/", async (_req, reply) => {
      reply.header("cache-control", "no-cache, no-store, must-revalidate");
      reply.type("text/html").send(await readFreshIndex());
    });
    // /wiw 또는 /wiw/ 도 index 반환 (Caddy strip 없이 직접 접속 시)
    fastify.get("/wiw", async (_req, reply) => {
      reply.header("cache-control", "no-cache, no-store, must-revalidate");
      reply.type("text/html").send(await readFreshIndex());
    });
    fastify.get("/wiw/", async (_req, reply) => {
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
void warmEmbeddingModel();
console.log(`brain loop ready (enabled=${getBrainConfig().enabled}, provider=${getBrainConfig().provider}, reflectIntervalMs=${getBrainConfig().reflectIntervalMs})`);
