import type { WorldState } from "@wiw/shared";
import { itemTypeFromId } from "../effects/itemPrices";

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
const tradeCooldown = new Map<string, number>(); // `${from}:${to}` → unblockTick

export const tradePairCooldownLeft = (world: WorldState, from: string, to: string): number => {
  const k = `${from}:${to}`;
  const until = tradeCooldown.get(k) ?? 0;
  return Math.max(0, until - world.tick);
};

export const setTradePairCooldown = (world: WorldState, from: string, to: string, ticks: number): void => {
  const k = `${from}:${to}`;
  tradeCooldown.set(k, world.tick + ticks);
};

export const cleanupPendingTrades = (world: WorldState): string[] => {
  const trades = world.pendingTrades ?? [];
  const expired = trades.filter((trade) => trade.expiresAtTick <= world.tick);
  world.pendingTrades = trades.filter((trade) => trade.expiresAtTick > world.tick);
  // 만료 후 60tick pair cooldown
  for (const t of expired) setTradePairCooldown(world, t.from, t.to, 60);
  return expired.map((trade) => `거래 미완료: ${trade.from}->${trade.to}`);
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

  const expectedCurrency = goldMatch ? "gold" as const : undefined;
  const amount = goldMatch ? parseCount(goldMatch[1]) : undefined;
  const carrotCount = carrotMatch ? parseCount(carrotMatch[1]) : undefined;
  const expectedItem = carrotMatch ? `carrot:${carrotCount ?? 1}` : undefined;

  world.pendingTrades ??= [];
  world.pendingTrades = world.pendingTrades.filter((trade) => !(trade.from === from && trade.to === to));
  world.pendingTrades.push({
    from,
    to,
    expectedCurrency,
    amount,
    expectedItem,
    expiresAtTick: world.tick + 60
  });
};

/**
 * 명시적 SPEAK intent=trade_request 로부터 pendingTrade open. NLU 보다 정확.
 */
export const createPendingTradeFromIntent = (
  world: WorldState,
  from: string,
  to: string,
  speak: { wantItem?: string; wantCount?: number; offerItem?: string; offerCount?: number; offerGold?: number }
): void => {
  if (tradePairCooldownLeft(world, from, to) > 0) return;
  const expectedCurrency = speak.offerGold ? "gold" as const : undefined;
  const amount = speak.offerGold;
  const expectedItem = speak.wantItem
    ? `${speak.wantItem.split("-")[0]}:${speak.wantCount ?? 1}`
    : undefined;
  if (!expectedCurrency && !expectedItem) return;
  world.pendingTrades ??= [];
  world.pendingTrades = world.pendingTrades.filter((trade) => !(trade.from === from && trade.to === to));
  world.pendingTrades.push({
    from,
    to,
    expectedCurrency,
    amount,
    expectedItem,
    expiresAtTick: world.tick + 60
  });
  setTradePairCooldown(world, from, to, 30);
};

export const closeMatchingPendingTrade = (
  world: WorldState,
  from: string,
  to: string,
  give: { itemId?: string; currency?: "gold"; amount?: number }
): string | null => {
  const trades = world.pendingTrades ?? [];
  const index = trades.findIndex((trade) => {
    if (trade.from !== from || trade.to !== to) return false;
    if (trade.expectedCurrency) {
      return give.currency === trade.expectedCurrency && give.amount === trade.amount;
    }
    if (trade.expectedItem && give.itemId) {
      const [type] = trade.expectedItem.split(":");
      return itemTypeFromId(give.itemId) === type;
    }
    return false;
  });
  if (index < 0) return null;
  const [closed] = trades.splice(index, 1);
  world.pendingTrades = trades;
  return `거래 성사: ${closed.from}->${closed.to}`;
};
