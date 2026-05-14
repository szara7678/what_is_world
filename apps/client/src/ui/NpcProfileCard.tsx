import { useEffect, useState } from "react";
import type { Actor, Observation, Soul, Thought } from "@wiw/shared";
import { API_BASE } from "../net/endpoints";

type Snapshot = {
  actor: Actor;
  soul: Soul | null;
  thought: Thought | null;
  recentObservations: Observation[];
  topRelationships: Array<{ from: string; to: string; affinity: number; trust?: number }>;
};

export function NpcProfileCard({ actorId, actorName, onClose }: { actorId: string; actorName: string; onClose: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/agent/${actorId}/snapshot`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Snapshot>;
      })
      .then(setSnap)
      .catch((e) => { if (e.name !== "AbortError") setErr(String(e)); });
    return () => controller.abort();
  }, [actorId]);

  const goals = snap?.soul?.goals?.slice(0, 3) ?? [];
  const beliefs = snap?.thought?.beliefs?.slice(-2) ?? [];
  const memories = (snap?.recentObservations ?? []).slice(-3).reverse();
  const rels = snap?.topRelationships ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 4 }}>{actorName}</h2>
        {snap && snap.actor && (
          <div className="sub">
            {snap.actor.alive ? "Alive" : "Resting"} · HP {snap.actor.hp}/{snap.actor.maxHp} · ({snap.actor.x}, {snap.actor.y})
          </div>
        )}
        {err && <div className="empty">Failed: {err}</div>}
        {!snap && !err && <div className="empty">Loading...</div>}

        {snap?.soul && (
          <div className="acard" style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>About</div>
            <p style={{ marginTop: 4 }}>{snap.soul.backstory}</p>
            <div className="meta">Persona: {snap.soul.persona}</div>
            <div className="meta">Tone: {snap.soul.tone}</div>
          </div>
        )}

        {goals.length > 0 && (
          <div className="acard">
            <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>What they want today</div>
            <ul style={{ marginTop: 4 }}>
              {goals.map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          </div>
        )}

        {snap?.thought && (
          <div className="acard">
            <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>Right now</div>
            <p>{snap.thought.priority}</p>
            <div className="meta">Mood: {snap.thought.emotion} · Next: {snap.thought.nextIntent}</div>
            {beliefs.length > 0 && <ul style={{ marginTop: 4 }}>{beliefs.map((b, i) => <li key={i}>{b}</li>)}</ul>}
          </div>
        )}

        {rels.length > 0 && (
          <div className="acard">
            <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>Closest bonds</div>
            <ul style={{ marginTop: 4 }}>
              {rels.map((r, i) => {
                const other = r.from === actorId ? r.to : r.from;
                const symbol = r.affinity > 0 ? "💛" : r.affinity < 0 ? "⚡" : "·";
                return <li key={i}>{symbol} {other} (affinity {Math.round(r.affinity)})</li>;
              })}
            </ul>
          </div>
        )}

        {memories.length > 0 && (
          <div className="acard">
            <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>Recent moments</div>
            <ul style={{ marginTop: 4 }}>
              {memories.map((m) => <li key={m.id}>{m.text}</li>)}
            </ul>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button className="ghost-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
