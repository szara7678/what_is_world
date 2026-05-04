import type { Relationship } from "@wiw/shared";
import { recordHistory } from "../logging/historyLogStore";
import { readAllRelationships, writeRelationships } from "../persistence/soulStore";
import { getWorld } from "../state/worldStore";

type Bump = { from: string; to: string; delta: number; tick: number; note: string };

let queue: Bump[] = [];
let flushing = false;

export function bumpAffinity(from: string, to: string, delta: number, tick: number, note: string): void {
  if (from === to) return;
  queue.push({ from, to, delta, tick, note });
  void flush();
}

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      const batch = queue;
      queue = [];
      const rels = await readAllRelationships();
      const idx = new Map<string, Relationship>();
      for (const r of rels) idx.set(`${r.from}::${r.to}`, r);
      for (const b of batch) {
        const k = `${b.from}::${b.to}`;
        const prev = idx.get(k);
        if (prev) {
          const before = prev.affinity;
          prev.affinity = clamp(prev.affinity + b.delta, -100, 100);
          prev.lastInteractionTick = b.tick;
          prev.notes = b.note;
          await recordRelationshipThreshold(b, before, prev.affinity);
        } else {
          const baseline = baselineRelationship(b.from, b.to);
          const affinity = clamp(baseline.affinity + b.delta, -100, 100);
          idx.set(k, {
            from: b.from,
            to: b.to,
            affinity,
            lastInteractionTick: b.tick,
            notes: baseline.note ? `${baseline.note}; ${b.note}` : b.note
          });
          await recordRelationshipThreshold(b, baseline.affinity, affinity);
        }
      }
      await writeRelationships([...idx.values()]);
    }
  } finally {
    flushing = false;
  }
}

function baselineRelationship(from: string, to: string): { affinity: number; note?: string } {
  const homes: Record<string, string> = {
    "player-1": "home-mochi",
    "npc-1": "home-mochi",
    "npc-3": "home-yui",
    "npc-4": "home-jin"
  };
  if (homes[from] && homes[from] === homes[to]) {
    return { affinity: 15, note: "한 지붕 아래 산다" };
  }
  if ((from === "npc-2" && to === "npc-3") || (from === "npc-3" && to === "npc-2")) {
    return { affinity: 10, note: "이웃 상인" };
  }
  if (from === "npc-4" || to === "npc-4") {
    return { affinity: 5, note: "마을 자경단 신뢰" };
  }
  return { affinity: 0 };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function recordRelationshipThreshold(b: Bump, before: number, after: number): Promise<void> {
  const becameFriend = before < 60 && after >= 60;
  const becameEnemy = before > -40 && after <= -40;
  if (!becameFriend && !becameEnemy) return;

  const world = getWorld();
  const fromName = world.actors[b.from]?.name ?? b.from;
  const toName = world.actors[b.to]?.name ?? b.to;
  const label = becameFriend ? "친구" : "원수";
  await recordHistory({
    tick: b.tick,
    ts: Date.now(),
    actorId: b.from,
    kind: becameFriend ? "relationship.friend" : "relationship.enemy",
    text: `${fromName} 와 ${toName} 가 ${label}가 되었어요.`,
    meta: { from: b.from, to: b.to, affinity: after, note: b.note }
  });
}
