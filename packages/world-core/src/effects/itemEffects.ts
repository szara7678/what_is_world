import type { Actor, WorldState } from "@wiw/shared";
import { addToInventory, inventorySlotsUsed } from "@wiw/shared";
import { placeGroundItemAt } from "../placement/groundItems";

export type ItemEffectResult = { ok: boolean; message: string; consumed: boolean };

const BLUEPRINT_TO_STRUCTURE: Record<string, { type: string; assetKey: string; width: number; height: number; placeKind?: string; placeName?: string }> = {
  workbench_blueprint: { type: "workbench", assetKey: "object.bench", width: 2, height: 1 },
  oven_blueprint: { type: "oven", assetKey: "object.feedbox", width: 1, height: 1 },
  cottage_blueprint: { type: "home", assetKey: "object.cottage", width: 4, height: 4, placeKind: "home", placeName: "new cottage" }
};

export function tryPlaceBlueprint(world: WorldState, actor: Actor, itemId: string): { ok: boolean; message: string } {
  const prefix = itemId.split("-")[0] ?? "";
  const spec = BLUEPRINT_TO_STRUCTURE[prefix];
  if (!spec) return { ok: false, message: `unknown_blueprint:${prefix}` };
  // 인접 후보 위치 (자기 자리 + 4방향, spec 크기에 맞게 모두 빈 칸·통행 가능)
  const candidates = [
    { dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 0 }
  ];
  for (const c of candidates) {
    const x = actor.x + c.dx;
    const y = actor.y + c.dy;
    if (!fitsAt(world, x, y, spec.width, spec.height)) continue;
    const id = `structure-${spec.type}-${Math.random().toString(36).slice(2, 7)}`;
    world.structures[id] = {
      id,
      type: spec.type,
      x, y,
      width: spec.width,
      height: spec.height,
      assetKey: spec.assetKey,
      props: { placedBy: actor.id, station: spec.type === "workbench" || spec.type === "oven" || spec.type === "forge" || spec.type === "alchemy_table" ? spec.type : undefined }
    };
    if (spec.placeKind === "home") {
      const placeId = `place-${id}`;
      world.places[placeId] = {
        id: placeId,
        name: spec.placeName ?? "새 거주지",
        kind: "home",
        x, y, width: spec.width, height: spec.height,
        allowedActions: ["WAIT", "REST", "SPEAK"],
        socialWeight: 0.25,
        dayPhaseBias: { morning: 0.35, day: 0.15, evening: 0.75, night: 1 },
        tags: ["home", "rest", "indoor", "built"]
      };
      world.structures[id].props.placeId = placeId;
    }
    world.revision += 1;
    return { ok: true, message: `built:${spec.type}@${x},${y} by ${actor.name}` };
  }
  return { ok: false, message: "no_space_for_blueprint" };
}

function fitsAt(world: WorldState, x: number, y: number, w: number, h: number): boolean {
  if (x < 0 || y < 0 || x + w > world.map.width || y + h > world.map.height) return false;
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      if (world.map.collision[yy]?.[xx] === 1) return false;
      const occupied = Object.values(world.structures ?? {}).some((s) =>
        xx >= s.x && xx < s.x + s.width && yy >= s.y && yy < s.y + s.height
      );
      if (occupied) return false;
    }
  }
  return true;
}

export const applyItemEffect = (
  actor: Actor,
  itemId: string,
  _world: WorldState
): ItemEffectResult => {
  const hpBefore = actor.hp;
  const hungerBefore = actor.hunger;
  const staminaBefore = actor.stamina;
  const intelligence = actor.status?.intelligence ?? 5;
  const cooking = actor.skills?.find((skill) => skill.id === "cooking")?.level ?? 0;
  const multiplier = 1 + intelligence / 20 + cooking * 0.05;
  const hungerGain = (amount: number): number => amount * multiplier;
  const hpGain = (amount: number): number => amount * multiplier;

  if (itemId.startsWith("carrot")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(10));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 2);
    return {
      ok: true,
      message: `carrot hunger:${hungerBefore}->${actor.hunger} stamina:${staminaBefore}->${actor.stamina}`,
      consumed: true
    };
  }

  // 2026-05-08: wheat_seed 통합 — wheat 자체가 plantable. 단독 USE 효과는 없음 (oven craft 또는 field plant 만).
  // legacy wheat_seed 슬롯 호환: USE 는 plant 라우팅으로 dispatchAction 에서 처리 (효과 단계 도달 X).
  if (itemId.startsWith("wheat_seed") || itemId.startsWith("carrot_seed")) {
    return { ok: false, message: "seed_plant_at_field", consumed: false };
  }
  if (itemId.startsWith("wheat") || itemId.startsWith("carrot")) {
    return { ok: false, message: "use_at_field_or_oven", consumed: false };
  }

  if (itemId.startsWith("herb")) {
    actor.hp = Math.min(actor.maxHp, actor.hp + hpGain(5));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 3);
    return {
      ok: true,
      message: `herb hp:${hpBefore}->${actor.hp} stamina:${staminaBefore}->${actor.stamina}`,
      consumed: true
    };
  }

  if (itemId.startsWith("potion-heal")) {
    actor.hp = Math.min(actor.maxHp, actor.hp + hpGain(30));
    return {
      ok: true,
      message: `potion-heal hp:${hpBefore}->${actor.hp}`,
      consumed: true
    };
  }

  if (itemId.startsWith("letter")) {
    return {
      ok: true,
      message: "letter belief: news and a message from another village are written in this letter",
      consumed: true
    };
  }

  if (itemId.startsWith("trinket")) {
    return {
      ok: true,
      message: "trinket gift-ready",
      consumed: false
    };
  }

  if (itemId.startsWith("workbench_blueprint") || itemId.startsWith("oven_blueprint") || itemId.startsWith("cottage_blueprint")) {
    const built = tryPlaceBlueprint(_world, actor, itemId);
    if (!built.ok) return { ok: false, message: built.message, consumed: false };
    return { ok: true, message: built.message, consumed: true };
  }

  if (itemId.startsWith("bread")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(20));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 3);
    return { ok: true, message: `bread hunger:${hungerBefore}->${actor.hunger} stamina+3`, consumed: true };
  }

  if (itemId.startsWith("cooked_fish")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(28));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 6);
    return { ok: true, message: `cooked_fish hunger:${hungerBefore}->${actor.hunger} stamina+6`, consumed: true };
  }

  if (itemId.startsWith("healing_potion")) {
    actor.hp = Math.min(actor.maxHp, actor.hp + hpGain(35));
    return { ok: true, message: `healing_potion hp:${hpBefore}->${actor.hp}`, consumed: true };
  }

  if (itemId.startsWith("stamina_potion")) {
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 30);
    actor.mp = Math.min(actor.maxMp, actor.mp + 5);
    return { ok: true, message: `stamina_potion stamina:${staminaBefore}->${actor.stamina}`, consumed: true };
  }

  if (itemId.startsWith("meat")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(22));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 5);
    return {
      ok: true,
      message: `meat hunger:${hungerBefore}->${actor.hunger} stamina+5`,
      consumed: true
    };
  }

  if (itemId.startsWith("cooked_meat")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(28));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 6);
    return {
      ok: true,
      message: `cooked_meat hunger:${hungerBefore}->${actor.hunger} stamina+6`,
      consumed: true
    };
  }

  if (itemId.startsWith("fish_stew")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(32));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 8);
    actor.hp = Math.min(actor.maxHp, actor.hp + hpGain(8));
    return {
      ok: true,
      message: `fish_stew hunger:${hungerBefore}->${actor.hunger} stamina+8 hp:${hpBefore}->${actor.hp}`,
      consumed: true
    };
  }

  if (itemId.startsWith("corpse")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(28));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 4);
    return {
      ok: true,
      message: `corpse_meat hunger:${hungerBefore}->${actor.hunger} stamina:${staminaBefore}->${actor.stamina}`,
      consumed: true
    };
  }

  if (itemId.startsWith("apple")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(14));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 2);
    return { ok: true, message: `apple hunger:${hungerBefore}->${actor.hunger}`, consumed: true };
  }
  if (itemId.startsWith("pear")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(14));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 2);
    return { ok: true, message: `pear_deprecated_as_apple hunger:${hungerBefore}->${actor.hunger}`, consumed: true };
  }
  if (itemId.startsWith("pineapple")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(15));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 2);
    return { ok: true, message: `pineapple hunger:${hungerBefore}->${actor.hunger}`, consumed: true };
  }

  const foodEffects: Record<string, { hunger: number; stamina: number }> = {
    cheese: { hunger: 16, stamina: 3 },
    eggs: { hunger: 12, stamina: 2 },
    cooked_eggs: { hunger: 18, stamina: 4 },
    chicken_leg: { hunger: 24, stamina: 5 },
    steak: { hunger: 26, stamina: 5 },
    honey: { hunger: 10, stamina: 4 },
    tomato: { hunger: 11, stamina: 2 },
    potato: { hunger: 13, stamina: 2 },
    onion: { hunger: 8, stamina: 1 },
    cherry: { hunger: 9, stamina: 2 },
    peach: { hunger: 14, stamina: 2 },
    sushi: { hunger: 24, stamina: 6 },
    shrimp: { hunger: 16, stamina: 4 },
    sardines: { hunger: 18, stamina: 4 },
    sashimi: { hunger: 22, stamina: 5 }
  };
  const foodKey = Object.keys(foodEffects).find((key) => itemId.startsWith(key));
  if (foodKey) {
    const effect = foodEffects[foodKey];
    actor.hunger = Math.max(0, actor.hunger - hungerGain(effect.hunger));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + effect.stamina);
    return { ok: true, message: `${foodKey} hunger:${hungerBefore}->${actor.hunger} stamina:${staminaBefore}->${actor.stamina}`, consumed: true };
  }

  if (itemId.startsWith("berry")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(12));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 1);
    return {
      ok: true,
      message: `berry hunger:${hungerBefore}->${actor.hunger} stamina:${staminaBefore}->${actor.stamina}`,
      consumed: true
    };
  }

  if (itemId.startsWith("mushroom")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(8));
    actor.mp = Math.min(actor.maxMp, actor.mp + 2);
    return {
      ok: true,
      message: `mushroom hunger:${hungerBefore}->${actor.hunger} mp+2`,
      consumed: true
    };
  }

  if (itemId.startsWith("fish")) {
    actor.hunger = Math.max(0, actor.hunger - hungerGain(20));
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 4);
    return {
      ok: true,
      message: `fish hunger:${hungerBefore}->${actor.hunger} stamina:${staminaBefore}->${actor.stamina}`,
      consumed: true
    };
  }

  if (itemId.startsWith("fishing_rod")) {
    const groundItems = Object.values(_world.groundItems);
    const nearPond = groundItems.some((item) =>
      Math.abs(item.x - actor.x) <= 1 && Math.abs(item.y - actor.y) <= 1 && item.type === "water"
    );
    const placeKind = (() => {
      const place = Object.values(_world.places ?? {}).find((p) =>
        actor.x >= p.x && actor.x < p.x + p.width && actor.y >= p.y && actor.y < p.y + p.height
      );
      return place?.kind;
    })();
    const isAtPond = placeKind === "pond" || placeKind === "well" || nearPond;
    if (!isAtPond) return { ok: false, message: "fishing_no_water_nearby", consumed: false };
    const fishing = actor.skills?.find((skill) => skill.id === "fishing")?.level ?? 0;
    const successChance = 0.35 + fishing * 0.05;
    if (Math.random() < successChance) {
      const fishId = `fish-${Math.random().toString(36).slice(2, 7)}`;
      if (!placeGroundItemAt(_world, { id: fishId, x: actor.x, y: actor.y, type: "food", iconKey: "item.food.fish" })) {
        return { ok: true, message: "cast_rod no_space", consumed: false };
      }
      return { ok: true, message: `cast_rod fish_caught:${fishId}`, consumed: false };
    }
    return { ok: true, message: "cast_rod no_bite", consumed: false };
  }

  if (itemId.startsWith("bucket")) {
    // 양동이는 요리(craft) 용 물 보관 도구. 우물·연못에서 USE 시 인벤에 water-X 1개 추가.
    // stamina 직접 회복은 없음 — 물은 요리 재료로만.
    const placeKind = (() => {
      const place = Object.values(_world.places ?? {}).find((p) =>
        actor.x >= p.x && actor.x < p.x + p.width && actor.y >= p.y && actor.y < p.y + p.height
      );
      return place?.kind;
    })();
    if (placeKind === "well" || placeKind === "pond") {
      if (inventorySlotsUsed(actor.inventory) < 14) {
        addToInventory(actor.inventory, "water", 1, 14);
      }
      return { ok: true, message: `bucket_filled water_drawn`, consumed: false };
    }
    return { ok: false, message: "bucket_no_water_source", consumed: false };
  }
  // water 자체는 요리 재료. USE water 단독으로는 효과 없음 (recipe 통해 craft 만 사용)
  if (itemId.startsWith("water")) {
    return { ok: false, message: "water_only_for_cooking", consumed: false };
  }

  // 2026-05-08: clay/coal USE 단독 효과 없음. 이전 ok:true 라 LLM 이 거짓 success 메모리 적립 → ok:false.
  // 실제 사용처는 craft input 만. 단독 USE 는 의미 없음.
  if (itemId.startsWith("clay")) {
    return { ok: false, message: "material_only_for_craft", consumed: false };
  }
  if (itemId.startsWith("coal")) {
    return { ok: false, message: "material_only_for_craft", consumed: false };
  }

  if (itemId.startsWith("simple_charm") || itemId.startsWith("charm")) {
    actor.mp = Math.min(actor.maxMp, actor.mp + 5);
    actor.stamina = Math.min(actor.maxStamina, actor.stamina + 2);
    return { ok: true, message: `charm_blessing mp:${actor.mp} stamina:${actor.stamina}`, consumed: false };
  }

  if (itemId.startsWith("wood") || itemId.startsWith("ore")) {
    return {
      ok: false,
      message: "crafting_not_implemented",
      consumed: false
    };
  }

  return {
    ok: false,
    message: "no_effect",
    consumed: false
  };
};
