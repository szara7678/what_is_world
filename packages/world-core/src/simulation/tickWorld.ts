import type { Actor, WorldState } from "@wiw/shared";
import { cleanupPendingTrades } from "../economy/pendingTrade";
import { tickWorldContext } from "./tickWorldContext";
import { dispatchAction, maturateCrops } from "../actions/dispatchAction";

/**
 * actor 가 movePath 를 가지고 있으면 매 tickWorld 호출 시 cooldown 검사 후 1 칸 자동 진행.
 * cooldown 은 dispatchAction 의 MOVE 핸들러 가 actor.lastMoveTick 으로 관리.
 * 즉 LLM 결정 없이도 path 따라 자연 이동 (속도는 stat·skill 차등).
 */
const advanceMovePath = (world: WorldState, actor: Actor): void => {
  const path = actor.movePath;
  if (!path || path.length === 0) return;
  const next = path[0];
  const result = dispatchAction(world, {
    actorId: actor.id,
    action: { type: "MOVE", dx: next.dx, dy: next.dy }
  });
  if (result.ok) {
    actor.movePath = path.slice(1);
    if (actor.movePath.length === 0) actor.movePath = undefined;
  } else if (result.message === "blocked_actor" || result.message === "blocked_tile") {
    // 일시적 막힘 — 그대로 path 유지 (다음 tick 재시도). cooldown 으로 자연 throttle.
  } else if (result.message !== "move_cooldown" && result.message !== "stamina_too_low") {
    // 회복 불가 막힘 (out_of_bounds 등) → path 폐기, brain 이 새 결정
    actor.movePath = undefined;
    actor.movePathTarget = undefined;
  }
};

export const tickWorld = (world: WorldState): void => {
  world.tick += 1;
  world.timeOfDay = (world.timeOfDay + 0.01) % 24;
  tickWorldContext(world);
  cleanupPendingTrades(world);
  maturateCrops(world);

  for (const actor of Object.values(world.actors)) {
    if (!actor.alive) continue;
    const constitution = actor.status?.constitution ?? 5;
    const meditation = actor.skills?.find((skill) => skill.id === "meditation")?.level ?? 0;
    actor.maxStamina = 50 + constitution * 5;
    actor.hunger = Math.min(100, actor.hunger + 0.008);
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 0.04 + meditation * 0.05);

    if (actor.hunger >= 100) {
      actor.hp = Math.max(0, actor.hp - 0.01);
    }

    if (actor.kind === "npc" && actor.hunger < 50) {
      actor.hp = Math.min(actor.maxHp, actor.hp + 0.05);
    }

    // path 자동 진행 (NPC + player). monster 는 mock AI 가 별도로 처리.
    if (actor.kind !== "monster") advanceMovePath(world, actor);
  }
};
