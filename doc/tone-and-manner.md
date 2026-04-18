# what_is_world — Tone & Manner

> "어두운 엔진 편집기"가 아니라 **"따뜻한 관측소(Cozy Observatory)"**. 작은 마을의 삶을 훔쳐보는 감각.

## 1. 컨셉 키워드

- **Cozy observatory** · **Pocket diorama** · **Living miniature**
- 참조: Stardew Valley(따뜻한 팔레트), Animal Crossing(라운드 UI), Dwarf Fortress Adventures 텍스트, RimWorld 주민 카드의 정감, Observatory/관측 장비의 은은한 빛.

## 2. Color tokens (light-warm 팔레트)

CSS 변수로 박제. 기존 `--bg:#0d1117` 같은 slate/neon 톤은 전부 대체.

```
--bg        : #fbf6ec ;  /* 달빛 크림 — 베이스 배경 */
--surface   : #ffffff ;  /* 카드 표면 */
--surface-2 : #f3ead9 ;  /* 한 단계 가라앉은 표면 (패널 안쪽) */
--surface-3 : #ecdfc4 ;  /* 인셋/비활성 */
--ink       : #2b2118 ;  /* 본문 텍스트 (순 검정 X) */
--ink-soft  : #6b5a47 ;  /* 보조 텍스트 */
--ink-mute  : #a89884 ;  /* 캡션/placeholder */
--line      : #e0d3bb ;  /* 기본 테두리 */
--line-2    : #c9b99b ;  /* 강조 테두리 */

--accent    : #d97a4b ;  /* 테라코타 — primary CTA / 선택 */
--accent-2  : #e9b44c ;  /* 머스타드 — 주의/노란 강조 */
--sage      : #8aa68a ;  /* 이끼 — OK / alive */
--sky       : #6aa0c9 ;  /* 옅은 하늘 — MP/상상 */
--plum      : #a46fa1 ;  /* 연한 자주 — reflection / 꿈 */
--ember     : #c85a3f ;  /* 잉걸 — HP 경고 / 사망 */

--day       : #ffe9a8 ;  /* 낮 배경 오버레이 */
--night     : #2f3e5c ;  /* 밤 (쓰일 때만 어두워짐) */
--shadow    : 0 2px 8px rgba(60, 40, 20, 0.08) ;
--shadow-lg : 0 8px 24px rgba(60, 40, 20, 0.12) ;
```

**원칙**: 배경은 절대 #000 쪽으로 가지 않는다. 어둠은 오직 "밤 시간대 오버레이"에서만 쓴다. 네온 그린/빨강 대신 세이지/테라코타로 채도를 낮춘다.

## 3. Typography

- 본문: `"Pretendard Variable", "Inter", "Segoe UI", system-ui, sans-serif` — 14px base
- 이름/제목: 살짝 굵게 (600), 소문자 대신 **한글 제목 그대로**.
- 숫자/좌표/ID: `"JetBrains Mono", ui-monospace` 11-12px, `--ink-mute`
- 전부 대문자(uppercase)로 도배하지 않는다. 라벨은 자연스러운 케이스 (`주민`, `생각`, `기억`).

## 4. Shape & spacing

- 라운드: `--r-sm:6px`, `--r:10px`, `--r-lg:14px`, `--r-pill:999px`
- 카드는 1px solid `--line` + `--shadow`. 날카로운 1px 네온 테두리 금지.
- 패딩 스케일: 4/8/12/16/20/28 (8의 배수 우선)
- 아이콘은 이모지 + pictorial (🌾🌼🐗🕯️). Material icons/체인 아이콘 지양 — 동화책 느낌.

## 5. Motion

- 150-220ms ease-out이 기본. hover는 **밝기 +2% / 살짝 들림(translateY -1px)** — 색 점멸 X.
- 주민 카드 선택 시: 테두리가 `--accent`로 페이드-인 (flash 아님).
- 새 이벤트 도착: 피드 아이템이 위에서 `slideDown(180ms)` 으로 합류.

## 6. Language

- 에이전트 관련 표기는 전부 **한국어 친화**:
  - `Agent` → **주민 (Resident)**
  - `Memory stream` → **기억 흐름**
  - `Reflection` → **되새김**
  - `Soul` → **영혼 카드 (Soul)**
  - `Thought` → **오늘의 생각 (Thought)**
  - `Observation` → **관찰 (Observation)**
- 시스템 로그 문구는 "SPAWN_ACTOR OK" 같은 로그 스타일 대신 `🌼 새 주민 '모찌'가 마을에 도착했어요.` 스타일.

## 7. Layout language (Observatory 우선)

```
┌────────── 상단 바: 🌅 Day 3  08:42  ▶ 2× ⏸  [관측 | 편집] [⚙] ──────────┐
│                                                                       │
│ ┌── 주민 (왼쪽) ──┐  ┌── 월드 ──────────────────┐  ┌── 지금의 영혼 ──┐ │
│ │ 🌾 모찌 (NPC)   │  │                            │  │ 이름 모찌       │ │
│ │ HP▇▇▇░ 기분🙂  │  │                            │  │ 뼈대 …          │ │
│ │ 🐗 바울 (MOB)  │  │     [ 맵 — 픽셀 월드 ]    │  │ 오늘의 생각 …   │ │
│ │ …              │  │                            │  │ 최근 기억 …     │ │
│ └────────────────┘  └────────────────────────────┘  └─────────────────┘ │
│                                                                       │
│ ── 이벤트 피드 ──                                                     │
│ 08:41 🌼 모찌가 밀밭으로 향했어요.                                    │
│ 08:39 🔥 바울이 모찌를 발견했어요. (적대)                              │
└───────────────────────────────────────────────────────────────────────┘
```

편집 모드는 `[편집]` 토글로 전환되며 기존 UI 대부분 재사용 (팔레트만 교체).

## 8. Do / Don't

| Don't | Do |
|---|---|
| `#0d1117` 슬레이트 배경 | `#fbf6ec` 크림 배경 |
| 네온 녹색(#3fb950) HP 바 | 세이지(#8aa68a) HP 바 |
| UPPERCASE 라벨 도배 | 자연스러운 한글 라벨 |
| "SPAWN_ACTOR OK" 로그 | "🌾 모찌가 태어났어요." |
| 날카로운 1px 네온 테두리 | 옅은 `--line` + 은은한 shadow |
| Unity Inspector 스타일 키-값 덤프 | 서사 문장형 "오늘의 생각" 카드 |

## 9. 적용 순서

1. `App.css`의 `:root` 변수만 새 토큰으로 교체 → 전체 톤 변화 확인
2. 최상단 바에 [관측 / 편집] 토글 추가 → `ObservatoryShell` 노출
3. 편집 모드는 기존 UI 유지 (점진적 마감)
