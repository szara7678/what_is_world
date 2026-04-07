import type { EditCommand, WorldState } from "@wiw/shared";
type EditResult = {
    ok: boolean;
    message: string;
};
export declare const dispatchEdit: (world: WorldState, cmd: EditCommand) => EditResult;
export {};
