import { Client, type Room } from "colyseus.js";
import type { ClientToServerMessage, WorldState } from "@wiw/shared";

const client = new Client("ws://localhost:2567");
let roomRef: Room<WorldState> | null = null;

export const joinWorld = async (): Promise<Room<WorldState>> => {
  if (roomRef) return roomRef;
  roomRef = await client.joinOrCreate<WorldState>("world");
  return roomRef;
};

export const sendMessage = (msg: ClientToServerMessage): void => {
  if (!roomRef) return;
  roomRef.send("msg", msg);
};
