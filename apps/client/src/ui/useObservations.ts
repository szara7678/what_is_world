import { useEffect, useState } from "react";
import type { Observation } from "@wiw/shared";
import { API_BASE } from "../net/endpoints";

export function useObservations(actorId: string | null, limit = 60): Observation[] {
  const [obs, setObs] = useState<Observation[]>([]);

  useEffect(() => {
    if (!actorId) { setObs([]); return; }
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/observations/${actorId}`);
        const j = await r.json() as { observations: Observation[] };
        if (!cancel) setObs(j.observations.slice(-limit));
      } catch {}
    })();

    const es = new EventSource(`${API_BASE}/events/tail`);
    es.addEventListener("observation", (e) => {
      try {
        const o = JSON.parse((e as MessageEvent).data) as Observation;
        if (o.actorId !== actorId) return;
        setObs((prev) => [...prev.slice(-(limit - 1)), o]);
      } catch {}
    });
    es.onerror = () => { /* retry by browser */ };

    return () => { cancel = true; es.close(); };
  }, [actorId, limit]);

  return obs;
}
