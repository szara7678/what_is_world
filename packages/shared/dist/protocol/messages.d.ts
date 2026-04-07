import type { ActionRequest } from "../types/action";
import type { EditCommand } from "../types/edit";
export type ClientToServerMessage = {
    kind: "action";
    payload: ActionRequest;
} | {
    kind: "edit";
    payload: EditCommand;
} | {
    kind: "select";
    payload: {
        entityId?: string;
        x?: number;
        y?: number;
    };
};
