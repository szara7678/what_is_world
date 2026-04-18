import type { Actor, Soul, Thought, WorldState, Observation } from "@wiw/shared";

export interface BrainAction {
  type: "MOVE" | "ATTACK" | "SPEAK" | "USE" | "WAIT";
  dx?: number;
  dy?: number;
  targetId?: string;
  message?: string;
  itemId?: string;
}

export interface BrainDecision {
  thought: {
    priority: string;
    emotion: string;
    nextIntent: string;
    beliefs: string[];
    recentEvents: string[];
  };
  action: BrainAction;
}

const CARDINAL_HINTS = [
  { dx: 0,  dy: -1, name: "북(위)" },
  { dx: 0,  dy:  1, name: "남(아래)" },
  { dx: -1, dy: 0,  name: "서(왼쪽)" },
  { dx: 1,  dy: 0,  name: "동(오른쪽)" },
];

export function buildSystemPrompt(): string {
  return [
    "너는 작은 픽셀 마을에 사는 주민의 생각을 대변하는 서술자야.",
    "아래의 '지금' 정보를 보고 이 주민이 다음 한 박자(~5초) 동안 무엇을 할지를 결정해줘.",
    "출력은 반드시 **JSON 한 개**만. 바깥에 설명을 붙이지 마.",
    "",
    "JSON 스키마:",
    "{",
    '  "thought": { "priority": "짧은 한국어 문장", "emotion": "평온|즐거움|경계|두려움|피곤함 중 하나", "nextIntent": "의도 요약 한 문장", "beliefs": ["0~3개의 짧은 믿음 문장"], "recentEvents": ["이번 박자에 관찰한 것 0~3개"] },',
    '  "action": { "type": "MOVE"|"ATTACK"|"SPEAK"|"USE"|"WAIT",',
    '              "dx": -1|0|1, "dy": -1|0|1,  (MOVE에서 사용, 합이 0이면 안 됨)',
    '              "targetId": "id",           (ATTACK/USE)',
    '              "message": "한국어 짧은 한 문장" (SPEAK) }',
    "}",
    "",
    "규칙:",
    "- 한 박자에 한 칸만 움직일 수 있음 (dx,dy는 -1/0/1).",
    "- 주변에 누가 있고, 배고픈지 지친지 확인해.",
    "- 주민이 주인공 NPC면 폭력보다 대화/이동/쉼 우선.",
    "- 몬스터(kind=monster)는 배고프거나 적대적이면 ATTACK 가능.",
    "- 확신 없으면 WAIT 하고 priority에 이유를 적어.",
  ].join("\n");
}

export function buildUserPrompt(args: {
  world: WorldState;
  me: Actor;
  soul: Soul;
  thought: Thought;
  memories: Observation[];
}): string {
  const { world, me, soul, thought, memories } = args;
  const neighbors = Object.values(world.actors)
    .filter((a) => a.id !== me.id && a.alive)
    .map((a) => ({ id: a.id, name: a.name, kind: a.kind, x: a.x, y: a.y, dist: Math.abs(a.x - me.x) + Math.abs(a.y - me.y) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);

  const nearbyItems = Object.values(world.groundItems)
    .map((g) => ({ id: g.id, type: g.type, x: g.x, y: g.y, dist: Math.abs(g.x - me.x) + Math.abs(g.y - me.y) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3);

  const moveOptions = CARDINAL_HINTS.map((c) => {
    const nx = me.x + c.dx;
    const ny = me.y + c.dy;
    const outOfBounds = nx < 0 || ny < 0 || nx >= world.map.width || ny >= world.map.height;
    const blocked = !outOfBounds && world.map.collision[ny]?.[nx] === 1;
    return `${c.name} (dx=${c.dx},dy=${c.dy}): ${outOfBounds ? "맵 바깥" : blocked ? "막힘" : "갈 수 있음"}`;
  }).join("\n");

  const recentMem = memories.slice(-8).map((m) => `- [tick ${m.tick}] (${m.kind}) ${m.text}`).join("\n") || "- 아직 기억 없음.";

  return [
    `# 영혼 (변하지 않는 뼈대)`,
    `이름: ${soul.name}`,
    `배경: ${soul.backstory}`,
    `성격: ${soul.persona}`,
    `어조: ${soul.tone}`,
    `가치: ${soul.values.join(", ") || "-"}`,
    `목표: ${soul.goals.join(", ") || "-"}`,
    ``,
    `# 직전 생각`,
    `우선순위: ${thought.priority}`,
    `기분: ${thought.emotion}`,
    `의도: ${thought.nextIntent}`,
    `최근 믿음: ${thought.beliefs.slice(-3).join(" / ") || "-"}`,
    ``,
    `# 지금 (tick ${world.tick}, 시간 ${world.timeOfDay.toFixed(1)}시)`,
    `내 상태: kind=${me.kind}, 위치=(${me.x},${me.y}), HP=${me.hp}/${me.maxHp}, Stamina=${me.stamina}/${me.maxStamina}, Hunger=${me.hunger}`,
    ``,
    `# 주변 주민`,
    neighbors.length ? neighbors.map((n) => `- ${n.name} (id=${n.id}, kind=${n.kind}) at (${n.x},${n.y}), 거리=${n.dist}`).join("\n") : "- 주변에 아무도 없음.",
    ``,
    `# 주변 물건`,
    nearbyItems.length ? nearbyItems.map((g) => `- ${g.type} (id=${g.id}) at (${g.x},${g.y}), 거리=${g.dist}`).join("\n") : "- 주변에 물건 없음.",
    ``,
    `# 이동 가능성`,
    moveOptions,
    ``,
    `# 최근 기억`,
    recentMem,
    ``,
    `지금 이 주민이 다음 한 박자 동안 할 일을 JSON 한 개로 답해.`
  ].join("\n");
}
