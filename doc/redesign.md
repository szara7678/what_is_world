# what_is_world 재설계 제안서

작성일: 2026-04-19
대상: `apps/what_is_world` 현재 구현 (Colyseus + Fastify + Phaser + React) 전면 재정비

---

## 0. TL;DR

지금 코드는 **"맵 에디터"** 에 가깝고, 정작 `doc/idea.md`가 말하는 **"영혼/생각 파일을 가진 NPC들이 살아가는 세계를 관찰하는 시뮬레이션 오브저버토리"** 는 어디에도 없다. Phaser 씬은 24×16 빈 필드 + 3 액터 + 스탯바만 렌더링하고, 우측 인스펙터는 `ID / Name / Kind / Asset / Position (2.0, 2.0)` 같은 **엔진 디버그 패널** 이다. `PLAY` 를 눌러도 세계에 아무 일도 벌어지지 않는다 — 원인은 단순하다. NPC 가 **행동/의도/기억** 을 갖지 않고, 1/100ms 틱에서 hunger/stamina 만 깎이고 있기 때문이다.

재설계의 축은 두 개다.

1. **시뮬레이션 축**: 현재 룰 엔진 위에, `idea.md` 4단계(더미 루프) → 5~9단계(LLM 에이전트 + 생각/영혼/장기기억) 로 이어지는 **계층** 을 하나의 아키텍처로 고정한다. Generative Agents(Park 2023) 의 memory stream/reflection/retrieval 구조, AI Town(a16z)의 Convex 기반 지속성, Project Sid 의 PIANO(병렬 인지 모듈), MemGPT(Letta)의 OS 메모리 계층을 근거로 설계한다.
2. **UI/UX 축**: "편집기" 를 주(主)에서 보조 모드로 내리고, **관찰(Observatory) 모드** 를 1등 시민으로 만든다. RimWorld 의 at-a-glance 콜로니스트 카드, Dwarf Fortress 의 announcement 스트림, AI Town 의 bird's-eye + 대화 오버레이 패턴을 참고한다.

아래는 근거와 구체안.

---

## 1. 현재 상태 진단

### 1.1 코드 구조 (확인됨)

| 계층 | 위치 | 역할 |
|---|---|---|
| 공유 타입 | [packages/shared/src/types/world.ts](../packages/shared/src/types/world.ts) | `WorldState`, `Actor`, `Structure`, `GroundItem` 등 |
| 월드 룰 | [packages/world-core/](../packages/world-core/) | `createWorldState`, `dispatchAction` (MOVE/ATTACK/SPEAK/USE), `tickWorld` (hunger/stamina) |
| 서버 | [apps/server/src/rooms/WorldRoom.ts](../apps/server/src/rooms/WorldRoom.ts), [apps/server/src/main.ts](../apps/server/src/main.ts) | Colyseus 2567, Fastify 3001, `/health /world /snapshot /spawn /import-seed` |
| 클라이언트 UI | [apps/client/src/ui/App.tsx](../apps/client/src/ui/App.tsx) | React 셸(툴바/패널/콘솔) |
| 클라이언트 게임 | [apps/client/src/game/startGame.ts](../apps/client/src/game/startGame.ts) | Phaser WorldScene, 이동 보간/히트 플래시/스프라이트 애니메이션 |
| 네트워크 | [apps/client/src/net/room.ts](../apps/client/src/net/room.ts) | Colyseus client + 1초 HTTP polling fallback |

### 1.2 UI 현 상태 (Playwright 캡처 결과)

`/tmp/wiw-playwright/shots/` 에 10장 캡처. 요약:

- **상단 툴바**: `WORLD ENGINE` 로고 + `PLAY / PAUSE / STOP` + `SELECT / MOVE / TILE / SPAWN` + `재스캔` — 전형적인 **엔진 편집기** 톤. PLAY 가 "시작" 이 아니라 "편집 잠금 해제 → 실행 모드 전환" 같은 느낌.
- **좌측 패널 (EDIT)**: `ASSETS` 탭 (TILES / NPC / MOB / OBJ / ITEM). 에셋 썸네일 그리드 + 검색창. 이건 나쁘지 않다 — **편집 모드에선 그대로 둬도 됨**.
- **좌측 패널 (PLAY)**: `ACTORS 3 ALIVE` + Hero/Villager/Boar 카드 + HP/MP/STM/HGR 바 4개. **카드가 너무 얇고 정보가 숫자 위주**. 이 NPC 가 *지금 뭘 생각하고 뭘 하려는지* 가 전혀 안 보인다.
- **중앙 Phaser 캔버스**: 24×16 잔디밭에 액터 3 명이 멈춰 있음. PLAY 로 전환해도 NPC 가 움직이지 않는다 (tickWorld 가 hunger/stamina 만 건드리고 NPC 의사결정 없음).
- **우측 인스펙터**: `ENTITY` (ID/Name/Kind/Asset) + `TRANSFORM` (Position) + `STATS` (HP/MP/STM/Hunger/Gold) + `발화/사용` 버튼 + `WORLD` (Tick/Time/Actors/Structures/Items/Map) + `QUICK SPAWN` (Human NPC / Bear / 아이템 드랍 / 상자). **Unity 의 Inspector 를 그대로 이식** 한 UX. 게임 플레이/관찰에는 과잉, 에디터로선 적절.
- **하단 콘솔**: `4시 42분 10초 서버 연결 완료 / 맵 초기화: 24×16 / 게임 씬 준비됨 / 모드: PLAY / 모드: STOP`. 시스템 로그뿐, **세계에서 일어나는 사건**(X 가 Y 를 공격, Z 가 굶주려 음식 탐색) 이 없다.

### 1.3 핵심 갭

| 분류 | 현재 | 부족 |
|---|---|---|
| 시뮬레이션 | tickWorld 가 스탯만 감소 | NPC 의사결정(룰 or LLM), 룰베이스 더미 NPC, 행동 성공/실패 원시 로그 집계 |
| 데이터 | `Actor` 에 hp/mp/stm/hunger/gold/inventory | 영혼 파일, 생각 파일, 장기기억, 관계, 관찰 큐 — `idea.md` 0단계 스키마 미확정 |
| UI | 편집기 톤, 디버그 인스펙터, 무음의 플레이 모드 | Observatory 모드 (생각/의도/기억 타임라인), 이벤트 스트림 피드, 시간/날씨/씬 컨텍스트 |
| 월드감 | 24×16 민둥 잔디, 건물 0, 아이템 1 | 시드 맵(마을/시장/오두막/숲), 구조물 프리셋, 생체(biome) 분화 |

---

## 2. 관련 연구/OSS/서비스 요약과 **우리가 취할 것 / 안 취할 것**

### 2.1 Generative Agents (Park et al., 2023 — Smallville)
- **핵심**: memory stream (자연어 관찰 로그 append-only) + retrieval (recency α·r + importance α·i + relevance α·rel, 가중합) + reflection (100개 최근 기억 → "가장 중요한 3개 질문" → 답 → 상위 기억 추가) + planning (day-level → hourly → action).
- **취할 것**: `Actor.memoryStream: Observation[]` + 중요도 LLM 스코어링(1–10) + 코사인 유사도 retrieval. `idea.md` 7~9단계와 1:1 매핑.
- **안 취할 것**: Day/Hour 중첩 플래닝은 지금 스케일에 과함 — 우리는 먼저 **tick-level reactive** 로 가고, 플래닝은 확장기에 둔다.

### 2.2 AI Town (a16z-infra)
- **핵심**: Convex(serverless DB + queue) 에 상태 영속화, 각 에이전트는 name/back-story/goals/moods/working-memory, 대화는 RAG(Pinecone) + OpenAI.
- **취할 것**: **soul 파일** = back-story + goals + persona + tone. 프롬프트 블록을 `(soul, thought, recent events, local scene, available actions)` 순으로 고정.
- **안 취할 것**: Convex 의존성 — 우리는 이미 Colyseus authoritative state 가 있고, 장기기억은 SQLite + sqlite-vec(또는 libsql) 로 로컬 유지. 외부 벡터 DB 금지(오프라인 우선).

### 2.3 Project Sid — PIANO (Altera, 2024)
- **핵심**: 중앙 인지 코어 + **병렬** 서브모듈(Perception / Action / Memory / Social / Planning / Reflection) 이 동시에 돈다. 순차 CoT 의 레이턴시 문제를 우회.
- **취할 것**: `agent-runtime` 은 이벤트 루프 하나에 **여러 코루틴**(reactive action, slow reflection, periodic planning) 을 분리. 빠른 반응(100~500ms) 과 느린 성찰(수십 초) 을 섞는다.
- **안 취할 것**: 700+ 에이전트 마인크래프트 스케일 — 우리는 10 단계 목표가 3~5 명. 코루틴 분리는 가져가되 모듈 수는 3개(Reactive / Reflect / Plan) 로 축소.

### 2.4 MemGPT / Letta
- **핵심**: Core memory(항상 프롬프트에 로드) + Archival/Recall memory(도구 호출로 검색), OS 가상메모리 유사.
- **취할 것**: **영혼 파일 = Core**, **생각 파일 = Working**, **장기기억 = Archival**. 컨텍스트 윈도우 초과하면 생각 파일을 **요약 압축**(`idea.md` 7단계의 "길어지면 압축" 과 정확히 일치).
- **안 취할 것**: MemGPT 의 tool-based 메모리 페이지 스왑은 지금 과함. 단순 "요약 트리거" 로 충분.

### 2.5 Voyager (Wang et al., 2023)
- **핵심**: auto-curriculum + skill library(코드 스니펫 = 재사용 가능한 "기술") + iterative prompting.
- **취할 것**: 확장 단계(10단계 후) 에 skill library 도입 가능. 지금은 **안 도입** — action space 가 4종(MOVE/ATTACK/SPEAK/USE) 밖에 없어 skill abstraction 가치가 낮다.

### 2.6 CAMEL / OASIS
- **핵심**: 대규모 소셜 에이전트 시뮬레이션, role-play 페어링.
- **취할 것**: 관계(relationship) 스키마 설계 시 OASIS 의 `(actor_a, actor_b, affinity, last_interaction_tick, tags)` 형태 참고.
- **안 취할 것**: 대규모 스케일, Twitter-like 토폴로지.

### 2.7 UI 레퍼런스

| 레퍼런스 | 훔칠 것 |
|---|---|
| **RimWorld** 콜로니스트 바 | at-a-glance: 초상화 + 배경색(mood) + HP/배고픔 세로바 + hover 시 세부. **숫자 대신 색/아이콘** 으로 먼저 말한다. [Moonlit Dev 분석](https://www.moonlitdevelopment.com/development-blog/2017/12/25/the-designers-folder-rimworlds-at-a-glance-user-interface-elements) |
| **Dwarf Fortress** announcements | 시간순 이벤트 피드, 카테고리 색 태그, 클릭 시 카메라 점프 |
| **AI Town** | 월드 위 대화 말풍선 + 플레이어가 NPC 선택 시 메모리 목록 인라인 |
| **Oxygen Not Included** duplicant overlay | 역할/스킬/스트레스 시각화, hover tooltip 으로 세부 |
| **Factorio** 정보 밀도 | 항상 보여야 할 전역 KPI 는 상단 얇은 바, 세부는 패널 토글 |
| **Stonehearth / Settlers** 건물 플레이스 고스트 | 우리 TILE/SPAWN 툴 UX 에 그대로 적용 가능(이미 어느 정도 있음) |

---

## 3. 재설계 — 데이터/아키텍처

### 3.1 스키마 확장 (idea.md 0단계 확정안)

[packages/shared/src/types/world.ts](../packages/shared/src/types/world.ts) 에 다음을 추가한다.

```ts
// 영혼 파일 — 일생 거의 변하지 않음 (소설적 정체성)
interface Soul {
  actorId: string;
  name: string;
  backstory: string;         // 1~3 문단
  persona: string;           // "조심스럽고 남을 잘 믿지 않음"
  goals: string[];           // ["마을에서 신뢰를 얻는다", ...]
  tone: string;              // "짧고 무뚝뚝"
  values: string[];          // ["규칙 준수", "가족"]
}

// 생각 파일 — 자주 갱신, 항상 프롬프트에 로드 (MemGPT core)
interface Thought {
  actorId: string;
  updatedAtTick: number;
  recentEvents: string;      // 최근에 있었던 일
  beliefs: string;           // 지금 내가 믿는 것
  priority: string;          // 지금 가장 중요한 것
  emotions: string;          // 감정/관계 변화
  nextIntent: string;        // 다음에 하고 싶은 것
}

// 관찰(원시 기억) — append-only
interface Observation {
  id: string;
  actorId: string;
  tick: number;
  text: string;              // 자연어, "나는 Boar 에게 공격받았다"
  tags: string[];
  importance: number;        // 0~1 (LLM 스코어)
  embedding?: number[];      // 지연 계산
  kind: 'action' | 'perception' | 'dialogue' | 'reflection';
}

// 관계
interface Relationship {
  from: string; to: string;
  affinity: number;          // -1 ~ 1
  lastInteractionTick: number;
  notes: string;             // "첫 만남에서 빵을 거절했다"
}

// Actor 확장
interface Actor {
  // ... 기존 필드
  soulRef?: string;          // souls/<id>.md
  thoughtRef?: string;       // thoughts/<id>.md
  memoryCount: number;       // observations 수
}
```

파일 레이아웃:

```
apps/what_is_world/data/
  souls/<actorId>.md         # 사람이 직접 편집 가능한 소울 파일
  thoughts/<actorId>.md      # 에이전트가 쓰는 생각 파일
  memories/<actorId>.jsonl   # append-only 관찰/에피소드 로그
  snapshots/<id>.json        # 월드 상태 스냅샷
  events.ndjson              # 2단계 원시 이벤트 로그
```

### 3.2 서비스 분리

```
[Colyseus WorldRoom]  ←── authoritative state & 4 primitive actions
        │
        │ action result + event
        ▼
[event-bus] (in-process EventEmitter → later nats/redis)
        │
        ├─► [logger]        → events.ndjson (idea.md 2단계)
        ├─► [dummy-brain]   → 룰 기반 NPC (idea.md 4단계)
        └─► [agent-runtime] → LLM 에이전트 (idea.md 5~9단계)
                  │
                  ├─ reactive (100~500ms)   ── PIANO 빠른 루프
                  ├─ reflective (30~60s)    ── Park 의 reflection
                  └─ planner (240s+)        ── 장기 계획 (선택)
```

새 패키지:
- `packages/agent-runtime/` — soul/thought 로드, 프롬프트 조립, LLM 호출, 행동 검증, 실패 재시도
- `packages/memory-store/` — SQLite + sqlite-vec 기반 관찰/관계 저장, retrieval 점수 함수
- `apps/brain/` — Node 프로세스, WorldRoom 클라이언트로 접속하여 NPC 를 "조종"하는 별도 서버

**중요**: 룰베이스 더미(4단계) 와 LLM(5~9단계) 는 **동일 프로토콜**(action JSON) 로 서버에 붙는다. 그래야 언제든 스위치할 수 있고, 초기 성능 문제를 룰로 우회 가능.

### 3.3 LLM 백엔드

로컬 프록시가 이미 있다 → `127.0.0.1:18796/v1` (OpenAI 호환, key=`claude-code-local`). `agent-runtime` 은 이 엔드포인트만 보고, 모델 선택은 환경변수로.

- **reactive**: 작은/빠른 모델 (gemma3:4b or qwen3:4b via ollama) — 1~2s 내 응답
- **reflective/plan**: 더 큰 모델 (gemma3:12b 또는 openakashic 게이트웨이 경유)

`insu_server/apps/openakashic-llm/compose.yaml` 의 ollama 와 경합하지 않도록 `OLLAMA_KEEP_ALIVE=2m` 설정은 유지.

### 3.4 프롬프트 블록 고정 (idea.md 5단계)

```
<SOUL>
... soul 파일 raw ...
</SOUL>

<THOUGHT>
... thought 파일 raw ...
</THOUGHT>

<SCENE tick={n}>
위치: (x,y)
시간: 낮/밤
주변 10칸 이내:
  - Villager (actor_id=npc_1, x,y, hp=.., mood=..)
  - bread_02 (item)
최근 내게 일어난 일:
  - tick 181: 나는 Boar 에게 hp 5 피해를 받았다
  - tick 183: 나는 bread 를 먹어 hunger 를 20 회복했다
</SCENE>

<MEMORY retrieved>
1. [importance=0.72] 시장 상인은 외상을 거절했다 (tick 45)
2. [importance=0.61] Hero 는 나를 도와준 적이 있다 (tick 12)
</MEMORY>

<AVAILABLE_ACTIONS>
[{"type":"MOVE","direction":"N"}, {"type":"SPEAK","target":"npc_1","text":"<fill>"}, ...]
</AVAILABLE_ACTIONS>

출력 규칙:
반드시 다음 JSON 하나만 출력. 소설 금지.
{"action": {...}, "reason": "<한 문장>", "thought_delta": {"emotions": "<선택>"}}
```

`reason` 은 콘솔 피드/대화 말풍선에 노출되어 **관찰 가능성** 을 올린다. 이게 UI 재설계의 핵심 소스다.

---

## 4. UI/UX 재설계

### 4.1 상위 원칙

1. **Observatory-first**: 기본 모드는 "관찰". 편집은 우상단 토글로 진입하는 보조 모드.
2. **Agent is the subject, not the entity**: 우측 패널은 Inspector 가 아니라 **Agent Card** — soul / thought / memory / intent 가 메인.
3. **Event feed is a first-class citizen**: 하단 콘솔을 "세계의 사건 피드" 로 승격, 카테고리 색상 + 클릭 → 카메라 점프.
4. **At-a-glance first, drill-down on hover**: 숫자/ID 는 세컨더리, 색/아이콘/진행바로 먼저 말한다 (RimWorld).
5. **Don't show what doesn't matter yet**: 지금 게임에 Gold 가 10 있어도 쓸 데가 없으면 기본 HUD 에서 제외.

### 4.2 새 화면 구성 (Observatory 모드)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [≡ WORLD]  Day 1  13:42  ☀  tick 4120   ▶ 1x 2x 4x 8x  ⏸  [편집모드 ⇗]  │  ← 상단 글로벌 바 (Factorio)
├─────────────┬────────────────────────────────────────┬──────────────────┤
│             │                                        │                  │
│ RESIDENTS   │                                        │ AGENT: Villager  │  ← 우측 Agent Card
│ ┌─────────┐ │                                        │ ┌──────────────┐ │
│ │▓▓ Hero  │ │                                        │ │ [avatar]     │ │
│ │▓░ Vil.. │ │         ── Phaser World ──             │ │ 마을 상인    │ │
│ │░░ Boar  │ │                                        │ │ mood: 걱정   │ │
│ └─────────┘ │        대화 말풍선 / intent hint       │ └──────────────┘ │
│             │                                        │                  │
│ (RimWorld   │                                        │ ▼ SOUL           │
│  style      │                                        │   "조심스럽다"  │
│  stacked    │                                        │ ▼ THOUGHT        │
│  cards,     │                                        │   최근: Boar가…  │
│  mood-bg)   │                                        │   지금 중요: 생존│
│             │                                        │   다음 의도: 도주│
│             │                                        │ ▼ MEMORIES (12)  │
│             │                                        │   • 상인 거절… │
│             │                                        │   • Hero 도움… │
│             │                                        │ ▼ RELATIONSHIPS  │
│             │                                        │   Hero +0.3     │
│             │                                        │   Boar −0.8     │
├─────────────┴────────────────────────────────────────┴──────────────────┤
│ EVENT FEED  [all][combat][dialog][need][reflect]  ──── 세계에서 일어남 ── │
│ 13:42  ⚔  Boar hit Villager for 5  [→jump]                              │
│ 13:42  💭  Villager: "이 곳은 위험하다. 마을로 돌아가자."  [→jump]       │
│ 13:41  🍞  Hero ate bread (−20 hunger)                                   │
│ 13:40  🧠  Villager reflected: "상인은 규칙을 지키는 사람 같다"           │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.3 편집 모드 (기존 UI 유지, 격하)

- 우상단 `편집모드 ⇗` 토글로만 진입
- 들어가면 현재 UI(ASSETS 탭 / Inspector / 툴바) 가 나타남
- **PLAY / PAUSE / STOP 은 편집 모드에서도 항상 보인다** (Observatory 에서도 동일)
- 편집 모드는 **월드를 일시정지** 시키는 게 기본 (시뮬레이션 중 편집은 confusing)

### 4.4 Resident Card (좌측)

RimWorld 스타일 차용:

```
┌──────────────────────┐
│ ▓▓▓ 배경색 = mood    │   배경 색상: 초록(happy) / 노랑(neutral) / 주황(stressed) / 빨강(danger)
│ [16×16 initial]      │   초상화 = assetKey 의 첫 프레임 crop
│ Villager             │
│ ▓▓▓▓▓▓▓▓▓░  HP       │   가로 미니바 3개 (세로 배치): HP / Stamina / Hunger (역방향)
│ ▓▓▓▓▓░░░░░  STM      │   수치 숨김, hover 시 tooltip
│ ▓▓▓▓▓▓▓▓░░  HGR      │
│ 💭 "마을로 돌아가야" │   ← thought.nextIntent 의 첫 문장 (최대 20자, 없으면 ...)
└──────────────────────┘
```

클릭 시: 우측 Agent Card 에 로드 + 카메라가 해당 액터로 팬.

### 4.5 Agent Card (우측)

섹션별 접기 가능. 각 섹션:
- **SOUL** (읽기 전용, "편집" 버튼 → soul.md 파일 인라인 에디터)
- **THOUGHT** (최신 생성물 diff 뷰 가능, "강제 갱신" 버튼)
- **MEMORIES**: 시간 역순 리스트. 각 항목에 `importance` 점 3단(● ◐ ○) 으로 표시, hover 시 full text + tags.
- **RELATIONSHIPS**: 바 그래프, -1~1 스케일.
- **PLAN** (선택, 9단계 이후): 다음 의도 트리.

### 4.6 Event Feed (하단)

- 필터 탭: `All / Combat / Dialogue / Needs / Reflection / System`
- 라인: `[시각] [아이콘] [본문] [→jump]`
- 자동 스크롤 토글
- **새 이벤트가 3초간 상단에 페이드 하이라이트** (Dwarf Fortress announcements)
- 리플렉션(🧠) 은 배경색 살짝 다르게 — 중요 사건 구분

### 4.7 월드 오버레이 (Phaser 내부)

- NPC 상공에 **intent bubble**: `"→ 마을"` 같은 한 단어 의도 (thought.nextIntent 축약). 말수가 많으면 UI 가 시끄러워짐 — 10 tick 마다 깜빡 업데이트.
- 대화(SPEAK) 시 말풍선 3초 유지.
- 공격(ATTACK) 시 float damage, 이미 구현됨.
- **선택된 액터 주변 시야 반경**(예: 10 tile) 을 옅은 하이라이트로 — "이 NPC 가 현재 세계에 대해 아는 범위" 를 시각화.

### 4.8 톤앤매너

| 요소 | 현재 | 변경 |
|---|---|---|
| 팔레트 | `#0d1117` 흑회색 + 형광 연두 | 유지 — 어두운 관찰실 분위기 맞음 |
| 타이포 | 시스템 sans | Pretendard 또는 IBM Plex Sans (숫자 tabular) |
| 액센트 | 연두 `#41d57b` | 2색 추가: 사건 알림용 warm amber `#f5a524`, 리플렉션용 lavender `#8b7ef7` |
| 모서리 | 각진 네모 | 카드 4px radius (RimWorld 도 각짐 유지) |
| 폰트 크기 | 12~14px 혼재 | 12/14/16 세 단계로 고정 |
| 한글/영어 혼용 | 섞여 있음 (`재스캔`, `연결됨`) | 라벨은 한글, 상태/이벤트 본문도 한글. 코드/ID/키만 영문 |

### 4.9 "지금은 없지만 바로 넣을 수 있는" 5가지

1. **시드 맵 교체**: 24×16 민둥 잔디 → 작은 마을 시드(48×32, 광장 + 상점 + 오두막 2채 + 숲) 을 Tiled 로 만들어 `import-seed` 로 투입. 건물/NPC 가 **있는** 세계부터 보여줘야 한다.
2. **Day/Night + 시계**: tick × n → day/hour 로 계산해 상단 바에 표시. 밤에는 Phaser 에 dark overlay(알파 0.35).
3. **Event Feed MVP**: WorldRoom 에서 이미 `appendRawEvent` 하고 있으니, 클라이언트로 브로드캐스트 → 하단 피드에 렌더. 카테고리 아이콘 매핑만.
4. **Intent bubble**: thought 가 없어도, 룰베이스 더미 NPC(4단계) 가 `currentGoal: 'seek_food'` 같은 enum 을 가지면 번역 테이블로 한글 표시 가능.
5. **Agent Card 레이아웃**: soul/thought 파일이 비어 있어도 placeholder("아직 자아가 없습니다") 를 넣어 UI 셸부터 먼저 만든다.

---

## 5. 구현 로드맵 (idea.md 10단계 ↔ 본 재설계 매핑)

| Phase | idea.md | 본 설계 산출물 | 크기 |
|---|---|---|---|
| **R0** | 0단계 (기준 고정) | `soul.md`/`thought.md` 스키마, `Observation` 타입, events.ndjson 포맷, 재설계 문서 병합 | 1일 |
| **R1** | 1~2단계 보강 | `appendRawEvent` → `events.ndjson` 실제 저장, `/events` API, 테스트 픽스처, 시드 맵 | 2일 |
| **R2** | UI 쉘 재작업 | Observatory/Edit 모드 분리, Resident Card, Agent Card(셸), Event Feed(라이브), 상단 글로벌 바 | 3~4일 |
| **R3** | 4단계 (더미) | 룰베이스 브레인 (`apps/brain-dummy`), 행동 트리(배고픔→탐색, 피로→휴식, 위험→도주), 마을 시드 확장 | 3일 |
| **R4** | 5단계 (컨텍스트) | `agent-runtime` 프롬프트 조립기, 프롬프트 블록 고정, 로컬 LLM 연결, 행동 JSON 검증 | 3일 |
| **R5** | 6단계 (NPC 1명 루프) | reactive 루프, 행동 실행, UI 에 intent/reason 표시 | 2일 |
| **R6** | 7단계 (생각 파일) | reflective 루프(30~60s), `thoughts/<id>.md` 파일 쓰기, UI 에 diff 뷰 | 3일 |
| **R7** | 8~9단계 (장기기억) | `memory-store` + sqlite-vec, 중요도 스코어링, 2-stage retrieval, MEMORIES 섹션 활성화 | 4일 |
| **R8** | 10단계 (다인화) | NPC 3~5명, 관계 엔진, 이벤트 피드 혼잡 대응 필터, 안정화 | 4일 |

**총 예상**: 약 5 주 집중 작업(병행 불가 기준).

---

## 6. 즉시 해야 할 액션 (다음 PR 후보)

아래 3개는 병렬 가능.

1. **스키마 픽스(R0)** — [packages/shared/src/types/world.ts](../packages/shared/src/types/world.ts) 에 `Soul / Thought / Observation / Relationship` 추가, `data/` 디렉토리 규약 README.
2. **이벤트 로깅 실저장(R1)** — 현재 `appendRawEvent` 가 메모리만 쌓고 있을 가능성이 큼. 실제 `data/events.ndjson` 으로 flush + tail 읽기 API + 브로드캐스트.
3. **UI 쉘 분리(R2-a)** — `App.tsx` 를 `ObservatoryShell.tsx` / `EditorShell.tsx` 로 분리, 모드 토글. 내용은 현재 UI 그대로 이관부터.

그 다음 **R2-b (Agent Card / Event Feed)** → **R3 (더미 브레인)** 순.

---

## 7. 폐기/축소 권장

- **현재 우측 인스펙터의 `TRANSFORM (Position)` 노출**: 일반 Observatory 에서는 불필요. 편집 모드에만.
- **`QUICK SPAWN` 우측 상단**: 편집 모드 전용으로 이동. Observatory 에서 스폰 버튼 노출은 몰입 깨짐.
- **상단 `재스캔` 버튼**: 의미 불명(뭘 재스캔?). 제거 또는 `reconnect` 로 네이밍 변경.
- **좌측 에셋 탭에서 ITEM 의 기본 선택이 "item_(sword)" 인 UX**: 카테고리 첫 그리드 위치 고정 불필요, 최근 사용 에셋 상위 고정이 더 유용.

---

## 8. 참고

- [Generative Agents (Park et al., 2023)](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763) — memory stream / retrieval scoring / reflection
- [AI Town (a16z-infra) ARCHITECTURE](https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md) — 상태 영속화, 에이전트 프롬프트 분리
- [Project Sid — PIANO](https://arxiv.org/abs/2411.00114) — 병렬 인지 모듈
- [MemGPT / Letta](https://arxiv.org/abs/2310.08560) — Core/Archival 메모리 계층
- [Reflexion](https://www.promptingguide.ai/techniques/reflexion) — self-reflection 루프
- [RimWorld at-a-glance UI 분석 (Moonlit Dev)](https://www.moonlitdevelopment.com/development-blog/2017/12/25/the-designers-folder-rimworlds-at-a-glance-user-interface-elements)
- [Voyager](https://arxiv.org/abs/2305.16291) — 장기적 확장용 skill library 참고
