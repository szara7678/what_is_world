/**
 * Inventory helper. dispatchAction / persist / UI / prompt 모두 이걸 통해서만 인벤 조작.
 * 직접 actor.inventory.push / filter 금지.
 */
import type { InventorySlot, InventoryStackSlot, InventoryInstanceSlot } from "../types/world";
import { itemMaxStack, itemPrefix, itemStackable } from "./items";

export type InvAddResult = { added: number; rejected: number };

/** prefix·instance id 양쪽에서 catalog key 추출 */
export const itemKeyOf = (idOrPrefix: string): string => itemPrefix(idOrPrefix);

/** 인벤 슬롯의 사람용 표시 카운트 (stack count 또는 instance=1) */
export const slotCount = (slot: InventorySlot): number => slot.kind === "stack" ? slot.count : 1;

/** 인벤 안 catalog key 별 합계 카운트 */
export const inventoryCounts = (inv: InventorySlot[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const s of inv) out[s.item] = (out[s.item] ?? 0) + slotCount(s);
  return out;
};

/** 인벤 안 특정 key 의 총합 (stack + instance) */
export const inventoryCountOf = (inv: InventorySlot[], key: string): number => {
  let total = 0;
  for (const s of inv) if (s.item === key) total += slotCount(s);
  return total;
};

/** 인벤 슬롯 점유 수 (= 길이). 8칸 한도 등 비교용. */
export const inventorySlotsUsed = (inv: InventorySlot[]): number => inv.length;

/**
 * 아이템 추가. stackable 이면 기존 슬롯에 합치고 maxStack 초과는 새 슬롯·rejection.
 * non-stackable 이면 instance 슬롯 신규.
 *
 * @param idOrKey  catalog key 또는 instance id ("wheat-7"). instance id 면 instance 슬롯 보존.
 * @param count    추가량 (stackable 만 적용. instance 는 1 강제)
 * @param slotCap  슬롯 한도 (기본 8). 초과는 rejected
 * @returns        { added, rejected }
 */
export function addToInventory(
  inv: InventorySlot[],
  idOrKey: string,
  count = 1,
  slotCap = 8,
  meta?: Record<string, unknown>
): InvAddResult {
  const key = itemKeyOf(idOrKey);
  const stackable = itemStackable(key);
  const maxStack = itemMaxStack(key);
  let toAdd = count;
  let rejected = 0;
  if (stackable) {
    // 1) 기존 stack 슬롯 채우기
    for (const s of inv) {
      if (s.kind !== "stack" || s.item !== key) continue;
      const room = maxStack - s.count;
      if (room <= 0) continue;
      const fill = Math.min(room, toAdd);
      s.count += fill;
      toAdd -= fill;
      if (toAdd <= 0) return { added: count, rejected: 0 };
    }
    // 2) 새 stack 슬롯 추가
    while (toAdd > 0) {
      if (inv.length >= slotCap) {
        rejected = toAdd;
        break;
      }
      const fill = Math.min(maxStack, toAdd);
      inv.push({ kind: "stack", item: key, count: fill });
      toAdd -= fill;
    }
  } else {
    // instance: count 무시, 1개씩 슬롯
    for (let i = 0; i < count; i += 1) {
      if (inv.length >= slotCap) {
        rejected = count - i;
        break;
      }
      // instance id 가 명시적이면 그대로, 아니면 prefix 기반 random
      const id = idOrKey.includes("-") ? idOrKey : `${key}-${Math.random().toString(36).slice(2, 7)}`;
      inv.push({ kind: "instance", id, item: key, meta });
    }
  }
  return { added: count - rejected, rejected };
}

/**
 * 아이템 제거. stackable 이면 가장 적합한 stack 슬롯에서 차감, 비면 슬롯 삭제.
 * instance 면 id 또는 key 매칭으로 첫 슬롯 제거.
 *
 * @returns 실제 제거된 수량
 */
export function removeFromInventory(inv: InventorySlot[], idOrKey: string, count = 1): number {
  const key = itemKeyOf(idOrKey);
  let toRemove = count;
  // 1) instance 우선 매칭 (id 정확)
  for (let i = inv.length - 1; i >= 0 && toRemove > 0; i -= 1) {
    const s = inv[i];
    if (s.kind === "instance" && (s.id === idOrKey || s.item === key)) {
      inv.splice(i, 1);
      toRemove -= 1;
    }
  }
  // 2) stack 차감
  for (let i = inv.length - 1; i >= 0 && toRemove > 0; i -= 1) {
    const s = inv[i];
    if (s.kind !== "stack" || s.item !== key) continue;
    const take = Math.min(s.count, toRemove);
    s.count -= take;
    toRemove -= take;
    if (s.count <= 0) inv.splice(i, 1);
  }
  return count - toRemove;
}

/** 인벤에 key 또는 instance id 가 1개 이상 있는지 */
export function hasInInventory(inv: InventorySlot[], idOrKey: string): boolean {
  return inventoryCountOf(inv, itemKeyOf(idOrKey)) > 0;
}

/** 처음 매치되는 슬롯 (stack 또는 instance). 효과 발동·소비 시 활용. */
export function findFirstSlot(inv: InventorySlot[], idOrKey: string): InventorySlot | undefined {
  const key = itemKeyOf(idOrKey);
  for (const s of inv) {
    if (s.kind === "instance" && (s.id === idOrKey || s.item === key)) return s;
    if (s.kind === "stack" && s.item === key) return s;
  }
  return undefined;
}

/** 첫 instance slot (id 정확 매치 우선, 그 다음 key) */
export function findInstanceSlot(inv: InventorySlot[], idOrKey: string): InventoryInstanceSlot | undefined {
  const key = itemKeyOf(idOrKey);
  for (const s of inv) {
    if (s.kind === "instance" && s.id === idOrKey) return s;
  }
  for (const s of inv) {
    if (s.kind === "instance" && s.item === key) return s;
  }
  return undefined;
}

/** 첫 stack slot */
export function findStackSlot(inv: InventorySlot[], key: string): InventoryStackSlot | undefined {
  const k = itemKeyOf(key);
  for (const s of inv) {
    if (s.kind === "stack" && s.item === k) return s;
  }
  return undefined;
}

/**
 * 구버전 string[] → InventorySlot[] 마이그레이션. snapshot.json 로드 시 사용.
 * stackable 카탈로그 기준으로 같은 key 의 stack 합치기, instance 는 그대로.
 */
export function migrateInventoryFromStringArray(oldInv: unknown): InventorySlot[] {
  if (!Array.isArray(oldInv)) return [];
  // 이미 InventorySlot[] (마이그레이션 끝났거나 신규) 인 경우 그대로.
  if (oldInv.length === 0) return [];
  if (typeof oldInv[0] === "object" && oldInv[0] !== null && "kind" in oldInv[0]) {
    return oldInv as InventorySlot[];
  }
  const out: InventorySlot[] = [];
  for (const idStr of oldInv as string[]) {
    if (typeof idStr !== "string") continue;
    addToInventory(out, idStr, 1, Number.MAX_SAFE_INTEGER);
  }
  return out;
}
