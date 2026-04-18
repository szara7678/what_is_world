export type RawEvent = {
  tick: number;
  timestamp: number;
  actorId: string;
  category: "action" | "edit" | "world" | "brain";
  type: string;
  result: "success" | "failed" | "info";
  reason?: string;
  payload: unknown;
};

export type NarrativeEvent = {
  id: string;
  tick: number;
  timestamp: number;
  icon: string;
  text: string;
  tone: "calm" | "warn" | "danger" | "warm" | "cool";
  actorIds: string[];
  raw?: RawEvent;
};
