import type { Observation, Soul } from "@wiw/shared";
import { appendObservation } from "../persistence/soulStore";

type SeedTemplate = {
  text: string;
  tags: string[];
  importance: number;
  ageTicks: number;
};

/**
 * 시드 메모리: 절차형 ("X→Y로 해결") 표현 금지. 세계 정서/장소성/감각만.
 * NPC 가 자기답게 자연스럽게 발견하도록. 행동 매핑은 LLM 결정에 맡김 (강제 X 자연 진화).
 */
const COMMON: SeedTemplate[] = [
  { text: "이 마을 사람들은 곤란에 처한 이웃을 그냥 지나치지 않는 편이었다.", tags: ["seed", "social"], importance: 0.45, ageTicks: 5000 },
  { text: "한 번 거절당했어도 다른 사람에게 다시 말을 거는 게 자연스럽던 시절이 있었다.", tags: ["seed", "social"], importance: 0.4, ageTicks: 7200 },
  { text: "혼자 들판을 거닐다 손에 묻은 흙냄새가 오래 남았던 기억이 있다.", tags: ["seed", "place", "field"], importance: 0.35, ageTicks: 6000 },
  { text: "큰 발걸음 소리에 한 발 물러서서 살아남은 적이 있다.", tags: ["seed", "danger"], importance: 0.45, ageTicks: 8400 },
  { text: "잠시 멈추면 다음 결심이 더 분명해지곤 했다.", tags: ["seed", "rest"], importance: 0.35, ageTicks: 9000 }
];

/**
 * role-specific seed: 직업·작업 절차 X. 그 사람이 가까이 두던 장소·감각·생활 결만.
 */
const BY_ROLE: Record<string, SeedTemplate[]> = {
  baker: [
    { text: "햇살 빵집 오븐에서 새벽마다 따뜻한 냄새가 퍼지던 게 손에 익어 있다.", tags: ["seed", "place", "oven"], importance: 0.55, ageTicks: 3500 },
    { text: "텃밭 흙 위에 풀잎 떨어지는 소리가 빵집 안에서도 들리던 날들이 있었다.", tags: ["seed", "place"], importance: 0.45, ageTicks: 4800 },
    { text: "낯선 손님이 처음 빵집에 들어왔을 때의 어색하고도 따뜻한 짧은 인사가 떠오른다.", tags: ["seed", "social"], importance: 0.4, ageTicks: 5600 }
  ],
  merchant: [
    { text: "잡화점 안 작은 병들 사이에서는 마른 풀과 산열매 냄새가 섞여 있었다.", tags: ["seed", "place", "alchemy_table"], importance: 0.55, ageTicks: 3800 },
    { text: "물건을 줄 맞춰 놓은 다음에야 손님과 시선이 마주치던 습관이 있었다.", tags: ["seed", "place", "trade"], importance: 0.45, ageTicks: 4800 },
    { text: "거래가 깨진 자리에 잠깐 머물다가 다른 길로 발을 옮기는 게 익숙했다.", tags: ["seed", "social"], importance: 0.4, ageTicks: 6000 }
  ],
  farmer: [
    { text: "이른 아침 텃밭에 내려앉은 이슬을 먼저 알아차리던 게 일상이었다.", tags: ["seed", "place", "field"], importance: 0.55, ageTicks: 3700 },
    { text: "흙냄새와 바람결로 계절이 바뀌는 걸 손끝으로 알 수 있었다.", tags: ["seed", "place"], importance: 0.45, ageTicks: 5000 },
    { text: "비 오는 날 처마 밑에서 잠시 쉬는 것도 하루의 일이었다.", tags: ["seed", "rest"], importance: 0.35, ageTicks: 7000 }
  ],
  guard: [
    { text: "광산 입구의 차가운 공기와 대장간 쇳소리가 함께 머물던 자리에 익숙하다.", tags: ["seed", "place", "forge", "mine"], importance: 0.55, ageTicks: 3900 },
    { text: "위험을 먼저 본 사람이 다른 이를 부르던 밤이 있었다.", tags: ["seed", "danger", "social"], importance: 0.5, ageTicks: 4800 },
    { text: "무리한 다음 날의 욱신거림은 오래 기억에 남았다.", tags: ["seed", "fatigue"], importance: 0.45, ageTicks: 6500 }
  ],
  hero: [
    { text: "여행길에 작업대 위 나뭇결을 손으로 더듬으며 시간을 보낸 적이 있다.", tags: ["seed", "place", "workbench"], importance: 0.5, ageTicks: 4000 },
    { text: "낯선 마을의 첫 미소를 잊지 못하는 편이다.", tags: ["seed", "social"], importance: 0.45, ageTicks: 6000 },
    { text: "위험 앞에서 자세를 낮추는 법을 길에서 배웠다.", tags: ["seed", "danger"], importance: 0.45, ageTicks: 7000 },
    { text: "주머니가 가벼울 때보다 무거울 때 마음이 더 단단해지지 않는다는 걸 안다.", tags: ["seed", "values"], importance: 0.4, ageTicks: 8000 }
  ],
  wanderer: [
    { text: "낯선 마을에 들어설 때 가장 먼저 들리는 소리에 귀를 기울이는 버릇이 있다.", tags: ["seed", "place"], importance: 0.4, ageTicks: 6000 },
    { text: "들에서 바람결만 따라 걸어도 하루가 흐르던 시절이 있었다.", tags: ["seed", "place"], importance: 0.4, ageTicks: 7000 }
  ]
};

const idGen = (prefix: string): string => `obs_seed_${prefix}_${Math.random().toString(36).slice(2, 8)}`;

export async function seedBootstrapMemories(actorId: string, soul: Soul, currentTick: number): Promise<void> {
  const role = (soul.role ?? "wanderer").toLowerCase();
  const templates = [
    ...(BY_ROLE[role] ?? BY_ROLE.wanderer),
    ...COMMON.slice(0, 4)
  ];
  for (const t of templates) {
    const obs: Observation = {
      id: idGen(role),
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
