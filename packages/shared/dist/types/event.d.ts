export type RawEvent = {
    tick: number;
    timestamp: number;
    actorId: string;
    category: "action" | "edit";
    type: string;
    result: "success" | "failed";
    reason?: string;
    payload: unknown;
};
