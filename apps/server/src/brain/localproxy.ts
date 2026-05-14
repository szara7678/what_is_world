import type { Actor, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import type { BrainConfig } from "../config/brainConfig";
import { LOCAL_PROXY_DEFAULTS } from "../config/brainConfig";
import { decideWithOpenRouter } from "./openrouter";
import type { BrainDecision, RecentDecision } from "./prompt";

export async function decideWithLocalProxy(
  cfg: BrainConfig,
  args: { world: WorldState; me: Actor; soul: Soul; thought: Thought; memories: Observation[]; invalidAction?: { reason: string; options: string[] }; lastDecisions?: RecentDecision[]; trustByActor?: Record<string, number>; relationships?: Array<{ from: string; to: string; affinity: number; lastInteractionTick: number; trust?: number }> }
): Promise<BrainDecision | null> {
  return decideWithOpenRouter({
    ...cfg,
    baseUrl: cfg.baseUrl || LOCAL_PROXY_DEFAULTS.baseUrl,
    apiKey: cfg.apiKey || LOCAL_PROXY_DEFAULTS.apiKey,
    model: cfg.model || LOCAL_PROXY_DEFAULTS.model
  }, args);
}
