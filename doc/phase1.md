좋아.
그럼 **1단계만 완성하는 개발 설계서**로 고정해서 정리하자.

기준은 이거다.

* **에이전트 없음**
* **관계 시스템 없음**
* **기억 시스템 없음**
* **수련 시스템 없음**
* 대신 **실시간 동기화되는 권위적 월드 서버**가 있고,
* **게임 안에서 사람과 나중의 에이전트가 맵 배치/속성 변경 가능한 구조**를 만든다.

핵심 선택은 아래다.

* **언어:** TypeScript 단일 스택
* **백엔드:** Node.js + TypeScript + Colyseus + Fastify
* **프론트:** Vite + React + Phaser
* **초기 맵 시드 편집기:** Tiled
* **공유 규칙 엔진:** 순수 TypeScript 패키지
* **저장:** 1단계는 JSON snapshot + 로그 파일, 필요하면 SQLite 추가

이 선택의 이유는 간단하다.
Phaser는 타일맵 데이터를 런타임에 만들고 수정할 수 있어서 게임 내 에디터 모드에 잘 맞고, Colyseus는 서버가 상태를 직접 변경하고 클라이언트는 상태 변화를 패치로 받아 UI를 동기화하는 구조라서 “서버 권위 월드 + 실시간 편집”에 잘 맞는다. Tiled는 레이어, 오브젝트, 커스텀 프로퍼티, 커스텀 타입을 지원해서 초깃값 맵과 구조물 프리셋을 만들기 좋다. ([Phaser Documentation][1])

---

# 1. 1단계 목표

1단계에서 끝내야 하는 건 딱 이거다.

1. 서버가 월드 상태를 들고 있다.
2. 클라이언트는 서버 상태를 실시간으로 본다.
3. 이동 / 공격 / 발화 / 사용이 서버 룰대로 계산된다.
4. 타일/구조물 배치와 속성 변경이 서버를 통해 반영된다.
5. 모든 변경은 원시 이벤트 로그로 남는다.
6. 외부 에디터는 초깃값 시드용일 뿐, 런타임의 진실은 서버다.

---

# 2. 기술 스택 고정안

## 백엔드

**Node.js + TypeScript + Colyseus + Fastify**

역할은 이렇게 나눈다.

* **Colyseus**

  * 실시간 월드 상태 동기화
  * 플레이어/에디터/나중의 에이전트가 보내는 명령 처리
  * 서버 authoritative state 유지
* **Fastify**

  * 상태 조회
  * 스냅샷 저장/로드
  * 맵 시드 import
  * 로그 조회
  * 디버그/관리용 API

Colyseus는 서버만 상태를 직접 mutate하고, 클라이언트는 패치를 받아 동기화하는 구조다. 또 property-level 변경만 패치로 보내는 구조라 월드 편집처럼 잦은 상태 변경에도 맞다. ([Colyseus][2])

## 프론트

**Vite + React + Phaser**

역할은 이렇게 나눈다.

* **React**

  * 우측 패널
  * 선택한 타일/구조물 속성 패널
  * 에디터 툴바
  * 디버그 패널
* **Phaser**

  * 타일맵 렌더링
  * 엔티티 렌더링
  * 카메라 이동
  * 타일 브러시 / 구조물 배치 고스트 / 클릭 선택
  * 서버 상태 반영

Phaser Tilemap은 런타임에 타일을 만들고 수정할 수 있어서, 게임 내 편집 모드 구현에 적합하다. ([Phaser Documentation][1])

## 외부 시드 맵 툴

**Tiled**

역할:

* 초깃값 맵 제작
* 타일 레이어 정의
* 오브젝트/구조물 시드 배치
* 커스텀 프로퍼티 정의
* 구조물 프리셋/템플릿 관리

Tiled는 기본 데이터 구조 전반에 커스텀 프로퍼티를 붙일 수 있고, 커스텀 enum/class도 지원한다. 또 타일 오브젝트에 별도 속성을 붙여 상자, NPC, 상점 같은 인식 가능한 인터랙티브 오브젝트를 배치할 수 있다. ([Tiled Documentation][3])

---

# 3. 왜 TypeScript 단일 스택인가

이건 단순하다.

1단계는 아직 AI가 아니라 **월드 판정과 편집 파이프라인**이 핵심이다.
그래서 백엔드/프론트/공유 타입을 하나의 언어로 묶는 게 가장 이득이다.

장점:

* 상태 타입 공유
* 메시지 타입 공유
* 룰 엔진 재사용 가능
* 프론트와 서버 간 스키마 불일치 감소
* 개발자 온보딩 쉬움

즉 1단계에서는 성능보다 **구현 속도와 구조 안정성**이 더 중요하다.

---

# 4. 전체 구조

구조는 이렇게 본다.

```txt
[Tiled Seed Map]
     ↓ import
[Fastify Importer]
     ↓
[WorldState Snapshot]
     ↓
[Colyseus WorldRoom]
     ↔
[Phaser Client + React Editor UI]
     ↔
[Fastify Admin/Debug API]
```

중요한 점은 이거다.

* Tiled 파일은 **초깃값**
* 실제 월드는 **WorldState**
* 런타임 수정은 **항상 서버 명령**
* 클라이언트는 직접 월드를 고치지 않음

---

# 5. 추천 모노레포 구조

이대로 가면 된다.

```txt
project-root/
  apps/
    server/
      src/
        main.ts
        server.ts
        config/
        rooms/
        api/
        persistence/
        imports/
        logging/
    client/
      src/
        main.tsx
        app/
        game/
        editor/
        net/
        panels/
        state/
  packages/
    shared/
      src/
        types/
        protocol/
        constants/
        schemas/
    world-core/
      src/
        state/
        actions/
        rules/
        edits/
        simulation/
        utils/
    content/
      seeds/
      tilesets/
      maps/
      templates/
  docs/
    phase1/
```

---

# 6. 폴더별 역할

## `apps/server`

실시간 서버와 관리 API를 담는다.

```txt
apps/server/src/
  main.ts
  server.ts
  rooms/
    WorldRoom.ts
    schema/
      WorldRoomState.ts
      ActorState.ts
      StructureState.ts
      TileLayerState.ts
  api/
    worldRoutes.ts
    snapshotRoutes.ts
    logRoutes.ts
    importRoutes.ts
  imports/
    tiled/
      parseTiledJson.ts
      mapSeedToWorld.ts
  persistence/
    snapshotStore.ts
    eventLogStore.ts
  logging/
    rawEventLogger.ts
  config/
    env.ts
```

### 역할

* `WorldRoom.ts`

  * 실시간 월드 룸
  * 클라이언트 메시지 수신
  * 상태 변경
  * 패치 전파
* `schema/`

  * Colyseus sync 대상 상태 정의
* `api/`

  * REST 관리 API
* `imports/`

  * Tiled JSON → WorldState 변환
* `persistence/`

  * 저장/로드
* `logging/`

  * 원시 이벤트 로그 기록

Colyseus의 state는 서버에서 정의하고 서버만 직접 mutate해야 하며, 클라이언트는 state change callback으로 반영하는 식이 기본 구조다. ([Colyseus][2])

## `apps/client`

렌더링과 에디터 UI를 담는다.

```txt
apps/client/src/
  main.tsx
  app/
    App.tsx
    routes.tsx
  game/
    GameBootstrap.ts
    scenes/
      WorldScene.ts
      EditorScene.ts
    render/
      tilemapRenderer.ts
      structureRenderer.ts
      actorRenderer.ts
    input/
      cameraInput.ts
      tileBrushInput.ts
      selectionInput.ts
  editor/
    tools/
      selectTool.ts
      paintTileTool.ts
      eraseTileTool.ts
      placeStructureTool.ts
      propertyEditTool.ts
    store/
      editorStore.ts
  net/
    colyseusClient.ts
    roomBindings.ts
    apiClient.ts
  panels/
    ToolPanel.tsx
    PropertyPanel.tsx
    SelectionPanel.tsx
    DebugPanel.tsx
  state/
    uiState.ts
```

### 역할

* `game/`

  * Phaser 씬과 렌더링
* `editor/`

  * 에디터 툴 로직
* `net/`

  * 서버 연결
* `panels/`

  * React UI

## `packages/shared`

서버/클라 공통 타입을 둔다.

```txt
packages/shared/src/
  types/
    action.ts
    editCommand.ts
    event.ts
    world.ts
  protocol/
    roomMessages.ts
  constants/
    layers.ts
    entityTypes.ts
  schemas/
    zod/
```

### 역할

* 액션 요청 타입
* 편집 명령 타입
* 이벤트 로그 타입
* 공통 enum

## `packages/world-core`

가장 중요하다.
게임 규칙은 여기 있다.

```txt
packages/world-core/src/
  state/
    createWorldState.ts
    worldState.ts
    tile.ts
    structure.ts
    actor.ts
  actions/
    dispatchAction.ts
    move.ts
    attack.ts
    speak.ts
    use.ts
  edits/
    dispatchEdit.ts
    placeTile.ts
    removeTile.ts
    placeStructure.ts
    moveStructure.ts
    updateStructureProperty.ts
    removeStructure.ts
  rules/
    collision.ts
    combat.ts
    itemEffects.ts
    placementRules.ts
    validation.ts
  simulation/
    tickWorld.ts
    timeRules.ts
    needsRules.ts
  utils/
    ids.ts
    geometry.ts
```

### 역할

* 액션 룰
* 맵 편집 룰
* 충돌/배치 검증
* tick 시뮬레이션

1단계에서 가장 중요한 원칙은
**룰은 server app 안에 흩어지지 말고 `world-core`에 몰아넣는 것**이다.

---

# 7. 1단계의 데이터 권한

권한은 절대 흔들리면 안 된다.

## 서버가 가진 권한

* 타일 변경 확정
* 구조물 배치/삭제 확정
* 구조물 속성 수정 확정
* 이동 가능 여부
* 충돌 판정
* 공격/사용 결과
* 상태 변화
* 시간 경과
* 로그 기록

## 클라이언트가 하는 일

* 편집 요청 보내기
* 행동 요청 보내기
* 상태 렌더링
* 선택 UI, 패널 UI, 툴 UI

즉 클라이언트는 **요청만** 하고, 확정은 서버가 한다.

---

# 8. 1단계의 핵심 상태 모델

1단계는 상태를 너무 크게 벌리지 않는 게 중요하다.

```ts
type WorldState = {
  revision: number;
  tick: number;
  timeOfDay: number;
  map: {
    width: number;
    height: number;
    tileSize: number;
    terrain: number[][];
    collision: number[][];
    decor: number[][];
  };
  structures: Record<string, Structure>;
  actors: Record<string, Actor>;
  groundItems: Record<string, GroundItem>;
};
```

여기서 중요한 건 레이어를 최소 3개로 고정하는 거다.

* `terrain`: 바닥/물/벽 등의 기본 지형
* `collision`: 서버 판정용 막힘/특수 타일
* `decor`: 보기용 장식

이렇게 하면 렌더링과 판정이 덜 꼬인다.

## 구조물

```ts
type Structure = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  props: Record<string, unknown>;
};
```

`props`에 문 상태, 잠금, 상점 타입, 휴식 값 같은 걸 넣는다.

## 액터

```ts
type Actor = {
  id: string;
  kind: "player" | "npc" | "monster";
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  stamina: number;
  maxStamina: number;
  hunger: number;
  gold: number;
  stats: {
    str: number;
    dex: number;
    int: number;
    vit: number;
  };
  inventory: InventoryItem[];
  alive: boolean;
};
```

---

# 9. 액션과 편집 명령을 분리한다

이건 매우 중요하다.

## 행동 명령

* `MOVE`
* `ATTACK`
* `SPEAK`
* `USE`

## 편집 명령

* `PLACE_TILE`
* `ERASE_TILE`
* `PLACE_STRUCTURE`
* `MOVE_STRUCTURE`
* `REMOVE_STRUCTURE`
* `UPDATE_STRUCTURE_PROPERTY`

나중에 에이전트도 맵을 바꿀 수 있게 하려면
**인간 에디터와 에이전트가 같은 편집 명령 체계**를 써야 한다.

예시:

```ts
type EditCommand =
  | {
      type: "PLACE_TILE";
      layer: "terrain" | "collision" | "decor";
      x: number;
      y: number;
      tileId: number;
    }
  | {
      type: "PLACE_STRUCTURE";
      structureType: string;
      x: number;
      y: number;
      width: number;
      height: number;
      props?: Record<string, unknown>;
    }
  | {
      type: "UPDATE_STRUCTURE_PROPERTY";
      structureId: string;
      key: string;
      value: unknown;
    };
```

---

# 10. 룸 메시지 규격

Colyseus room에서는 메시지도 명확히 나눠야 한다.

```ts
type ClientToServerMessage =
  | { kind: "action"; payload: ActionRequest }
  | { kind: "edit"; payload: EditCommand }
  | { kind: "select"; payload: { entityId?: string; x?: number; y?: number } };

type ServerToClientEvent =
  | { kind: "action_result"; payload: ActionResult }
  | { kind: "edit_result"; payload: EditResult }
  | { kind: "toast"; payload: { message: string } };
```

주의할 점은 이거다.
**Colyseus Schema는 state용이고, 메시지는 별도로 관리**하는 게 맞다. 공식 문서도 `Schema`는 state 안에서만 쓰고, state 외 메시지에 남용하지 말라고 안내한다. ([Colyseus][4])

---

# 11. Tiled는 어떻게 쓸까

Tiled는 런타임 월드 자체가 아니다.
역할은 두 개뿐이다.

## 역할 1. 초기 맵 시드

* 마을 기본 타일 배치
* 기본 구조물 위치
* 기본 NPC 스폰 포인트
* 기본 충돌 레이어

## 역할 2. 구조물 프리셋

* 문
* 침대
* 카운터
* 상자
* 작업대
* 스폰 포인트

Tiled는 거의 모든 기본 구조에 커스텀 프로퍼티를 붙일 수 있고, 오브젝트에 타일을 삽입해서 특별 정보를 가진 인터랙티브 오브젝트를 배치하는 데 쓸 수 있다. ([Tiled Documentation][3])

1단계에서는 Tiled 프로젝트에 최소한 이 속성은 두는 걸 추천한다.

### 타일 프로퍼티

* `terrainType`
* `walkable`
* `moveCost`
* `blocksBuild`

### 구조물 오브젝트 프로퍼티

* `structureType`
* `blocksMovement`
* `interactable`
* `maxHp`
* `restValue`
* `shopType`

---

# 12. 개발 순서

이 순서대로 가면 된다.

## 1주차 묶음

1. monorepo 생성
2. `packages/shared` 생성
3. `packages/world-core` 생성
4. `apps/server` Colyseus + Fastify 부트
5. `apps/client` Vite + React + Phaser 부트

목표: 프로젝트 껍데기와 공통 타입 고정

## 2주차 묶음

1. `WorldState` 정의
2. Colyseus `WorldRoomState` 정의
3. 기본 타일맵 렌더링
4. Tiled JSON import
5. terrain/collision/decor 로드

목표: 시드 맵이 서버와 클라에 뜨기

## 3주차 묶음

1. `MOVE` 구현
2. `USE` 구현
3. `ATTACK` 구현
4. `SPEAK` 구현
5. action dispatcher 작성
6. raw event logger 작성

목표: 월드 규칙이 서버에서 돌아가기

## 4주차 묶음

1. Phaser 에디터 모드
2. 타일 브러시
3. 구조물 배치 툴
4. 구조물 선택/삭제
5. 속성 패널
6. 편집 명령 dispatcher 작성

목표: 게임 안에서 타일/구조물 편집 가능

## 5주차 묶음

1. snapshot save/load
2. 로그 조회 API
3. 에디터 권한 체크
4. 충돌/중첩/설치 불가 검증
5. 디버그 패널

목표: 1단계를 실제로 운영 가능한 상태로 마무리

---

# 13. 개발자 역할 분담

팀이 있다면 이 정도로 자르면 된다.

## A. 서버/룰 담당

* `world-core`
* `apps/server`
* 액션/편집 명령 검증
* 로그
* 저장/로드

## B. 클라이언트/렌더 담당

* Phaser 타일맵 렌더
* 엔티티 렌더
* 카메라/입력
* 상태 반영

## C. 에디터 UI 담당

* React 패널
* 속성 편집 UI
* 툴 선택
* 선택 상태 표시
* 편집 UX

## D. 콘텐츠/시드 담당

* Tiled 맵 제작
* 타일셋 정리
* 구조물 프리셋
* 시드 import 검수

---

# 14. 1단계 완료 기준

이 기준을 만족하면 1단계 끝이다.

1. 서버가 월드 상태를 authoritative 하게 유지한다.
2. 클라이언트는 Colyseus 패치로 상태를 본다. ([Colyseus][2])
3. 이동/공격/발화/사용이 서버 판정으로만 실행된다.
4. 게임 안에서 타일 수정이 가능하다.
5. 게임 안에서 구조물 배치/삭제/속성 수정이 가능하다.
6. 모든 액션/편집이 원시 이벤트 로그로 남는다.
7. 서버 재시작 후 snapshot 복원이 가능하다.
8. Tiled 시드 맵을 불러와 시작 월드를 만들 수 있다. ([Tiled Documentation][3])

---

# 15. 공식 참고 소스

1단계에서 실제로 계속 보게 될 기본 소스는 이 4개면 충분하다.

* **Phaser Tilemap 문서**: 런타임 타일맵 수정과 렌더링 기준. ([Phaser Documentation][1])
* **Colyseus State Synchronization / Schema 문서**: 서버 authoritative state와 패치 동기화 기준. ([Colyseus][2])
* **Tiled Custom Properties 문서**: 시드 맵과 구조물 속성 정의 기준. ([Tiled Documentation][3])
* **Tiled Objects 문서**: 구조물/오브젝트 배치 방식 기준. ([Tiled Documentation][5])

---

# 16. 최종 결정안

1단계의 최종 설계는 이렇게 고정하면 된다.

* **언어:** TypeScript
* **백엔드:** Node.js + Colyseus + Fastify
* **프론트:** Vite + React + Phaser
* **시드 툴:** Tiled
* **코어 룰:** `packages/world-core`
* **공유 타입:** `packages/shared`
* **런타임 진실:** 서버 `WorldState`
* **편집 방식:** 게임 내 에디터 + 서버 명령 패치
* **외부 에디터 역할:** 초기 맵/프리셋 제작 בלבד

이걸로 가면 개발자가 1단계를 실제로 끝낼 수 있다.

다음으로 바로 이어서 할 일은
**이 설계 기준으로 `shared` 타입, `world-core` 상태 모델, `WorldRoom` 메시지 규격을 실제 코드 수준으로 정의하는 것**이다.

[1]: https://docs.phaser.io/api-documentation/class/tilemaps-tilemap "Tilemap | Phaser Help"
[2]: https://docs.colyseus.io/state "State Synchronization – Colyseus"
[3]: https://doc.mapeditor.org/en/stable/manual/custom-properties/ "Custom Properties — Tiled 1.12.1 documentation"
[4]: https://docs.colyseus.io/state/schema "Schema Definition – Colyseus"
[5]: https://doc.mapeditor.org/en/stable/manual/objects/ "Working with Objects — Tiled 1.12.1 documentation"
