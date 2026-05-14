import type { Observation, Soul } from "@wiw/shared";
import { appendObservation } from "../persistence/soulStore";

type SeedTemplate = {
  text: string;
  tags: string[];
  importance: number;
  ageTicks: number;
};

/**
 * 본능 메모리 — 아기가 태어날 때 들고 있는 것.
 * 사용자 + gpt-5.5 결정: 시스템 매뉴얼 X, 감각형 톤. schema 명칭(GATHER/MOVE.to/plan) 절대 X.
 * 모든 NPC 공통. 직업 success_memory 와 함께 seed 시점 1회 주입.
 *
 * 카테고리: survival_instinct / item_basics / world_basics / automation_sense / social_sense / plan_sense
 * retrieve gate: 항상 노출 X. 관련 상황에서 떠오름. 한 prompt 당 1~2건.
 */
const INSTINCT_SEEDS: SeedTemplate[] = [
  // survival_instinct
  { text: "When the belly empties too long, hands tremble and feet grow heavy.", tags: ["instinct", "survival_instinct"], importance: 0.85, ageTicks: 12000 },
  { text: "When danger draws close, stepping back one pace earns one more breath.", tags: ["instinct", "survival_instinct"], importance: 0.90, ageTicks: 12000 },
  { text: "Resting brings strength back, dimly known.", tags: ["instinct", "survival_instinct"], importance: 0.75, ageTicks: 12000 },
  // survival_rule — death mechanics
  { text: "If hunger lasts too long, the body withers and returns to soil.", tags: ["instinct", "survival_rule"], importance: 0.92, ageTicks: 12000 },
  { text: "Heavy bleeding or repeated enemy strikes leave the body unable to rise again.", tags: ["instinct", "survival_rule"], importance: 0.92, ageTicks: 12000 },
  { text: "When starvation runs deep, brief rest cannot catch up to recovery.", tags: ["instinct", "survival_rule"], importance: 0.85, ageTicks: 12000 },
  { text: "Anyone knows: pushing too hard meets the soil sooner than resting does.", tags: ["instinct", "survival_rule"], importance: 0.78, ageTicks: 12000 },
  // item_basics
  { text: "Whatever is held can be used — its effect arrives in place.", tags: ["instinct", "item_basics"], importance: 0.78, ageTicks: 12000 },
  { text: "What lies underfoot can be picked up by hand.", tags: ["instinct", "item_basics"], importance: 0.78, ageTicks: 12000 },
  // world_basics
  { text: "To hand something directly to another person, you must stand within a step.", tags: ["instinct", "world_basics"], importance: 0.75, ageTicks: 12000 },
  { text: "Seeds take root only on soil — dimly known.", tags: ["instinct", "world_basics"], importance: 0.75, ageTicks: 12000 },
  { text: "At a workbench, practiced work yields new shapes.", tags: ["instinct", "world_basics"], importance: 0.78, ageTicks: 12000 },
  // automation_sense
  { text: "Once you firmly resolve to go far, the body moves there without counting each step.", tags: ["instinct", "automation_sense"], importance: 0.70, ageTicks: 12000 },
  { text: "When the same gathering must repeat, settling the mind once lets the hand carry on.", tags: ["instinct", "automation_sense"], importance: 0.70, ageTicks: 12000 },
  // social_sense
  { text: "To get what you want from another, speaking it clearly helps the heart reach.", tags: ["instinct", "social_sense"], importance: 0.78, ageTicks: 12000 },
  { text: "When you want something, it is natural to also recall what you can give in return.", tags: ["instinct", "social_sense"], importance: 0.78, ageTicks: 12000 },
  { text: "Some answer when asked; some pass by pretending not to know — dimly known.", tags: ["instinct", "social_sense"], importance: 0.70, ageTicks: 12000 },
  // plan_sense
  { text: "Long intentions scatter less when their order is held in mind.", tags: ["instinct", "plan_sense"], importance: 0.65, ageTicks: 12000 },
  { text: "Sorting what comes first from what comes later keeps the body from wandering.", tags: ["instinct", "plan_sense"], importance: 0.65, ageTicks: 12000 }
];

/**
 * cmd_hint 메모리 풀 폐지 (2026-05-06).
 * 절차 지식(schema/recipe)은 Skill block (createDefaultSkills) 으로 이전.
 * 메모리는 순수 declarative 회상만 — instinct, survival_rule, place_sensory.
 * 이유: cmd_hint 가 memory + recipe + schema + action hint 를 섞어 episodic 품질을 망쳤음.
 *       동일 텍스트 반복 노출이 LLM 을 "기억 떠올리기" 가 아니라 "프롬프트 박힌 암시 따르기" 로 기울게 함.
 */

/**
 * 시드 메모리: 절차형 ("X→Y로 해결") 표현 금지. 세계 정서/장소성/감각만.
 * NPC 가 자기답게 자연스럽게 발견하도록. 행동 매핑은 LLM 결정에 맡김 (강제 X 자연 진화).
 */
const COMMON: SeedTemplate[] = [
  { text: "Folk in this village tend not to walk past a neighbor in trouble.", tags: ["social"], importance: 0.45, ageTicks: 5000 },
  { text: "Even after being refused once, speaking again to another person felt natural in those days.", tags: ["social"], importance: 0.4, ageTicks: 7200 },
  { text: "Wandering the field alone, the smell of soil on the hands lingered long after.", tags: ["place", "field"], importance: 0.35, ageTicks: 6000 },
  { text: "There was a time stepping back from heavy footfalls saved a life.", tags: ["danger"], importance: 0.45, ageTicks: 8400 },
  { text: "Pausing a beat often made the next resolve clearer.", tags: ["rest"], importance: 0.35, ageTicks: 9000 }
];

/**
 * 보편 분위기 시드 — 모든 NPC 가 같은 풀에서 받는 sensory/place 회상.
 * 마을의 다양한 장소·작업·감각을 담아 NPC 가 시야·인접 station 매칭에 따라 자연스레 떠올리도록.
 */
const PLACE_SENSORY_SEEDS: SeedTemplate[] = [
  // bakery/oven
  { text: "At the Sunny Bakery oven, the warm scent that spread each dawn became familiar to the hands.", tags: ["place", "oven"], importance: 0.55, ageTicks: 6000 },
  { text: "On the day 2 wheat went into the oven and the first loaf rose golden, the scent stayed on the fingertips.", tags: ["success_memory", "cooking", "sensory", "not_instruction"], importance: 0.65, ageTicks: 5500 },
  // shop/alchemy
  { text: "Among the small vials in the corner shop, dry herbs mingled with the smell of berries.", tags: ["place", "alchemy_table"], importance: 0.55, ageTicks: 6500 },
  { text: "Laying 2 herb and 1 berry on the alchemy table and stirring, a healing potion settled into a small vial.", tags: ["success_memory", "alchemy", "sensory", "not_instruction"], importance: 0.65, ageTicks: 6000 },
  // field/farming
  { text: "Noticing the dawn dew settled over the field was a daily habit.", tags: ["place", "field"], importance: 0.55, ageTicks: 6000 },
  { text: "On a sunlit autumn day, after burying a handful of wheat seeds in the soil and waiting a few days, the ripened wheat was harvested.", tags: ["success_memory", "farming", "sensory", "not_instruction"], importance: 0.65, ageTicks: 5500 },
  // mine/forge
  { text: "The cold air at the mine entrance and the iron-ringing of the forge mingled in a familiar place.", tags: ["place", "forge", "mine"], importance: 0.55, ageTicks: 6500 },
  { text: "Hammering ore until the weight of a tool's grip settled in the palm — that touch is unforgotten.", tags: ["success_memory", "smithing", "sensory", "not_instruction"], importance: 0.65, ageTicks: 6000 },
  // workbench/forest/trade
  { text: "At the workbench, time passed running fingers along the wood grain.", tags: ["place", "workbench"], importance: 0.50, ageTicks: 6500 },
  { text: "On the way back from the forest with a sackful of berries and mushrooms, the evening footsteps felt light.", tags: ["success_memory", "foraging", "sensory", "not_instruction"], importance: 0.60, ageTicks: 5800 },
  { text: "Once, handing a loaf of bread to a neighbor and receiving 2 wheat in return filled the shelf again.", tags: ["success_memory", "trade", "sensory", "not_instruction"], importance: 0.60, ageTicks: 6500 },
  // village mood/rest
  { text: "The weekly rhythm of straightening the shop display and greeting customers in the morning lingered in the body.", tags: ["social"], importance: 0.45, ageTicks: 7000 },
  { text: "Even resting briefly under the eaves on a rainy day was part of the day's work.", tags: ["rest"], importance: 0.40, ageTicks: 7500 },
  { text: "The aching that follows a day pushed too hard tends to linger long.", tags: ["fatigue"], importance: 0.45, ageTicks: 7000 },
  { text: "The first smile in an unfamiliar village is hard to forget.", tags: ["social"], importance: 0.45, ageTicks: 7000 },
  { text: "On entering an unfamiliar village, listening first to the sounds nearby is a habit.", tags: ["place"], importance: 0.40, ageTicks: 8000 }
];

const idGen = (prefix: string): string => `obs_seed_${prefix}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * NPC 별 개인 success_memory (2026-05-06 신설).
 * 사용자 의도: 시스템 추가 X, 메모리만으로 자연 차별화.
 * 톤: 순수 회상 (schema 명시 X). importance 0.70~0.78 — PLACE_SENSORY (0.55~0.65) 보다 약간 높게.
 * retrieve 의 station/inventory match boost 와 자연스럽게 결합.
 *
 * Mira (npc-2, 빵집):       baking 5 + trade 2
 * Peter (npc-1, 텃밭 거주):  farming 5 + trade 2
 * Lia (npc-3, 잡화점):       alchemy 4 + trade 4
 * Jin (npc-4, guard):       combat 4 + smithing 3
 * Aaron (player-1, 떠돌이):  foraging 3 + 다양 4
 */
const PERSONAL_SEEDS: Record<string, SeedTemplate[]> = {
  "npc-2": [
    // baking 5 — 2026-05-07: schema 라인 추가. NPC 가 retrieve 해서 그대로 schema 복사 가능.
    { text: "Yesterday at dawn beside the oven, with 2 wheat in hand, baked one loaf of bread; the scent of warm crust stayed on the fingertips.\nExecuted: type=USE objectId=structure-oven targetItemId=bread | Outcome: success", tags: ["success_memory", "experience", "cooking"], importance: 0.78, ageTicks: 1500 },
    { text: "Baking 2 wheat at the bakery oven a second time, the loaf rose more golden. The same sequence is in the hands.\nExecuted: type=USE objectId=structure-oven targetItemId=bread | Outcome: success", tags: ["success_memory", "experience", "cooking"], importance: 0.76, ageTicks: 2200 },
    { text: "Last week even on a rainy morning the oven stayed warm; baked bread with 2 wheat and put it on the shelf.\nExecuted: type=USE objectId=structure-oven targetItemId=bread | Outcome: success", tags: ["success_memory", "experience", "cooking"], importance: 0.74, ageTicks: 3500 },
    { text: "On days the hands fumbled at the oven, the bag was always short of wheat. Belief: the oven needs 2 wheat for one loaf — attempts with less fall short.", tags: ["belief", "experience", "cooking", "fail:missing_inputs"], importance: 0.78, ageTicks: 2800 },
    { text: "After a few days off from baking, even standing by the oven made the hands itch. Want to try one loaf again today.", tags: ["success_memory", "cooking"], importance: 0.72, ageTicks: 1800 },
    // trade 2
    { text: "Sold one baked loaf of bread to a customer in front of the corner shop for 5 gold. The same price worked again next time.\nExecuted: type=OFFER_TRADE offerItem=bread offerGold=5 | Outcome: success", tags: ["success_memory", "experience", "trade"], importance: 0.72, ageTicks: 4000 },
    { text: "On days short of wheat, handed a neighbor farmer one loaf of bread and got 2 wheat back. That refilled the shelf.", tags: ["success_memory", "trade"], importance: 0.74, ageTicks: 3200 }
  ],
  "npc-1": [
    // farming 5 — schema 명시
    { text: "Last autumn, gently buried a handful of wheat seeds in the field soil and waited a few days; the bag filled with ripened wheat.\nExecuted: type=USE itemId=wheat_seed | Outcome: success (on field soil)", tags: ["success_memory", "experience", "farming"], importance: 0.78, ageTicks: 1600 },
    { text: "The softness of placing seeds onto soil with the fingertips is vivid. The hand caught it best on bare field soil.\nExecuted: type=USE itemId=wheat_seed | Outcome: success (on field tile)", tags: ["success_memory", "experience", "farming"], importance: 0.74, ageTicks: 2400 },
    { text: "Buried a handful of carrot seeds and the next week, bent at the waist, gathered them by the handful.\nExecuted: type=USE itemId=carrot_seed | Outcome: success", tags: ["success_memory", "experience", "farming"], importance: 0.74, ageTicks: 3000 },
    { text: "On a morning field smelling of earth, where each seed was buried a sprout came up days later.", tags: ["success_memory", "farming"], importance: 0.72, ageTicks: 2800 },
    { text: "On days seeds were dropped on the road instead of the field, nothing grew. Belief: wheat_seed plants only on field soil; off-field USE has no effect.", tags: ["belief", "experience", "farming", "fail:wrong_terrain"], importance: 0.76, ageTicks: 3400 },
    // trade 2
    { text: "Once handed 2 harvested wheat to the bakery neighbor and received one freshly baked loaf to share with family.\nExecuted: type=OFFER_TRADE offerItem=wheat wantItem=bread | Outcome: success", tags: ["success_memory", "experience", "trade"], importance: 0.74, ageTicks: 4000 },
    { text: "After fieldwork, dropping by the corner shop and trading a handful of carrots for 2 gold.", tags: ["success_memory", "trade"], importance: 0.70, ageTicks: 4800 },
    // 주변인 1건 (heard from Mira)
    { text: "Heard from Mira: she said the oven turns 2 wheat into one loaf if you stand right beside it.\nExecuted: type=USE objectId=structure-oven targetItemId=bread | Outcome: success (heard, not lived)", tags: ["heard_memory", "experience", "cooking", "from:npc-2"], importance: 0.60, ageTicks: 5500 }
  ],
  "npc-3": [
    // alchemy 4 — schema 명시
    { text: "Laid 2 herb and 1 berry on the alchemy table inside the corner shop, stirred — and a healing potion settled into a small vial.\nExecuted: type=USE objectId=structure-alchemy-table targetItemId=healing_potion | Outcome: success", tags: ["success_memory", "experience", "alchemy"], importance: 0.78, ageTicks: 1800 },
    { text: "On an evening short on herb, the hands fumbled at the alchemy table. Belief: a healing_potion needs 2 herb and 1 berry; short on either fails.", tags: ["belief", "experience", "alchemy", "fail:missing_inputs"], importance: 0.76, ageTicks: 2600 },
    { text: "Following the same sequence at the alchemy table a second time, a clearer-colored potion came out.\nExecuted: type=USE objectId=structure-alchemy-table targetItemId=healing_potion | Outcome: success", tags: ["success_memory", "experience", "alchemy"], importance: 0.74, ageTicks: 3000 },
    { text: "On days a vial filled, the corner shop's display gained one more row.", tags: ["success_memory", "alchemy"], importance: 0.72, ageTicks: 3800 },
    // trade 4
    { text: "Sold one healing potion to a guard nearby for 8 gold.\nExecuted: type=OFFER_TRADE offerItem=healing_potion offerGold=8 | Outcome: success", tags: ["success_memory", "experience", "trade"], importance: 0.74, ageTicks: 4200 },
    { text: "Once bought freshly baked bread from the neighboring bakery and kept it for own lunch.", tags: ["success_memory", "trade"], importance: 0.72, ageTicks: 4500 },
    { text: "Buying berries with gold from a passing wanderer was useful when making potion the next day.", tags: ["success_memory", "trade"], importance: 0.70, ageTicks: 5200 },
    { text: "Once an item was placed on the display, the customer started speaking first.", tags: ["success_memory", "trade"], importance: 0.68, ageTicks: 5800 },
    // 주변인 1건 (heard from Mira)
    { text: "Heard from Mira: 2 wheat at the oven becomes a loaf — useful when she runs short.\nExecuted: type=USE objectId=structure-oven targetItemId=bread | Outcome: success (heard, not lived)", tags: ["heard_memory", "experience", "cooking", "from:npc-2"], importance: 0.60, ageTicks: 5500 }
  ],
  "npc-4": [
    // combat 4 — schema 명시
    { text: "Once met a boar at the mine entrance, met it with a sword in one steady breath, and felled it.\nExecuted: type=ATTACK targetId=monster-boar | Outcome: success", tags: ["success_memory", "experience", "combat"], importance: 0.78, ageTicks: 1800 },
    { text: "On a night when breath grew dangerous, stepped back one pace then forward one pace, driving off the wolf.\nExecuted: type=ATTACK targetId=monster-wolf | Outcome: success", tags: ["success_memory", "experience", "combat"], importance: 0.76, ageTicks: 2400 },
    { text: "When a bear was met, did not charge but kept distance and withdrew. The breath that came back alive is vivid.", tags: ["success_memory", "combat"], importance: 0.74, ageTicks: 3000 },
    { text: "After the hunt, 2 cuts of meat brought home filled the village table that day.", tags: ["success_memory", "combat"], importance: 0.72, ageTicks: 3800 },
    // smithing 3 — schema 명시 (사용자 핵심 요청: Jin pickaxe 회상)
    { text: "At the anvil beside the forge, with 2 ore and 2 wood and 1 coal, hammering set the weight of a pickaxe handle into the palm.\nExecuted: type=USE objectId=structure-forge targetItemId=pickaxe | Outcome: success", tags: ["success_memory", "experience", "smithing"], importance: 0.80, ageTicks: 2200 },
    { text: "Hands that shaped tools amid the iron-ringing felt steadier walking the mine.\nExecuted: type=USE objectId=structure-forge targetItemId=pickaxe | Outcome: success", tags: ["success_memory", "experience", "smithing"], importance: 0.74, ageTicks: 3400 },
    { text: "On days short of materials the hands fumbled at the anvil. Belief: a pickaxe at the forge needs 2 ore + 2 wood + 1 coal; missing any of those fails.", tags: ["belief", "experience", "smithing", "fail:missing_inputs"], importance: 0.74, ageTicks: 4200 },
    // 주변인 1건 (heard from Lia)
    { text: "Heard from Lia: 2 herb and 1 berry at the alchemy table give a healing potion.\nExecuted: type=USE objectId=structure-alchemy-table targetItemId=healing_potion | Outcome: success (heard, not lived)", tags: ["heard_memory", "experience", "alchemy", "from:npc-3"], importance: 0.58, ageTicks: 6000 }
  ],
  "player-1": [
    // foraging 3 (Aaron 전문)
    { text: "There was a day on the way back from the forest with a sackful of berries and mushrooms, the evening footsteps felt light.\nExecuted: type=GATHER item=berry | Outcome: success (forest_edge)", tags: ["success_memory", "experience", "foraging"], importance: 0.74, ageTicks: 2200 },
    { text: "The first berry tasted on the road eased the hunger for a while — that road memory is vivid.\nExecuted: type=USE itemId=berry | Outcome: success (hunger eased)", tags: ["success_memory", "experience", "foraging", "edible"], importance: 0.70, ageTicks: 3000 },
    { text: "One afternoon standing by water with a fishing rod, the float trembled and a fish followed.\nExecuted: type=USE itemId=fishing_rod | Outcome: success (next to water)", tags: ["success_memory", "experience", "fishing"], importance: 0.72, ageTicks: 3500 },
    // edible & social
    { text: "When hunger grew deep, even one leaf of herb from the bag went to the mouth first.\nExecuted: type=USE itemId=herb | Outcome: success (hunger eased)", tags: ["success_memory", "experience", "edible"], importance: 0.76, ageTicks: 2400 },
    { text: "After offering a handful of carrots to someone asking for help, that person greeted first afterward.", tags: ["success_memory", "trade", "social"], importance: 0.68, ageTicks: 4800 },
    // 주변인 회상
    { text: "Heard from Mira once: she said baking 2 wheat at the oven gives a loaf — tried it once myself and it worked.\nExecuted: type=USE objectId=structure-oven targetItemId=bread | Outcome: success (lived once)", tags: ["heard_memory", "experience", "cooking", "from:npc-2"], importance: 0.62, ageTicks: 5500 },
    { text: "Watched Peter burying wheat seeds on field soil one morning — the flow of his hand stayed in mind.\nExecuted: type=USE itemId=wheat_seed | Outcome: success (heard from Peter)", tags: ["heard_memory", "experience", "farming", "from:npc-1"], importance: 0.60, ageTicks: 6000 }
  ],
  "traveler-1": [
    { text: "The small stories gathered passing through several villages often unfolded by the campfire in the evening.", tags: ["success_memory", "social"], importance: 0.65, ageTicks: 5000 },
    { text: "Once on an unfamiliar road, gathered handfuls of berries and mushrooms to last until the next village.\nExecuted: type=GATHER item=berry | Outcome: success", tags: ["success_memory", "experience", "foraging"], importance: 0.68, ageTicks: 4500 },
    { text: "At a passing roadside stall, sold a small trinket for 2 gold.\nExecuted: type=OFFER_TRADE offerItem=trinket offerGold=2 | Outcome: success", tags: ["success_memory", "experience", "trade"], importance: 0.66, ageTicks: 5500 }
  ]
};

/**
 * 시드 정책 (2026-05-06 v2):
 *  - 모든 NPC 공통 풀: INSTINCT (19) + PLACE_SENSORY (16) + COMMON (3)
 *  - NPC 별 개인 success_memory (5~7) — 시작 위치/페르소나 기반 자연 차별화
 *  - role 라벨 X, schema 명시 X — 순수 회상. retrieve 가 상황 매칭으로 surface.
 */
export async function seedBootstrapMemories(actorId: string, _soul: Soul, currentTick: number): Promise<void> {
  const personal = PERSONAL_SEEDS[actorId] ?? [];
  const templates = [
    ...INSTINCT_SEEDS,         // 19건
    ...PLACE_SENSORY_SEEDS,    // 16건
    ...COMMON.slice(0, 3),     // 3건
    ...personal                // 0~7건 (NPC 별 차별화)
  ];
  for (const t of templates) {
    const obs: Observation = {
      id: idGen("a"),
      actorId,
      tick: Math.max(0, currentTick - t.ageTicks),
      timestamp: Date.now() - t.ageTicks * 100,
      kind: "memory",
      text: t.text,
      tags: t.tags,
      importance: t.importance
    };
    await appendObservation(obs);
  }
}
