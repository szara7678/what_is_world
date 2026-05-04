# what_is_world — Master Plan v3 (2026-04-27)

작성: Claude (insu의 페어) + Codex GPT-5.5 합의안. v2 (2026-04-26) 후속, 사용자 새 패러다임 정정 6 박제.

---

## 0. 한 줄 정의 (불변)

> "영혼 / 생각 / 장기 기억"을 가진 픽셀 마을 주민들이 자율적으로 살아가는 모습을 따뜻한 픽처북 톤으로 관찰하는 시뮬레이터.

---

## 1. v2 → v3 정정 사항 (6 흡수)

| # | v1/v2 결정 | v3 정정 | 사유 |
|---|---|---|---|
| 1 | redesign §2.4 "MemGPT tool-based 스왑 과함" | **`think` action primitive로 self-directed retrieval 흡수** (function call X, 동일 action 형식 유지) | 사용자 의도: 모든 컨텍스트 prompt에 박지 않고 에이전트가 자율 query |
| 2 | redesign §2.5 "Voyager skill library 안 도입" | **`skill` action primitive로 dynamic affordance exposure 흡수** (XP 스킬과 별개) | action 8+ 종류로 늘었고 가용성 동적 노출 가치 회복 |
| 3 | M2.4 2-stage retrieval Park식 | **자동 1차 retrieval + LLM 주도 `think`로 emergent 2차** | tool 호출 X, primitive로 자연 발생 |
| 4 | RPG R5 "sleep/meal/work lifecycle" | **별도 lifecycle 폐기, USE 효과로 흡수** (USE bed=sleep, USE food=meal, USE tool/resource=work) | 사용자 정정: 채집/벌목/경작은 USE의 효과 |
| 5 | RPG R7 "XP/level/skills" | **후순위로 축소.** `skill` action은 affordance query 의미. 성장은 soul.values 누적이 우선. XP/level은 별도 PR로 늦춤 | 사용자 의도: emergent 성장, grind X |
| 6 | RPG R4 "BUY/SELL primitive" | **public primitive에서 내림 (deprecated).** `GIVE`가 item OR currency 둘 다. `SPEAK` 협상 + `GIVE` 정산. 내부 `pendingTrade` resolver | 사용자 정정: 거래는 SPEAK+GIVE 자연 발생 |

---

## 2. 컨텍스트 — 5 블록 최소

| # | 블록 | 내용 | 평균 chars |
|---|---|---|---:|
| 1 | 현재 상태 | HP/Hunger/Stamina/위치 (한 줄) | ~80 |
| 2 | 현재 환경 (시야) | 인접 ≤3칸 actor/item/place + 시간/날씨 (정해진 범위) | ~250 |
| 3 | 메모리 | retrieval 결과 (think 누적) + reflection 1-2개 | ~400 |
| 4 | 페르소나 | name/role/persona/tone/values/goals | ~250 |
| 5 | 이해한 신탁 | active oracle quest (조건부, 사도만) | ~150 |

**목표:** 1500-2000 chars (현재 worst 4315의 35-45%).
**더 멀리 / 깊이 / 다른 angle 정보:** `think` action으로 자율 호출.

빠지는 것:
- 직업 가이드 → 페르소나에 흡수, think로 query
- 주변 주민/물건/장소 (top 5/3/6) → 시야 (≤3) 만 + think 추가
- 이동 가능성 4방향 → `skill` action으로 query
- 직전 생각 → 메모리 retrieval에 자연 흡수
- recent x8 + reflection x3 + belief x4 분리 → 하나의 메모리 블록

**안전망 (Codex 권고):** invalid action 후 다음 turn에 temporary fallback affordance 노출.

---

## 3. 신규 Action primitive

```ts
// 동일 형식, 한 박자 = 한 action
type ThinkAction = { type: "THINK"; query: string };
type InventoryAction = { type: "INVENTORY" };
type SkillAction = { type: "SKILL" };

// GIVE 확장 (BUY/SELL 흡수)
type GiveAction =
  | { type: "GIVE"; targetId: string; itemId: string; quantity?: number }
  | { type: "GIVE"; targetId: string; currency: "gold"; amount: number };
```

dispatchAction 처리:
- `THINK`: MemoryStore.retrieve(query, me, now) top 5 → 새 observation kind="memory" tags=["self-recall"]로 적재 → 다음 prompt 메모리 블록에 자연 노출.
- `INVENTORY`: actor.inventory.items + gold listing → thought.recentEvents 갱신.
- `SKILL`: 현재 위치/인벤/관계/시간 기준 가용 action list → thought.recentEvents 갱신.
- `GIVE` currency: gold 이전. inventory.gold +/- 검증.

**Cap/Cooldown (affordance starvation 방지):**
- 연속 3회 `THINK` 차단 (4번째는 invalid → fallback).
- `INVENTORY`/`SKILL`은 60초 cooldown (자기 인벤/스킬은 자주 안 변함).

---

## 4. M2.1 MemoryStore Interface (불변)

```ts
type MemoryQuery = {
  text: string;
  actorId: string;
  placeId?: string;
  targetActorId?: string;
  actionType?: string;
  needs?: ("hunger" | "danger" | "social" | "work" | "oracle")[];
  tags?: string[];
  limit?: number;
};

retrieve(q: MemoryQuery, actor, now): Observation[]
```

Score: `0.30·recency + 0.45·importance + 0.25·relevance` (Codex Review 6 권고).

Backend: JSONL 유지 (M2.2 sqlite-vec는 후속 PR).

---

## 5. 거래 — SPEAK + GIVE pendingTrade

내부 resolver:
1. `SPEAK` "빵 5골드에 살게요" → 시스템이 `pendingTrade {fromActor, toActor, item, currency, expiresAt}` 후보 생성 (LLM 응답 파싱 또는 SPEAK 메모리 적재).
2. actor `GIVE 5 gold to npc-3` 실행.
3. npc-3 다음 turn에 `GIVE bread to actor` (LLM 자율).
4. 양쪽 GIVE 일치 시 거래 완료. 한쪽만 일어나면 미완료 memory.

**자동 자산 이전 X.** SPEAK는 협상, GIVE만 자산 이동.

---

## 6. PR 단위 (v3 갱신)

### PR2 v3 — think/inventory/skill + 5 블록 + retrieval + GIVE 확장

7 sub-task:
1. `THINK` primitive (cap 3회)
2. `INVENTORY`/`SKILL` primitive (60s cooldown)
3. `MemoryStore.retrieve` M2.1 (structured query, topK, dedupe)
4. importance heuristic table (Review 6 권고 값)
5. 5-block prompt diet + invalid-action fallback
6. BUY/SELL deprecate + `GIVE` currency 확장 + `pendingTrade`
7. Oracle progress schema small

### PR3+ — 다음 마일스톤

| PR | 묶음 |
|---|---|
| PR3 | Plan Schema (M3) — 위반 허용 플랜 |
| PR4 | Relationship + social memory deepening (R5 흡수) |
| PR5 | History/Chronicle UI + reflection citation (R8 강화) |
| PR6 | Thin XP (skills/level 후순위) |
| PR7 | sqlite-vec backend + 2-stage retrieval (M2.2 + M2.4) |
| Editor | 별도 작은 PR (잔존 fix) |

---

## 7. 회귀 KPI (각 PR 검증)

- prompt token p50/p95
- oracle fulfillment ratio
- SPEAK/USE/PICKUP/GIVE 분포
- think/inventory/skill 호출 분포 (도배 X)
- invalid action rate
- NPC 사망률
- WAIT 비율
- persona consistency (golden phrase)
- critical memory recall@5

---

## 8. 변경 이력

- v2 (2026-04-26): redesign v1 후속, PR 잘게, places affordance, smoke fixture, 그 후 §8 v2.5 RPG 트랙
- **v3 (2026-04-27): 사용자 새 패러다임 정정 6 흡수.** think/inventory/skill primitive 도입, 5 블록 컨텍스트, BUY/SELL→GIVE 확장, R5 lifecycle 폐기, R7 후순위.

---

## 9. 이전 노트와 관계

- `redesign-proposal-2026-04-19.md` (Akashic): 큰 그림 유효, §2.4·§2.5 결정은 v3 정정.
- `master-plan-v2-2026-04-26.md` (Akashic): M1·M3는 유효, M2.4 2-stage는 think로 풀어냄. RPG R4·R5·R7 흡수.
