const inBounds = (world, x, y) => x >= 0 && y >= 0 && x < world.map.width && y < world.map.height;
const actorAt = (world, x, y) => Object.values(world.actors).find((a) => a.alive && a.x === x && a.y === y)?.id;
export const dispatchAction = (world, request) => {
    const actor = world.actors[request.actorId];
    if (!actor || !actor.alive)
        return { ok: false, message: "actor_not_found" };
    switch (request.action.type) {
        case "MOVE": {
            const nx = actor.x + request.action.dx;
            const ny = actor.y + request.action.dy;
            if (!inBounds(world, nx, ny))
                return { ok: false, message: "out_of_bounds" };
            if (world.map.collision[ny][nx] === 1)
                return { ok: false, message: "blocked_tile" };
            if (actorAt(world, nx, ny))
                return { ok: false, message: "blocked_actor" };
            actor.x = nx;
            actor.y = ny;
            world.revision += 1;
            return { ok: true, message: "moved" };
        }
        case "ATTACK": {
            const target = world.actors[request.action.targetId];
            if (!target || !target.alive)
                return { ok: false, message: "target_not_found" };
            const dist = Math.abs(target.x - actor.x) + Math.abs(target.y - actor.y);
            if (dist > 1)
                return { ok: false, message: "target_too_far" };
            target.hp -= 10;
            if (target.hp <= 0) {
                target.hp = 0;
                target.alive = false;
            }
            world.revision += 1;
            return { ok: true, message: "attacked" };
        }
        case "SPEAK":
            return { ok: true, message: `say:${request.action.message}` };
        case "USE": {
            const hungerBefore = actor.hunger;
            actor.hunger = Math.max(0, actor.hunger - 20);
            actor.stamina = Math.min(actor.maxStamina, actor.stamina + 5);
            world.revision += 1;
            return { ok: true, message: `used hunger:${hungerBefore}->${actor.hunger}` };
        }
    }
    return { ok: false, message: "unknown_action" };
};
