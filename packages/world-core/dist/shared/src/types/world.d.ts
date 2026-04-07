export type LayerName = "terrain" | "collision" | "decor";
export type Structure = {
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    assetKey?: string;
    props: Record<string, unknown>;
};
export type ActorKind = "player" | "npc" | "monster";
export type Actor = {
    id: string;
    kind: ActorKind;
    name: string;
    assetKey?: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    stamina: number;
    maxStamina: number;
    hunger: number;
    gold: number;
    inventory: string[];
    alive: boolean;
};
export type GroundItem = {
    id: string;
    x: number;
    y: number;
    type: string;
    iconKey?: string;
};
export type WorldState = {
    revision: number;
    tick: number;
    timeOfDay: number;
    map: {
        width: number;
        height: number;
        tileSize: number;
        terrain: number[][];
        collision: number[][];
        decor: number[][];
    };
    structures: Record<string, Structure>;
    actors: Record<string, Actor>;
    groundItems: Record<string, GroundItem>;
    spawnPoints: {
        humans: Array<{
            x: number;
            y: number;
            assetKey?: string;
        }>;
        animals: Array<{
            x: number;
            y: number;
            assetKey?: string;
        }>;
        monsters: Array<{
            x: number;
            y: number;
            assetKey?: string;
        }>;
    };
};
