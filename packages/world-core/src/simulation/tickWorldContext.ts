import { createDefaultWorldContext, type PlaceKind, type Weather, type WorldState } from "@wiw/shared";
import { createDefaultSkills } from "../state/createWorldState";

const DAY_TICKS = 2400;
const TRAVELER_ID = "traveler-1";

const WEATHER_WEIGHTS: Array<{ weather: Weather; weight: number }> = [
  { weather: "sunny", weight: 0.5 },
  { weather: "cloudy", weight: 0.2 },
  { weather: "rain", weight: 0.15 },
  { weather: "fog", weight: 0.1 },
  { weather: "windy", weight: 0.05 }
];

const ISSUE_TEXT = {
  well_dry: "우물 물이 말라가고 있어 물을 아껴야 한다.",
  boar_pack: "북쪽 숲에 멧돼지 무리가 보인다는 소문이 돈다.",
  low_harvest: "텃밭 수확물이 줄어 마을 사람들이 식량을 걱정한다.",
  harvest_festival: "오늘은 수확 축제라 광장에 모여 음식을 나누기 좋다.",
  traveler_arrival: "여행자가 광장에 머물며 다른 마을 소식을 전하고 있다."
} as const;

const pickWeather = (): Weather => {
  let r = Math.random();
  for (const item of WEATHER_WEIGHTS) {
    r -= item.weight;
    if (r <= 0) return item.weather;
  }
  return "sunny";
};

const nextInDays = (day: number, min: number, max: number): number =>
  day + min + Math.floor(Math.random() * (max - min + 1));

const hasGroundItemAt = (world: WorldState, x: number, y: number): boolean =>
  Object.values(world.groundItems).some((item) => item.x === x && item.y === y);

const hasActorAt = (world: WorldState, x: number, y: number): boolean =>
  Object.values(world.actors).some((actor) => actor.alive && actor.x === x && actor.y === y);

const countGroundPrefix = (world: WorldState, prefix: string): number =>
  Object.values(world.groundItems).filter((item) => item.id.startsWith(prefix)).length;

const nextItemId = (world: WorldState, prefix: string): string => {
  const exists = (id: string) =>
    Boolean(world.groundItems[id])
    || Object.values(world.actors).some((actor) =>
        actor.inventory.some((slot) => slot.kind === "instance" && slot.id === id));
  let n = 1;
  while (exists(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
};

export const findSpawnableTile = (
  world: WorldState,
  placeKind: PlaceKind,
  x?: number,
  y?: number,
  exclusions: Array<{ x: number; y: number }> = []
): { x: number; y: number } | null => {
  const excluded = new Set(exclusions.map((entry) => `${entry.x},${entry.y}`));
  const candidates: Array<{ x: number; y: number }> = [];
  const places = Object.values(world.places ?? {}).filter((place) => place.kind === placeKind);
  for (const place of places) {
    for (let yy = place.y; yy < place.y + place.height; yy += 1) {
      for (let xx = place.x; xx < place.x + place.width; xx += 1) {
        if (x !== undefined && xx !== x) continue;
        if (y !== undefined && yy !== y) continue;
        if (xx < 0 || yy < 0 || xx >= world.map.width || yy >= world.map.height) continue;
        if (world.map.collision[yy]?.[xx] === 1) continue;
        if (excluded.has(`${xx},${yy}`) || hasGroundItemAt(world, xx, yy) || hasActorAt(world, xx, yy)) continue;
        candidates.push({ x: xx, y: yy });
      }
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
};

const spawnGroundItem = (world: WorldState, prefix: string, x: number, y: number, type: string, iconKey: string): void => {
  const id = nextItemId(world, prefix);
  world.groundItems[id] = { id, x, y, type, iconKey };
};

const spawnOutdoorHerb = (world: WorldState): void => {
  if (countGroundPrefix(world, "herb") >= 8 || Math.random() >= 0.05) return;
  const candidates: Array<{ x: number; y: number }> = [];
  for (let y = 1; y < world.map.height - 1; y += 1) {
    for (let x = 1; x < world.map.width - 1; x += 1) {
      const terrain = world.map.terrain[y]?.[x];
      if (terrain !== 1 && terrain !== 3) continue;
      if (world.map.collision[y]?.[x] === 1 || hasGroundItemAt(world, x, y) || hasActorAt(world, x, y)) continue;
      candidates.push({ x, y });
    }
  }
  const tile = candidates[Math.floor(Math.random() * candidates.length)];
  if (tile) spawnGroundItem(world, "herb", tile.x, tile.y, "food", "item.food.herb");
};

const spawnDailyResources = (world: WorldState): void => {
  // PR4: wheat/carrot 은 농사 사이클로만 (씨앗→심기→성장→PICKUP). 자동 spawn 제거.
  trySpawnByCurve(world, "wood", 4, "forest_edge", "material", "item.material.wood", 1);
  trySpawnByCurve(world, "ore", 2, "mine", "material", "item.material.ore", 1);
  trySpawnByCurve(world, "coal", 1, "mine", "material", "item.material.coal", 1);
};

// 부족할수록 빠르고 capacity 근처에서 느려지는 재생 곡선.
// 부족도 = max(0, 1 - current/capacity). chance = base * (1 + 부족도 * boost). 매 tick 호출.
type RegenSpec = {
  prefix: string;
  capacity: number;
  baseChance: number;
  placeKind: PlaceKind | "outdoor_grass";
  type: string;
  iconKey: string;
};
const REGEN: RegenSpec[] = [
  // PR4: carrot/wheat 은 농사 사이클로만. 야생 자원만 REGEN.
  { prefix: "herb", capacity: 12, baseChance: 0.014, placeKind: "outdoor_grass", type: "food", iconKey: "item.food.herb" },
  { prefix: "berry", capacity: 8, baseChance: 0.010, placeKind: "forest_edge", type: "food", iconKey: "item.food.berry" },
  { prefix: "mushroom", capacity: 8, baseChance: 0.008, placeKind: "forest_edge", type: "food", iconKey: "item.food.mushroom" },
  { prefix: "wood", capacity: 10, baseChance: 0.010, placeKind: "forest_edge", type: "material", iconKey: "item.material.wood" },
  { prefix: "ore", capacity: 6, baseChance: 0.008, placeKind: "mine", type: "material", iconKey: "item.material.ore" },
  { prefix: "coal", capacity: 4, baseChance: 0.006, placeKind: "mine", type: "material", iconKey: "item.material.coal" },
  { prefix: "clay", capacity: 6, baseChance: 0.008, placeKind: "pond", type: "material", iconKey: "item.material.clay" }
];

function trySpawnByCurve(
  world: WorldState,
  prefix: string,
  cap: number,
  placeKind: PlaceKind | "outdoor_grass",
  type: string,
  iconKey: string,
  forceCount: number
): boolean {
  const current = countGroundPrefix(world, prefix);
  if (current >= cap) return false;
  for (let i = 0; i < forceCount; i += 1) {
    const tile = placeKind === "outdoor_grass"
      ? pickGrassTile(world)
      : findSpawnableTile(world, placeKind);
    if (!tile) return false;
    spawnGroundItem(world, prefix, tile.x, tile.y, type, iconKey);
  }
  return true;
}

function pickGrassTile(world: WorldState): { x: number; y: number } | null {
  const candidates: Array<{ x: number; y: number }> = [];
  for (let y = 1; y < world.map.height - 1; y += 1) {
    for (let x = 1; x < world.map.width - 1; x += 1) {
      const terrain = world.map.terrain[y]?.[x];
      if (terrain !== 1) continue; // 잔디 외 제외
      if (world.map.collision[y]?.[x] === 1 || hasGroundItemAt(world, x, y) || hasActorAt(world, x, y)) continue;
      candidates.push({ x, y });
    }
  }
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
}

function tickRegenerate(world: WorldState): void {
  // 부족 곡선 기반 spawn — 매 N tick 마다 한 번 시도 (10초 간격)
  if (world.tick % 100 !== 0) return;
  for (const spec of REGEN) {
    const current = countGroundPrefix(world, spec.prefix);
    if (current >= spec.capacity) continue;
    const scarcity = 1 - current / spec.capacity; // 0~1
    const chance = spec.baseChance * (1 + scarcity * 3); // 부족할수록 최대 4배
    // 날씨 보너스
    const weather = world.context.weather;
    let weatherMul = 1;
    if (weather === "rain" && (spec.prefix === "herb" || spec.prefix === "mushroom" || spec.prefix === "clay")) weatherMul = 1.6;
    if (weather === "windy") weatherMul = 0.7;
    if (weather === "fog" && spec.prefix === "mushroom") weatherMul *= 1.4;
    if (Math.random() >= chance * weatherMul) continue;
    const tile = spec.placeKind === "outdoor_grass" ? pickGrassTile(world) : findSpawnableTile(world, spec.placeKind);
    if (tile) spawnGroundItem(world, spec.prefix, tile.x, tile.y, spec.type, spec.iconKey);
  }
}

const ensureEventSchedule = (world: WorldState): void => {
  world.context.nextHarvestFestivalDay ??= nextInDays(world.context.calendarDay, 7, 14);
  world.context.nextTravelerArrivalDay ??= nextInDays(world.context.calendarDay, 4, 10);
};

const spawnTraveler = (world: WorldState, day: number): void => {
  if (world.actors[TRAVELER_ID]?.alive) return;
  world.actors[TRAVELER_ID] = {
    id: TRAVELER_ID,
    kind: "npc",
    name: "Traveler",
    assetKey: "human.traveler",
    x: 22,
    y: 15,
    hp: 100,
    maxHp: 100,
    mp: 20,
    maxMp: 20,
    stamina: 75,
    maxStamina: 75,
    hunger: 15,
    status: { strength: 5, dexterity: 6, constitution: 5, intelligence: 6 },
    skills: createDefaultSkills(),
    gold: 8,
    inventory: [{ kind: "instance" as const, id: "trinket-1", item: "trinket" }],
    alive: true
  };
  world.context.travelerActorId = TRAVELER_ID;
  world.context.travelerUntilDay = day + 1 + Math.floor(Math.random() * 2);
};

const despawnExpiredTraveler = (world: WorldState, day: number): void => {
  const travelerId = world.context.travelerActorId;
  if (!travelerId || !world.context.travelerUntilDay || day < world.context.travelerUntilDay) return;
  delete world.actors[travelerId];
  world.context.travelerActorId = undefined;
  world.context.travelerUntilDay = undefined;
  world.revision += 1;
};

export const tickWorldContext = (world: WorldState): void => {
  world.context ??= createDefaultWorldContext(world.tick);
  const context = world.context;
  const day = Math.floor(world.tick / DAY_TICKS);
  const previousDay = context.calendarDay;
  const dayChanged = day !== previousDay;
  const weatherBeforeTick = context.weather;
  context.calendarDay = day;
  ensureEventSchedule(world);

  // 매 tick 자원 재생 (capacity 곡선 기반)
  tickRegenerate(world);

  if (world.tick >= context.weatherUntilTick) {
    context.weather = pickWeather();
    context.weatherUntilTick = world.tick + 300 + Math.floor(Math.random() * 180);
    world.revision += 1;
  }

  context.marketDayActive = day % 7 === 0;
  context.marketDayUntilTick = context.marketDayActive ? (day + 1) * DAY_TICKS : context.marketDayUntilTick;
  if (context.marketDayUntilTick <= world.tick) context.marketDayActive = false;

  if (context.activeIssue && context.activeIssue.until <= world.tick) {
    context.activeIssue = undefined;
    world.revision += 1;
  }

  if (!dayChanged) return;
  despawnExpiredTraveler(world, day);

  context.resources.carrotStock = Math.max(0, context.resources.carrotStock - 2);
  context.resources.wellWaterLevel = Math.max(0, context.resources.wellWaterLevel - 1);
  if (weatherBeforeTick === "rain") {
    context.resources.wellWaterLevel = Math.min(10, context.resources.wellWaterLevel + 3);
  }
  spawnDailyResources(world);

  if (!context.activeIssue && day >= (context.nextHarvestFestivalDay ?? Infinity)) {
    context.resources.carrotStock = Math.min(99, context.resources.carrotStock + 5);
    const plaza = world.places?.plaza;
    if (plaza) plaza.socialWeight = Math.min(1, plaza.socialWeight + 0.2);
    context.activeIssue = {
      kind: "harvest_festival",
      until: world.tick + DAY_TICKS,
      text: ISSUE_TEXT.harvest_festival
    };
    context.nextHarvestFestivalDay = nextInDays(day, 7, 14);
  } else if (!context.activeIssue && day >= (context.nextTravelerArrivalDay ?? Infinity)) {
    spawnTraveler(world, day);
    context.activeIssue = {
      kind: "traveler_arrival",
      until: world.tick + DAY_TICKS * 2,
      text: ISSUE_TEXT.traveler_arrival
    };
    context.nextTravelerArrivalDay = nextInDays(day, 7, 10);
  } else if (!context.activeIssue && Math.random() < 0.05) {
    const kinds = ["well_dry", "boar_pack", "low_harvest"] as const;
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    context.activeIssue = {
      kind,
      until: world.tick + DAY_TICKS * (2 + Math.floor(Math.random() * 3)),
      text: ISSUE_TEXT[kind]
    };
  }
  world.revision += 1;
};
