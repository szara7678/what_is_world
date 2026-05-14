const loc = typeof window !== "undefined" ? window.location : null;

const envApi = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL;
const envWs  = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WS_URL;

const sameOrigin = loc && loc.hostname !== "localhost" && loc.hostname !== "127.0.0.1";
const PATH_PREFIX = sameOrigin ? "/wiw" : "";

export const API_BASE: string = envApi
  ?? (sameOrigin ? `${loc!.protocol}//${loc!.host}${PATH_PREFIX}` : "http://localhost:3011");

// 2026-05-11: localhost 도 같은 포트 3011 (colyseus attached to same port). 직전 fallback 2568 은 stale.
export const WS_URL: string = envWs
  ?? (sameOrigin
        ? `${loc!.protocol === "https:" ? "wss" : "ws"}://${loc!.host}${PATH_PREFIX}`
        : "ws://localhost:3011");
