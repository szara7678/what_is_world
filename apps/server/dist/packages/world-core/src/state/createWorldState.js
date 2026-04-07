const createLayer = (width, height, fill = 0) => Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
export const createWorldState = (width = 24, height = 16) => {
    const terrain = createLayer(width, height, 1);
    const collision = createLayer(width, height, 0);
    const decor = createLayer(width, height, 0);
    for (let x = 0; x < width; x += 1) {
        collision[0][x] = 1;
        collision[height - 1][x] = 1;
    }
    for (let y = 0; y < height; y += 1) {
        collision[y][0] = 1;
        collision[y][width - 1] = 1;
    }
    const player = {
        id: "player-1",
        kind: "player",
        name: "Hero",
        assetKey: "human.default",
        x: 2,
        y: 2,
        hp: 100,
        maxHp: 100,
        mp: 20,
        maxMp: 20,
        stamina: 100,
        maxStamina: 100,
        hunger: 0,
        gold: 10,
        inventory: ["bread-1"],
        alive: true
    };
    const dummy = {
        ...player,
        id: "npc-1",
        kind: "npc",
        name: "Villager",
        assetKey: "human.villager",
        x: 5,
        y: 5
    };
    const animal = {
        ...player,
        id: "animal-1",
        kind: "monster",
        name: "Boar",
        assetKey: "animal.boar",
        x: 8,
        y: 6
    };
    return {
        revision: 1,
        tick: 0,
        timeOfDay: 8,
        map: { width, height, tileSize: 32, terrain, collision, decor },
        structures: {},
        actors: { [player.id]: player, [dummy.id]: dummy, [animal.id]: animal },
        groundItems: { "bread-1": { id: "bread-1", x: 3, y: 2, type: "food", iconKey: "item.food.bread" } },
        spawnPoints: {
            humans: [{ x: 2, y: 2, assetKey: "human.default" }],
            animals: [{ x: 8, y: 6, assetKey: "animal.boar" }],
            monsters: [{ x: 5, y: 5, assetKey: "monster.slime" }]
        }
    };
};
