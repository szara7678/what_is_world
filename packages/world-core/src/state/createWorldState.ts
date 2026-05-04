import { createDefaultWorldContext, migrateInventoryFromStringArray, type Actor, type ActorStatus, type Place, type Skill, type WorldState } from "@wiw/shared";

const createLayer = (width: number, height: number, fill = 0): number[][] =>
  Array.from({ length: height }, () => Array.from({ length: width }, () => fill));

const DEFAULT_STATUS: ActorStatus = { strength: 5, dexterity: 5, constitution: 5, intelligence: 5 };

const statusForRole = (role: "hero" | "farmer" | "baker" | "merchant" | "guard" | "wanderer" | "monster"): ActorStatus => {
  if (role === "monster") return { strength: 2, dexterity: 4, constitution: 3, intelligence: 1 };
  const status = { ...DEFAULT_STATUS };
  if (role === "hero") {
    status.strength += 1;
    status.dexterity += 1;
  } else if (role === "farmer") {
    status.constitution += 1;
    status.strength += 1;
  } else if (role === "baker") {
    status.intelligence += 1;
    status.constitution += 1;
  } else if (role === "merchant") {
    status.intelligence += 1;
    status.dexterity += 1;
  } else if (role === "guard") {
    status.strength += 1;
    status.constitution += 1;
  } else if (role === "wanderer") {
    status.dexterity += 1;
    status.intelligence += 1;
  }
  return status;
};

const maxStaminaFor = (status: ActorStatus): number => 50 + status.constitution * 5;

export const createDefaultSkills = (): Skill[] => [
  { id: "running", name: "달리기", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "dexterity", description: "MOVE stamina cost 줄임 (0.5%/level)" },
  { id: "swordsmanship", name: "검술", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength", description: "ATTACK damage +5%/level" },
  { id: "gathering", name: "채집", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength", description: "USE 채집 자원 시 추가 산출 확률 +3%/level" },
  { id: "fishing", name: "낚시", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "dexterity", description: "USE fishing_rod 시 fish 획득 확률 +5%/level" },
  { id: "foraging", name: "탐색", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "dexterity", description: "forest_edge 자원 PICKUP 시 +0.03/lv 추가 yield 확률" },
  { id: "cooking", name: "요리", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence", description: "음식 hunger 회복 +5%/level (요리한 NPC가 받음)" },
  { id: "conversation", name: "대화", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence", description: "SPEAK 후 affinity 변화 +5%/level" },
  { id: "farming", name: "농사", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "constitution", description: "field USE 시 추가 carrot/wheat spawn +5%/level" },
  { id: "meditation", name: "명상", type: "passive", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "constitution", description: "PRAY/WAIT 후 stamina 회복 +0.05/level/tick" },
  { id: "smithing", name: "대장기술", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "strength", description: "forge USE → 도구·무기 제작" },
  { id: "alchemy", name: "연금", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence", description: "alchemy_table USE → 물약 제작" },
  { id: "architecture", name: "건축", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence", description: "workbench USE → 청사진·구조물 제작" },
  { id: "appraise", name: "감정", type: "active", level: 0, xp: 0, lastPracticedTick: 0, primaryStat: "intelligence", description: "USE skillId=appraise targetId=... 로 대상 정보 관찰. 레벨↑ 시 더 많은 속성 노출." }
];

export const createWorldState = (width = 24, height = 16): WorldState => {
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

  const playerStatus = statusForRole("hero");
  const player: Actor = {
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
    stamina: maxStaminaFor(playerStatus),
    maxStamina: maxStaminaFor(playerStatus),
    hunger: 0,
    status: playerStatus,
    skills: createDefaultSkills(),
    gold: 10,
    inventory: [],
    alive: true
  };

  const dummy: Actor = {
    ...player,
    id: "npc-1",
    kind: "npc",
    name: "Villager",
    assetKey: "human.villager",
    x: 5,
    y: 5,
    status: statusForRole("wanderer"),
    skills: createDefaultSkills()
  };

  const animal: Actor = {
    ...player,
    id: "animal-1",
    kind: "monster",
    name: "Boar",
    assetKey: "animal.boar",
    x: 8,
    y: 6,
    hp: 35,
    maxHp: 35,
    mp: 0,
    maxMp: 0,
    stamina: maxStaminaFor(statusForRole("monster")),
    maxStamina: maxStaminaFor(statusForRole("monster")),
    status: statusForRole("monster"),
    skills: createDefaultSkills(),
    gold: 0
  };

  return {
    revision: 1,
    tick: 0,
    timeOfDay: 8,
    context: createDefaultWorldContext(0),
    map: { width, height, tileSize: 32, terrain, collision, decor },
    structures: {},
    places: {},
    actors: { [player.id]: player, [dummy.id]: dummy, [animal.id]: animal },
    groundItems: { "carrot-1": { id: "carrot-1", x: 3, y: 2, type: "food", iconKey: "item.food.carrot" } },
    spawnPoints: {
      humans: [{ x: 2, y: 2, assetKey: "human.default" }],
      animals: [{ x: 8, y: 6, assetKey: "animal.boar" }],
      monsters: [{ x: 5, y: 5, assetKey: "monster.slime" }]
    }
  };
};

const fillRect = (layer: number[][], x: number, y: number, width: number, height: number, tile: number): void => {
  for (let yy = y; yy < y + height; yy += 1) {
    if (!layer[yy]) continue;
    for (let xx = x; xx < x + width; xx += 1) {
      if (xx < 0 || xx >= layer[yy].length) continue;
      layer[yy][xx] = tile;
    }
  }
};

const createActor = (
  id: string,
  kind: Actor["kind"],
  name: string,
  assetKey: string,
  x: number,
  y: number,
  inventoryRaw: string[] = [],
  hunger = 0,
  role: "hero" | "farmer" | "baker" | "merchant" | "guard" | "wanderer" | "monster" = kind === "monster" ? "monster" : "wanderer"
): Actor => {
  const isMonster = kind === "monster";
  const status = statusForRole(role);
  const maxStamina = maxStaminaFor(status);
  return {
    id,
    kind,
    name,
    assetKey,
    x,
    y,
    hp: isMonster ? 20 : 100,
    maxHp: isMonster ? 20 : 100,
    mp: isMonster ? 0 : 20,
    maxMp: isMonster ? 0 : 20,
    stamina: maxStamina,
    maxStamina,
    hunger,
    status,
    skills: createDefaultSkills(),
    gold: isMonster ? 0 : 10,
    inventory: migrateInventoryFromStringArray(inventoryRaw),
    alive: true
  };
};

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((item) => [item.id, item]));

export const createMochiVillageState = (width = 64, height = 48): WorldState => {
  const mapWidth = Math.max(width, 64);
  const mapHeight = Math.max(height, 48);
  const terrain = createLayer(mapWidth, mapHeight, 1);
  const collision = createLayer(mapWidth, mapHeight, 0);
  const decor = createLayer(mapWidth, mapHeight, 0);

  for (let x = 0; x < mapWidth; x += 1) {
    collision[0][x] = 1;
    collision[mapHeight - 1][x] = 1;
  }
  for (let y = 0; y < mapHeight; y += 1) {
    collision[y][0] = 1;
    collision[y][mapWidth - 1] = 1;
  }

  const places: Place[] = [
    // ── 중앙 마을 (모찌 광장 일대, 64×48 지도 중앙) ──────────────────
    {
      id: "plaza",
      name: "모찌 광장",
      kind: "plaza",
      x: 29, y: 21, width: 6, height: 6,
      allowedActions: ["WAIT", "SPEAK", "USE"],
      socialWeight: 0.95,
      dayPhaseBias: { morning: 0.9, day: 0.6, evening: 0.85, night: 0.2 },
      tags: ["social", "outdoor", "center"]
    },
    {
      id: "well",
      name: "작은 우물",
      kind: "well",
      x: 26, y: 22, width: 2, height: 2,
      allowedActions: ["WAIT", "SPEAK", "USE"],
      socialWeight: 0.7,
      dayPhaseBias: { morning: 0.8, day: 0.55, evening: 0.5, night: 0.15 },
      tags: ["water", "social", "outdoor"]
    },
    {
      id: "noticeboard",
      name: "마을 게시판",
      kind: "noticeboard",
      x: 32, y: 27, width: 1, height: 1,
      allowedActions: ["WAIT", "USE", "SPEAK"],
      socialWeight: 0.55,
      dayPhaseBias: { morning: 0.7, day: 0.85, evening: 0.55, night: 0.1 },
      tags: ["info", "social", "outdoor"]
    },
    {
      id: "tavern",
      name: "달빛 선술집",
      kind: "tavern",
      x: 35, y: 26, width: 4, height: 4,
      allowedActions: ["WAIT", "SPEAK", "REST", "BUY"],
      socialWeight: 0.85,
      dayPhaseBias: { morning: 0.15, day: 0.25, evening: 0.95, night: 0.85 },
      tags: ["social", "indoor", "evening"]
    },
    {
      id: "shrine",
      name: "작은 사당",
      kind: "shrine",
      x: 30, y: 16, width: 3, height: 3,
      allowedActions: ["WAIT", "SPEAK", "PRAY"],
      socialWeight: 0.35,
      dayPhaseBias: { morning: 0.65, day: 0.45, evening: 0.55, night: 0.25 },
      tags: ["faith", "quiet", "outdoor"]
    },
    {
      id: "bakery",
      name: "햇살 빵집",
      kind: "shop",
      x: 22, y: 18, width: 4, height: 4,
      allowedActions: ["WAIT", "SPEAK", "BUY", "SELL", "USE"],
      socialWeight: 0.8,
      dayPhaseBias: { morning: 0.95, day: 0.75, evening: 0.35, night: 0.05 },
      tags: ["food", "shop", "indoor"]
    },
    {
      id: "general-store",
      name: "모퉁이 잡화점",
      kind: "shop",
      x: 38, y: 18, width: 4, height: 4,
      allowedActions: ["WAIT", "SPEAK", "BUY", "SELL"],
      socialWeight: 0.65,
      dayPhaseBias: { morning: 0.55, day: 0.85, evening: 0.45, night: 0.05 },
      tags: ["shop", "tools", "indoor"]
    },
    {
      id: "home-mochi",
      name: "모찌의 오두막",
      kind: "home",
      x: 18, y: 30, width: 4, height: 4,
      allowedActions: ["WAIT", "REST", "SPEAK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.35, day: 0.15, evening: 0.75, night: 1 },
      tags: ["home", "rest", "indoor"]
    },
    {
      id: "home-yui",
      name: "유이의 오두막",
      kind: "home",
      x: 30, y: 31, width: 4, height: 4,
      allowedActions: ["WAIT", "REST", "SPEAK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.35, day: 0.15, evening: 0.75, night: 1 },
      tags: ["home", "rest", "indoor"]
    },
    {
      id: "home-jin",
      name: "진의 오두막",
      kind: "home",
      x: 42, y: 30, width: 4, height: 4,
      allowedActions: ["WAIT", "REST", "SPEAK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.35, day: 0.15, evening: 0.75, night: 1 },
      tags: ["home", "rest", "indoor"]
    },
    // ── 도로: 마을-숲-광산-강 잇는 주도로 2개 ──────────────────────
    {
      id: "road-main-ew",
      name: "마을 동서 큰길",
      kind: "road",
      x: 16, y: 23, width: 32, height: 2,
      allowedActions: ["WAIT", "SPEAK"],
      socialWeight: 0.45,
      dayPhaseBias: { morning: 0.55, day: 0.55, evening: 0.55, night: 0.2 },
      tags: ["road", "outdoor"]
    },
    {
      id: "road-main-ns",
      name: "마을 남북 큰길",
      kind: "road",
      x: 31, y: 12, width: 2, height: 28,
      allowedActions: ["WAIT", "SPEAK"],
      socialWeight: 0.45,
      dayPhaseBias: { morning: 0.55, day: 0.55, evening: 0.55, night: 0.2 },
      tags: ["road", "outdoor"]
    },
    // ── 농경지 (남쪽) ──────────────────────────────────────
    {
      id: "field-west",
      name: "서쪽 텃밭",
      kind: "field",
      x: 14, y: 36, width: 6, height: 6,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.35,
      dayPhaseBias: { morning: 0.55, day: 0.95, evening: 0.35, night: 0.05 },
      tags: ["farm", "food", "outdoor"]
    },
    {
      id: "field-east",
      name: "동쪽 텃밭",
      kind: "field",
      x: 44, y: 36, width: 6, height: 6,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.35,
      dayPhaseBias: { morning: 0.55, day: 0.95, evening: 0.35, night: 0.05 },
      tags: ["farm", "food", "outdoor"]
    },
    {
      id: "field-orchard",
      name: "마을 과수원",
      kind: "field",
      x: 24, y: 38, width: 8, height: 6,
      allowedActions: ["WAIT", "WORK", "USE"],
      socialWeight: 0.3,
      dayPhaseBias: { morning: 0.55, day: 0.9, evening: 0.4, night: 0.05 },
      tags: ["farm", "food", "fruit", "outdoor"]
    },
    // ── 숲 (북쪽 + 서쪽) ───────────────────────────────────
    {
      id: "forest-north",
      name: "북쪽 숲",
      kind: "forest_edge",
      x: 0, y: 0, width: 64, height: 4,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.1,
      dayPhaseBias: { morning: 0.35, day: 0.45, evening: 0.25, night: 0.1 },
      tags: ["forest", "wild", "outdoor"]
    },
    {
      id: "forest-west",
      name: "서쪽 숲",
      kind: "forest_edge",
      x: 0, y: 4, width: 10, height: 28,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.1,
      dayPhaseBias: { morning: 0.35, day: 0.45, evening: 0.25, night: 0.1 },
      tags: ["forest", "wild", "outdoor", "deep"]
    },
    // ── 광산 (북동) + 동굴 입구 (북) ────────────────────────
    {
      id: "mine",
      name: "북동 광산",
      kind: "mine",
      x: 50, y: 4, width: 8, height: 6,
      allowedActions: ["WAIT", "WORK"],
      socialWeight: 0.15,
      dayPhaseBias: { morning: 0.35, day: 0.65, evening: 0.25, night: 0.05 },
      tags: ["mine", "ore", "outdoor"]
    },
    {
      id: "cave-entrance",
      name: "봉인된 동굴 입구",
      kind: "mine",
      x: 28, y: 4, width: 4, height: 3,
      allowedActions: ["WAIT"],
      socialWeight: 0.05,
      dayPhaseBias: { morning: 0.2, day: 0.3, evening: 0.2, night: 0.1 },
      tags: ["cave", "danger", "sealed", "outdoor"]
    },
    // ── 강 (동쪽) + 연못 (남동 습지) ─────────────────────────
    {
      id: "river-east",
      name: "동쪽 시냇물",
      kind: "pond",
      x: 60, y: 6, width: 3, height: 28,
      allowedActions: ["WAIT", "USE", "WORK"],
      socialWeight: 0.25,
      dayPhaseBias: { morning: 0.55, day: 0.7, evening: 0.55, night: 0.15 },
      tags: ["water", "river", "fishing", "outdoor"]
    },
    {
      id: "pond",
      name: "마을 연못",
      kind: "pond",
      x: 24, y: 25, width: 3, height: 2,
      allowedActions: ["WAIT", "USE", "WORK"],
      socialWeight: 0.3,
      dayPhaseBias: { morning: 0.55, day: 0.7, evening: 0.55, night: 0.15 },
      tags: ["water", "fishing", "outdoor"]
    },
    {
      id: "wetland",
      name: "남동 습지",
      kind: "pond",
      x: 50, y: 42, width: 10, height: 5,
      allowedActions: ["WAIT", "USE", "WORK"],
      socialWeight: 0.15,
      dayPhaseBias: { morning: 0.4, day: 0.6, evening: 0.4, night: 0.15 },
      tags: ["water", "wetland", "fishing", "outdoor"]
    },
    // ── 외곽 폐허 (서남, 옛 사당 흔적) ────────────────────────
    {
      id: "ruins-southwest",
      name: "서남 폐허",
      kind: "shrine",
      x: 4, y: 42, width: 5, height: 4,
      allowedActions: ["WAIT", "PRAY"],
      socialWeight: 0.05,
      dayPhaseBias: { morning: 0.25, day: 0.3, evening: 0.4, night: 0.5 },
      tags: ["ruins", "ancient", "spirit", "outdoor"]
    }
  ];

  const roads = places.filter((place) => place.kind === "road");
  const forest = places.filter((place) => place.kind === "forest_edge");
  const fields = places.filter((place) => place.kind === "field");
  const plaza = places.find((place) => place.kind === "plaza");
  const shopsAndHomes = places.filter((place) => place.kind === "shop" || place.kind === "home" || place.kind === "tavern" || place.kind === "shrine");
  const mines = places.filter((place) => place.kind === "mine");
  const well = places.find((place) => place.kind === "well");
  const pond = places.find((place) => place.kind === "pond");

  // 모든 decor 레이어 fill 제거 — Pipoya tilesheet decor IDs(6,7,9,10,11,13)가 잘린 나무/이상한 패턴으로 렌더링됨.
  // 시각 구분은 terrain ID + 실제 structure sprite로만 표현.
  for (const road of roads) fillRect(terrain, road.x, road.y, road.width, road.height, 3);
  if (plaza) fillRect(terrain, plaza.x, plaza.y, plaza.width, plaza.height, 2);
  for (const field of fields) {
    fillRect(terrain, field.x, field.y, field.width, field.height, 4);
  }
  for (const place of shopsAndHomes) {
    fillRect(terrain, place.x, place.y, place.width, place.height, 5);
  }
  for (const mine of mines) {
    fillRect(terrain, mine.x, mine.y, mine.width, mine.height, 6);
  }
  // PR7: 물 타일 시각화 + collision.
  // Pipoya BaseChip tileId 58 (큰 청록 물웅덩이). well/pond/river/wetland 모두 적용.
  // 사용자 요구: 물 위에 NPC 못 서게. 단 well 은 우물 정자 자체가 small 이라 통과 가능 유지.
  const WATER_TILE_ID = 58;
  for (const p of places.filter((pl) => pl.kind === "pond")) {
    fillRect(terrain, p.x, p.y, p.width, p.height, WATER_TILE_ID);
    // pond 영역 가장자리 1 칸은 통과 가능 (낚시·물긷기 동선). 안쪽 (1칸 안쪽) 은 collision.
    for (let yy = p.y + 1; yy < p.y + p.height - 1; yy += 1) {
      for (let xx = p.x + 1; xx < p.x + p.width - 1; xx += 1) {
        if (collision[yy] && collision[yy][xx] !== undefined) collision[yy][xx] = 1;
      }
    }
  }
  for (const p of places.filter((pl) => pl.kind === "well")) {
    fillRect(terrain, p.x, p.y, p.width, p.height, WATER_TILE_ID);
    // well 은 작아서(2×2) 안쪽 collision 만 1칸. 가장자리는 가능.
  }

  const structures = [
    // ── 마을 건물 ──────────────────────────────────────────
    { id: "structure-bakery", type: "bakery", x: 22, y: 18, width: 4, height: 4, assetKey: "object.bakery", props: { placeId: "bakery" } },
    { id: "structure-general-store", type: "general-store", x: 38, y: 18, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "general-store" } },
    { id: "structure-tavern", type: "tavern", x: 35, y: 26, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "tavern" } },
    { id: "structure-shrine", type: "shrine", x: 30, y: 16, width: 3, height: 3, props: { placeId: "shrine" } },
    { id: "structure-home-mochi", type: "home", x: 18, y: 30, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "home-mochi" } },
    { id: "structure-home-yui", type: "home", x: 30, y: 31, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "home-yui" } },
    { id: "structure-home-jin", type: "home", x: 42, y: 30, width: 4, height: 4, assetKey: "object.cottage", props: { placeId: "home-jin" } },
    { id: "structure-well", type: "well", x: 26, y: 22, width: 2, height: 2, assetKey: "object.well", props: { placeId: "well" } },
    { id: "structure-noticeboard", type: "noticeboard", x: 32, y: 27, width: 2, height: 2, assetKey: "object.noticeboard", props: { placeId: "noticeboard" } },
    // ── 광장 주변 가구 ─────────────────────────────────────
    { id: "structure-streetlamp-1", type: "streetlamp", x: 28, y: 17, width: 1, height: 3, assetKey: "object.streetlamp", props: {} },
    { id: "structure-streetlamp-2", type: "streetlamp", x: 35, y: 17, width: 1, height: 3, assetKey: "object.streetlamp", props: {} },
    { id: "structure-streetlamp-3", type: "streetlamp", x: 28, y: 27, width: 1, height: 3, assetKey: "object.streetlamp", props: {} },
    { id: "structure-streetlamp-4", type: "streetlamp", x: 35, y: 27, width: 1, height: 3, assetKey: "object.streetlamp", props: {} },
    { id: "structure-bench-1", type: "bench", x: 30, y: 27, width: 2, height: 1, assetKey: "object.bench", props: {} },
    { id: "structure-bench-2", type: "bench", x: 33, y: 21, width: 2, height: 1, assetKey: "object.bench", props: {} },
    { id: "structure-flowerpot-1", type: "flowerpot", x: 29, y: 21, width: 1, height: 1, assetKey: "object.flowerpot", props: {} },
    { id: "structure-flowerpot-2", type: "flowerpot", x: 34, y: 21, width: 1, height: 1, assetKey: "object.flowerpot", props: {} },
    { id: "structure-flowerpot-3", type: "flowerpot", x: 29, y: 26, width: 1, height: 1, assetKey: "object.flowerpot", props: {} },
    { id: "structure-flowerpot-4", type: "flowerpot", x: 34, y: 26, width: 1, height: 1, assetKey: "object.flowerpot", props: {} },
    { id: "structure-signpost-1", type: "signpost", x: 25, y: 22, width: 1, height: 2, assetKey: "object.signpost", props: {} },
    { id: "structure-signpost-2", type: "signpost", x: 40, y: 22, width: 1, height: 2, assetKey: "object.signpost", props: {} },
    // ── 텃밭·과수원 가구 ───────────────────────────────────
    { id: "structure-scarecrow-1", type: "scarecrow", x: 16, y: 35, width: 2, height: 3, assetKey: "object.scarecrow", props: {} },
    { id: "structure-scarecrow-2", type: "scarecrow", x: 46, y: 35, width: 2, height: 3, assetKey: "object.scarecrow", props: {} },
    { id: "structure-feedbox-1", type: "feedbox", x: 20, y: 36, width: 1, height: 1, assetKey: "object.feedbox", props: {} },
    { id: "structure-feedbox-2", type: "feedbox", x: 50, y: 36, width: 1, height: 1, assetKey: "object.feedbox", props: {} },
    // ── 북쪽 숲 ──────────────────────────────────────────
    { id: "structure-tree-1", type: "tree", x: 4, y: 1, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-2", type: "tree", x: 9, y: 0, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-3", type: "tree", x: 14, y: 1, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-4", type: "tree", x: 19, y: 0, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-5", type: "tree", x: 36, y: 0, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-6", type: "tree", x: 42, y: 1, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-7", type: "tree", x: 47, y: 0, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    // ── 서쪽 숲 ──────────────────────────────────────────
    { id: "structure-tree-w1", type: "tree", x: 2, y: 8, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-w2", type: "tree", x: 6, y: 12, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-w3", type: "tree", x: 3, y: 16, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-tree-w4", type: "tree", x: 7, y: 20, width: 2, height: 3, assetKey: "object.tree.medium", props: {} },
    { id: "structure-tree-w5", type: "tree", x: 2, y: 26, width: 2, height: 3, assetKey: "object.tree.large", props: {} },
    { id: "structure-bush-1", type: "bush", x: 6, y: 9, width: 1, height: 1, assetKey: "object.bush", props: {} },
    { id: "structure-bush-2", type: "bush", x: 9, y: 14, width: 1, height: 1, assetKey: "object.bush", props: {} },
    { id: "structure-bush-3", type: "bush", x: 5, y: 22, width: 1, height: 1, assetKey: "object.bush", props: {} },
    { id: "structure-bush-4", type: "bush", x: 8, y: 28, width: 1, height: 1, assetKey: "object.bush", props: {} },
    // ── 광산 + 동굴 ──────────────────────────────────────
    { id: "structure-rock-1", type: "rock", x: 51, y: 4, width: 2, height: 2, assetKey: "object.rock", props: {} },
    { id: "structure-rock-2", type: "rock", x: 54, y: 6, width: 2, height: 2, assetKey: "object.rock", props: {} },
    { id: "structure-rock-3", type: "rock", x: 56, y: 4, width: 2, height: 2, assetKey: "object.rock", props: {} },
    { id: "structure-rock-4", type: "rock", x: 52, y: 8, width: 2, height: 2, assetKey: "object.rock", props: {} },
    { id: "structure-rock-cave1", type: "rock", x: 28, y: 4, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "cave-entrance" } },
    { id: "structure-rock-cave2", type: "rock", x: 30, y: 4, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "cave-entrance" } },
    // ── 폐허 (서남) ─────────────────────────────────────
    { id: "structure-ruins-shrine", type: "shrine", x: 5, y: 42, width: 3, height: 3, props: { placeId: "ruins-southwest" } },
    { id: "structure-ruins-rock", type: "rock", x: 4, y: 45, width: 2, height: 2, assetKey: "object.rock", props: {} },
    // ── Crafting stations (PR12.3) ─────────────────────────
    { id: "structure-oven", type: "oven", x: 23, y: 19, width: 1, height: 1, assetKey: "object.feedbox", props: { placeId: "bakery", station: "oven" } },
    { id: "structure-alchemy-table", type: "alchemy_table", x: 39, y: 19, width: 2, height: 1, assetKey: "object.bench", props: { placeId: "general-store", station: "alchemy_table" } },
    { id: "structure-workbench", type: "workbench", x: 36, y: 22, width: 2, height: 1, assetKey: "object.bench", props: { station: "workbench" } },
    { id: "structure-forge", type: "forge", x: 50, y: 6, width: 2, height: 2, assetKey: "object.rock", props: { placeId: "mine", station: "forge" } }
  ];

  const player = createActor("player-1", "player", "Hero", "human.default", 20, 29, [], 0, "hero");
  player.hunger = 75;

  const monsterTuned = (id: string, name: string, asset: string, x: number, y: number, hp: number, status: ActorStatus): Actor => {
    const stamina = 50 + status.constitution * 5;
    return {
      id, kind: "monster", name, assetKey: asset, x, y,
      hp, maxHp: hp, mp: 0, maxMp: 0,
      stamina, maxStamina: stamina,
      hunger: 0, status, skills: createDefaultSkills(),
      gold: 0, inventory: [], alive: true
    };
  };

  const actors = [
    player,
    createActor("npc-1", "npc", "Villager", "human.villager", 28, 22, [], 20, "farmer"),
    createActor("npc-2", "npc", "Baker", "human.baker", 25, 22, [], 0, "baker"),
    createActor("npc-3", "npc", "Yui", "human.merchant", 39, 22, [], 10, "merchant"),
    createActor("npc-4", "npc", "Jin", "human.guard", 32, 22, [], 10, "guard"),
    // 북동 광산·숲: 멧돼지 2 (낮은 위협)
    monsterTuned("monster-boar-1", "Boar", "animal.boar", 50, 2, 22, { strength: 3, dexterity: 4, constitution: 4, intelligence: 1 }),
    monsterTuned("monster-boar-2", "Boar2", "animal.boar", 52, 2, 22, { strength: 3, dexterity: 4, constitution: 4, intelligence: 1 }),
    // 비선공 사슴: 넓은 영역 자유 활동 (북·서·남 숲)
    monsterTuned("monster-deer-1", "Deer", "animal.deer", 6, 2, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-2", "Deer2", "animal.deer", 16, 1, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-3", "Deer3", "animal.deer", 38, 1, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-4", "Deer4", "animal.deer", 4, 18, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-5", "Deer5", "animal.deer", 8, 28, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-deer-6", "Deer6", "animal.deer", 60, 38, 18, { strength: 2, dexterity: 6, constitution: 3, intelligence: 1 }),
    // 깊은 서쪽 숲 야간: 늑대 2 (중간 위협, pack)
    monsterTuned("monster-wolf-1", "Wolf", "animal.wolf", 4, 12, 30, { strength: 4, dexterity: 5, constitution: 4, intelligence: 1 }),
    monsterTuned("monster-wolf-2", "Wolf2", "animal.wolf", 5, 13, 30, { strength: 4, dexterity: 5, constitution: 4, intelligence: 1 }),
    // 봉인된 동굴 입구: 곰 1 (높은 위협)
    monsterTuned("monster-bear-1", "Bear", "animal.bear", 30, 5, 50, { strength: 6, dexterity: 3, constitution: 6, intelligence: 1 }),
    // 남동 습지: 슬라임 3 (낮은 위협, 느림)
    monsterTuned("monster-slime-1", "Slime", "monster.slime.green", 53, 43, 16, { strength: 2, dexterity: 2, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-slime-2", "Slime2", "monster.slime.blue", 56, 44, 16, { strength: 2, dexterity: 2, constitution: 3, intelligence: 1 }),
    monsterTuned("monster-slime-3", "Slime3", "monster.slime.yellow", 58, 43, 16, { strength: 2, dexterity: 2, constitution: 3, intelligence: 1 })
  ];

  return {
    revision: 1,
    tick: 0,
    timeOfDay: 8,
    context: createDefaultWorldContext(0),
    map: { width: mapWidth, height: mapHeight, tileSize: 32, terrain, collision, decor },
    structures: byId(structures),
    places: byId(places),
    actors: byId(actors),
    groundItems: {
      // 텃밭 자원 (남쪽 농경지)
      "carrot-1": { id: "carrot-1", x: 16, y: 38, type: "food", iconKey: "item.food.carrot" },
      "carrot-2": { id: "carrot-2", x: 46, y: 38, type: "food", iconKey: "item.food.carrot" },
      "wheat-1": { id: "wheat-1", x: 23, y: 19, type: "food", iconKey: "item.food.wheat" },
      "wheat-2": { id: "wheat-2", x: 24, y: 19, type: "food", iconKey: "item.food.wheat" },
      "wheat-3": { id: "wheat-3", x: 18, y: 38, type: "food", iconKey: "item.food.wheat" },
      // 광산 자원
      "ore-1": { id: "ore-1", x: 52, y: 5, type: "material", iconKey: "item.material.ore" },
      "ore-2": { id: "ore-2", x: 55, y: 7, type: "material", iconKey: "item.material.ore" },
      "coal-1": { id: "coal-1", x: 53, y: 6, type: "material", iconKey: "item.material.coal" },
      "coal-2": { id: "coal-2", x: 56, y: 8, type: "material", iconKey: "item.material.coal" },
      // 숲 자원 (서쪽·북쪽)
      "wood-1": { id: "wood-1", x: 5, y: 10, type: "material", iconKey: "item.material.wood" },
      "wood-2": { id: "wood-2", x: 8, y: 17, type: "material", iconKey: "item.material.wood" },
      "wood-3": { id: "wood-3", x: 4, y: 24, type: "material", iconKey: "item.material.wood" },
      "wood-4": { id: "wood-4", x: 12, y: 1, type: "material", iconKey: "item.material.wood" },
      // 산열매·버섯 (숲)
      "berry-1": { id: "berry-1", x: 6, y: 5, type: "food", iconKey: "item.food.berry" },
      "berry-2": { id: "berry-2", x: 11, y: 12, type: "food", iconKey: "item.food.berry" },
      "berry-3": { id: "berry-3", x: 41, y: 2, type: "food", iconKey: "item.food.berry" },
      "berry-4": { id: "berry-4", x: 4, y: 19, type: "food", iconKey: "item.food.berry" },
      "mushroom-1": { id: "mushroom-1", x: 7, y: 6, type: "food", iconKey: "item.food.mushroom" },
      "mushroom-2": { id: "mushroom-2", x: 9, y: 25, type: "food", iconKey: "item.food.mushroom" },
      "mushroom-3": { id: "mushroom-3", x: 38, y: 2, type: "food", iconKey: "item.food.mushroom" },
      // 약초 (숲·과수원·습지)
      "herb-1": { id: "herb-1", x: 4, y: 14, type: "food", iconKey: "item.food.herb" },
      "herb-2": { id: "herb-2", x: 8, y: 22, type: "food", iconKey: "item.food.herb" },
      "herb-3": { id: "herb-3", x: 25, y: 41, type: "food", iconKey: "item.food.herb" },
      "herb-4": { id: "herb-4", x: 53, y: 44, type: "food", iconKey: "item.food.herb" },
      "herb-5": { id: "herb-5", x: 6, y: 44, type: "food", iconKey: "item.food.herb" },
      // 점토 (연못·습지 근처)
      "clay-1": { id: "clay-1", x: 25, y: 27, type: "material", iconKey: "item.material.clay" },
      "clay-2": { id: "clay-2", x: 51, y: 43, type: "material", iconKey: "item.material.clay" },
      "clay-3": { id: "clay-3", x: 56, y: 44, type: "material", iconKey: "item.material.clay" },
      // 도구·장식
      "fishing_rod-1": { id: "fishing_rod-1", x: 39, y: 19, type: "tool", iconKey: "item.tool.fishing_rod" },
      "bucket-1": { id: "bucket-1", x: 27, y: 22, type: "tool", iconKey: "item.tool.bucket" },
      "simple_charm-1": { id: "simple_charm-1", x: 31, y: 17, type: "trinket", iconKey: "item.trinket.charm" },
      "letter-1": { id: "letter-1", x: 19, y: 31, type: "letter", iconKey: "item.letter" },
      "trinket-1": { id: "trinket-1", x: 31, y: 32, type: "trinket", iconKey: "item.trinket" }
    },
    spawnPoints: {
      humans: [
        { x: 20, y: 29, assetKey: "human.default" },
        { x: 28, y: 22, assetKey: "human.villager" },
        { x: 25, y: 22, assetKey: "human.baker" },
        { x: 39, y: 22, assetKey: "human.merchant" },
        { x: 32, y: 22, assetKey: "human.guard" }
      ],
      animals: [
        { x: 50, y: 2, assetKey: "animal.boar" },
        { x: 52, y: 2, assetKey: "animal.boar" }
      ],
      monsters: [
        { x: 42, y: 2, assetKey: "animal.boar" },
        { x: 44, y: 2, assetKey: "animal.boar" },
        { x: 41, y: 5, assetKey: "animal.boar" }
      ]
    }
  };
};
