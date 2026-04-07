import type { LayerName } from "./world";

export type EditCommand =
  | { type: "PLACE_TILE"; layer: LayerName; x: number; y: number; tileId: number }
  | { type: "ERASE_TILE"; layer: LayerName; x: number; y: number }
  | {
      type: "PLACE_STRUCTURE";
      structureType: string;
      assetKey?: string;
      x: number;
      y: number;
      width: number;
      height: number;
      props?: Record<string, unknown>;
    }
  | { type: "MOVE_STRUCTURE"; structureId: string; x: number; y: number }
  | { type: "REMOVE_STRUCTURE"; structureId: string }
  | { type: "UPDATE_STRUCTURE_PROPERTY"; structureId: string; key: string; value: unknown };
