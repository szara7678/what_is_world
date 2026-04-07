const id = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
export const spawnActor = (world, kind, name, x, y, assetKey) => {
    const actor = {
        id: id(kind),
        kind,
        name,
        assetKey,
        x,
        y,
        hp: 100,
        maxHp: 100,
        mp: 20,
        maxMp: 20,
        stamina: 100,
        maxStamina: 100,
        hunger: 0,
        gold: 0,
        inventory: [],
        alive: true
    };
    world.actors[actor.id] = actor;
    world.revision += 1;
    return actor;
};
export const placeGroundItem = (world, type, x, y, iconKey) => {
    const item = { id: id("item"), x, y, type, iconKey };
    world.groundItems[item.id] = item;
    world.revision += 1;
    return item;
};
