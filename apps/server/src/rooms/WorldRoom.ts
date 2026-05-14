import { Room, type Client } from "@colyseus/core";
import type { ClientToServerMessage, RawEvent, WorldState } from "@wiw/shared";
import { createWorldState, dispatchAction, dispatchEdit } from "@wiw/world-core";
import { appendRawEvent } from "../logging/eventLogStore";
import { getWorld, setWorld } from "../state/worldStore";

const ADMIN_TOKEN = (process.env.WIW_ADMIN_TOKEN ?? "").trim();

export class WorldRoom extends Room<WorldState> {
  private timer?: NodeJS.Timeout;

  override onAuth(_client: Client, options: { token?: string } = {}): { isAdmin: boolean } {
    const presented = (options.token ?? "").trim();
    return { isAdmin: !ADMIN_TOKEN || presented === ADMIN_TOKEN };
  }

  override onCreate(): void {
    this.setState(getWorld() ?? createWorldState());

    this.onMessage("msg", async (client, message: ClientToServerMessage) => {
      const isAdmin = (client.userData as { isAdmin?: boolean } | undefined)?.isAdmin === true;
      if ((message.kind === "action" || message.kind === "edit") && !isAdmin) {
        client.send("result", { ok: false, message: "admin_token_required" });
        return;
      }
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
      } else if (message.kind === "edit") {
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

    // Force fresh setState every tick so Colyseus serializes plain-object diffs to clients.
    // (Reference compare missed in-place mutations from server-side tickWorld in main.ts.)
    this.timer = setInterval(() => {
      this.setState(structuredClone(getWorld()));
      this.broadcastPatch();
    }, 100);
  }

  override onDispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async log(event: RawEvent): Promise<void> {
    await appendRawEvent(event);
  }
}
