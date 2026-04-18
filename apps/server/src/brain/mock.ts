import type { Actor, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import type { BrainDecision } from "./prompt";

const pickFreeDir = (world: WorldState, me: Actor): { dx: number; dy: number } | null => {
  const dirs = [
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 0, dy: -1 }
  ].sort(() => Math.random() - 0.5);
  for (const d of dirs) {
    const nx = me.x + d.dx;
    const ny = me.y + d.dy;
    if (nx < 0 || ny < 0 || nx >= world.map.width || ny >= world.map.height) continue;
    if (world.map.collision[ny]?.[nx] === 1) continue;
    const blocked = Object.values(world.actors).some((a) => a.alive && a.x === nx && a.y === ny);
    if (blocked) continue;
    return d;
  }
  return null;
};

export function decideWithMock(args: {
  world: WorldState;
  me: Actor;
  soul: Soul;
  thought: Thought;
  memories: Observation[];
}): BrainDecision {
  const { world, me, soul } = args;

  // 몬스터: 가장 가까운 비-몬스터 공격 or 배회
  if (me.kind === "monster") {
    const prey = Object.values(world.actors)
      .filter((a) => a.alive && a.kind !== "monster")
      .map((a) => ({ a, dist: Math.abs(a.x - me.x) + Math.abs(a.y - me.y) }))
      .sort((x, y) => x.dist - y.dist)[0];
    if (prey && prey.dist <= 1) {
      return {
        thought: {
          priority: "눈앞의 사람을 위협한다",
          emotion: "경계",
          nextIntent: `ATTACK ${prey.a.name}`,
          beliefs: [`${prey.a.name}이(가) 가까이 있다`],
          recentEvents: []
        },
        action: { type: "ATTACK", targetId: prey.a.id }
      };
    }
    if (prey) {
      const dx = Math.sign(prey.a.x - me.x);
      const dy = Math.sign(prey.a.y - me.y);
      const move = dx !== 0 || dy !== 0 ? { dx: dx !== 0 ? dx as -1|0|1 : 0, dy: dx === 0 ? dy as -1|0|1 : 0 } : null;
      if (move) {
        return {
          thought: {
            priority: "먹잇감 쪽으로 다가간다",
            emotion: "경계",
            nextIntent: "MOVE",
            beliefs: [`${prey.a.name}이(가) ${prey.dist}칸 떨어져 있다`],
            recentEvents: []
          },
          action: { type: "MOVE", dx: move.dx, dy: move.dy }
        };
      }
    }
  }

  // 배고프면 WAIT (USE 없음 = 일단 멈춰 쉬기)
  if (me.hunger > 80) {
    return {
      thought: {
        priority: "배가 많이 고파서 쉰다",
        emotion: "피곤함",
        nextIntent: "WAIT",
        beliefs: ["먹을 것을 찾아야 한다"],
        recentEvents: []
      },
      action: { type: "WAIT" }
    };
  }

  // 가끔 인사
  if (Math.random() < 0.18) {
    const neighbor = Object.values(world.actors)
      .filter((a) => a.id !== me.id && a.alive && a.kind !== "monster")
      .map((a) => ({ a, dist: Math.abs(a.x - me.x) + Math.abs(a.y - me.y) }))
      .sort((x, y) => x.dist - y.dist)[0];
    if (neighbor && neighbor.dist <= 3) {
      const messages = [`안녕, ${neighbor.a.name}!`, "날씨 좋다.", "오늘 뭐 할까?", "배고프다…", "저쪽 길이 조용하네."];
      return {
        thought: {
          priority: `${neighbor.a.name}와(과) 인사한다`,
          emotion: "즐거움",
          nextIntent: "SPEAK",
          beliefs: [`${neighbor.a.name}이(가) 근처에 있다`],
          recentEvents: []
        },
        action: { type: "SPEAK", message: messages[Math.floor(Math.random() * messages.length)] }
      };
    }
  }

  // 기본: 느긋하게 배회
  const dir = pickFreeDir(world, me);
  if (dir) {
    return {
      thought: {
        priority: soul.goals[0] ?? "마을을 둘러본다",
        emotion: "평온",
        nextIntent: "MOVE",
        beliefs: [],
        recentEvents: []
      },
      action: { type: "MOVE", dx: dir.dx as -1|0|1, dy: dir.dy as -1|0|1 }
    };
  }
  return {
    thought: { priority: "잠깐 멈춰서 주위를 본다", emotion: "평온", nextIntent: "WAIT", beliefs: [], recentEvents: [] },
    action: { type: "WAIT" }
  };
}
