const loc = typeof window !== "undefined" ? window.location : null;

const envApi = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL;
const envWs  = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WS_URL;

const sameOrigin = loc && loc.hostname !== "localhost" && loc.hostname !== "127.0.0.1";

export const API_BASE: string = envApi
  ?? (sameOrigin ? `${loc!.protocol}//${loc!.host}` : "http://localhost:3001");

export const WS_URL: string = envWs
  ?? (sameOrigin
        ? `${loc!.protocol === "https:" ? "wss" : "ws"}://${loc!.host}`
        : "ws://localhost:2567");
