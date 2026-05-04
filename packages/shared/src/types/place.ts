export type PlaceKind = "plaza" | "well" | "shop" | "home" | "field" | "forest_edge" | "road" | "tavern" | "shrine" | "mine" | "pond" | "noticeboard";

export type PlaceAction = "WAIT" | "SPEAK" | "USE" | "WORK" | "REST" | "BUY" | "SELL" | "PRAY";

export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  x: number;
  y: number;
  width: number;
  height: number;
  allowedActions: PlaceAction[];
  socialWeight: number;
  dayPhaseBias: {
    morning: number;
    day: number;
    evening: number;
    night: number;
  };
  tags: string[];
}
