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
        if (!cancel) setEvents(json.narratives.slice(-limit));
      } catch {}
    })();

    const es = new EventSource(`${API_BASE}/events/tail`);
    es.addEventListener("narrative", (e) => {
      try {
        const n = JSON.parse((e as MessageEvent).data) as NarrativeEvent;
        setEvents((prev) => [...prev.slice(-(limit - 1)), n]);
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
