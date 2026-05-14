import {
  addToInventory,
  inventoryCountOf,
  itemKeyOf,
  removeFromInventory,
  type Actor,
  type InventorySlot,
  type PendingTrade,
  type PendingTradeItem,
  type PendingTradeOffer,
  type WorldState
} from "@wiw/shared";

const KOREAN_NUMBERS: Record<string, number> = {
  한: 1,
  두: 2,
  세: 3,
  네: 4,
  다섯: 5
};

const parseCount = (raw: string | undefined): number =>
  raw ? Number(raw) || KOREAN_NUMBERS[raw] || 1 : 1;

/**
 * P0-3: trade pair cooldown — 같은 (from, to) 짝 직전 trade_request 후 30 tick 동안
 * 새 trade_request 차단. 만료/거절 후 60 tick. 사용자 관찰: 상대가 묶여 다음 행동 못 함.
 * 단방향. global cooldown 은 사회 전체 얼어붙히므로 사용 X.
 */
const tradeCooldownByWorld = new WeakMap<WorldState, Map<string, number>>(); // `${from}:${to}` → unblockTick

const tradeCooldownsFor = (world: WorldState): Map<string, number> => {
  let map = tradeCooldownByWorld.get(world);
  if (!map) {
    map = new Map<string, number>();
    tradeCooldownByWorld.set(world, map);
  }
  return map;
};

export const tradePairCooldownLeft = (world: WorldState, from: string, to: string): number => {
  const k = `${from}:${to}`;
  const cooldowns = tradeCooldownsFor(world);
  const until = cooldowns.get(k) ?? 0;
  if (until - world.tick > 120) {
    cooldowns.delete(k);
    return 0;
  }
  return Math.max(0, until - world.tick);
};

export const setTradePairCooldown = (world: WorldState, from: string, to: string, ticks: number): void => {
  const k = `${from}:${to}`;
  tradeCooldownsFor(world).set(k, world.tick + ticks);
};

const tradeId = (world: WorldState, from: string, to: string): string =>
  `trade-${world.tick}-${from}-${to}-${Math.random().toString(36).slice(2, 6)}`;

const parseLegacyExpectedItem = (raw: string | undefined): PendingTradeItem[] => {
  if (!raw) return [];
  const [itemRaw, countRaw] = raw.split(":");
  const item = itemKeyOf(itemRaw ?? "");
  if (!item) return [];
  return [{ item, count: Math.max(1, Math.floor(Number(countRaw ?? 1) || 1)) }];
};

export const normalizePendingTrade = (world: WorldState, raw: PendingTrade): PendingTrade => {
  const wants = Array.isArray(raw.wants) && raw.wants.length
    ? raw.wants.map((w) => ({ item: itemKeyOf(w.item), count: Math.max(1, Math.floor(Number(w.count ?? 1))) })).filter((w) => w.item)
    : parseLegacyExpectedItem(raw.expectedItem);
  const legacyOffer: PendingTradeOffer = raw.expectedCurrency === "gold"
    ? { gold: Math.max(0, Math.floor(Number(raw.amount ?? 0))) }
    : {};
  return {
    ...raw,
    id: raw.id || tradeId(world, raw.from, raw.to),
    wants,
    offers: raw.offers ?? legacyOffer,
    createdAtTick: raw.createdAtTick ?? Math.max(0, raw.expiresAtTick - 60),
    status: raw.status ?? "pending"
  };
};

export const normalizePendingTrades = (world: WorldState): PendingTrade[] => {
  world.pendingTrades = (world.pendingTrades ?? []).map((trade) => normalizePendingTrade(world, trade));
  return world.pendingTrades;
};

const pushWorldEvent = (
  world: WorldState,
  event: Omit<NonNullable<WorldState["eventQueue"]>[number], "tick">
): void => {
  world.eventQueue ??= [];
  world.eventQueue.push({ tick: world.tick, ...event });
};

const tradeFailureEventType = (reason: string): string => `trade_accept_failed:${reason}`;

const failAcceptTrade = (
  world: WorldState,
  actorId: string,
  trade: PendingTrade | undefined,
  reason: string
): { ok: false; message: string } => {
  if (trade) {
    trade.status = "rejected";
    trade.reason = reason;
    trade.resolvedAtTick = world.tick;
    setTradePairCooldown(world, trade.from, trade.to, 60);
    world.revision += 1;
  }
  pushWorldEvent(world, {
    actorId,
    category: "action",
    type: tradeFailureEventType(reason),
    result: "failed",
    reason,
    payload: trade
      ? { tradeId: trade.id, from: trade.from, to: trade.to, wants: trade.wants, offers: trade.offers }
      : { tradeId: undefined }
  });
  return { ok: false, message: `trade_rejected:${reason}` };
};

export const cleanupPendingTrades = (world: WorldState): string[] => {
  const trades = normalizePendingTrades(world);
  const closed: string[] = [];
  for (const trade of trades) {
    if (trade.status !== "pending") continue;
    if (trade.expiresAtTick <= world.tick) {
      trade.status = "expired";
      trade.resolvedAtTick = world.tick;
      trade.reason = "ttl_expired";
      setTradePairCooldown(world, trade.from, trade.to, 60);
      closed.push(`거래 만료: ${trade.id}`);
      pushWorldEvent(world, {
        actorId: trade.from,
        category: "world",
        type: "trade:expired",
        result: "info",
        reason: "ttl_expired",
        payload: { tradeId: trade.id, from: trade.from, to: trade.to }
      });
    }
  }

  const pendingByReceiver = new Map<string, PendingTrade[]>();
  for (const trade of trades) {
    if (trade.status !== "pending") continue;
    const list = pendingByReceiver.get(trade.to) ?? [];
    list.push(trade);
    pendingByReceiver.set(trade.to, list);
  }
  for (const list of pendingByReceiver.values()) {
    list.sort((a, b) => a.createdAtTick - b.createdAtTick);
    while (list.length > 5) {
      const trade = list.shift();
      if (!trade) break;
      trade.status = "auto_rejected";
      trade.resolvedAtTick = world.tick;
      trade.reason = "receiver_inbox_full";
      setTradePairCooldown(world, trade.from, trade.to, 60);
      closed.push(`거래 자동거절: ${trade.id}`);
      pushWorldEvent(world, {
        actorId: trade.from,
        category: "world",
        type: "trade:auto_rejected",
        result: "info",
        reason: "receiver_inbox_full",
        payload: { tradeId: trade.id, from: trade.from, to: trade.to }
      });
    }
  }

  return closed;
};

const upsertPendingTrade = (
  world: WorldState,
  from: string,
  to: string,
  wants: PendingTradeItem[],
  offers: PendingTradeOffer
): void => {
  if (wants.length === 0 && !offers.item && !offers.gold) return;
  world.pendingTrades ??= [];
  normalizePendingTrades(world);
  world.pendingTrades.push({
    id: tradeId(world, from, to),
    from,
    to,
    wants,
    offers,
    createdAtTick: world.tick,
    expiresAtTick: world.tick + 150,
    status: "pending"
  });
  setTradePairCooldown(world, from, to, 30);
  cleanupPendingTrades(world);
};

export const createPendingTradeFromSpeech = (
  world: WorldState,
  from: string,
  to: string | undefined,
  message: string
): void => {
  if (!to) return;
  const goldMatch = message.match(/(\d+|한|두|세|네|다섯)\s*(?:골드|gold)/i);
  const carrotMatch = message.match(/당근\s*(\d+|한|두|세|네|다섯)?\s*(?:개)?/);
  if (!goldMatch && !carrotMatch) return;

  const offers = goldMatch ? { gold: parseCount(goldMatch[1]) } : {};
  const wants = carrotMatch ? [{ item: "carrot", count: parseCount(carrotMatch[1]) }] : [];
  upsertPendingTrade(world, from, to, wants, offers);
};

/**
 * 명시적 OFFER_TRADE 로부터 pendingTrade open.
 * wants = proposer 가 받고 싶은 것, offers = proposer 가 줄 것.
 */
export const createPendingTradeFromIntent = (
  world: WorldState,
  from: string,
  to: string,
  offer: { wantItem?: string; wantCount?: number; offerItem?: string; offerCount?: number; offerGold?: number }
): void => {
  if (tradePairCooldownLeft(world, from, to) > 0) return;
  const wants = offer.wantItem
    ? [{ item: itemKeyOf(offer.wantItem), count: Math.max(1, Math.floor(offer.wantCount ?? 1)) }]
    : [];
  const offers: PendingTradeOffer = {};
  if (offer.offerItem) {
    offers.item = itemKeyOf(offer.offerItem);
    offers.count = Math.max(1, Math.floor(offer.offerCount ?? 1));
  }
  if (offer.offerGold !== undefined && offer.offerGold > 0) {
    offers.gold = Math.max(1, Math.floor(offer.offerGold));
  }
  upsertPendingTrade(world, from, to, wants, offers);
};

const cloneInventory = (inv: InventorySlot[]): InventorySlot[] => inv.map((slot) => ({ ...slot }));

const applyItemTransfer = (
  fromInv: InventorySlot[],
  toInv: InventorySlot[],
  item: string,
  count: number,
  slotCap: number
): boolean => {
  const key = itemKeyOf(item);
  if (inventoryCountOf(fromInv, key) < count) return false;
  const added = addToInventory(toInv, key, count, slotCap);
  if (added.added !== count) return false;
  const removed = removeFromInventory(fromInv, key, count);
  return removed === count;
};

export const acceptPendingTrade = (
  world: WorldState,
  actorId: string,
  tradeIdToAccept: string,
  slotCap = 10
): { ok: boolean; message: string } => {
  const trades = normalizePendingTrades(world);
  const trade = trades.find((t) => t.id === tradeIdToAccept);
  if (!trade || trade.status !== "pending") {
    pushWorldEvent(world, {
      actorId,
      category: "action",
      type: tradeFailureEventType("trade_not_found"),
      result: "failed",
      reason: "trade_not_found",
      payload: { tradeId: tradeIdToAccept }
    });
    return { ok: false, message: "trade_not_found" };
  }
  if (trade.to !== actorId) {
    pushWorldEvent(world, {
      actorId,
      category: "action",
      type: tradeFailureEventType("trade_not_for_actor"),
      result: "failed",
      reason: "trade_not_for_actor",
      payload: { tradeId: trade.id, from: trade.from, to: trade.to }
    });
    return { ok: false, message: "trade_not_for_actor" };
  }
  const from = world.actors[trade.from];
  const to = world.actors[trade.to];
  if (!from || !to || !from.alive || !to.alive) return failAcceptTrade(world, actorId, trade, "trade_actor_not_found");

  const fromInv = cloneInventory(from.inventory ?? []);
  const toInv = cloneInventory(to.inventory ?? []);
  let fromGold = from.gold ?? 0;
  let toGold = to.gold ?? 0;

  for (const want of trade.wants) {
    if (!applyItemTransfer(toInv, fromInv, want.item, want.count, slotCap)) {
      return failAcceptTrade(world, actorId, trade, `missing_want:${want.item}`);
    }
  }
  if (trade.offers.item) {
    if (!applyItemTransfer(fromInv, toInv, trade.offers.item, Math.max(1, trade.offers.count ?? 1), slotCap)) {
      return failAcceptTrade(world, actorId, trade, `missing_offer:${trade.offers.item}`);
    }
  }
  if (trade.offers.gold !== undefined && trade.offers.gold > 0) {
    if (fromGold < trade.offers.gold) {
      return failAcceptTrade(world, actorId, trade, "missing_offer:gold");
    }
    fromGold -= trade.offers.gold;
    toGold += trade.offers.gold;
  }

  from.inventory = fromInv;
  to.inventory = toInv;
  from.gold = fromGold;
  to.gold = toGold;
  trade.status = "accepted";
  trade.resolvedAtTick = world.tick;
  setTradePairCooldown(world, trade.from, trade.to, 60);
  world.revision += 1;
  pushWorldEvent(world, {
    actorId,
    category: "action",
    type: "trade_settled",
    result: "success",
    payload: { tradeId: trade.id, from: trade.from, to: trade.to, wants: trade.wants, offers: trade.offers }
  });
  pushWorldEvent(world, {
    actorId,
    category: "action",
    type: "trade:accepted",
    result: "success",
    payload: { tradeId: trade.id, from: trade.from, to: trade.to, wants: trade.wants, offers: trade.offers }
  });
  return { ok: true, message: `trade_accepted:${trade.id}` };
};

export const rejectPendingTrade = (
  world: WorldState,
  actorId: string,
  tradeIdToReject: string
): { ok: boolean; message: string } => {
  const trades = normalizePendingTrades(world);
  const trade = trades.find((t) => t.id === tradeIdToReject);
  if (!trade || trade.status !== "pending") return { ok: false, message: "trade_not_found" };
  if (trade.to !== actorId) return { ok: false, message: "trade_not_for_actor" };
  trade.status = "rejected";
  trade.reason = "receiver_rejected";
  trade.resolvedAtTick = world.tick;
  setTradePairCooldown(world, trade.from, trade.to, 60);
  world.revision += 1;
  pushWorldEvent(world, {
    actorId,
    category: "action",
    type: "trade:rejected",
    result: "info",
    payload: { tradeId: trade.id, from: trade.from, to: trade.to }
  });
  return { ok: true, message: `trade_rejected:${trade.id}` };
};

