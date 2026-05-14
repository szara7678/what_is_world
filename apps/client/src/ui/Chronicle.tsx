import { useEffect, useMemo, useState } from "react";
import type { WorldState } from "@wiw/shared";
import { API_BASE } from "../net/endpoints";
import { adminFetch, isAdmin } from "../net/adminAuth";

type HistoryEntry = {
  tick: number;
  ts: number;
  actorId?: string;
  kind: string;
  text: string;
  meta?: Record<string, unknown>;
};

type ChroniclePage = {
  dayId: string;
  dayIndex: number;
  startTick: number;
  endTick: number;
  generatedAt: number;
  model: string;
  title: string;
  body: string;
  quotes: string[];
  milestoneCount: number;
  milestones: Array<{ tick: number; kind: string; text: string; actorId?: string }>;
};

export function Chronicle({
  world,
  onActorClick,
  limit = 30
}: {
  world: WorldState | null;
  onActorClick: (actorId: string) => void;
  limit?: number;
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [pages, setPages] = useState<ChroniclePage[]>([]);
  const [openPage, setOpenPage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const pull = () => {
      controller?.abort();
      controller = new AbortController();
      fetch(`${API_BASE}/history?limit=${limit}`, { signal: controller.signal })
        .then((res) => res.json())
        .then((json: { history: HistoryEntry[] }) => {
          if (!cancelled) setEntries(json.history ?? []);
        })
        .catch(() => {});
      fetch(`${API_BASE}/chronicle/pages`, { signal: controller.signal })
        .then((res) => res.json())
        .then((json: { pages: ChroniclePage[] }) => {
          if (!cancelled) setPages(json.pages ?? []);
        })
        .catch(() => {});
    };
    pull();
    const id = window.setInterval(pull, 7000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(id);
    };
  }, [limit]);

  const newestFirstPages = useMemo(() => [...pages].sort((a, b) => b.dayIndex - a.dayIndex), [pages]);
  const newestFirst = useMemo(() => [...entries].reverse(), [entries]);

  const regenerate = async () => {
    if (!isAdmin()) return;
    try {
      await adminFetch(`${API_BASE}/chronicle/regenerate`, { method: "POST" });
    } catch {}
  };

  if (newestFirstPages.length === 0 && newestFirst.length === 0) {
    return (
      <div>
        <div className="empty">No big events to chronicle yet.</div>
        {isAdmin() && <button className="ghost-btn" style={{ marginTop: 8 }} onClick={regenerate}>Try a page from collected events</button>}
      </div>
    );
  }

  return (
    <div className="chronicle-list">
      {newestFirstPages.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: "var(--text3)" }}>📓 LLM journal ({newestFirstPages.length})</span>
            {isAdmin() && <button className="ghost-btn" style={{ fontSize: 10, padding: "2px 6px" }} onClick={regenerate}>Regenerate</button>}
          </div>
          {newestFirstPages.map((p) => {
            const open = openPage === p.dayId;
            return (
              <div key={p.dayId} className="chronicle-page" style={{
                background: "var(--card)", border: "1px solid var(--border)",
                borderRadius: 8, padding: 10, marginBottom: 8
              }}>
                <button
                  type="button"
                  onClick={() => setOpenPage(open ? null : p.dayId)}
                  style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: 0 }}
                >
                  <div style={{ fontSize: 11, color: "var(--text3)" }}>Day {p.dayIndex} · {p.model} · {p.milestoneCount} events</div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{p.title}</div>
                </button>
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--text)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                  {p.body}
                </div>
                {p.quotes.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "var(--text2)", borderLeft: "2px solid var(--accent)", paddingLeft: 6 }}>
                    {p.quotes.map((q, i) => <div key={i}>"{q}"</div>)}
                  </div>
                )}
                {open && p.milestones.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 10, color: "var(--text3)" }}>
                    <div style={{ marginBottom: 4 }}>Events of the day</div>
                    {p.milestones.map((m, i) => (
                      <div key={i}>· tick {m.tick} {m.kind}{m.actorId ? ` (${world?.actors[m.actorId]?.name ?? m.actorId})` : ""}: {m.text}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {newestFirst.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6 }}>📜 history milestones (raw)</div>
          {newestFirst.map((entry, index) => {
            const actor = entry.actorId ? world?.actors[entry.actorId] : undefined;
            const actorName = actor?.name ?? entry.actorId;
            const canFocus = Boolean(entry.actorId && world?.actors[entry.actorId]);
            const text = actorName && entry.text.startsWith(actorName)
              ? entry.text.slice(actorName.length).trimStart()
              : entry.text;
            return (
              <button
                key={`${entry.ts}-${entry.kind}-${index}`}
                className="chronicle-item"
                type="button"
                disabled={!canFocus}
                onClick={() => entry.actorId && onActorClick(entry.actorId)}
              >
                <span className="chronicle-icon">{kindIcon(entry.kind)}</span>
                <span className="chronicle-main">
                  <span className="chronicle-meta">
                    {formatWorldTime(entry.tick)} · {entry.kind}
                  </span>
                  <span className="chronicle-text">
                    {actorName ? <strong>{actorName}</strong> : null}
                    {actorName ? " " : ""}
                    {text}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatWorldTime(tick: number): string {
  const day = Math.floor(tick / 2400) + 1;
  const hourFloat = (tick % 2400) / 100;
  const hour = Math.floor(hourFloat);
  const minute = Math.floor((hourFloat % 1) * 60);
  return `Day ${day} · ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function kindIcon(kind: string): string {
  if (kind.includes("skill")) return "✦";
  if (kind.includes("relationship")) return "♡";
  if (kind.includes("gift")) return "◇";
  if (kind.includes("harvest")) return "☘";
  if (kind.includes("combat") || kind.includes("death")) return "!";
  if (kind.includes("oracle")) return "※";
  if (kind.includes("memory")) return "◌";
  if (kind.includes("day")) return "☼";
  return "•";
}
