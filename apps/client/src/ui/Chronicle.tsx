import { useEffect, useMemo, useState } from "react";
import type { WorldState } from "@wiw/shared";
import { API_BASE } from "../net/endpoints";
import { adminFetch, isAdmin } from "../net/adminAuth";

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
  kind?: "day" | "week" | "month";
};

export function Chronicle({
  world,
  onActorClick: _onActorClick,
  limit: _limit = 30
}: {
  world: WorldState | null;
  onActorClick?: (actorId: string) => void;
  limit?: number;
}) {
  const [pages, setPages] = useState<ChroniclePage[]>([]);
  const [openPage, setOpenPage] = useState<string | null>(null);
  const [tab, setTab] = useState<"day" | "week" | "month">("day");
  const [dayFilter, setDayFilter] = useState<string>(""); // "" = all
  const [rollupBusy, setRollupBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const pull = () => {
      controller?.abort();
      controller = new AbortController();
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
  }, []);

  const allSorted = useMemo(() => [...pages].sort((a, b) => b.dayIndex - a.dayIndex), [pages]);
  const filteredPages = useMemo(() => {
    return allSorted.filter((p) => {
      const k = p.kind ?? "day";
      if (k !== tab) return false;
      if (tab === "day" && dayFilter.trim()) {
        const n = parseInt(dayFilter, 10);
        if (Number.isFinite(n) && p.dayIndex !== n) return false;
      }
      return true;
    });
  }, [allSorted, tab, dayFilter]);

  const regenerate = async () => {
    if (!isAdmin()) return;
    try {
      await adminFetch(`${API_BASE}/chronicle/regenerate`, { method: "POST" });
    } catch {}
  };

  const rollup = async (kind: "week" | "month") => {
    if (!isAdmin()) return;
    // pick the next un-generated index — count existing rollups + 1
    const existing = allSorted.filter((p) => p.kind === kind).map((p) => p.dayIndex);
    const dailyCount = allSorted.filter((p) => (p.kind ?? "day") === "day").length;
    const maxIndex = kind === "week" ? Math.ceil(dailyCount / 7) : Math.ceil(dailyCount / 30);
    const next = Math.max(1, Math.min(maxIndex, (existing[0] ?? 0) + 1));
    setRollupBusy(true);
    try {
      await adminFetch(`${API_BASE}/chronicle/rollup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, index: next })
      });
    } catch {} finally { setRollupBusy(false); }
  };

  return (
    <div className="chronicle-list">
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {(["day", "week", "month"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={tab === k ? "active" : ""}
            onClick={() => setTab(k)}
            style={{ fontSize: 11, padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 5, background: tab === k ? "var(--accent)" : "transparent", color: tab === k ? "white" : "inherit", cursor: "pointer" }}
          >
            {k === "day" ? "Daily" : k === "week" ? "Weekly" : "Monthly"} ({allSorted.filter((p) => (p.kind ?? "day") === k).length})
          </button>
        ))}
        {tab === "day" && (
          <input
            type="text"
            placeholder="Day #"
            value={dayFilter}
            onChange={(e) => setDayFilter(e.target.value)}
            style={{ marginLeft: "auto", fontSize: 11, padding: "3px 6px", width: 60, border: "1px solid var(--border)", borderRadius: 5 }}
          />
        )}
        {tab !== "day" && isAdmin() && (
          <button
            type="button"
            disabled={rollupBusy}
            onClick={() => rollup(tab)}
            style={{ marginLeft: "auto", fontSize: 10, padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", cursor: "pointer" }}
          >
            {rollupBusy ? "..." : `+ ${tab === "week" ? "Week" : "Month"}`}
          </button>
        )}
      </div>

      {filteredPages.length === 0 ? (
        <div>
          <div className="empty">No {tab} pages yet.</div>
          {isAdmin() && tab === "day" && <button className="ghost-btn" style={{ marginTop: 8 }} onClick={regenerate}>Generate from collected events</button>}
        </div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          {filteredPages.map((p) => {
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
                  <div style={{ fontSize: 11, color: "var(--text3)" }}>{(p.kind ?? "day") === "week" ? `Week ${p.dayIndex}` : (p.kind ?? "day") === "month" ? `Month ${p.dayIndex}` : `Day ${p.dayIndex}`} · {p.model} · {p.milestoneCount} events</div>
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
    </div>
  );
}
