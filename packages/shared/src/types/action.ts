export type MoveAction = { type: "MOVE"; dx: number; dy: number };
export type AttackAction = { type: "ATTACK"; targetId: string };
export type SpeakAction = { type: "SPEAK"; message: string };
export type UseAction = { type: "USE"; itemId?: string; targetId?: string };

export type ActionRequest = {
  actorId: string;
  action: MoveAction | AttackAction | SpeakAction | UseAction;
};
