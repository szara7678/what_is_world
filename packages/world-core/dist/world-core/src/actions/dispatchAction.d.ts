import type { ActionRequest, WorldState } from "@wiw/shared";
type ActionResult = {
    ok: boolean;
    message: string;
};
export declare const dispatchAction: (world: WorldState, request: ActionRequest) => ActionResult;
export {};
