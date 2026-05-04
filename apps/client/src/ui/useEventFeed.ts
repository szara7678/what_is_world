import { useEffect, useState } from "react";
import type { NarrativeEvent } from "@wiw/shared";
import { API_BASE } from "../net/endpoints";

export function useEventFeed(limit = 80): NarrativeEvent[] {
  const [events, setEvents] = useState<NarrativeEvent[]>([]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/events?limit=${limit}`);
        const json = await res.json() as { narratives: NarrativeEvent[] };
        if (!cancel) setEvents(json.narratives.slice(-limit).map(normalizeNarrative));
      } catch {}
    })();

    const es = new EventSource(`${API_BASE}/events/tail`);
    es.addEventListener("narrative", (e) => {
      try {
        const n = JSON.parse((e as MessageEvent).data) as NarrativeEvent;
        setEvents((prev) => [...prev.slice(-(limit - 1)), normalizeNarrative(n)]);
      } catch {}
    });
    es.onerror = () => { /* browser will retry */ };

    return () => {
      cancel = true;
      es.close();
    };
  }, [limit]);

  return events;
}

function normalizeNarrative(n: NarrativeEvent): NarrativeEvent {
  const actorId = n.raw?.actorId ?? n.actorIds[0];
  if (!n.actorName || !actorId) return n;
  return {
    ...n,
    text: n.text.replaceAll(actorId, n.actorName)
  };
}
