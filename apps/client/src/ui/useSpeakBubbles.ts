import { useEffect, useRef, useState } from "react";
import type { RawEvent } from "@wiw/shared";
import type { SpeechBubbleMap } from "../game/startGame";
import { API_BASE } from "../net/endpoints";

type SpeakActionPayload = {
  actorId?: unknown;
  action?: {
    type?: unknown;
    message?: unknown;
  };
};

const BUBBLE_MS = 4000;

const asPayload = (value: unknown): SpeakActionPayload => {
  if (value && typeof value === "object") return value as SpeakActionPayload;
  return {};
};

const extractSpeak = (raw: RawEvent): { actorId: string; text: string } | null => {
  const payload = asPayload(raw.payload);
  const actionType = typeof payload.action?.type === "string" ? payload.action.type : "";
  const isSpeak = actionType === "SPEAK" || (raw.category === "action" && raw.type.startsWith("SPEAK"));
  if (!isSpeak) return null;

  const actorId = typeof payload.actorId === "string" ? payload.actorId : raw.actorId;
  const message = typeof payload.action?.message === "string"
    ? payload.action.message
    : raw.type.replace(/^SPEAK:?\s*/i, "");
  return { actorId, text: message.trim() || "…" };
};

export function useSpeakBubbles(): SpeechBubbleMap {
  const [bubbles, setBubbles] = useState<SpeechBubbleMap>({});
  const timers = useRef<Record<string, number>>({});

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/events/tail`);
    es.addEventListener("raw", (event) => {
      try {
        const raw = JSON.parse((event as MessageEvent).data) as RawEvent;
        const speak = extractSpeak(raw);
        if (!speak) return;

        const until = Date.now() + BUBBLE_MS;
        window.clearTimeout(timers.current[speak.actorId]);
        setBubbles((prev) => ({
          ...prev,
          [speak.actorId]: { text: speak.text, until },
        }));
        timers.current[speak.actorId] = window.setTimeout(() => {
          setBubbles((prev) => {
            if (prev[speak.actorId]?.until !== until) return prev;
            const next = { ...prev };
            delete next[speak.actorId];
            return next;
          });
          delete timers.current[speak.actorId];
        }, BUBBLE_MS);
      } catch {}
    });
    es.onerror = () => { /* browser will retry */ };

    return () => {
      es.close();
      for (const timer of Object.values(timers.current)) window.clearTimeout(timer);
      timers.current = {};
    };
  }, []);

  return bubbles;
}
