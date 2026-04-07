import { Room } from "@colyseus/core";
import { createWorldState, dispatchAction, dispatchEdit, tickWorld } from "@wiw/world-core";
import { appendRawEvent } from "../logging/eventLogStore";
import { getWorld, setWorld } from "../state/worldStore";
export class WorldRoom extends Room {
    timer;
    onCreate() {
        this.setState(getWorld() ?? createWorldState());
        this.onMessage("msg", async (client, message) => {
            if (message.kind === "action") {
                const result = dispatchAction(this.state, message.payload);
                setWorld(this.state);
                await this.log({
                    tick: this.state.tick,
                    timestamp: Date.now(),
                    actorId: message.payload.actorId,
                    category: "action",
                    type: message.payload.action.type,
                    result: result.ok ? "success" : "failed",
                    reason: result.ok ? undefined : result.message,
                    payload: message.payload
                });
                client.send("result", result);
            }
            else if (message.kind === "edit") {
                const result = dispatchEdit(this.state, message.payload);
                setWorld(this.state);
                await this.log({
                    tick: this.state.tick,
                    timestamp: Date.now(),
                    actorId: client.sessionId,
                    category: "edit",
                    type: message.payload.type,
                    result: result.ok ? "success" : "failed",
                    reason: result.ok ? undefined : result.message,
                    payload: message.payload
                });
                client.send("result", result);
            }
        });
        this.timer = setInterval(() => {
            tickWorld(this.state);
            setWorld(this.state);
            this.broadcastPatch();
        }, 100);
    }
    onDispose() {
        if (this.timer)
            clearInterval(this.timer);
    }
    async log(event) {
        await appendRawEvent(event);
    }
}
