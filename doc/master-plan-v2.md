# what_is_world — Master Plan v2

작성일: 2026-04-26
작성자: Claude (insu의 페어) + Codex GPT-5.5 (공동 설계자) 합의안.
대상: `apps/what_is_world` — `doc/redesign.md`(2026-04-19)의 후속. R0~R5 부분 합치 후 R6부터를 더 작은 PR 단위로 재분할.

---

## 0. 한 줄 정의

> **"영혼 / 생각 / 장기 기억"을 가진 픽셀 마을 주민들이 자율적으로 살아가는 모습을, 따뜻한 픽처북 톤으로 관찰하는 시뮬레이터.**

키워드: cozy observatory · pocket diorama · living miniature.

---

## 1. 현재 상태 요약 (2026-04-26 기준 working tree)

### 이미 동작
- TS 모노레포: server (Colyseus + Fastify, :3001 unified), client (Vite + React + Phaser).
- 톤앤매너: 크림(`#fbf6ec`) + 테라코타 + 세이지 박제.
- Observatory 셸: 좌측 주민 카드(HP/STM/HGR 미니 바), 중앙 Phaser stage, 우측 Agent Detail(지금/최근 기억 탭), 하단 SSE 라이브 피드.
- Brain loop (server-internal): round-robin 액터, mock or OpenRouter, day-phase 분기, SPEAK/ATTACK/MOVE/USE/WAIT, JSON one-shot.
- Reflection loop: 45s 간격, 최근 관찰 ≥3건이면 LLM/mock 요약 → soul.values/goals 누적.
- Relationship: SPEAK +4 / ATTACK -12, `relationships.json` + `/relationships` GET.
- 영혼/생각/관찰 파일 저장 (`apps/server/data/`).

### 미진 (이 master plan v2 범위)
- 시드 마을 맵, 장소(affordance) 스키마, 야간 오버레이, 머리 위 의도, 관계 readout, 메모리 retrieval, importance, planner, 다인화, QA fixture.

---

## 2. 합의 원칙

1. **세계감 먼저, 시스템은 그 다음.** retrieval/planner를 깊게 넣어도 stage가 비면 "왜 그 행동을 했는지"가 보이지 않는다. M1은 시각화·장소·관계 readout 우선.
2. **단순 장식 금지.** 우물/상점/밭은 `place` 엔터티로 월드 상태에 실리고, brain prompt가 그 이름을 인용한다.
3. **PR은 잘게.** 한 PR이 여러 갭을 커버하지 않는다. 회귀 검증 가능한 단위로 자른다.
4. **Deterministic smoke 첫째.** seed map과 brain loop가 만나는 순간부터 "10분 mock run 후 스냅샷" fixture가 회귀 보호망.
5. **벡터 DB 추상화.** sqlite-vec은 pre-v1, SQLite 공식 `vec1`도 진행 중. `packages/memory-store` 안으로 의존을 가두고 인터페이스만 외부로 뺀다.
6. **NPC가 plan을 반드시 따르지 않는다.** 계획 위반 허용이 생동감의 핵심.
7. **이미지/자산은 병렬 작업.** 코드 PR과 같은 트랙에 묶지 않고, Codex 이미지 트랙에서 동시 진행.

---

## 3. 마일스톤 분할 (R6부터의 재분할)

### M1 — 살아있는 마을 첫 뷰 (1.5~2주, 5 PRs + 이미지 트랙)

| # | PR 이름 | 범위 | 산출물 | 의존성 |
|---|---|---|---|---|
| M1.1 | **Seed Village Map** | 32×24 또는 48×32 인라인 seed 함수. 광장·우물·상점·오두막·밭·숲 가장자리. | `packages/world-core/src/state/createWorldState.ts` 분기, `apps/server/src/imports/seedVillage.ts` | 없음 |
| M1.2 | **Place / Affordance** | `Place` 타입 + `world.places: Record<id, Place>` + brain prompt에 이름 노출. | `packages/shared/src/types/place.ts`, `prompt.ts` 패치, mock 행동 후보에 "광장으로 이동" 같은 hint | M1.1 |
| M1.3 | **Day/Night Overlay** | Phaser overlay alpha + tint. `world.tick → phase → visual` 단방향. | `apps/client/src/game/startGame.ts` (DayNightOverlay), 상단 시계와 동기화 | 없음 (병렬 가능) |
| M1.4 | **Intent Bubble** | NPC 머리 위 한 줄 의도. action-kind 기반 축약 테이블 (`MOVE: 광장`, `SPEAK: 인사`, `WAIT: 쉬기`). | `apps/client/src/game/startGame.ts` (intent label container), thought.nextIntent 입력 | M1.2 (장소 이름 사용) |
| M1.5 | **Relationship Readout** | Agent Detail 안 상위 3명 affinity bar (그래프 X). | `ObservatoryShell.tsx` AgentDetail 섹션 추가, `/relationships/:id` 엔드포인트 | 없음 (병렬) |

추가:
- **M1.QA — Deterministic Smoke Fixture** (M1.1~M1.5 끝나는 시점): seed 고정 → 10분 mock run → events.ndjson · relationships.json · 액터 위치 스냅샷을 기대값과 diff. CI에 안 올려도 로컬 npm script로 두면 회귀 즉시 감지.

### 이미지 트랙 (M1과 병렬, Codex가 그림)

| # | 이름 | 사이즈 | 개수 | 우선 |
|---|---|---|---|---|
| I1 | 길/광장/잔디 타일 | 16×16 | 8~10 | 최우선 (M1.1과 함께 적용 가능해야 마을이 "보임") |
| I2 | 오두막 정면, 빵집 정면, 우물 | 24×24 또는 32×32 | 3 | M1.1 직후 |
| I3 | 밭/작물 4종 (당근/순무/허브/빈 밭) | 16×16 | 4 | M1.1 후속 |
| I4 | 숲 가장자리 세트 (작은 나무, 큰 나무, 덤불, 그늘) | 16×16 | 4 | M1.1 후속 |
| I5 | 표지판, 길돌, 작은 분수 | 16×16 / 24×24 | 3 | M1.5 즈음 |

### M2 — 기억 다층화 (1.5~2주, 4 PRs)

| # | PR 이름 | 범위 |
|---|---|---|
| M2.1 | **MemoryStore Interface** | JSONL 저장 wrap + `MemoryStore.retrieve(query, actor, now)` 시그니처 + recency/importance 가중합 deterministic retrieval. 벡터 미사용, fixture 테스트 가능. |
| M2.2 | **Embedding Storage** | sqlite-vec 도입. `packages/memory-store` 내부에만 의존. 추상화 계층 (`EmbeddingProvider`) 정의. local sentence-transformers 또는 OpenAI 호환 endpoint. |
| M2.3 | **Importance Scoring** | heuristic 우선 + 고가치 이벤트(dialogue/attack/reflection)만 LLM scoring (캐시). |
| M2.4 | **2-stage Retrieval (Park식)** | 1차 query "현재 욕구/장소/상대" → 상위 N → reflection 명시 인용. 2단계 후보-행동별 재검색은 후속. |

### M3 — 스케줄/플래너 토대 (1주+, 4 PRs)

| # | PR 이름 | 범위 |
|---|---|---|
| M3.1 | **Plan Schema** | `thought.plan.today: PlanStep[]`, `currentStep`, `reason`, `expiresAtTick`. |
| M3.2 | **Periodic Planner** | 5~10분 주기 day plan 생성, 3 step. |
| M3.3 | **Plan-Aware Brain** | reactive prompt에 plan 노출하되 위반 허용. |
| M3.4 | **Plan UI** | Agent Detail "오늘 할 일" 3줄 표시. |

### M4 — 다인화 / 사회 분위기 (이후)

NPC 5+, 다양 영혼 시드, 자원 경쟁, 관계 그래프 본격 도입.

---

## 4. 데이터 스키마 추가 (이번 v2에서 박제)

### Place

```ts
// packages/shared/src/types/place.ts
export type PlaceKind = "plaza" | "well" | "shop" | "home" | "field" | "forest_edge" | "road";

export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  x: number; y: number;        // 좌상단
  width: number; height: number;
  allowedActions: ("WAIT" | "SPEAK" | "USE" | "WORK" | "REST" | "BUY")[];
  socialWeight: number;        // 0~1, 1=사람들이 모이기 쉬움
  dayPhaseBias: { morning: number; day: number; evening: number; night: number };
  tags: string[];              // ["food", "social", "outdoor"]
}
```

### WorldState 확장

```ts
export type WorldState = {
  // ... 기존
  places: Record<string, Place>;  // ← 추가
};
```

### Brain prompt 변경

`prompt.ts` 의 `# 주변` 블록에 가까운 place 3개를 추가:

```
# 주변 장소
- 광장 (plaza, 거리 4) · 사람이 모이기 쉬움
- 빵집 (shop, 거리 7) · 음식 사기
- 우물 (well, 거리 3) · 잠깐 쉬기/대화
```

mock 결정에도 place hint 통합 (예: "morning + plaza 거리 ≤ 5 → SPEAK 확률 +20%").

---

## 5. QA / 회귀

### Deterministic Smoke (M1.QA)

```bash
# apps/server scripts/smoke-mock.ts
pnpm -C apps/server smoke-mock --seed=mochi-village-1 --duration=600s --provider=mock
# → data/__smoke__/mochi-village-1/{events.ndjson,relationships.json,actor-positions.json}
# → 기대 fixture와 diff
```

기대값 예시:
- npc-1 affinity to npc-2 ≥ +20 (아침에 광장에서 인사 ≥ 5회 발생).
- monster `boar-1` HP는 0 또는 npc 한 명의 HP가 60 이하.
- reflection observation ≥ 3개.

### Manual Visual QA (Claude 담당)

각 M1.x PR 후 dev 서버 띄워 Phaser 화면 캡처 (`/tmp/wiw-qa/m1.x/`) → Claude가 톤/배치/가독성 검토 → 피드백을 Codex에 회송.

---

## 6. 외부 레퍼런스 (v1 + v2 추가)

v1 doc/redesign.md 의 레퍼런스 유지. 추가:

| 출처 | 시사점 |
|---|---|
| MemoryArena 2026 (Stanford DEL) | "기억을 검색했다"가 아니라 "예전에 싸운 주민을 피했다/사과했다" 같은 outcome fixture가 평가 기준. |
| AtomMem 2026 (arxiv) | 메모리 CRUD를 별도 atomic operation으로 보는 설계. 장기적으로 belief update / stale forget 분리 힌트. |
| sqlite-vec (asg017) + SQLite vec1 (sqlite.org) | 로컬 우선, 추상화 가두기. |
| MemoryAgentBench (Hu et al. 2025) | retrieval 정확도/forgetting/long-range 4축 평가. |
| Survey on Memory Mechanism in LLM Agents (ACM TOIS 2025) | Core/Working/Archival 계층 분류 정리. |

---

## 7. 다음 행동 (Step B — 즉시 분배)

### Codex Track A · 코드 (sandbox: workspace-write)

**Task A1**: Seed Village Map + Place/Affordance MVP (M1.1 + M1.2 합본).
- `packages/shared/src/types/place.ts` 신설.
- `WorldState` 에 `places` 추가, 호환 마이그레이션.
- `packages/world-core/src/state/createWorldState.ts` 에 `createMochiVillageState(width, height, seed)` 추가.
- `apps/server/src/imports/seedVillage.ts` (인라인 seed 함수, fastify route `/import-seed-village` POST).
- `apps/server/src/brain/prompt.ts` 에 `# 주변 장소` 블록.
- mock 결정에 place hint 통합 (morning + plaza 거리 → SPEAK 보정).
- Phaser는 place 마커 없이도 (place는 collision/배경 타일로) 마을 구조가 보이도록.

### Codex Track B · 이미지 (sora skill / 이미지 2.0)

**Task B1 (병렬)**: 16×16 모찌풍 길/광장/잔디 변형 8~10 타일.
**Task B2 (병렬)**: 24×24 또는 32×32 모찌풍 오두막 정면 / 빵집 정면 / 우물 3 앵커.

톤: 크림 베이스, 테라코타 지붕 액센트, 세이지 잎 디테일, 둥근 모서리, 픽셀 1:1, 그림책풍 4단계 명도.

### Claude (insu의 페어) — QA / 피드백 루프

- Track A 결과 PR diff 리뷰 (스키마 회귀, 톤앤매너 위반, 마이그레이션 누락).
- Track B 결과 이미지 톤/대비 검토 → 부적절 시 재생성 지시.
- M1.1 적용 후 dev 서버 띄워 시각 검증 → 발견 이슈를 Codex에 회송.
- 끝나면 master-plan-v2.md 의 M1.1 / I1 / I2 체크 표시 + Akashic 노트 동기화.

---

## 8. RPG 코어 트랙 (M1.5 신규, 2026-04-26 사용자 결정)

### 의도 (사용자 박제)

> "에이전트들이 판타지 세계에서 메모리/스킬/행동으로 상호작용하며 RPG 판타지 세계의 역사를 구축. 사용자 입장에선 다른 2D 도트 RPG 정도의 액션·기능을 가진 캐릭터들이 움직이고, 사용자가 별도 지시 안 하면 알아서 생활하고 성장한다."

기존 M1(시각화/장소/관계)이 끝난 시점에 **마을이 비어 있는 껍질**이 되지 않도록, 동시에 RPG 메커니즘 트랙을 박는다. 시각/메모리(M1·M2)와 RPG 코어(M1.5)는 **병렬 트랙**.

### M1-R1 — 길찾기 + 고수준 GoTo

- BFS 그리드 길찾기 (collision 회피).
- `GoTo(placeId | (x,y))` 고수준 intent → 매 박자 BFS 다음 1칸으로 풀린다.
- mock brain 의 `MOVE` 결정에 GoTo 후보 추가 (예: 아침 → 광장으로 GoTo).
- thought.nextIntent 에 `GoTo: 광장` 같은 형태 노출.

### M1-R2 — 인벤토리 인터랙션

- 신규 원시 행동: `PICKUP(itemId)`, `DROP(itemId, x?, y?)`, `GIVE(targetId, itemId)`.
- USE를 itemId 효과 테이블로 (`bread`: hunger -25, `carrot`: hunger -10, `potion-heal`: hp +30).
- inventory 한도 (8 슬롯).
- 액터가 굶주리면 자동 PICKUP+USE 식사 결정 (mock brain).

### M1-R3 — 직업 행동 / 일과

- `soul.role` 필드 신규 (`baker | farmer | merchant | guard | hero | wanderer`).
- 직업별 daily routine (mock 우선, LLM 보조):
  - **Baker**: 아침 빵집 출근 → flour USE → bread 1개 생성 → 진열대 DROP.
  - **Farmer**: 낮 텃밭 WORK → carrot 1개 생성 → 인벤토리 PICKUP. 저녁 광장 SPEAK.
  - **Merchant**: 잡화점 상주, BUY/SELL.
  - **Guard / Hero**: 마을 순찰 + 몬스터 ATTACK.
  - **Wanderer**: 자유.

### M1-R4 — 거래 (BUY / SELL)

- `BUY(targetId, itemId)` / `SELL(targetId, itemId)`. gold 이동.
- 가격 테이블 (item.price), 직업 NPC만 SELL 허용.
- 거래 시 +affinity, 거절 시 약간 -affinity.

### M1-R5 — 일과 사이클

- 자기/일어나기 ritual: home 안에서 night → REST 누적 → stamina/hp 회복.
- 굶주림 일정 임계 → 능동 식사 결정.
- 시간대 임계 (아침 7시, 저녁 19시) 에 직업 행동 트리거.

### M1-R6 — 전투 다양화

- 무기 슬롯 (`equipped: { weapon?: itemId }`).
- ATTACK 데미지 = base + weapon.damage. 회피 (stamina 소모).
- 죽음 후 inventory 일부 자원 드롭 (`monster.boar` → boar-skin).

### M1-R7 — 성장 / 경험

- `Actor.xp / level / skills`. SPEAK 성공 → social +1, ATTACK 성공 → combat +1, WORK 성공 → labor +1.
- 스킬 임계 도달 → bonus (combat 5 → ATTACK +1 dmg, social 5 → 새 dialogue pool).
- 레벨업 시 narrative event 방출.

### M1-R8 — 사회적 사건 / 역사 구축

- 누적 affinity ≥ 60 + 횟수 → "친구" 라벨. ≤ -40 → "원수".
- 마을 history.ndjson 신규 — 큰 사건만 연대기로 (사망/거래 N회/레벨업/관계 형성/마을 침공 등).
- Agent reflection이 history를 인용 가능.

### 에이전트 LLM 모델 (사용자 결정)

- **로컬 프록시 우선**: `http://127.0.0.1:18796/v1` OpenAI 호환, key `claude-code-local`. 모델명 후보: `openai/gpt-5.5-mini` (없으면 폴백), `claude-haiku-4-5`.
- OpenRouter 폴백 가능. 응답 ≤ 2초 목표 (reactive 루프).

### 진행 순서 (실행 가능 단위)

| Phase | 묶음 | 공정 |
|---|---|---|
| **R1+R2** (지금) | 길찾기 + 인벤토리 | 마을이 "이동/획득" 함 |
| R3 (다음) | 직업 행동 + 일과 | "일하는 마을" |
| R4 | 거래 | "경제" |
| R6+R7 | 전투+성장 | "모험" |
| R8 | 역사 | "연대기" |

QA: 각 Phase 끝나면 Claude가 dev 서버 띄우고 30분 mock run 관찰 후 history/relationships diff 보고.

### 직접 play 합의

Claude는 매 phase 끝마다 30~60분 mock + LLM 운영을 관찰하고 ndjson/스크린샷 캡처. Codex(gpt-5.5)는 자기 검증용 smoke run.

## 9. 변경 이력

- 2026-04-26 v2 initial: redesign.md(v1) 보완. Codex GPT-5.5 합의안 반영 (장소 affordance, smoke fixture, PR 잘게 자르기).
- 2026-04-26 v2.5 RPG: 사용자 결정 — RPG 코어 트랙(M1-R1~R8) 박제. 에이전트 LLM = 로컬 프록시의 작은 OpenAI 모델. Claude+Codex 자율 진행 + 직접 play.
