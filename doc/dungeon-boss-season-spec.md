# 던전 + 외부 보스 + 작물 황금기 + Epic monster Spec

목적: dynamic events 같은 외부 macro 강제 없이, **이미 시스템에 좌석이 있는** 4축에서 RPG 서사·생동감 확장.

원칙:
- "어거지" X — 이미 있는 place/monster/weather slot을 *naturally 확장*
- 외부 macro 가이드(VILLAGE MOOD 류) X — 각자 자기 시야에서 본 것만
- rule-based 우선 / LLM은 SPEAK 등 한정 호출 (비용 폭주 회피)
- agency 보존 — NPC가 "꼭 가야 하는" 강제 trigger 없음

---

## 1. 던전 (Dungeon Interior)

### 좌석
이미 4개 place 있음: temple, cemetery, ruins, deep_ruins. 좌표/이름 있고 NPC 도달 가능.

### 확장
- 각 place에 `entry: { x, y }` + `interior?: Interior` 필드 추가 (없으면 단순 야외 place 유지)
- `Interior = { layers: Layer[], depth: number, monsters: SpawnTable, loot: LootTable, sealedAt?: number }`
- `Layer = { id, name, hostility, spawnRule }` — depth 1-3개
- 진입: 기존 MOVE로 `entry` 좌표 도달 → 자동 transition to layer-1 (시스템적, "USE entrance" 같은 action 강제 X)
- 출구: layer-1의 `entry` 다시 도달 → 외부 복귀
- depth 깊을수록 hostile 강함, loot 강함, 시야 줄어듬 (heard_claim 무력화)

### 던전별 톤 (worldContext 안 깰 4 변형)
- **temple**: 조용/신비. hostile 적음. ritual artifacts (rune/blessing item) 자주. 보스: oracle keeper (sleep-only attack)
- **cemetery**: undead theme. skeleton/wraith. boss: Ancient Skeleton King
- **ruins**: 폐허 + 트랩. slime/boar.alpha. boss: 없거나 light boss
- **deep_ruins**: 가장 깊은 1군데. dragon-tier 보스 (Naga Queen 같은). artifact 진짜 강함

### 데이터
```ts
Interior {
  layers: Array<{ id: string; name: string; hostility: 1|2|3; spawnRule: SpawnTable; }>;
  loot: LootTable;          // 각 layer 종료 시 누적 보상
  bossId?: string;          // 마지막 layer에 etched
  guard?: { itemPrefix: string; uses: number };  // 입구 자물쇠 (선택)
}
```

### NPC 인지
- prompt의 # PEOPLE 옆 별도 노출 X (NPC가 보지 못함)
- 던전 entry place 자체는 평소처럼 보임, "deep_ruins kind=ruins" 같은 표지만
- discoveredPlaces에 first-entry tick 기록 (이미 있음) — milestone:dungeon_first_visit emit

### 출구·죽음
- layer-N에서 alive=false → 마을에서 부활 (현재 죽음 후 부활 시스템 유지)
- 단 lifeEvents에 "Fell at <layer.name>." milestone:death + dungeon-tagged

---

## 2. 외부 보스 (Outer-area Boss)

### 좌석
hostile monster 시스템 있음 (wolf/bear/skeleton/naga/troll/spirit). MONSTER_CATALOG 확장.

### 확장
- 각 monster kind에 optional `boss: BossSpec` (rule-based)
- BossSpec:
  - `nameOverride: string` (e.g. "Ancient Skeleton King")
  - `hpMul, atkMul, defMul`: 일반 동족의 2-3×
  - `behavior: Pattern[]` — 단순 rule (hp<50% → retreat-and-call / hp<25% → enrage)
  - `command?: { type, range }` — Epic monster 명령 능력 (아래)
  - `lootBias: ItemPrefix[]` — kill 시 drop 강화
  - `spawnRule: { mapBand, dayBand, rarity }` — 마을 외곽 high-band area에서 낮은 rate spawn

### Spawn
- 기존 spawner에 boss-tier rate 추가 (e.g. 1/200 일반 monster spawn rate)
- 던전 마지막 layer에 deterministic spawn (entry 시점 한 번)
- world.tick 기준 cooldown — boss 한 마리 죽으면 같은 종 boss 24h 안 etched

### 죽음 / 보상
- 일반 monster와 동일 ground item drop, 단 lootBias 적용 → rare item 확률↑
- killer actor에 milestone:boss_kill (이미 milestonesAchieved set 있으니 once)
- world event: `boss_defeated` — public fact로 다른 NPC heardClaims에 흐름 (Aaron→타 NPC 등)

---

## 3. Epic Monster (지능형 명령자)

### 의도
사용자 권고: "한두마리씩 같은 종류의 몬스터에게 명령을 내릴 수 있는 지능을 가진 보스 몬스터(에픽)". 보스 + 부하 협공.

### 구분
- Epic = Boss 중 `command` 필드 있는 일부
- 외부 보스 9종 중 3-4종만 (전부면 너무 빈번)
- 예시:
  - **Wolf Alpha** (Epic): wolf 2-3마리 부하 spawn + command:focus_fire
  - **Skeleton King** (Epic): skeleton 2마리 + command:flank
  - **Naga Queen** (Epic, deep_ruins): naga 2마리 + command:retreat_regroup

### Command 종류 (rule-based, LLM X)
```ts
EpicCommand =
  | { kind: "focus_fire"; targetId: string }      // 부하 모두 같은 actor 공격
  | { kind: "flank"; targetId: string }           // 부하 양쪽으로 분산해서 다가감
  | { kind: "retreat_regroup"; rallyXY: XY }      // hp 임계 시 후퇴 + 모임
  | { kind: "guard_treasure"; treasureXY: XY }    // 보물/제단 주변 sticky
```

### 발동 조건 (epic.behavior step)
- 시야 안 적 1+ + 명령 cooldown 만료 → `focus_fire` or `flank` 발동
- self.hp ≤ 40% → `retreat_regroup` (부하 → 자기 위치로)
- 던전 안 + 보물 좌표 정의됐으면 default `guard_treasure`

### 부하 구현
- `actor.commandedBy: string` 필드 추가 (optional, monster only)
- 부하 monster behavior tick에 commandedBy 체크 → 명령 따라 act (override default behavior)
- 명령은 epic이 dispatchAction-style emit ("epic_command" RawEvent)
- epic 사망 시 부하 commandedBy 해제 → wild로 흩어짐

### LLM 호출 (선택적)
- Epic만 1회 SPEAK 가능 (hp 50% / kill 직전 / 첫 조우)
- gpt-5.4-mini로 충분, 1줄 대사 ("도망쳐도 소용없다" 같은)
- 비용 +1% 미만 (1 epic당 lifetime 1-3 SPEAK)

---

## 4. 작물 황금기 (Seasonal Crop Window)

### 좌석
이미 weather + activeIssue slot 있음 (`worldContext.weather`, `worldContext.activeIssue`).

### 확장
- 새 슬롯: `worldContext.harvestSeason?: HarvestSeasonState`
- `HarvestSeasonState`:
  - `crops: ItemPrefix[]` — 황금기 작물 (wheat, apple, berry 등 중 1-2개)
  - `yieldMul: 1.5 | 2`  — GATHER 결과 수량 배수
  - `respawnMul: 1.5 | 2` — gather source 재생산 속도 배수
  - `startedAt, durationTicks`: 기간 (3-5일 ≈ 4320-7200 tick)
  - `mood: "abundant" | "bountiful"` (text only)
- prompt의 NOW 라인에 1줄 추가 (이미 있는 weather/event과 동일 톤): `harvest season: apple yields are abundant`

### Trigger
- deterministic scheduler — 매 day 새벽에 `Math.random() < 0.18`로 발동
- 발동 시 1-2 작물 무작위 선택
- weather와 cross-correlation 없음 (또는 sunny 우대 1.5×)

### 효과
- gather yield × yieldMul (gatherSource.ts에 hook)
- respawn × respawnMul
- NPC behavior 변화 X — 자율적으로 GATHER 더 매력적이 됨 (LOCAL ACTIONS 후보가 더 많아짐)

### 종료
- duration 만료 시 자동 reset
- 종료 시 `harvest_season_ended` world event (public fact, heard_claim 흐름)

---

## 5. Treasure / Loot (외곽 탐험 보상)

### 의도
Codex 1차 권고 — 외곽 place 탐험 동기. 현재 disc desc 평균 17-31, 외곽 도달률 낮음. 던전+보스가 이 axis 흡수했으니 별도 treasure chest는 불필요?

### 결정
**별도 treasure chest 시스템 X** — 던전 layer loot + boss drop으로 충분. 단순화.

만약 추가 원한다면:
- forest 외곽 random 좌표에 `discoveryItem` 1-2개 spawn (rare bone/herb/coin)
- 탐험 보상의 minimum signal 역할

---

## 6. Epic monster + 던전 + 작물 황금기 통합 흐름 (서사 예시)

**day 12 새벽**
- harvestSeason 발동: `crops: [wheat, apple]`, yieldMul 2, 4320 tick (3일)
- worldContext: "apple yields are abundant"
- NPC 자율적으로 GATHER 더 자주 (LOCAL ACTIONS에 wood→apple_tree 후보 빈도↑)

**day 12 정오**
- Lia가 outer forest 탐험 중 deep_ruins entry 도달
- 자동 transition to layer-1, hostility 2
- skeleton 1마리 조우 → 전투 → 승리 → ground item: rare herb drop

**day 12 저녁**
- Lia layer-2 진입. skeleton 2마리 + Skeleton King (Epic)
- Skeleton King가 LLM SPEAK "tread no further, daughter of the field" (lifetime 1회)
- Epic command: focus_fire targetId=Lia. skeleton 2마리 동시 공격
- Lia hp 30% → retreat. milestone:dungeon_first_visit at deep_ruins
- 다음 day에 reflection — "I was attacked deep underground; the place is dangerous" → lifeEvents

**day 14**
- harvestSeason 종료 → public fact "apple season is over" 흐름
- Lia가 마을 복귀 후 SPEAK Mira "There was a king of bone deep below" (heard_claim)
- Mira→Peter chain, soul.heardClaims["deep_ruins": "Skeleton King encountered"]
- Peter agenda CHANGE 후보 "find out more about Skeleton King" (자율, 강제 X)

---

## 구현 우선순위 (난이도·정합성·임팩트)

| # | 항목 | 임팩트 | 난이도 | 비용 |
|---|---|---|---|---|
| 1 | **작물 황금기** | 3 | 1.5 | ≈0 | 가장 작은 변경 (worldContext+gather hook). 시각화 가능. |
| 2 | **외부 보스** | 4 | 2.5 | ≈0 | MONSTER_CATALOG 확장. rule-based. |
| 3 | **던전 interior 좌석** | 4 | 3 | ≈0 | place type extension, layer transition. |
| 4 | **Epic command** | 4 | 3.5 | +1% | boss 중 일부에 command, LLM SPEAK 한정. |
| 5 | (선택) treasure chest | 2 | 1 | ≈0 | 던전 흡수했으면 생략 |

**추천 구현 순서**: 1 → 2 → 4 → 3 (4까지가 5-6시간 작업, 3 던전 interior가 2-3시간 추가).

각 단계마다 라이브 측정 → 다음 단계 진행.

---

## 안전 가드 (Codex 권고 반영)

1. **agency 보존**: 던전·보스 trigger는 자동, NPC가 "꼭 가야 함" 강제 없음
2. **herd 방지**: epic SPEAK는 자기 시야 NPC에만 도달 (전 마을 broadcast X)
3. **death economy**: 보스 kill로 인한 보상은 lootBias 정도. agency-altering one-shot reward X
4. **cost cap**: epic LLM SPEAK는 lifetime 3회 cap, evidence 게이트 확인
5. **persona drift**: 던전 경험 후 lifeEvents 적립은 자연스러우나 personaShift는 SLEEP gate 유지

---

## 다음 단계

이 spec 기반 구현 갈지, 또는:
- A. 라이브 결과 충분히 모은 후 spec 다듬기
- B. spec 1번 (작물 황금기)만 먼저 small commit → 효과 측정 → 2~4 단계 진행
- C. 모두 한 묶음으로 (큰 PR)
