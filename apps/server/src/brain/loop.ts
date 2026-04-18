import type { Actor, ActionRequest } from "@wiw/shared";
import { dispatchAction } from "@wiw/world-core";
import { getBrainConfig, onBrainConfigChange } from "../config/brainConfig";
import { getWorld, setWorld } from "../state/worldStore";
import { appendRawEvent } from "../logging/eventLogStore";
import {
  readSoul, readThought, writeThought,
  readObservations, appendObservation
} from "../persistence/soulStore";
import { decideWithMock } from "./mock";
import { decideWithOpenRouter } from "./openrouter";
import type { BrainDecision } from "./prompt";

let timer: NodeJS.Timeout | null = null;
let running = false;
let rr = 0; // round-robin pointer

export function startBrainLoop(): void {
  const schedule = () => {
    const cfg = getBrainConfig();
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, Math.max(2000, cfg.tickIntervalMs));
  };

  onBrainConfigChange(() => schedule());

  const tick = async () => {
    if (running) { schedule(); return; }
    const cfg = getBrainConfig();
    if (!cfg.enabled) { schedule(); return; }
    running = true;
    try {
      await runOne(cfg);
    } catch (e) {
      console.warn("[brain] tick error", e);
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();
}

async function runOne(cfg: ReturnType<typeof getBrainConfig>): Promise<void> {
  const world = getWorld();
  const candidates: Actor[] = Object.values(world.actors)
    .filter((a) => a.alive);
  if (candidates.length === 0) return;

  const n = Math.max(1, Math.min(cfg.maxActorsPerTick, candidates.length));
  for (let i = 0; i < n; i++) {
    const me = candidates[(rr + i) % candidates.length];
    if (!me) continue;
    await decideAndApply(me);
  }
  rr = (rr + n) % candidates.length;
}

async function decideAndApply(me: Actor): Promise<void> {
  const cfg = getBrainConfig();
  const world = getWorld();
  const soul = await readSoul(me.id, me.name);
  const thought = await readThought(me.id, world.tick);
  const memories = await readObservations(me.id, 20);

  let decision: BrainDecision | null = null;
  if (cfg.provider === "openrouter" && cfg.apiKey) {
    decision = await decideWithOpenRouter(cfg, { world, me, soul, thought, memories });
  }
  if (!decision) {
    decision = decideWithMock({ world, me, soul, thought, memories });
  }

  const actReq: ActionRequest | null = toActionRequest(me.id, decision);
  let resultOk = true;
  let resultMsg = "WAIT";
  if (actReq) {
    const result = dispatchAction(world, actReq);
    setWorld(world);
    resultOk = result.ok;
    resultMsg = result.message;
  }

  // write thought
  const updatedThought = {
    ...thought,
    priority: decision.thought.priority,
    emotion: decision.thought.emotion,
    nextIntent: decision.thought.nextIntent,
    beliefs: mergeCap(thought.beliefs, decision.thought.beliefs, 8),
    recentEvents: mergeCap(thought.recentEvents, decision.thought.recentEvents, 8),
    updatedAtTick: world.tick,
    updatedAtMs: Date.now()
  };
  await writeThought(updatedThought);

  // write observation (self-action)
  await appendObservation({
    id: `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    actorId: me.id,
    tick: world.tick,
    timestamp: Date.now(),
    kind: "action",
    text: `${decision.action.type}${decision.action.message ? ` "${decision.action.message}"` : ""}${resultOk ? "" : ` (${resultMsg})`}`,
    tags: [decision.action.type.toLowerCase(), cfg.provider],
    importance: decision.action.type === "ATTACK" ? 0.8 : decision.action.type === "SPEAK" ? 0.4 : 0.2
  });

  // raw event (shows up in feed via SSE)
  await appendRawEvent({
    tick: world.tick,
    timestamp: Date.now(),
    actorId: me.id,
    category: "brain",
    type: `${decision.action.type}${decision.action.message ? `: ${decision.action.message}` : ""}`,
    result: resultOk ? "success" : "failed",
    reason: resultOk ? undefined : resultMsg,
    payload: { provider: cfg.provider, thought: decision.thought, action: decision.action }
  });
}

function toActionRequest(actorId: string, d: BrainDecision): ActionRequest | null {
  const a = d.action;
  switch (a.type) {
    case "MOVE":
      if ((a.dx ?? 0) === 0 && (a.dy ?? 0) === 0) return null;
      return { actorId, action: { type: "MOVE", dx: a.dx ?? 0, dy: a.dy ?? 0 } };
    case "ATTACK":
      if (!a.targetId) return null;
      return { actorId, action: { type: "ATTACK", targetId: a.targetId } };
    case "SPEAK":
      return { actorId, action: { type: "SPEAK", message: a.message ?? "…" } };
    case "USE":
      return { actorId, action: { type: "USE", itemId: a.itemId, targetId: a.targetId } };
    case "WAIT":
    default:
      return null;
  }
}

function mergeCap(prev: string[], next: string[], cap: number): string[] {
  const merged = [...prev, ...next];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of merged) {
    const k = s.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.slice(-cap);
}
