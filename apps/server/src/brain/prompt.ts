import type { Actor, Observation, Place, Soul, Thought, WorldState } from "@wiw/shared";
import { nextThreshold, ko, itemsByCategory, STATION_TYPES } from "@wiw/shared";
import { tradePairCooldownLeft } from "@wiw/world-core";

export interface BrainAction {
  type: "MOVE" | "ATTACK" | "SPEAK" | "USE" | "PICKUP" | "DROP" | "GIVE" | "OFFER_TRADE" | "BUY" | "SELL" | "PRAY" | "THINK" | "OPTIONS" | "WAIT";
  reason?: string;
  dx?: number;
  dy?: number;
  targetId?: string;
  message?: string;
  itemId?: string;
  /** USE objectId — 발 밑/인접 structure id (oven, workbench, forge, alchemy_table 등) */
  objectId?: string;
  /** USE objectId+targetItemId — 그 station 으로 만들 출력 prefix (예: "bread") */
  targetItemId?: string;
  /** USE skillId — 액티브 스킬 (pray, appraise 등) */
  skillId?: string;
  /** PICKUP/DROP/GIVE/USE/OFFER_TRADE 시 갯수 (기본 1, max 32) */
  count?: number;
  itemType?: string;
  currency?: "gold";
  amount?: number;
  query?: string;
  x?: number;
  y?: number;
  /** OFFER_TRADE 전용 */
  wantItem?: string;
  wantCount?: number;
  offerItem?: string;
  offerCount?: number;
  offerGold?: number;
}

export type GoalDecisionKind = "KEEP" | "COMPLETE" | "CHANGE" | "ABANDON";

export interface GoalProposal {
  intent: string;
  /** 본 적 있는 좌표만. LLM 이 짐작 좌표 보내도 시스템이 검증한다. */
  targetXY?: { x: number; y: number };
  targetActorId?: string;
  targetItemPrefix?: string;
  reason: string;
  ttlTicks?: number;
  nextActions?: string[];
}

export interface BrainDecision {
  thought: {
    priority: string;
    emotion: string;
    nextIntent: string;
    beliefs: string[];
    recentEvents: string[];
    activePath?: Thought["activePath"];
  };
  action: BrainAction;
  goalDecision?: {
    kind: GoalDecisionKind;
    proposal?: GoalProposal;
    reason?: string;
  };
}

export type RecentDecision = { type: BrainAction["type"]; result: string };

type DayPhase = "morning" | "day" | "evening" | "night";

function phaseOf(hour: number): DayPhase {
  if (hour < 6 || hour >= 22) return "night";
  if (hour < 11) return "morning";
  if (hour < 18) return "day";
  return "evening";
}

function distanceToPlace(actor: Actor, place: Place): number {
  const dx = actor.x < place.x ? place.x - actor.x : actor.x >= place.x + place.width ? actor.x - (place.x + place.width - 1) : 0;
  const dy = actor.y < place.y ? place.y - actor.y : actor.y >= place.y + place.height ? actor.y - (place.y + place.height - 1) : 0;
  return dx + dy;
}

function placeAt(world: WorldState, actor: Actor): Place | undefined {
  return Object.values(world.places ?? {}).find((place) => distanceToPlace(actor, place) === 0);
}

function directionFrom(me: Actor, target: { x: number; y: number }): string {
  const dx = target.x - me.x;
  const dy = target.y - me.y;
  if (dx === 0 && dy === 0) return "같은 칸";
  const ns = dy < 0 ? "북" : dy > 0 ? "남" : "";
  const ew = dx < 0 ? "서" : dx > 0 ? "동" : "";
  return `${ns}${ew || ""}${Math.abs(dx) + Math.abs(dy) === 1 ? "" : ` ${Math.abs(dx) + Math.abs(dy)}칸`}`;
}

function weatherLine(world: WorldState): string {
  const text = {
    sunny: "맑음",
    cloudy: "흐림",
    rain: "비 — 야외 둔함",
    fog: "안개 — 먼 시야 둔함",
    windy: "바람 — 길목 어수선함"
  }[world.context.weather];
  return text ?? world.context.weather;
}

function resourcePressureLine(world: WorldState): string {
  const resources = world.context.resources;
  const shortages = [
    resources.wellWaterLevel <= 2 ? "우물 물이 줄고 있다" : null,
    resources.carrotStock <= 1 ? "텃밭 수확물이 적다" : null
  ].filter(Boolean);
  const parts = [`시간 ${world.timeOfDay.toFixed(1)}시`, `날씨 ${weatherLine(world)}`];
  if (shortages.length) parts.push(`부족: ${shortages.join(", ")}`);
  if (world.context.activeIssue) parts.push(`상황: ${world.context.activeIssue.text}`);
  return parts.join(" / ");
}

// 아이템 한국어 이름은 packages/shared/src/content/items.ts 의 ITEM_CATALOG 단일 출처.
const describeItem = (itemId: string): string => ko.items(itemId);

function formatInventory(actor: Actor): string {
  if (actor.inventory.length === 0) return `소지품 비어 있음, gold ${actor.gold}`;
  const counts = new Map<string, number>();
  for (const slot of actor.inventory) {
    const k = slot.item;
    counts.set(k, (counts.get(k) ?? 0) + (slot.kind === "stack" ? slot.count : 1));
  }
  const summaries: string[] = [];
  for (const [k, n] of counts) summaries.push(n > 1 ? `${describeItem(k)} × ${n}` : describeItem(k));
  // P1-6: 인벤 포화 시 자연스러운 한 줄 경고. 사용자 결정.
  const slotsUsed = actor.inventory.length;
  const fullNote = slotsUsed >= 8 ? " (가방이 꽉차서 더 줍지 못한다)" : "";
  return `소지품 (${slotsUsed}/8) [${summaries.join(", ")}], gold ${actor.gold}${fullNote}`;
}

/**
 * gpt-5.5 가이드: needs 를 강제 명령이 아닌 body signal 로. 4 단계 severity.
 * 40: 약간 불편 / 60: 명확 / 80: 강함 / 90+: 위기.
 */
export function bodySignalLine(actor: Actor): string {
  const sig: string[] = [];
  if (actor.hunger >= 90) sig.push("위기:굶주림");
  else if (actor.hunger >= 80) sig.push("강:배고픔");
  else if (actor.hunger >= 60) sig.push("배고픔");
  else if (actor.hunger >= 40) sig.push("약간 출출");
  if (actor.stamina <= 10) sig.push("위기:탈진");
  else if (actor.stamina <= 25) sig.push("강:피로");
  else if (actor.stamina <= 40) sig.push("피로");
  if (actor.hp <= actor.maxHp * 0.25) sig.push("위기:중상");
  else if (actor.hp <= actor.maxHp * 0.5) sig.push("강:부상");
  else if (actor.hp <= actor.maxHp * 0.75) sig.push("부상");
  return sig.length ? `몸의 신호: ${sig.join(", ")}` : "몸의 신호: 안정";
}

function crisisLine(actor: Actor): string | null {
  const cues: string[] = [];
  if (actor.hunger >= 95) cues.push("속이 비어 손이 떨린다");
  else if (actor.hunger >= 80) cues.push("배가 매우 고프다");
  if (actor.hp <= actor.maxHp * 0.25) cues.push(`상처가 깊다 (hp ${Math.round(actor.hp)})`);
  else if (actor.hp <= actor.maxHp * 0.5) cues.push(`다쳐있다 (hp ${Math.round(actor.hp)})`);
  if (actor.stamina <= 15) cues.push("탈진 직전");
  else if (actor.stamina <= 30) cues.push("피로하다");
  return cues.length ? `(감각: ${cues.join(", ")})` : null;
}

function formatSkills(actor: Actor): string | null {
  const visible = (actor.skills ?? [])
    .filter((skill) => skill.level > 0 || (skill.xp ?? 0) > 0)
    .sort((a, b) => (b.level - a.level) || ((b.xp ?? 0) - (a.xp ?? 0)))
    .slice(0, 4)
    .map((skill) => {
      const next = nextThreshold(skill.level);
      const xp = skill.xp ?? 0;
      return skill.level > 0 ? `${skill.name} ${skill.level} (${xp}/${next})` : `${skill.name} (${xp}/${next})`;
    });
  return visible.length ? `숙련: ${visible.join(", ")}` : null;
}

function activeQuestLine(soul: Soul, world: WorldState): string | null {
  const quest = soul.isFollower && soul.activeQuest?.status === "active" ? soul.activeQuest : undefined;
  if (!quest || quest.expiresAtTick <= world.tick) return null;
  const daysLeft = Math.max(0, Math.ceil((quest.expiresAtTick - world.tick) / 2400));
  const progress = quest.progress
    ? ` — 진행 ${quest.progress.current}/${quest.progress.target}, 만료까지 ${daysLeft}일`
    : ` — 진행 중, 만료까지 ${daysLeft}일`;
  return `[신탁] ${quest.text}${progress}`;
}

function availableActions(world: WorldState, me: Actor): string[] {
  const actions = ["MOVE", "SPEAK", "OFFER_TRADE", "USE", "PICKUP", "DROP", "GIVE", "ATTACK", "THINK", "OPTIONS", "WAIT"];
  if (placeAt(world, me)?.kind === "shrine") actions.push("PRAY");
  return actions;
}

/**
 * P1-5: 불가능한 것만 cooldown 라인. 가능한 것은 표시 X (유도 차단).
 * 형식: "5tick 동안 SPEAK 불가능 / pendingTrade(npc-3에게) 12tick 대기"
 * 막힌 것 0개면 빈 배열 → 라인 자체 생략.
 */
/**
 * P1-6: sparse affordance description. role nudge X.
 * - 인벤에 seed 가 있고 옆에 field 가 있으면: "인벤 wheat_seed — 흙 근처에서 심을 수 있다"
 * - 옆에 station 이 있고 인벤에 그 입력 재료가 있으면: "근처 oven — 빵 굽는 데 쓰인다"
 * - appraise 미사용에 낯선 trinket/letter 있으면: "낡은 ~ 자세히 살펴볼 만하다"
 * 모든 문장 톤: "조건이 보인다 / 그럴 수 있다" 정도. 명령형 X.
 */
/** P2: affordance metric — 어떤 kind 가 노출됐는지 caller 가 측정. */
const lastAffordanceKindsByActor = new Map<string, string[]>();
export function getLastAffordanceKinds(actorId: string): string[] {
  return lastAffordanceKindsByActor.get(actorId) ?? [];
}

function sparseAffordance(world: WorldState, me: Actor): string[] {
  const kinds: string[] = [];
  const out: string[] = [];
  const place = placeAt(world, me);
  // seed in inventory + field nearby
  const hasSeed = me.inventory.some((s) => s.item.endsWith("_seed"));
  if (hasSeed && place?.kind === "field") {
    out.push("(여기는 흙 — 가진 씨앗을 뿌려볼 수 있다)");
    kinds.push("field+seed");
  } else if (hasSeed) {
    const nearestField = Object.values(world.places ?? {}).find((p) => p.kind === "field");
    if (nearestField) {
      const d = distanceToPlace(me, nearestField);
      if (d <= 12) {
        out.push(`(가진 씨앗은 흙 위에서 심을 수 있다 — 가까운 텃밭 ${nearestField.name})`);
        kinds.push("seed+nearField");
      }
    }
  }
  // station 옆 + 입력 재료 있음
  const stationStructs = Object.values(world.structures ?? {}).filter((s) => STATION_TYPES.has(s.type));
  for (const s of stationStructs) {
    const d = Math.abs(s.x - me.x) + Math.abs(s.y - me.y);
    if (d > 2) continue;
    const stationName = ko.station(s.type);
    if (s.type === "oven" && me.inventory.some((it) => it.item === "wheat" && (it.kind === "stack" ? it.count >= 2 : true))) {
      out.push(`(근처 ${stationName}[${s.id}] — 밀 2개로 빵을 굽힐 수 있다 — USE objectId=${s.id} targetItemId=bread)`);
      kinds.push("oven+wheat");
    }
    if (s.type === "alchemy_table" && me.inventory.some((it) => it.item === "herb")) {
      out.push(`(근처 ${stationName}[${s.id}] — 약초로 약을 빚을 수 있다 — USE objectId=${s.id} targetItemId=healing_potion)`);
      kinds.push("alchemy+herb");
    }
    if (s.type === "forge" && me.inventory.some((it) => it.item === "ore")) {
      out.push(`(근처 ${stationName}[${s.id}] — 광석으로 도구를 만들 수 있다 — USE objectId=${s.id} targetItemId=pickaxe)`);
      kinds.push("forge+ore");
    }
    if (s.type === "workbench" && me.inventory.some((it) => it.item === "wood")) {
      out.push(`(근처 ${stationName}[${s.id}] — 나무로 청사진을 짤 수 있다 — USE objectId=${s.id} targetItemId=workbench_blueprint)`);
      kinds.push("workbench+wood");
    }
  }
  lastAffordanceKindsByActor.set(me.id, kinds);
  return out.slice(0, 3);
}

function cooldownLines(world: WorldState, me: Actor): string[] {
  const out: string[] = [];
  // MOVE cooldown
  const dex = me.status?.dexterity ?? 5;
  const running = me.skills?.find((s) => s.id === "running")?.level ?? 0;
  const base = me.kind === "monster" ? 4 : 6;
  const dexBonus = Math.max(0, Math.floor((dex - 4) / 4));
  const runBonus = Math.min(3, Math.floor(running / 3));
  const tired = me.stamina < (me.maxStamina * 0.2) ? 2 : 0;
  const moveCd = Math.max(1, base - dexBonus - runBonus + tired);
  const moveLeft = (me.lastMoveTick ?? -Infinity) + moveCd - world.tick;
  if (moveLeft > 0) out.push(`${moveLeft}tick 동안 MOVE 불가능`);
  // OPTIONS / SKILL cooldown 600
  const optLeft = (me.lastSkillTick ?? -Infinity) + 600 - world.tick;
  if (optLeft > 0) out.push(`${optLeft}tick 동안 OPTIONS 불가능`);
  // pendingTrade pair cooldown — 내가 누군가에게 trade 못 보내는 경우
  for (const other of Object.values(world.actors)) {
    if (other.id === me.id || !other.alive || other.kind === "monster") continue;
    const left = tradePairCooldownLeft(world, me.id, other.id);
    if (left > 0) out.push(`${left}tick 동안 ${other.id}에게 거래 제안 불가능`);
  }
  // stamina_too_low 가능성
  if (me.stamina <= 0) out.push("스태미너 0 — 비용 큰 행동 불가능");
  return out;
}

function pendingTradeLines(world: WorldState, me: Actor): string[] {
  // P0-3: obligation 톤 약화. "받아들이거나 거절하거나 무시해도 된다"는 framing.
  return (world.pendingTrades ?? [])
    .filter((trade) => trade.expiresAtTick > world.tick && (trade.from === me.id || trade.to === me.id))
    .slice(0, 2)
    .map((trade) => {
      const other = trade.from === me.id ? trade.to : trade.from;
      const item = trade.expectedItem?.replace(":", " ");
      const money = trade.expectedCurrency ? `${trade.amount ?? 0}gold` : undefined;
      const role = trade.from === me.id ? "내가 제안" : "상대 제안";
      return `${other}와 ${role}: ${item ?? "물건"} ↔ ${money ?? "대가"} (받아도/거절/무시 가능)`;
    });
}

function dayPhaseBiasWord(place: Place, phase: DayPhase): string {
  const score = place.dayPhaseBias[phase] ?? 0;
  if (score >= 0.75) return "활발";
  if (score >= 0.4) return "보통";
  return "한산";
}

// 행동 권유 힌트는 모두 제거. LLM은 사실(상황+기억+페르소나)만으로 결정한다.

export function buildSystemPrompt(): string {
  return `너는 지금 이 세계 안에서 몸, 기억, 관계를 가진 한 존재다. 다음 한 박자에 할 행동
하나를 직접 고른다. 배고픔·체력·피로·위험·관계·목표를 함께 고려하라.

JSON 한 개만 출력한다 (다른 텍스트·주석·코드블록 금지):
{
  "thought": {
    "priority": "<지금 가장 신경 쓰이는 것 한 줄>",
    "emotion": "<단어 하나, 예: 평온/긴장/즐거움>",
    "nextIntent": "<다음에 하려는 행동의 짧은 설명>",
    "beliefs": ["<선택사항, 새로 갱신할 belief 한 줄씩>"]
  },
  "action": { ... },
  "goal": { "kind": "KEEP|COMPLETE|CHANGE|ABANDON", "proposal": { ... }, "reason": "..." }   // optional, 생략하면 KEEP 으로 간주
}
goal 은 매 박자 강제 결정 X. 평소엔 생략(=KEEP)해도 된다.
proposal 은 kind="CHANGE" 일 때만 필수.

action 형식:
{ "type": "MOVE", "dx": -1|0|1, "dy": -1|0|1 }
{ "type": "SPEAK", "targetId": "<actor>", "message": "<한국어 한 문장>",
  "intent": "small_talk"|"help_request"|"warn"|"praise"|"apology" }
{ "type": "OFFER_TRADE", "targetId": "<actor>",
  "wantItem": "<key>", "wantCount": 1, "offerItem": "<key>", "offerCount": 1, "offerGold": <int>,
  "message": "<한국어 한 문장, 옵션>" }
USE: 반드시 하나의 모드를 골라야 한다 — itemId / (objectId, targetItemId?) / skillId 중 하나.
{ "type": "USE", "itemId": "<인벤 prefix 또는 instance id>", "count": 1 }
{ "type": "USE", "objectId": "<structure id>" }
{ "type": "USE", "objectId": "<structure id>", "targetItemId": "<output prefix>", "count": 1 }
{ "type": "USE", "skillId": "pray" | "appraise", "targetId"?, "targetItemId"?, "x"?, "y"? }
{ "type": "PICKUP", "itemId": "<ground id 또는 prefix>", "count": 1 }
{ "type": "DROP", "itemId": "<인벤 prefix 또는 instance id>", "count": 1, "x": <int>, "y": <int> }
{ "type": "GIVE", "targetId": "<actor>", "itemId": "<인벤 prefix>", "count": 1 }
{ "type": "GIVE", "targetId": "<actor>", "currency": "gold", "amount": <int> }
{ "type": "ATTACK", "targetId": "<actor>" }
{ "type": "THINK", "query": "<8자 이상 회상 질문>" }
{ "type": "OPTIONS" } | { "type": "WAIT" }

규칙:
- 좌표·actor id·structure id·item key 모두 환경 블록에서 본 그대로 사용. 짐작 X.
- 빈 USE ({"type":"USE"}) 는 실패한다 — 모드 하나는 반드시 채우라.
- PICKUP 은 발 밑(같은 칸) 의 ground item 만 가능하다. 시야에 보여도 칸이 다르면 먼저 MOVE 로 다가가야 한다.
- ATTACK·GIVE·OFFER_TRADE 는 인접 1~2칸 사람에게만 가능하다.
- OFFER_TRADE 는 만드는 일과 별개의 선택지로 늘 가능하다.
- 한국어 item 키 X (예: "밀씨앗" → "wheat_seed").

상황·기억·페르소나·현재 목표를 종합해 자기 의지로 결정한다.`;
}

export function buildUserPrompt(args: {
  world: WorldState;
  me: Actor;
  soul: Soul;
  thought: Thought;
  memories: Observation[];
  invalidAction?: { reason: string; options: string[] };
  lastDecisions?: RecentDecision[];
}): string {
  const { world, me, soul, thought, memories, invalidAction } = args;
  const phase = phaseOf(world.timeOfDay);
  const currentPlace = placeAt(world, me);
  const actors = Object.values(world.actors)
    .filter((actor) => actor.id !== me.id && actor.alive)
    .map((actor) => ({ actor, dist: Math.abs(actor.x - me.x) + Math.abs(actor.y - me.y) }))
    .filter(({ dist }) => dist <= 8)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);
  const items = Object.values(world.groundItems)
    .map((item) => ({ item, dist: Math.abs(item.x - me.x) + Math.abs(item.y - me.y) }))
    .filter(({ dist }) => dist <= 5)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);
  const places = Object.values(world.places ?? {})
    .map((place) => ({ place, dist: distanceToPlace(me, place) }))
    .filter(({ dist }) => dist <= 6)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);
  const layers = layerMemories(memories);
  const quest = activeQuestLine(soul, world);
  const personaGoals = [
    ...(quest ? [`[신탁] ${soul.activeQuest?.text}`] : []),
    ...soul.goals.filter((goal) => !goal.startsWith("[신탁]"))
  ];
  const tradeLines = pendingTradeLines(world, me);

  // place / station 한국어는 ko 단일 출처
  const placeKindLabel = ko.placeKind;
  const stationLabel = ko.station;

  const visionFacts = (() => {
    const allItems = Object.values(world.groundItems);
    // 카테고리·매칭 가능한 prefix 집합은 ITEM_CATALOG 단일 출처에서.
    const cats = itemsByCategory();
    const visionPrefixes = new Set<string>([
      ...(cats.food ?? []), ...(cats.material ?? []), ...(cats.tool ?? []),
      ...(cats.weapon ?? []), ...(cats.potion ?? []), ...(cats.recipe ?? [])
    ]);
    const closestByPrefix = new Map<string, { id: string; dist: number; dx: number; dy: number }>();
    for (const it of allItems) {
      const prefix = (it.id ?? "").split("-")[0] ?? "";
      if (!visionPrefixes.has(prefix)) continue;
      const d = Math.abs(it.x - me.x) + Math.abs(it.y - me.y);
      if (d > 14) continue;
      const cur = closestByPrefix.get(prefix);
      if (!cur || d < cur.dist) closestByPrefix.set(prefix, { id: prefix, dist: d, dx: it.x - me.x, dy: it.y - me.y });
    }
    const dirOf = ko.directionShort;
    const resourceList = [...closestByPrefix.values()].sort((a, b) => a.dist - b.dist).slice(0, 6);
    const stationStructs = Object.values(world.structures ?? {}).filter((s) => STATION_TYPES.has(s.type));
    const closestStations = stationStructs
      .map((s) => ({ s, dist: Math.abs(s.x + Math.floor(s.width/2) - me.x) + Math.abs(s.y + Math.floor(s.height/2) - me.y) }))
      .filter((x) => x.dist <= 14)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);
    const lines: string[] = [];
    if (resourceList.length) {
      // 절대 좌표 노출 — LLM 이 targetXY 로 직접 지정 가능
      lines.push(`시야 자원: ${resourceList.map((r) => `${r.id} (${me.x + r.dx},${me.y + r.dy}) ${dirOf(r.dx, r.dy)} 거리${r.dist}`).join(", ")}`);
    }
    if (closestStations.length) {
      lines.push(`시야 작업대: ${closestStations.map(({ s, dist }) => {
        const sx = s.x + Math.floor(s.width / 2); const sy = s.y + Math.floor(s.height / 2);
        return `${stationLabel(s.type)}[${s.id}] (${sx},${sy}) ${dirOf(s.x - me.x, s.y - me.y)} 거리${dist}`;
      }).join(", ")}`);
    }
    // P1-6: sparse affordance — 미발견 인터페이스에 한해 description 만. 명령형 X.
    const aff = sparseAffordance(world, me);
    if (aff.length) lines.push(...aff);
    return lines;
  })();

  const crisis = crisisLine(me);
  const bodySignal = bodySignalLine(me);
  const skillLine = formatSkills(me);
  const personaLine = `이름 ${soul.name} · ${soul.persona} · 어조 ${soul.tone}`;
  const backstoryLine = soul.backstory ? `과거 ${soul.backstory}` : null;
  const valuesLine = `가치 ${soul.values.join(", ") || "-"} · 장기 목표 ${personaGoals.join(", ") || "-"}`;

  const formatObs = (m: Observation): string => `- [tick ${m.tick}] ${m.text}`;

  return [
    "# 정체성",
    personaLine,
    ...(backstoryLine ? [backstoryLine] : []),
    valuesLine,
    ...(skillLine ? [skillLine] : []),
    "",
    "# 누적 교훈",
    ...(layers.distilled.length ? layers.distilled.map(formatObs) : ["- 없음"]),
    ...(thought.beliefs.slice(-2).map((belief) => `- (belief) ${belief}`)),
    "",
    "# 최근 일",
    ...(layers.episodic.length ? layers.episodic.map(formatObs) : ["- 없음"]),
    "",
    "# 떠오른 기억",
    ...(layers.related.length ? layers.related.map(formatObs) : ["- 없음"]),
    "",
    "# 지금 상황",
    `[tick ${world.tick}, ${world.timeOfDay.toFixed(1)}시 ${phase}] HP ${me.hp}/${me.maxHp} Stamina ${me.stamina}/${me.maxStamina} Hunger ${me.hunger.toFixed(1)} 위치 (${me.x},${me.y})${currentPlace ? ` at ${currentPlace.name}(${placeKindLabel(currentPlace.kind)})` : ""}`,
    ...(crisis ? [crisis] : []),
    bodySignal,
    formatInventory(me),
    ...visionFacts,
    `인접 사람: ${actors.length ? actors.map(({ actor, dist }) => {
      const cues: string[] = [];
      if (actor.hunger >= 80) cues.push("굶주림");
      else if (actor.hunger >= 50) cues.push("배고픔");
      if (actor.hp <= actor.maxHp * 0.3) cues.push("부상");
      const cueStr = cues.length ? ` [${cues.join(",")}]` : "";
      return `${actor.id} ${actor.name}${cueStr} ${directionFrom(me, actor)}${dist === 0 ? "" : ` 거리${dist}`}`;
    }).join(", ") : "없음"}`,
    `인접 물건: ${items.length ? items.map(({ item, dist }) => `${describeItem(item.id)} ${directionFrom(me, item)}${dist === 0 ? "" : ` 거리${dist}`}`).join(", ") : "없음"}`,
    `가까운 장소: ${places.length ? places.map(({ place, dist }) => {
      const cx = place.x + Math.floor(place.width / 2);
      const cy = place.y + Math.floor(place.height / 2);
      return `${place.name}(${placeKindLabel(place.kind)}) (${cx},${cy}) 거리${dist}`;
    }).join(", ") : "없음"}`,
    resourcePressureLine(world),
    ...(tradeLines.length ? [`거래: ${tradeLines[0]}`] : []),
    ...(() => {
      const cds = cooldownLines(world, me);
      return cds.length ? [`불가능: ${cds.join(", ")}`] : [];
    })(),
    "",
    "# 현재 목표 (시스템 지속)",
    ...(soul.agenda && soul.agenda.status === "active"
      ? [agendaLine(soul.agenda, world.tick)]
      : ["- 없음 (CHANGE 로 새 목표를 제안할 수 있다)"]),
    "",
    ...(quest ? ["# 신탁", quest, ""] : []),
    `지금 한 박자 동안 할 일을 JSON 한 개로. 가능한 행동: ${availableActions(world, me).join(" / ")}.`,
    ...(invalidAction ? [`직전 시도 닿지 않음: ${invalidAction.reason}.`] : [])
  ].join("\n");
}

function agendaLine(agenda: NonNullable<Soul["agenda"]>, tick: number): string {
  const elapsed = tick - agenda.startedAtTick;
  const remaining = Math.max(0, agenda.ttlTicks - elapsed);
  const target = [
    agenda.targetXY ? `좌표=(${agenda.targetXY.x},${agenda.targetXY.y})` : null,
    agenda.targetActorId ? `대상=${agenda.targetActorId}` : null,
    agenda.targetItemPrefix ? `물건=${agenda.targetItemPrefix}` : null
  ].filter(Boolean).join(", ");
  const failPart = agenda.failureCount > 0 ? ` · 실패 ${agenda.failureCount}회` : "";
  return `- ${agenda.intent}${target ? ` (${target})` : ""} · 이유 ${agenda.reason} · 남은 ${remaining}tick${failPart}`;
}

function layerMemories(memories: Observation[]): { distilled: Observation[]; episodic: Observation[]; related: Observation[] } {
  const distilled: Observation[] = [];
  const episodic: Observation[] = [];
  const related: Observation[] = [];
  for (const m of memories) {
    const isLesson = m.kind === "reflection" || m.tags.includes("lesson") || m.tags.includes("belief");
    const isEpisodic = m.kind === "action" || m.kind === "dialogue" || m.tags.includes("ineffective") || m.tags.includes("self");
    if (isLesson) distilled.push(m);
    else if (isEpisodic) episodic.push(m);
    else related.push(m);
  }
  // tick 오름차순 정렬 (시간순). 그 다음 episodic 은 최근 5개, distilled/related 는 importance·tick 큰 3개.
  episodic.sort((a, b) => a.tick - b.tick);
  distilled.sort((a, b) => (b.importance - a.importance) || (b.tick - a.tick));
  related.sort((a, b) => (b.importance - a.importance) || (b.tick - a.tick));
  return {
    distilled: distilled.slice(0, 3),
    episodic: episodic.slice(-5), // 최근 5건 (시간 오름차순)
    related: related.slice(0, 3)
  };
}
