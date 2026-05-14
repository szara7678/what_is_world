# Birth Memories — wiw 시민 출생 메모리 단일 소스 (2026-05-07)

## 원칙

NPC 가 처음 태어날 때(=`seedBootstrapMemories` 1회 실행) 주입되는 메모리의 **유일한 출처**.

이 문서가 곧 진실. 코드 (`apps/server/src/brain/bootstrapSeed.ts`) 는 이 문서를 코드화한 것일 뿐.

### 이후의 지식 전수 경로

출생 이후로 시스템이 메모리를 새로 끼워 넣지 않는다. 새 지식은 **두 경로** 만 허용:

1. **명시적 admin 주입** — `/admin/oracle` 또는 직접 jsonl 편집. 운영자가 의도해야 함.
2. **Zara (오라클) 의 in-world SPEAK** — NPC 가 SPEAK 메시지를 듣고 자기 메모리에 자연 저장. 시스템이 prompt 에 박지 않는다.

**금지**: PERSONAL_SEED-식 후속 주입, retrieve 가산 boost (seed/personal tag boost), prompt 에 system 메시지로 레시피 박기.

이유: "강제 X 자연 진화" 마스터 플랜. 시스템이 과도하게 보정하면 emergent 다양성이 죽는다.

---

## 공통 메모리 풀 (모든 NPC 동일 주입)

### INSTINCT — 본능 (19건)
"태어날 때 들고 있는 것". 시스템 매뉴얼 X, 감각형 톤. schema 명칭 (GATHER/MOVE/plan) 절대 X.

#### survival_instinct
- "When the belly empties too long, hands tremble and feet grow heavy." (i 0.85)
- "When danger draws close, stepping back one pace earns one more breath." (i 0.90)
- "Resting brings strength back, dimly known." (i 0.75)

#### survival_rule (death mechanics)
- "If hunger lasts too long, the body withers and returns to soil." (i 0.92)
- "Heavy bleeding or repeated enemy strikes leave the body unable to rise again." (i 0.92)
- "When starvation runs deep, brief rest cannot catch up to recovery." (i 0.85)
- "Anyone knows: pushing too hard meets the soil sooner than resting does." (i 0.78)

#### item_basics
- "Whatever is held can be used — its effect arrives in place." (i 0.78)
- "What lies underfoot can be picked up by hand." (i 0.78)

#### world_basics
- "To hand something directly to another person, you must stand within a step." (i 0.75)
- "Seeds take root only on soil — dimly known." (i 0.75)
- "At a workbench, practiced work yields new shapes." (i 0.78)

#### automation_sense
- "Once you firmly resolve to go far, the body moves there without counting each step." (i 0.70)
- "When the same gathering must repeat, settling the mind once lets the hand carry on." (i 0.70)

#### social_sense
- "To get what you want from another, speaking it clearly helps the heart reach." (i 0.78)
- "When you want something, it is natural to also recall what you can give in return." (i 0.78)
- "Some answer when asked; some pass by pretending not to know — dimly known." (i 0.70)

#### plan_sense
- "Long intentions scatter less when their order is held in mind." (i 0.65)
- "Sorting what comes first from what comes later keeps the body from wandering." (i 0.65)

### PLACE_SENSORY — 마을 장소·감각 (16건)
순수 회상 톤. 절차 지식 X.

(bakery, shop, alchemy, field, mine, forge, workbench, forest, trade, village mood, rest, fatigue 가 골고루 분포.
i 0.40~0.65, ageTicks 5800~8000)

전체 목록은 `bootstrapSeed.ts:PLACE_SENSORY_SEEDS` 참조.

### COMMON — 사회 분위기 (3건)
- "Folk in this village tend not to walk past a neighbor in trouble."
- "Even after being refused once, speaking again to another person felt natural in those days."
- "Wandering the field alone, the smell of soil on the hands lingered long after."

---

## NPC 개인 메모리

각 NPC 의 시작 위치·페르소나에 어울리는 성공/실패 회상. schema 라인 포함 → retrieve 시 LLM 이 schema 그대로 활용 가능.

### Mira (npc-2, 빵집): baking 5 + trade 2
- baking 4 success + 1 failure ("wheat 부족") → oven schema 회상
- trade 2 (bread→gold, bread→wheat 교환)

### Peter (npc-1, 텃밭): farming 5 + trade 2 + 1 heard
- farming 4 success + 1 failure ("seed_plant_at_field") → wheat_seed/carrot_seed schema
- trade 2 (wheat→bread, carrot→gold)
- heard from Mira: oven baking 절차

### Lia (npc-3, 잡화점): alchemy 4 + trade 4 + 1 heard
- alchemy 3 success + 1 failure ("herb 부족") → alchemy-table schema
- trade 4 (potion→gold, bread/berry buy, display)
- heard from Mira: oven baking

### Jin (npc-4, guard): combat 4 + smithing 3 + 1 heard
- combat 4 (boar/wolf/bear, 사냥 후 고기 → 마을 식탁)
- smithing 2 success + 1 failure → forge schema (pickaxe: ore×2 + wood×2 + coal×1)
- heard from Lia: alchemy 절차

### Aaron (player-1, 떠돌이): foraging 3 + edible/social 4
- foraging (berry/mushroom/fishing) → GATHER + USE schema
- edible (herb 응급 식량)
- 거래·사회 (trade & first-greeting)
- heard from Mira/Peter: baking·farming

### Traveler-1 (떠돌이): 3건
- 경험 일반 (campfire 이야기, 채집, trinket→gold)

---

## 새 NPC 가 추가될 때

이 문서에 그 NPC 의 PERSONAL 섹션을 추가 → `bootstrapSeed.ts:PERSONAL_SEEDS` 에 같은 내용 미러링. 둘이 어긋나지 않도록 동시 갱신.

새 시민의 페르소나·시작 위치·인벤은 위 5명의 예시를 참고하여 자연스럽게 차별화. role 라벨 X — 메모리·시작 위치·인벤만으로 emergent 분화.
