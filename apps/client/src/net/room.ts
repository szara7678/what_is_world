import { Client, type Room } from "colyseus.js";
import type { ClientToServerMessage, WorldState } from "@wiw/shared";
import { WS_URL } from "./endpoints";

const client = new Client(WS_URL);
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
