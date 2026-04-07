export const tickWorld = (world) => {
    world.tick += 1;
    world.timeOfDay = (world.timeOfDay + 0.01) % 24;
    for (const actor of Object.values(world.actors)) {
        if (!actor.alive)
            continue;
        actor.hunger = Math.min(100, actor.hunger + 0.1);
        actor.stamina = Math.max(0, actor.stamina - 0.05);
        if (actor.hunger >= 100) {
            actor.hp = Math.max(0, actor.hp - 0.05);
            if (actor.hp === 0)
                actor.alive = false;
        }
    }
};
