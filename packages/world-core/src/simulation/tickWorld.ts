import type { WorldState } from "@wiw/shared";

export const tickWorld = (world: WorldState): void => {
  world.tick += 1;
  world.timeOfDay = (world.timeOfDay + 0.01) % 24;

  for (const actor of Object.values(world.actors)) {
    if (!actor.alive) continue;
    actor.hunger = Math.min(100, actor.hunger + 0.02);
    // 스태미나 서서히 회복
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 0.1);

    // 플레이어만 굶주림으로 HP 감소 (NPC/몬스터는 자동 회복)
    if (actor.kind === "player" && actor.hunger >= 100) {
      actor.hp = Math.max(0, actor.hp - 0.02);
      if (actor.hp === 0) actor.alive = false;
    } else if (actor.kind !== "player") {
      // NPC, 몬스터는 굶주리면 자동으로 먹이를 찾아 허기 리셋
      if (actor.hunger >= 80) actor.hunger = 0;
      // HP 서서히 회복
      actor.hp = Math.min(actor.maxHp, actor.hp + 0.05);
    }
  }
};
