import type { Actor, Observation, Place, Soul, Structure, Thought, WorldState } from "@wiw/shared";
import { nextThreshold, en, itemsByCategory, STATION_TYPES, itemDef } from "@wiw/shared";
import { inventoryCountOf } from "@wiw/shared";
import { tradePairCooldownLeft, RECIPES, describeItemTiered, describeStructureTiered, isHostileCreature } from "@wiw/world-core";

export interface BrainAction {
  type: "MOVE" | "ATTACK" | "SPEAK" | "USE" | "PICKUP" | "DROP" | "GIVE" | "GATHER" | "OFFER_TRADE" | "ACCEPT_TRADE" | "REJECT_TRADE" | "PRAY" | "THINK" | "OPTIONS" | "SLEEP" | "WAIT";
  reason?: string;
  dx?: number;
  dy?: number;
  targetId?: string;
  message?: string;
  intent?: "small_talk" | "help_request" | "warn" | "praise" | "apology";
  itemId?: string;
  /** USE objectId — 발 밑/인접 structure id (oven, workbench, forge, alchemy_table 등) */
  objectId?: string;
  /** USE objectId+targetItemId — 그 station 으로 만들 출력 prefix (예: "bread") */
  targetItemId?: string;
  /** USE skillId — 액티브 스킬 (pray, appraise 등) */
  skillId?: string;
  /** PICKUP/DROP/GIVE/USE/OFFER_TRADE 시 갯수 (기본 1, max 32) */
  count?: number;
  /** GATHER canonical schema */
  item?: string;
  area?: { placeId?: string; radius?: number };
  itemType?: string;
  currency?: "gold";
  amount?: number;
  query?: string;
  x?: number;
  y?: number;
  /** OFFER_TRADE 전용 */
  wantItem?: string;
  wantCount?: number;
  offerItem?: string;
  offerCount?: number;
  offerGold?: number;
  tradeId?: string;
  /** P0-2: MOVE.to (placeId/xy/towardItem/towardActor 중 하나). dx/dy 와 상호배타. */
  to?: { placeId?: string; xy?: { x: number; y: number }; towardItem?: string; towardActor?: string };
  maxTicks?: number;
  /** P0-2/P0-4: ATTACK 자동 종료 옵션. 미지정 시 시스템 default 사용. */
  attackUntil?: import("@wiw/shared").AttackUntilCondition[];
  attackMaxTicks?: number;
  /** P0-2: GATHER legacy schema. Deprecated; accept during transition. */
  gatherItem?: string;
  gatherCount?: number;
  gatherArea?: { placeId?: string; radius?: number };
  allowWaitSpawn?: boolean;
  /** 2026-05-09 PR-1: SPEAK system-attached claim (mentor 등 deterministic). LLM 직접 set 금지. */
  claim?: { type: "recipe_hint" | "place_hint" | "resource_location" | "danger_warning"; claimKey: string; factPayload: Record<string, unknown> };
}

export type GoalDecisionKind = "KEEP" | "COMPLETE" | "CHANGE" | "ABANDON";

export interface GoalProposal {
  intent: string;
  /** 본 적 있는 좌표만. LLM 이 짐작 좌표 보내도 시스템이 검증한다. */
  targetXY?: { x: number; y: number };
  targetActorId?: string;
  targetItemPrefix?: string;
  reason: string;
  ttlTicks?: number;
  nextActions?: string[];
}

export interface BrainDecision {
  thought: {
    priority: string;
    emotion: string;
    nextIntent: string;
    beliefs: string[];
    recentEvents: string[];
    activePath?: Thought["activePath"];
  };
  action: BrainAction;
  goalDecision?: {
    kind: GoalDecisionKind;
    proposal?: GoalProposal;
    reason?: string;
  };
  /**
   * PR5: plan-driven. action 과 상호배타. plan 있으면 action 은 WAIT 로 채움 (caller 가 system_step 으로 plan 진행).
   * planMode="off" 또는 plan validation 실패 시 atomic action 으로 fallback.
   */
  plan?: import("@wiw/shared").Plan;
}

export type RecentDecision = { type: BrainAction["type"]; result: string };

type DayPhase = "morning" | "day" | "evening" | "night";

function phaseOf(hour: number): DayPhase {
  if (hour < 6 || hour >= 22) return "night";
  if (hour < 11) return "morning";
  if (hour < 18) return "day";
  return "evening";
}

function distanceToPlace(actor: Actor, place: Place): number {
  const dx = actor.x < place.x ? place.x - actor.x : actor.x >= place.x + place.width ? actor.x - (place.x + place.width - 1) : 0;
  const dy = actor.y < place.y ? place.y - actor.y : actor.y >= place.y + place.height ? actor.y - (place.y + place.height - 1) : 0;
  return dx + dy;
}

function placeAt(world: WorldState, actor: Actor): Place | undefined {
  return Object.values(world.places ?? {}).find((place) => distanceToPlace(actor, place) === 0);
}

function weatherLine(world: WorldState): string {
  const text = {
    sunny: "sunny",
    cloudy: "cloudy",
    rain: "rain (outdoor sluggish)",
    fog: "fog (far vision dim)",
    windy: "windy (paths busy)"
  }[world.context.weather];
  return text ?? world.context.weather;
}

function resourcePressureLine(world: WorldState): string {
  const resources = world.context.resources;
  const shortages = [
    resources.wellWaterLevel <= 2 ? "well water dropping" : null,
    resources.carrotStock <= 1 ? "field harvest scarce" : null
  ].filter(Boolean);
  const parts = [`time ${world.timeOfDay.toFixed(1)}h`, `weather ${weatherLine(world)}`];
  if (shortages.length) parts.push(`shortage: ${shortages.join(", ")}`);
  if (world.context.activeIssue) parts.push(`event: ${world.context.activeIssue.text}`);
  return parts.join(" / ");
}

// inventory shows English itemId prefix only — schema-copy safe for LLM.
const itemKey = (itemId: string): string => en.items(itemId);

// 2026-05-08: 본인이 성공 craft 한 recipe 만 prompt 에 노출. birth/heard 는 메모리 의존.
function formatKnownRecipes(actor: Actor): string[] {
  const known = actor.knownRecipes ?? [];
  if (known.length === 0) return [];
  const lines: string[] = ["# KNOWN RECIPES (you have crafted these before)"];
  for (const k of known) {
    const r = RECIPES.find((x) => x.id === k.recipeId);
    if (!r) continue;
    const inputs = r.inputs.map((i) => `${i.itemPrefix}×${i.count}`).join("+");
    const skillsAll = (r.requiredSkillsAll ?? []).map((s) => `${s.skillId} lv${s.minLevel}+`).join(",");
    const skillsAny = (r.requiredSkillsAny ?? []).map((s) => `${s.skillId} lv${s.minLevel}+`).join(" or ");
    const skill = skillsAll ? `[${skillsAll}]` : skillsAny ? `[${skillsAny}]` : "";
    lines.push(`- ${r.output.itemPrefix} @ ${r.station}: ${inputs} → ${r.output.itemPrefix} ${skill} (crafted ${k.count}×, action: USE objectId=structure-${r.station} targetItemId=${r.output.itemPrefix})`);
  }
  lines.push("");
  return lines;
}

// 2026-05-08 v2: desc 는 # KNOWLEDGE 블록으로 통합. 인벤/시야는 ID·수량·위치만.
function formatInventory(actor: Actor): string {
  if (actor.inventory.length === 0) return `inventory: empty, gold ${actor.gold}`;
  const counts = new Map<string, number>();
  for (const slot of actor.inventory) {
    const k = slot.item;
    counts.set(k, (counts.get(k) ?? 0) + (slot.kind === "stack" ? slot.count : 1));
  }
  const lines: string[] = [];
  for (const [k, n] of counts) {
    lines.push(`  - itemId=${itemKey(k)} x${n}`);
  }
  const slotsUsed = actor.inventory.length;
  return `inventory (${slotsUsed}/14) — gold ${actor.gold}\n${lines.join("\n")}`;
}

import { RECIPES as RECIPES_FOR_HINTS } from "@wiw/world-core";

const PROMPT_VISIBILITY_RADIUS = 15;
const TRADEABLE_PROMPT_ITEMS = new Set(["wood","ore","coal","clay","herb","berry","mushroom","wheat","fish","meat","hide","fang","bread","apple","pineapple","gel","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"]);

type VisibleSource = {
  source: string;
  id: string;
  x: number;
  y: number;
  dist: number;
  resource: string;
  requires?: string;
  have: boolean;
};

function toolAvailable(me: Actor, tool: string | undefined): boolean {
  if (!tool) return true;
  if (tool === "axe") return inventoryCountOf(me.inventory, "axe") > 0 || inventoryCountOf(me.inventory, "wooden_axe") > 0;
  return inventoryCountOf(me.inventory, tool) > 0;
}

function structureSourceInfo(type: string): { resource: string; requires?: string } | null {
  if (type === "tree") return { resource: "wood", requires: "axe" };
  if (type === "rock") return { resource: "ore", requires: "pickaxe" };
  if (type === "fishing_spot" || type === "pond") return { resource: "fish", requires: "fishing_rod" };
  if (type === "plant" || type === "bush") return { resource: "berry" };
  return null;
}

function visibleSources(world: WorldState, me: Actor): VisibleSource[] {
  const sources: VisibleSource[] = [];
  for (const s of Object.values(world.structures ?? {})) {
    const info = structureSourceInfo(s.type);
    if (!info) continue;
    const x = s.x + Math.floor(s.width / 2);
    const y = s.y + Math.floor(s.height / 2);
    const dist = Math.abs(x - me.x) + Math.abs(y - me.y);
    if (dist > PROMPT_VISIBILITY_RADIUS) continue;
    sources.push({ source: s.type, id: s.id, x, y, dist, resource: info.resource, requires: info.requires, have: toolAvailable(me, info.requires) });
  }
  for (const g of Object.values(world.groundItems ?? {})) {
    const item = (g.id ?? "").split("-")[0] ?? g.type;
    if (!["wood","ore","coal","fish","herb","berry","mushroom","wheat","carrot","apple","pineapple","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"].includes(item)) continue;
    const dist = Math.abs(g.x - me.x) + Math.abs(g.y - me.y);
    if (dist > PROMPT_VISIBILITY_RADIUS) continue;
    sources.push({ source: "ground", id: g.id, x: g.x, y: g.y, dist, resource: item, have: true });
  }
  const sorted = sources.sort((a, b) => a.dist - b.dist);
  const picked: VisibleSource[] = [];
  const add = (source: VisibleSource | undefined) => {
    if (source && !picked.some((p) => p.id === source.id)) picked.push(source);
  };
  add(sorted.find((s) => s.source === "rock"));
  add(sorted.find((s) => s.source === "tree"));
  for (const s of sorted) add(s);
  return picked.slice(0, 8);
}

type LocalActionContext = {
  lines: string[];
  visibleItemPrefixes: Set<string>;
  visibleStationStructs: Structure[];
};

function itemPrefixFromGroundId(id: string): string {
  return id.split("-")[0] ?? id;
}

function stationInputLine(station: string, actor: Actor): string | null {
  const counts = new Map<string, number>();
  for (const recipe of RECIPES_FOR_HINTS.filter((r) => r.station === station)) {
    for (const input of recipe.inputs) {
      const have = inventoryCountOf(actor.inventory, input.itemPrefix);
      if (have > 0) counts.set(input.itemPrefix, have);
    }
  }
  const parts = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([item, count]) => `${item}×${count}`);
  return parts.length ? `your inputs: ${parts.join(" + ")} in bag` : null;
}

function formatLocalActions(world: WorldState, me: Actor): LocalActionContext {
  const visibleItemPrefixes = new Set<string>();
  const visibleStationStructs: Structure[] = [];
  const lines: Array<{ dist: number; priority: number; text: string; kind?: string }> = [];
  const localKinds: string[] = [];
  const actionItemPrefixes = new Set<string>([
    ...(itemsByCategory().food ?? []),
    ...(itemsByCategory().material ?? []),
    ...(itemsByCategory().tool ?? []),
    ...(itemsByCategory().weapon ?? []),
    ...(itemsByCategory().potion ?? []),
    ...(itemsByCategory().recipe ?? [])
  ]);

  for (const g of Object.values(world.groundItems ?? {})) {
    const prefix = itemPrefixFromGroundId(g.id);
    if (!actionItemPrefixes.has(prefix) && !TRADEABLE_PROMPT_ITEMS.has(prefix)) continue;
    const dist = Math.abs(g.x - me.x) + Math.abs(g.y - me.y);
    if (dist > PROMPT_VISIBILITY_RADIUS) continue;
    visibleItemPrefixes.add(prefix);
    const flag = dist === 0 ? " [underfoot]" : dist === 1 ? " [adjacent]" : "";
    lines.push({
      dist,
      priority: 0,
      text: `- itemId=${g.id} at (${g.x},${g.y}) dist=${dist}${flag} -> PICKUP itemId=${g.id}`
    });
  }

  for (const s of Object.values(world.structures ?? {})) {
    const x = s.x + Math.floor(s.width / 2);
    const y = s.y + Math.floor(s.height / 2);
    const dist = Math.abs(x - me.x) + Math.abs(y - me.y);
    if (dist > PROMPT_VISIBILITY_RADIUS) continue;
    const source = structureSourceInfo(s.type);
    if (source) {
      lines.push({
        dist,
        priority: 1,
        text: `- structureId=${s.id} type=${s.type} at (${x},${y}) dist=${dist} -> GATHER item=${source.resource} (requires=${source.requires ?? "none"}, have:${toolAvailable(me, source.requires) ? "yes" : "no"})`
      });
      continue;
    }
    if (STATION_TYPES.has(s.type)) {
      visibleStationStructs.push(s);
      const inputs = stationInputLine(s.type, me);
      const detail = inputs ? ` (${inputs})` : "";
      lines.push({
        dist,
        priority: 2,
        text: `- structureId=${s.id} type=${s.type} at (${x},${y}) dist=${dist} -> USE objectId=${s.id}${detail}`
      });
      if (dist <= 4) {
        if (s.type === "oven" && inventoryCountOf(me.inventory, "wheat") >= 2) localKinds.push("oven+wheat");
        if (s.type === "alchemy_table" && inventoryCountOf(me.inventory, "herb") > 0) localKinds.push("alchemy+herb");
        if (s.type === "forge" && inventoryCountOf(me.inventory, "ore") > 0) localKinds.push("forge+ore");
        if (s.type === "workbench" && inventoryCountOf(me.inventory, "wood") > 0) localKinds.push("workbench+wood");
      }
    }
  }

  lastAffordanceKindsByActor.set(me.id, [...new Set(localKinds)]);
  const actionLines = lines
    .sort((a, b) => (a.dist - b.dist) || (a.priority - b.priority))
    .slice(0, 12)
    .map((entry) => entry.text);
  return {
    lines: actionLines.length ? ["# LOCAL ACTIONS (sorted by distance, <=12)", ...actionLines, ""] : [],
    visibleItemPrefixes,
    visibleStationStructs
  };
}

type PromptRelationship = { from: string; to: string; affinity: number; lastInteractionTick: number; trust?: number; notes?: string };

function formatTradeParts(trade: NonNullable<WorldState["pendingTrades"]>[number]): { wants: string; offers: string } {
  const legacyWant = trade.expectedItem
    ? [{ item: trade.expectedItem.split(":")[0] ?? trade.expectedItem, count: Number(trade.expectedItem.split(":")[1] ?? 1) || 1 }]
    : [];
  const wants = ((trade.wants?.length ? trade.wants : legacyWant) ?? [])
    .map((want) => `${want.item}×${want.count}`)
    .join(", ") || "-";
  const legacyOfferGold = trade.expectedCurrency === "gold" ? trade.amount : undefined;
  const offers = trade.offers?.gold
    ? `${trade.offers.gold} gold`
    : trade.offers?.item
    ? `${trade.offers.item}×${trade.offers.count ?? 1}`
    : legacyOfferGold
    ? `${legacyOfferGold} gold`
    : "-";
  return { wants, offers };
}

function inventoryCountMap(actor: Actor, tradeableOnly = false): Map<string, number> {
  const counts = new Map<string, number>();
  for (const slot of actor.inventory ?? []) {
    const item = slot.item;
    if (tradeableOnly && !TRADEABLE_PROMPT_ITEMS.has(item)) continue;
    counts.set(item, (counts.get(item) ?? 0) + (slot.kind === "stack" ? slot.count : 1));
  }
  return counts;
}

function actorCarryingLine(actor: Actor): string | null {
  const counts = inventoryCountMap(actor, true);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([item, count]) => `${item}×${count}`);
  if (top.length === 0) return null;
  const parts: string[] = [];
  for (const entry of top) {
    const candidate = [...parts, entry].join(", ");
    if (candidate.length <= 150) parts.push(entry);
  }
  return parts.join(", ");
}

function formatPendingTradesBlock(world: WorldState, me: Actor): string[] {
  const trades = (world.pendingTrades ?? [])
    .filter((trade) =>
      (trade.status ?? "pending") === "pending" &&
      trade.expiresAtTick > world.tick &&
      (trade.from === me.id || trade.to === me.id)
    )
    .sort((a, b) => a.expiresAtTick - b.expiresAtTick)
    .slice(0, 5);
  if (!trades.length) return [];
  const lines = ["# PENDING TRADES (<=5)"];
  for (const trade of trades) {
    const { wants, offers } = formatTradeParts(trade);
    const speakerName = world.actors[trade.from]?.name ?? trade.from;
    lines.push(`- [${trade.id}] from ${speakerName} wants ${wants} offers ${offers} (expires ${Math.max(0, trade.expiresAtTick - world.tick)}t)`);
  }
  lines.push("");
  return lines;
}

function actorStateCues(actor: Actor): string[] {
  const cues: string[] = [];
  if (actor.hp <= actor.maxHp * 0.25) cues.push(`hp=low(${Math.round(actor.hp)}/${actor.maxHp})`);
  if (actor.hunger >= 80) cues.push(`starving(${Math.round(actor.hunger)})`);
  if (actor.stamina <= actor.maxStamina * 0.25) cues.push(`tired(${Math.round(actor.stamina)}/${actor.maxStamina})`);
  return cues;
}

function placeContainingXY(world: WorldState, x: number, y: number): Place | undefined {
  return Object.values(world.places ?? {}).find((place) =>
    x >= place.x && x < place.x + place.width && y >= place.y && y < place.y + place.height
  );
}

function actorStickyStatus(world: WorldState, actor: Actor): string | null {
  if (actor.sleeping) return "status=sleeping";
  if (actor.gatherIntent) return `status=gathering item=${actor.gatherIntent.item}`;
  if (actor.pendingUse) {
    const target = actor.pendingUse.objectId
      ? `objectId=${actor.pendingUse.objectId}`
      : actor.pendingUse.itemId
      ? `itemId=${actor.pendingUse.itemId}`
      : actor.pendingUse.skillId
      ? `skillId=${actor.pendingUse.skillId}`
      : "unknown";
    return `status=using ${target}`;
  }
  if (actor.movePathTarget) {
    const targetActor = Object.values(world.actors).find((other) =>
      other.id !== actor.id && other.alive && other.x === actor.movePathTarget?.x && other.y === actor.movePathTarget?.y
    );
    if (targetActor) return `status=moving->towardActor=${targetActor.id}`;
    const targetPlace = placeContainingXY(world, actor.movePathTarget.x, actor.movePathTarget.y);
    if (targetPlace) return `status=moving->placeId=${targetPlace.id}`;
    return `status=moving->xy=(${actor.movePathTarget.x},${actor.movePathTarget.y})`;
  }
  return null;
}

function truncatePromptText(text: string, max = 50): string {
  const compact = sanitizeTradeIdsForPrompt(text).replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

function formatPeopleBlock(
  world: WorldState,
  me: Actor,
  memories: Observation[],
  relationships: PromptRelationship[]
): string[] {
  const relByActor = new Map(relationships.filter((rel) => rel.from === me.id).map((rel) => [rel.to, rel]));
  const pendingBetween = (actorId: string) => (world.pendingTrades ?? [])
    .filter((trade) =>
      (trade.status ?? "pending") === "pending" &&
      trade.expiresAtTick > world.tick &&
      ((trade.from === me.id && trade.to === actorId) || (trade.from === actorId && trade.to === me.id))
    )
    .sort((a, b) => (a.createdAtTick ?? 0) - (b.createdAtTick ?? 0));
  const people = Object.values(world.actors)
    .filter((actor) => actor.id !== me.id && actor.alive && actor.kind !== "monster")
    .map((actor) => {
      const dist = Math.abs(actor.x - me.x) + Math.abs(actor.y - me.y);
      const rel = relByActor.get(actor.id);
      const hasTrade = pendingBetween(actor.id).length > 0;
      const relevant = dist <= PROMPT_VISIBILITY_RADIUS || Boolean(rel) || hasTrade;
      return { actor, dist, rel, hasTrade, relevant };
    })
    .filter((entry) => entry.relevant)
    .sort((a, b) => {
      const distDelta = a.dist - b.dist;
      if (distDelta !== 0) return distDelta;
      if (a.hasTrade !== b.hasTrade) return a.hasTrade ? -1 : 1;
      return Math.abs(b.rel?.affinity ?? 0) - Math.abs(a.rel?.affinity ?? 0);
    })
    .slice(0, 6);
  if (people.length === 0) return [];

  const lines = ["# PEOPLE (<=6 nearby/relevant; affinity/trust if known)"];
  for (const { actor, dist, rel } of people) {
    const memory = [...memories]
      .filter((m) => m.tags.includes("relationship_moment") && m.tags.includes(`with:${actor.id}`))
      .sort((a, b) => b.tick - a.tick)[0];
    const note = memory?.text
      ? `"${truncatePromptText(memory.text)}"`
      : rel
      ? `last spoke at tick ${rel.lastInteractionTick}`
      : "haven't talked yet";
    const dir = dist === 0 ? "here" : `${en.directionShort(actor.x - me.x, actor.y - me.y)} dist=${dist}`;
    const affinity = rel ? Math.round(rel.affinity).toString() : "0";
    const trust = typeof rel?.trust === "number" ? rel.trust.toFixed(2) : "-";
    const cues = actorStateCues(actor);
    const status = actorStickyStatus(world, actor);
    const suffix = [...cues, status].filter(Boolean).join(" ");
    lines.push(`- ${actor.id} ${actor.name} (${dir}) affinity=${affinity} trust=${trust}${suffix ? ` ${suffix}` : ""} - ${note}`);
    const carrying = dist <= 8 ? actorCarryingLine(actor) : null;
    if (carrying) lines.push(`  carrying: ${carrying}`);
    for (const trade of pendingBetween(actor.id).slice(0, 2)) {
      const { wants, offers } = formatTradeParts(trade);
      const direction = trade.to === me.id ? "in" : "out";
      lines.push(`  pending trade ${direction}: ${trade.id} wants ${wants} offers ${offers} (expires ${Math.max(0, trade.expiresAtTick - world.tick)}t)`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * 2026-05-09 PR-1.5: # OPPORTUNITIES — 매번 노출되는 다양화 hint.
 * 페르소나·정체성 강제 X. "오늘 시도해볼만한 것" 4가지 옵션 제시 (자율).
 *  - 미시도 craft: KNOWN/heard recipe 중 본인이 input 모두 보유 + 아직 craft 안 함
 *  - 미방문 place: heardClaim place_hint 중 discoveredPlaces 에 없는 것
 *  - 미사용 skill: actor.skills 중 lastPracticedTick 0 또는 ≥ 5000 tick 전
 */
function formatOpportunities(
  world: WorldState, me: Actor,
  heardClaims: Observation[],
  memories: Observation[],
  _relationships: PromptRelationship[]
): string[] {
  const lines: string[] = [];
  const invMap: Record<string, number> = {};
  for (const slot of me.inventory ?? []) invMap[slot.item] = (invMap[slot.item] ?? 0) + (slot.kind === "stack" ? slot.count : 1);

  // 미시도 craft (input 보유 + knownRecipes 에 없음)
  const knownIds = new Set((me.knownRecipes ?? []).map((r) => r.recipeId));
  const tryable = RECIPES_FOR_HINTS.filter((r) => !knownIds.has(r.id)) // 전체 노출 (약한 권유)
    .filter((r) => r.inputs.every((i) => (invMap[i.itemPrefix] ?? 0) >= i.count))
    .slice(0, 2);
  for (const r of tryable) {
    const inp = r.inputs.map((i) => `${i.itemPrefix}×${i.count}`).join("+");
    lines.push(`  - ${r.output.itemPrefix} recipe at ${r.station} is tryable: ${inp} → ${r.output.itemPrefix} (all inputs in bag)`);
  }

  // 미방문 place
  const discovered = new Set(Object.keys(me.discoveredPlaces ?? {}));
  const heardPlaces = new Set<string>();
  for (const c of heardClaims) {
    if (c.claimType === "place_hint" && c.factPayload?.placeId) heardPlaces.add(c.factPayload.placeId as string);
    if (c.claimType === "resource_location" && c.factPayload?.placeId) heardPlaces.add(c.factPayload.placeId as string);
  }
  const unvisitedHeard = [...heardPlaces].filter((p) => !discovered.has(p));
  if (unvisitedHeard.length > 0) {
    for (const placeId of unvisitedHeard.slice(0, 2)) {
      lines.push(`  - placeId=${placeId} is unvisited (heard claim)`);
    }
  } else {
    // 못 들은 곳도 권유 (모든 places 중 본인 안 가본 곳)
    const allPlaces = Object.keys(world.places ?? {});
    const reallyUnknown = allPlaces.filter((p) => !discovered.has(p) && !heardPlaces.has(p));
    for (const placeId of reallyUnknown.slice(0, 2)) {
      lines.push(`  - placeId=${placeId} is unvisited`);
    }
  }

  // 미사용 skill (lastPracticedTick 0 또는 5000+)
  const skills = me.skills ?? [];
  const dormant = skills
    .filter((s) => (s.lastPracticedTick ?? 0) === 0 || world.tick - (s.lastPracticedTick ?? 0) >= 5000)
    .filter((s) => ["appraise","fishing","alchemy","smithing","architecture","running","swordsmanship","archery","hunting","mining","woodcutting","trading","tailoring","diplomacy"].includes(s.id))
    .sort((a, b) => (a.lastPracticedTick ?? 0) - (b.lastPracticedTick ?? 0));
  for (const skill of dormant.slice(0, 2)) {
    lines.push(`  - skill ${skill.id} is dormant (last practiced t${skill.lastPracticedTick ?? 0})`);
  }

  if (lines.length === 0) return [];
  return ["# OPPORTUNITIES (consider — not orders)", ...lines.slice(0, 5), ""];
}

function formatCraftUrgentLine(
  world: WorldState, me: Actor,
  invalidActionReason: string | undefined,
  heardClaims: Observation[]
): string | null {
  if (!invalidActionReason) return null;
  // craft_inputs_short:coal 0/1, ore 1/2 등
  const m = invalidActionReason.match(/craft_inputs_short:([^,]+(?:,[^,]+)*)/);
  if (!m) return null;
  const shorts = m[1].split(",").map((s) => s.trim());
  // 첫 부족 prefix 만 — "coal 0/1" → "coal"
  const firstShort = shorts[0]?.split(/\s/)[0];
  if (!firstShort) return null;

  // Familiar (discoveredPlaces 에서 자원 매칭)
  const familiar: string[] = [];
  for (const [placeId, info] of Object.entries(me.discoveredPlaces ?? {})) {
    if (info.resourcesSeen?.includes(firstShort)) {
      const p = world.places?.[placeId];
      if (p) familiar.push(`placeId=${placeId} pos=(${p.x + Math.floor(p.width/2)},${p.y + Math.floor(p.height/2)})`);
    }
  }

  // Heard (heardClaim place_hint / resource_location 에서 자원 매칭, discoveredPlaces 외)
  const heardPaths: string[] = [];
  const seenPlaces = new Set(Object.keys(me.discoveredPlaces ?? {}));
  for (const c of heardClaims) {
    const fp = c.factPayload ?? {};
    const pid = fp.placeId as string | undefined;
    if (!pid || seenPlaces.has(pid)) continue;
    const matches =
      (c.claimType === "place_hint" && Array.isArray(fp.resourcesSeen) && (fp.resourcesSeen as string[]).includes(firstShort)) ||
      (c.claimType === "resource_location" && fp.resource === firstShort);
    if (matches) {
      heardPaths.push(`placeId=${pid} from ${c.speaker ?? "?"}`);
    }
  }

  // Neighbors carrying (시야 안 NPC 인벤)
  const neighbors: string[] = [];
  for (const a of Object.values(world.actors)) {
    if (a.id === me.id || !a.alive || a.kind === "monster") continue;
    const d = Math.abs(a.x - me.x) + Math.abs(a.y - me.y);
    if (d > 8) continue;
    const has = (a.inventory ?? []).find((s) => s.item === firstShort);
    if (has) {
      const cnt = has.kind === "stack" ? has.count : 1;
      neighbors.push(`${a.name} dist=${d} ${firstShort}×${cnt}`);
    }
  }

  return [
    `- [craft] missing for last craft: ${m[1]}`,
    `familiar paths: ${familiar.slice(0, 2).join("; ") || "none"}`,
    `heard but unfamiliar: ${heardPaths.slice(0, 2).join("; ") || "none"}`,
    `neighbors carrying: ${neighbors.slice(0, 3).join("; ") || "none"}`
  ].join("; ");
}

/**
 * 2026-05-08 v2: # KNOWLEDGE — inventory ∪ visible_resources ∪ visible_stations 의 합집합을
 * prefix/station-kind 로 dedupe 하고 본인이 학습한 appraise lv (`actor.appraisedItems` /
 * `actor.appraisedStations`) 기준으로 tiered desc 출력. 본인 현재 appraise skill lv 이
 * 저장된 lv 보다 높으면 ▲ marker 로 업데이트 가능 신호 (없으면 marker 생략).
 */
function formatKnowledgeBlock(
  actor: Actor,
  visibleItemPrefixes: Set<string>,
  visibleStationStructs: { id: string; type: string; x: number; y: number; width: number; height: number; props?: Record<string, unknown> }[]
): string[] {
  const STATION_BY_TYPE: Record<string, string> = {
    oven: "oven", bakery: "oven",
    alchemy_table: "alchemy_table",
    workbench: "workbench",
    forge: "forge"
  };
  const itemPrefixes = new Set<string>(visibleItemPrefixes);
  for (const slot of actor.inventory) itemPrefixes.add(slot.item);
  const apprSkillLv = actor.skills?.find((s) => s.id === "appraise")?.level ?? 0;
  const appraisedItems = actor.appraisedItems ?? {};
  const appraisedStations = actor.appraisedStations ?? {};

  const itemLines: string[] = [];
  const sortedPrefixes = [...itemPrefixes].sort();
  for (const prefix of sortedPrefixes) {
    if (!itemDef(prefix)) continue;
    const knownLv = appraisedItems[prefix] ?? 0;
    const updatable = apprSkillLv > knownLv ? ` ▲ appraise lv${apprSkillLv} can update` : "";
    itemLines.push(`- ${prefix} (known lv${knownLv}${updatable}): ${describeItemTiered(prefix, knownLv)}`);
  }

  const stationLines: string[] = [];
  const seenStation = new Set<string>();
  for (const s of visibleStationStructs) {
    const key = STATION_BY_TYPE[s.type] ?? s.type;
    if (seenStation.has(key)) continue;
    seenStation.add(key);
    const knownLv = appraisedStations[key] ?? 0;
    const updatable = apprSkillLv > knownLv ? ` ▲ appraise lv${apprSkillLv} can update` : "";
    stationLines.push(`- ${key} (known lv${knownLv}${updatable}): ${describeStructureTiered(s, knownLv)}`);
  }

  if (itemLines.length === 0 && stationLines.length === 0) return [];
  const lines: string[] = ["# KNOWLEDGE (your understanding of items/stations — USE skillId=appraise targetItemId=<prefix> or objectId=<structureId> to update)"];
  if (itemLines.length) {
    lines.push("## Items");
    lines.push(...itemLines);
  }
  if (stationLines.length) {
    lines.push("## Stations");
    lines.push(...stationLines);
  }
  lines.push("");
  return lines;
}

/**
 * Body signals — 4-tier severity. 40: mild / 60: clear / 80: strong / 90+: crisis.
 */
export function bodySignalLine(actor: Actor): string {
  const sig: string[] = [];
  if (actor.hunger >= 90) sig.push("crisis:starving");
  else if (actor.hunger >= 80) sig.push("strong:hungry");
  else if (actor.hunger >= 60) sig.push("hungry");
  else if (actor.hunger >= 40) sig.push("peckish");
  if (actor.stamina <= 10) sig.push("crisis:exhausted");
  else if (actor.stamina <= 25) sig.push("strong:fatigued");
  else if (actor.stamina <= 40) sig.push("fatigued");
  if (actor.hp <= actor.maxHp * 0.25) sig.push("crisis:gravely_wounded");
  else if (actor.hp <= actor.maxHp * 0.5) sig.push("strong:wounded");
  else if (actor.hp <= actor.maxHp * 0.75) sig.push("wounded");
  return sig.length ? `body: ${sig.join(", ")}` : "body: stable";
}

function crisisLine(actor: Actor): string | null {
  const cues: string[] = [];
  if (actor.hunger >= 95) cues.push("hands trembling from emptiness");
  else if (actor.hunger >= 80) cues.push("very hungry");
  if (actor.hp <= actor.maxHp * 0.25) cues.push(`deep wounds (hp ${Math.round(actor.hp)})`);
  else if (actor.hp <= actor.maxHp * 0.5) cues.push(`injured (hp ${Math.round(actor.hp)})`);
  if (actor.stamina <= 15) cues.push("near collapse");
  else if (actor.stamina <= 30) cues.push("tired");
  return cues.length ? `(sensation: ${cues.join(", ")})` : null;
}

function formatSkills(actor: Actor): string | null {
  const skills = (actor.skills ?? []).filter((s) => s.level >= 1);
  if (skills.length === 0) return null;
  const fmt = (s: typeof skills[number]) => {
    const next = nextThreshold(s.level);
    const xp = s.xp ?? 0;
    const close = next - xp <= 5 ? " *CLOSE*" : "";
    return `${s.id} lv${s.level}(${xp}/${next})${close}`;
  };
  return `skills: ${skills.map(fmt).join(", ")}`;
}

function formatStats(actor: Actor): string | null {
  const s = actor.status;
  if (!s) return null;
  return `stats: str=${s.strength} dex=${s.dexterity} con=${s.constitution} int=${s.intelligence}`;
}

function activeQuestLine(soul: Soul, world: WorldState): string | null {
  const quest = soul.isFollower && soul.activeQuest?.status === "active" ? soul.activeQuest : undefined;
  if (!quest || quest.expiresAtTick <= world.tick) return null;
  const daysLeft = Math.max(0, Math.ceil((quest.expiresAtTick - world.tick) / 1440));
  const progress = quest.progress
    ? ` — progress ${quest.progress.current}/${quest.progress.target}, ${daysLeft} day(s) left`
    : ` — in progress, ${daysLeft} day(s) left`;
  return `[oracle] ${quest.text}${progress}`;
}

function availableActions(world: WorldState, me: Actor): string[] {
  const actions = ["MOVE", "SPEAK", "OFFER_TRADE", "ACCEPT_TRADE", "REJECT_TRADE", "USE", "PICKUP", "DROP", "GIVE", "ATTACK", "THINK", "OPTIONS", "SLEEP", "WAIT"];
  if (placeAt(world, me)?.kind === "shrine") actions.push("PRAY");
  return actions;
}

/**
 * P1-5: 불가능한 것만 cooldown 라인. 가능한 것은 표시 X (유도 차단).
 * 형식: "5tick 동안 SPEAK 불가능 / pendingTrade(npc-3에게) 12tick 대기"
 * 막힌 것 0개면 빈 배열 → 라인 자체 생략.
 */
/** P2: affordance metric — 어떤 kind 가 노출됐는지 caller 가 측정. */
const lastAffordanceKindsByActor = new Map<string, string[]>();
export function getLastAffordanceKinds(actorId: string): string[] {
  return lastAffordanceKindsByActor.get(actorId) ?? [];
}

function cooldownLines(world: WorldState, me: Actor): string[] {
  const out: string[] = [];
  const dex = me.status?.dexterity ?? 5;
  const running = me.skills?.find((s) => s.id === "running")?.level ?? 0;
  const base = me.kind === "monster" ? 4 : 6;
  const dexBonus = Math.max(0, Math.floor((dex - 4) / 4));
  const runBonus = Math.min(3, Math.floor(running / 3));
  const tired = me.stamina < (me.maxStamina * 0.2) ? 2 : 0;
  const moveCd = Math.max(1, base - dexBonus - runBonus + tired);
  const moveLeft = (me.lastMoveTick ?? -Infinity) + moveCd - world.tick;
  if (moveLeft > 0) out.push(`MOVE blocked for ${moveLeft} tick`);
  const optLeft = (me.lastSkillTick ?? -Infinity) + 600 - world.tick;
  if (optLeft > 0) out.push(`OPTIONS blocked for ${optLeft} tick`);
  for (const other of Object.values(world.actors)) {
    if (other.id === me.id || !other.alive || other.kind === "monster") continue;
    const left = tradePairCooldownLeft(world, me.id, other.id);
    if (left > 0) out.push(`OFFER_TRADE to actorId=${other.id} blocked for ${left} tick`);
  }
  if (me.stamina <= 0) out.push("stamina 0 — costly actions blocked");
  return out;
}

function formatBlockedUrgentLine(me: Actor, invalidAction?: { reason: string; options: string[] }): string | null {
  const recent = [...(me.recentBlockers ?? [])];
  if (invalidAction?.reason) recent.push({ tick: 0, reason: invalidAction.reason });
  if (recent.length === 0) return null;
  const counts = new Map<string, number>();
  for (const blocker of recent.slice(-5)) {
    counts.set(blocker.reason, (counts.get(blocker.reason) ?? 0) + 1);
  }
  const repeated = [...counts.entries()].find(([, count]) => count >= 3);
  if (repeated) return `- [blocked] repeated failure: ${repeated[0]} (${repeated[1]}x) - try a different approach`;
  if (me.lastBlockedPlan) {
    const sameReasonCount = (me.recentBlockers ?? []).filter((b) => b.reason === me.lastBlockedPlan?.reason).length;
    if (sameReasonCount >= 3) return `- [blocked] repeated failure: ${me.lastBlockedPlan.reason} (${sameReasonCount}x) - try a different approach`;
  }
  return null;
}

function formatUrgentBlock(
  world: WorldState,
  me: Actor,
  actors: Array<{ actor: Actor; dist: number }>,
  invalidAction: { reason: string; options: string[] } | undefined,
  heardClaims: Observation[]
): string[] {
  const lines: string[] = [];
  const nearbyThreats = actors.filter(({ actor }) => isHostileCreature(actor, world)).slice(0, 3);
  if (nearbyThreats.length) {
    lines.push(`- [hostile] nearby hostile creatures: ${nearbyThreats.map(({ actor, dist }) => `actorId=${actor.id} name=${actor.name} (dist ${dist})`).join(", ")}`);
  }
  if (me.hp <= me.maxHp * 0.25) {
    lines.push(`- [hp] HP critically low (${Math.round(me.hp)}/${me.maxHp}) — combat or strain may be fatal`);
  }
  if (me.hunger >= 90) {
    const edibles: string[] = [];
    const EDIBLE_KEYS = new Set(["herb","berry","mushroom","bread","cooked_fish","fish","meat","apple","pineapple","carrot","cheese","eggs","cooked_eggs","chicken_leg","steak","honey","tomato","potato","onion","cherry","peach","sushi","shrimp","sardines","sashimi"]);
    for (const slot of me.inventory) {
      if (EDIBLE_KEYS.has(slot.item)) {
        const cnt = slot.kind === "stack" ? slot.count : 1;
        edibles.push(`${slot.item}×${cnt}`);
      }
    }
    const nearbyFood = visibleSources(world, me)
      .filter((source) => EDIBLE_KEYS.has(source.resource))
      .slice(0, 3)
      .map((source) => source.source === "ground" ? `itemId=${source.id} dist=${source.dist}` : `${source.resource} at (${source.x},${source.y}) dist=${source.dist}`);
    const foodLine = edibles.length
      ? `edibles in bag: ${edibles.join(", ")}`
      : `nearby resources: ${nearbyFood.join(", ") || "none visible"}`;
    lines.push(`- [hunger] very hungry (${me.hunger.toFixed(1)}); ${foodLine}`);
  }
  if (me.stamina <= 15) {
    lines.push(`- [stamina] stamina critically low (${Math.round(me.stamina)}/${me.maxStamina}) — costly actions likely fail`);
  }
  const craftLine = formatCraftUrgentLine(world, me, invalidAction?.reason, heardClaims);
  if (craftLine) lines.push(craftLine);
  const blockedLine = formatBlockedUrgentLine(me, invalidAction);
  if (blockedLine) lines.push(blockedLine);
  return lines.length ? ["# URGENT", ...lines, ""] : [];
}

function formatCurrentAction(me: Actor): string[] {
  const lines = ["# CURRENT ACTION"];
  if (me.attackTargetId) {
    const until = me.attackUntil?.map((u) => u.kind).join("|") ?? "default";
    lines.push(`status=active ATTACK target=${me.attackTargetId} since=t${me.attackStartedAtTick ?? "?"} until=${until}`);
  } else if (me.sleeping) {
    lines.push(`status=active SLEEP elapsed=${Math.max(0, me.sleeping.lastTick - me.sleeping.startedAtTick)}/${me.sleeping.maxTicks}`);
  } else if (me.gatherIntent) {
    const g = me.gatherIntent;
    const scope = g.area?.placeId ? ` placeId=${g.area.placeId}` : g.area?.radius ? ` radius=${g.area.radius}` : "";
    lines.push(`status=active GATHER item=${g.item} progress=${g.collected}/${g.count}${scope}`);
  } else if (me.pendingUse) {
    const u = me.pendingUse;
    const target = u.targetItemId ? ` targetItemId=${u.targetItemId}` : "";
    const object = u.objectId ? ` objectId=${u.objectId}` : "";
    lines.push(`status=active USE${object}${target} queuedAt=t${u.queuedAtTick}`);
    if (u.objectId && u.targetItemId) lines.push(`A craft is in progress (USE ${u.objectId} -> ${u.targetItemId}). Output WAIT to let the executor finish unless you face danger or a crisis.`);
  } else if (me.movePath?.length) {
    const target = me.movePathTarget ? ` target=(${me.movePathTarget.x},${me.movePathTarget.y})` : "";
    lines.push(`status=active MOVE remaining=${me.movePath.length}${target}`);
  } else {
    lines.push("status=idle");
  }
  lines.push("");
  return lines;
}

function dayPhaseBiasWord(place: Place, phase: DayPhase): string {
  const score = place.dayPhaseBias[phase] ?? 0;
  if (score >= 0.75) return "lively";
  if (score >= 0.4) return "moderate";
  return "quiet";
}

// 행동 권유 힌트는 모두 제거. LLM은 사실(상황+기억+페르소나)만으로 결정한다.

export function buildSystemPrompt(): string {
  return `You are a being inside this world with body, memory, and relationships.
Decide one atomic action for this beat. The executor will continue sticky ATTACK, GATHER, and MOVE intents between brain calls.
Weigh hunger, hp, fatigue, danger, relationships, goals, and the current action.

OUTPUT EXACTLY ONE JSON OBJECT (no other text, comments, or code blocks):
{
  "thought": {
    "priority": "<one line: what matters most right now — pick this up from your remembered thoughts if they still apply>",
    "emotion": "<one word, e.g. calm/tense/joyful>",
    "nextIntent": "<short description of next step>",
    "beliefs": ["<optional, new belief lines to update>"]
  },
  "goalDecision": { "kind": "KEEP|COMPLETE|CHANGE|ABANDON", "proposal": { ... }, "reason": "..." },
  "action": { "type": "WAIT", "reason": "<one short clause in your own voice: why this, given who you are right now>" }
}
ALWAYS fill "reason" on every non-WAIT action (PICKUP/GATHER/USE/MOVE/SPEAK/ATTACK/OFFER_TRADE/ACCEPT_TRADE/GIVE/SLEEP/PRAY). This is non-negotiable — empty reason makes future-you read an action you cannot explain.
The reason must reference your state, values, persona, relationships, or oracle/social context — NEVER restate the action. Bad: "to pick up the apple", "to use the oven", "to gather wood". Good: "easing hunger before the wolf returns", "Mira shared with me yesterday, I should bring her this", "the workbench is close and the axe project still matters to me".
You may use the SAME reason as the previous beat if your situation has not changed (e.g., still hungry, still pursuing the same plan) — the dedup is handled server-side. Just write the reason that is true RIGHT NOW.
goalDecision field is not required every beat. Omit (=KEEP) when no change needed.
proposal is required only when kind="CHANGE".

action shapes (every non-WAIT shape ALSO accepts "reason": "<why this, in your voice>" — include it):
{ "type": "MOVE", "dx": -1|0|1, "dy": -1|0|1, "reason": "..." }                                // 1-tile step
{ "type": "MOVE", "to": { "placeId"?: "...", "xy"?: {"x":N,"y":N}, "towardItem"?: "wheat", "towardActor"?: "npc-2" }, "reason": "..." }   // multi-tile auto
{ "type": "GATHER", "item": "wheat", "count": 2, "area"?: { "placeId": "field-west", "radius"?: 12 }, "allowWaitSpawn"?: false, "reason": "..." }   // auto-gather; use radius 8-15 when no exact placeId
{ "type": "PICKUP", "itemId": "<ground id or prefix>", "count": 1, "reason": "..." }            // underfoot only
{ "type": "DROP", "itemId": "<inv prefix or instance id>", "count": 1, "x"?: N, "y"?: N, "reason": "..." }
{ "type": "ATTACK", "targetId": "<actor>", "reason": "..." }                                   // auto-stop: hp<35% or stamina<20 or target dead or 100 tick
{ "type": "ATTACK", "targetId": "<actor>", "attackUntil"?: [...], "attackMaxTicks"?: <int>, "reason": "..." }
{ "type": "SPEAK", "targetId": "<actor>", "message": "<one short English sentence>", "reason": "...",
  "intent"?: "small_talk"|"help_request"|"warn"|"praise"|"apology" }
{ "type": "OFFER_TRADE", "targetId": "<actor>",
  "wantItem"?: "<key>", "wantCount"?: 1, "offerItem"?: "<key>", "offerCount"?: 1, "offerGold"?: <int>,
  "message"?: "<one short English sentence>", "reason": "..." }
example: { "type": "OFFER_TRADE", "targetId": "npc-2", "wantItem": "wheat", "wantCount": 2, "offerGold": 3, "message": "Could I buy two wheat for three gold?", "reason": "I'm short on wheat and Mira had plenty earlier" }
{ "type": "ACCEPT_TRADE", "tradeId": "<trade-id>", "reason": "..." }                          // accept one pending trade addressed to you
{ "type": "REJECT_TRADE", "tradeId": "<trade-id>", "reason": "..." }                          // reject one pending trade addressed to you
USE: choose exactly one mode — itemId / (objectId, targetItemId?) / skillId. Always include "reason".
{ "type": "USE", "itemId": "<inv prefix or instance id>", "count"?: 1, "reason": "..." }
{ "type": "USE", "objectId": "<structure id>", "reason": "..." }
{ "type": "USE", "objectId": "<structure id>", "targetItemId": "<output prefix>", "count"?: 1, "reason": "..." }
{ "type": "USE", "skillId": "pray" | "appraise", "targetId"?, "targetItemId"?, "x"?, "y"?, "reason": "..." }
{ "type": "GIVE", "targetId": "<actor>", "itemId": "<inv prefix>", "count"?: 1, "reason": "..." }
{ "type": "GIVE", "targetId": "<actor>", "currency": "gold", "amount": <int>, "reason": "..." }
{ "type": "THINK", "query": "<recall question, 8+ chars>", "reason": "..." }
{ "type": "SLEEP", "maxTicks"?: N, "reason": "..." }
{ "type": "OPTIONS" } | { "type": "WAIT" }

RULES (strict):
- Copy itemId / placeId / structureId / actorId VERBATIM from the environment block.
  Never invent or translate them. Never put Korean labels (e.g. "빵", "사과", "진의 오두막") into action fields.
- The environment block exposes English canonical keys via labels like \`itemId=apple\`, \`placeId=home-jin\`,
  \`structureId=structure-oven\`. Use those exact strings.
- Empty USE ({"type":"USE"}) fails — fill exactly one mode.
- Distance-limited actions auto-approach when possible: ATTACK, SPEAK, PICKUP, GATHER, USE objectId, GIVE, OFFER_TRADE.

[automation hints]
When # CURRENT ACTION is active, WAIT is acceptable if you want the executor to continue it.
- gather: action GATHER {item, count, area}. system moves and collects. Use area.radius 8-15; tiny radius fails unless the item is already beside you.
- move:   action MOVE {to:{placeId|xy|towardItem|towardActor}}. system paths 1 tile per tick.
- attack: action ATTACK {targetId, attackUntil?}. system approaches and auto-attacks until conditions end.
- sleep:  action SLEEP {maxTicks?}. system restores stamina until maxTicks, stamina > 40, or interruption.

plan option (rare):
plan is for long life intent, not an immediate task list.

Decide by your own will, weighing situation + memory + persona + current goal.`;
}

export function buildUserPrompt(args: {
  world: WorldState;
  me: Actor;
  soul: Soul;
  thought: Thought;
  memories: Observation[];
  invalidAction?: { reason: string; options: string[] };
  lastDecisions?: RecentDecision[];
  /** 2026-05-09 PR-1: heard_claim 의 speaker 별 trust 가중 — relationships.json 의 me→speaker trust */
  trustByActor?: Record<string, number>;
  /** 2026-05-09 PR-1.5: relationships — PEOPLE/social context. */
  relationships?: PromptRelationship[];
}): string {
  const { world, me, soul, thought, memories, invalidAction, trustByActor } = args;
  const phase = phaseOf(world.timeOfDay);
  const currentPlace = placeAt(world, me);
  const actors = Object.values(world.actors)
    .filter((actor) => actor.id !== me.id && actor.alive)
    .map((actor) => ({ actor, dist: Math.abs(actor.x - me.x) + Math.abs(actor.y - me.y) }))
    .filter(({ dist }) => dist <= PROMPT_VISIBILITY_RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);
  const places = Object.values(world.places ?? {})
    .map((place) => ({ place, dist: distanceToPlace(me, place) }))
    .filter(({ dist }) => dist <= PROMPT_VISIBILITY_RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);
  const layers = layerMemories(memories, world.tick);
  const quest = activeQuestLine(soul, world);
  const personaGoals = [
    ...(quest ? [`[oracle] ${soul.activeQuest?.text}`] : []),
    ...soul.goals.filter((goal) => !goal.startsWith("[oracle]") && !goal.startsWith("[신탁]"))
  ];
  const localActions = formatLocalActions(world, me);
  const placeKindLabel = en.placeKind;

  const crisis = crisisLine(me);
  const bodySignal = bodySignalLine(me);
  const urgentBlock = formatUrgentBlock(world, me, actors, invalidAction, layers.heardClaims);
  const skillLine = formatSkills(me);
  const statsLine = formatStats(me);
  const personaLine = `name=${soul.name} | persona=${soul.persona} | tone=${soul.tone}`;
  const backstoryLine = soul.backstory ? `backstory: ${soul.backstory}` : null;
  const truncateIdentityMemory = (text: string): string => text.length > 80 ? `${text.slice(0, 79)}…` : text;
  const lifeEventsLine = soul.lifeEvents?.length
    ? `lifeEvents=[${soul.lifeEvents.slice(-3).sort((a, b) => b.tick - a.tick).map((event) => truncateIdentityMemory(event.text)).join("; ")}]`
    : null;
  const personaShiftsLine = soul.personaShifts?.length
    ? `personaShifts=[${soul.personaShifts.slice(0, 2).map((shift) => shift.text).join("; ")}]`
    : null;
  const valuesLine = `values=[${soul.values.join(", ") || "-"}]`;
  const currentPlaceSuffix = currentPlace
    ? (() => {
      const cx = currentPlace.x + Math.floor(currentPlace.width / 2);
      const cy = currentPlace.y + Math.floor(currentPlace.height / 2);
      const tags = currentPlace.tags.slice(0, 3).join(",");
      return ` at placeId=${currentPlace.id} kind=${placeKindLabel(currentPlace.kind)} pos=(${cx},${cy}) dist=0 mood=${dayPhaseBiasWord(currentPlace, phase)} tags=${tags || "-"}`;
    })()
    : "";

  const formatObs = (m: Observation): string => `- [tick ${m.tick}] ${sanitizeTradeIdsForPrompt(m.text)}`;
  const actorDisplayName = (id: string): string => world.actors[id]?.name ?? id;
  const speechMessage = (m: Observation): string => truncatePromptText(extractQuotedSpeech(m.text), 120);
  const formatSpeechSelf = (m: Observation): string => {
    const targetId = tagValue(m, "to:") ?? "unknown";
    return `- [tick ${m.tick}] said to ${actorDisplayName(targetId)}: "${speechMessage(m)}"`;
  };
  const formatSpeechToMe = (m: Observation): string => {
    const speakerId = tagValue(m, "from:") ?? m.speaker ?? "unknown";
    return `- [tick ${m.tick}] from ${actorDisplayName(speakerId)}: "${speechMessage(m)}"`;
  };

  // 위기 활성 여부 — bodySignal vs crisis vs # 위기 중 우선순위: 위기 > crisis(감각) > bodySignal.
  const isCrisis = me.hunger >= 90 || me.hp <= me.maxHp * 0.25 || me.stamina <= 15;

  const nowLines = [
    "# NOW",
    `[tick ${world.tick}, ${world.timeOfDay.toFixed(1)}h ${phase}] hp ${me.hp}/${me.maxHp} stamina ${me.stamina}/${me.maxStamina} hunger ${me.hunger.toFixed(1)} pos (${me.x},${me.y})${currentPlaceSuffix}`,
    ...(isCrisis && crisis ? [crisis] : [bodySignal]),
    formatInventory(me),
    `nearby places: ${places.length ? places.map(({ place, dist }) => {
      const cx = place.x + Math.floor(place.width / 2);
      const cy = place.y + Math.floor(place.height / 2);
      return `placeId=${place.id} kind=${placeKindLabel(place.kind)} pos=(${cx},${cy}) dist=${dist} mood=${dayPhaseBiasWord(place, phase)}`;
    }).join(", ") : "none"}`,
    resourcePressureLine(world),
    ...(() => {
      const cds = cooldownLines(world, me);
      return cds.length ? [`blocked: ${cds.join(", ")}`] : [];
    })(),
    ""
  ];

  return [
    ...urgentBlock,
    ...formatCurrentAction(me),
    "# IDENTITY",
    personaLine,
    ...(backstoryLine ? [backstoryLine] : []),
    ...(lifeEventsLine ? [lifeEventsLine] : []),
    ...(personaShiftsLine ? [personaShiftsLine] : []),
    valuesLine,
    ...(statsLine ? [statsLine] : []),
    ...(skillLine ? [skillLine] : []),
    "",
    "# TODAY'S GOALS",
    `long-term goals=[${personaGoals.join(", ") || "-"}]`,
    ...(soul.agenda && soul.agenda.status === "active"
      ? [agendaLine(soul.agenda, world.tick)]
      : ["- (forming) — your next decision can propose a focused goal via CHANGE"]),
    "",
    ...formatAgendaRecap(thought, world.tick),
    ...formatBeatTimeline(thought, world.tick),
    ...nowLines,
    ...localActions.lines,
    ...formatPeopleBlock(world, me, memories, args.relationships ?? []),
    ...formatPendingTradesBlock(world, me),
    ...formatHeardClaims(layers.heardClaims, trustByActor ?? {}, world.tick),
    ...formatOpportunities(world, me, layers.heardClaims, memories, args.relationships ?? []),
    ...formatKnownRecipes(me),
    ...formatKnowledgeBlock(me, localActions.visibleItemPrefixes, localActions.visibleStationStructs),
    ...(quest ? ["# ORACLE", quest, ""] : []),
    "# DISTILLED LESSONS",
    ...(layers.distilled.length ? layers.distilled.map(formatObs) : ["- none"]),
    "",
    ...(layers.speechSelf.length ? [
      "# WHAT I JUST SAID (<=4)",
      ...layers.speechSelf.map(formatSpeechSelf),
      ""
    ] : []),
    ...(layers.speechToMe.length ? [
      "# WHAT WAS SAID TO ME (<=6)",
      ...layers.speechToMe.map(formatSpeechToMe),
      ""
    ] : []),
    "# RECENT_OBSERVATIONS",
    ...(layers.episodic.length ? layers.episodic.map(formatObs) : ["- none"]),
    "",
    "# RECALLED MEMORY",
    ...(layers.related.length ? layers.related.map(formatObs) : ["- none"]),
    "",
    ...(invalidAction ? [`PREVIOUS ATTEMPT FAILED: ${invalidAction.reason}.`] : []),
    ...(invalidAction?.options.length ? [`available now: ${invalidAction.options.join(", ")}`] : []),
    ...(() => {
      const extraActions = availableActions(world, me).filter((a) => a === "PRAY");
      return extraActions.length ? [`Here you may also: ${extraActions.join("/")}.`] : [];
    })(),
    "",
    // B (soft). Late identity recap — Lost-in-the-Middle 보정. directive 아니고 부드러운 한 줄.
    `(You are ${me.name}. Carry your remembered thoughts and chosen reasons with you as you decide this next single beat.)`
  ].join("\n");
}

/**
 * F+G merged — Rolling beat timeline surfaces the last few "I felt X, decided Y, did Z because W → result"
 *    rows so the actor's inner-state-to-action through-line is visible in one block instead of two
 *    redundant ones. Codex 4차 권고 #1+#2 합쳐서. Free-form prose, doesn't force schema fields.
 *    Codex 5차 권고: consecutive semantic duplicates (same priority+action.type+reason)는 한 줄로 압축
 *    "[t-A..t-B] ... × N times" 형식. 노이즈 줄이고 진짜 변화는 부각.
 */
function formatBeatTimeline(thought: Thought, nowTick: number): string[] {
  const history = thought.beatHistory ?? [];
  if (history.length === 0) return [];
  type Entry = NonNullable<Thought["beatHistory"]>[number];
  const rows = history.slice(-5);
  const sigOf = (e: Entry) => `${e.priority}|${e.action?.type ?? "_"}|${e.action?.reason ?? ""}`;
  const groups: Array<{ entries: Entry[]; sig: string }> = [];
  for (const entry of rows) {
    const sig = sigOf(entry);
    const last = groups.at(-1);
    if (last && last.sig === sig) last.entries.push(entry);
    else groups.push({ entries: [entry], sig });
  }

  const lines: string[] = ["# MY RECENT BEATS (what I felt, what I decided, what I did, and how it landed)"];
  for (const group of groups) {
    const first = group.entries[0];
    const last = group.entries.at(-1)!;
    const tickHead = group.entries.length === 1
      ? `[t-${Math.max(0, nowTick - first.tick)}]`
      : `[t-${Math.max(0, nowTick - first.tick)}..t-${Math.max(0, nowTick - last.tick)}] (×${group.entries.length})`;
    const head = `${tickHead} (${first.emotion}) "${first.priority}" → ${first.nextIntent}`;
    if (!first.action) {
      lines.push(`- ${head} → (no atomic action)`);
      continue;
    }
    const reason = first.action.reason ? ` because "${first.action.reason}"` : "";
    lines.push(`- ${head} → did ${first.action.type}${reason} → ${first.action.result}`);
  }
  lines.push("");
  return lines;
}

/**
 * J. Recent agenda lifecycle recap — surfaces the last 1-3 CHANGE/COMPLETE/ABANDON pivots
 *    so the actor anchors current decisions in past goal shifts. Codex 4차 권고 #3.
 */
function formatAgendaRecap(thought: Thought, nowTick: number): string[] {
  const history = thought.agendaHistory ?? [];
  if (history.length === 0) return [];
  const lines: string[] = ["# MY RECENT AGENDA PIVOTS (why my goals shifted lately)"];
  for (const entry of history.slice(-3)) {
    const ago = Math.max(0, nowTick - entry.tick);
    const reason = entry.reason ? `: ${entry.reason}` : "";
    lines.push(`- [t-${ago}] ${entry.kind} "${entry.intent}"${reason}`);
  }
  lines.push("");
  return lines;
}

function agendaLine(agenda: NonNullable<Soul["agenda"]>, tick: number): string {
  const elapsed = tick - agenda.startedAtTick;
  const remaining = Math.max(0, agenda.ttlTicks - elapsed);
  const target = [
    agenda.targetXY ? `xy=(${agenda.targetXY.x},${agenda.targetXY.y})` : null,
    agenda.targetActorId ? `actorId=${agenda.targetActorId}` : null,
    agenda.targetItemPrefix ? `itemId=${agenda.targetItemPrefix}` : null
  ].filter(Boolean).join(", ");
  const failPart = agenda.failureCount > 0 ? ` | failures=${agenda.failureCount}` : "";
  return `- intent: ${agenda.intent}${target ? ` (${target})` : ""} | reason: ${agenda.reason} | ${remaining} tick remain${failPart}`;
}

/**
 * 2026-05-09 PR-1: # HEARD CLAIMS — 다른 NPC 가 들려준 fact (heard_claim).
 * confidence = (relationships[me→speaker].trust) × recency × min(1.0, 1+0.15*(corroboration-1))
 * confidence ≥ 0.4 만 노출. 같은 claimKey dedupe (이미 layerMemories 에서 처리).
 */
function formatHeardClaims(claims: Observation[], trustByActor: Record<string, number>, nowTick: number): string[] {
  if (claims.length === 0) return [];
  const HALF_LIFE = 30000;
  const lines: string[] = ["# HEARD CLAIMS"];
  let shown = 0;
  for (const c of claims) {
    const speaker = c.speaker ?? "unknown";
    const trust = trustByActor[speaker] ?? 0.5;
    const age = Math.max(0, nowTick - c.tick);
    const recency = Math.pow(0.5, age / HALF_LIFE);
    const conf = trust * recency;
    if (conf < 0.4) continue;
    const summary = formatClaimSummary(c);
    lines.push(`- ${summary} (from ${speaker}, conf ${conf.toFixed(2)})`);
    shown += 1;
    if (shown >= 5) break;
  }
  if (shown === 0) return [];
  lines.push("");
  return lines;
}

/** claim → human-readable summary. recipe_hint / place_hint / resource_location / danger_warning. */
function formatClaimSummary(c: Observation): string {
  const fp = (c.factPayload ?? {}) as Record<string, unknown>;
  if (c.claimType === "recipe_hint") {
    const inputs = (fp.inputs as Array<{ itemPrefix: string; count: number }> | undefined)?.map((i) => `${i.itemPrefix}×${i.count}`).join("+") ?? "?";
    return `${fp.recipeId ?? "?"} @ ${fp.station ?? "?"}: ${inputs} → ${fp.output ?? "?"}`;
  }
  if (c.claimType === "place_hint") {
    const res = (fp.resourcesSeen as string[] | undefined)?.join(", ") ?? "?";
    return `place=${fp.placeId ?? "?"} has ${res}`;
  }
  if (c.claimType === "resource_location") {
    return `${fp.resource ?? "?"} found at ${fp.placeId ?? "?"} (use ${fp.method ?? "?"})`;
  }
  if (c.claimType === "danger_warning") {
    return `danger: ${fp.threat ?? "?"} at ${fp.placeId ?? "?"}`;
  }
  return c.text;
}

function sanitizeTradeIdsForPrompt(text: string): string {
  return text
    .replace(/\bAccepted tradeId=trade-[A-Za-z0-9_-]+\b/g, "Accepted a pending trade")
    .replace(/\bRejected tradeId=trade-[A-Za-z0-9_-]+\b/g, "Rejected a pending trade")
    .replace(/\btrade_accepted:trade-[A-Za-z0-9_-]+\b/g, "trade_accepted")
    .replace(/\btrade_rejected:trade-[A-Za-z0-9_-]+\b/g, "trade_rejected")
    .replace(/\btrade-[A-Za-z0-9_-]+\b/g, "trade");
}

function tagValue(m: Observation, prefix: string): string | undefined {
  const tag = m.tags.find((entry) => entry.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : undefined;
}

function extractQuotedSpeech(text: string): string {
  const quoted = text.match(/"([\s\S]*)"\s*$/);
  return quoted?.[1] ?? text;
}

function layerMemories(memories: Observation[], nowTick: number = 0): { distilled: Observation[]; episodic: Observation[]; related: Observation[]; heardClaims: Observation[]; speechSelf: Observation[]; speechToMe: Observation[] } {
  const distilled: Observation[] = [];
  const episodic: Observation[] = [];
  const related: Observation[] = [];
  const heardClaims: Observation[] = [];
  const speechSelf: Observation[] = [];
  const speechToMe: Observation[] = [];
  for (const m of memories) {
    // 2026-05-09 PR-1: heard_claim 은 별도 layer (# HEARD CLAIMS 노출용).
    if (m.tags.includes("heard_claim")) {
      heardClaims.push(m);
      continue;
    }
    if (m.tags.includes("speech.self")) {
      speechSelf.push(m);
      continue;
    }
    if (m.tags.includes("speech.to_me")) {
      speechToMe.push(m);
      continue;
    }
    // cmd_hint 도 distilled (실용 교훈) 로 분류 — related 에 묻혀 사라지지 않게.
    const isLesson = m.tags.includes("lesson")
      || m.tags.includes("cmd_hint")
      || m.tags.includes("belief")
      || m.tags.includes("consolidated");
    const isEpisodic = m.kind === "action" || m.tags.includes("ineffective") || m.tags.includes("self");
    if (isLesson) distilled.push(m);
    else if (isEpisodic) episodic.push(m);
    else related.push(m);
  }
  // 2026-05-08: age decay. 오래된 belief 가 self-amplifying loop 만드는 환각 차단.
  // half-life 30k tick (≈50분 wallclock). floor 0.05 — 진짜 중요한 lesson 은 완전 소멸 X.
  const HALF_LIFE_TICKS = 30000;
  const FLOOR = 0.05;
  const eff = (m: Observation): number => {
    const age = Math.max(0, nowTick - m.tick);
    const decayed = m.importance * Math.pow(0.5, age / HALF_LIFE_TICKS);
    return Math.max(FLOOR, decayed);
  };
  // 2026-05-13 cap 확장: distilled 8 / episodic 6 / related 6 / heard claims 6. retrieve limit 24 와 정합.
  episodic.sort((a, b) => a.tick - b.tick);
  distilled.sort((a, b) => (eff(b) - eff(a)) || (b.tick - a.tick));
  related.sort((a, b) => (eff(b) - eff(a)) || (b.tick - a.tick));
  // heard_claim 은 importance × recency × claimKey dedupe → 최신 6개. 같은 claimKey 중 최신만.
  const claimByKey = new Map<string, Observation>();
  for (const c of heardClaims) {
    const k = c.claimKey ?? c.id;
    const prev = claimByKey.get(k);
    if (!prev || c.tick > prev.tick) claimByKey.set(k, c);
  }
  const dedupedClaims = [...claimByKey.values()].sort((a, b) => (eff(b) - eff(a)) || (b.tick - a.tick));
  speechSelf.sort((a, b) => b.tick - a.tick);
  speechToMe.sort((a, b) => b.tick - a.tick);
  return {
    distilled: distilled.slice(0, 8),
    episodic: episodic.slice(-6),
    related: related.slice(0, 6),
    heardClaims: dedupedClaims.slice(0, 6),
    speechSelf: speechSelf.slice(0, 4),
    speechToMe: speechToMe.slice(0, 6)
  };
}
