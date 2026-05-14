import { useCallback, useEffect, useRef, useState } from "react";
import type { Actor, Observation, Soul, Thought, WorldState } from "@wiw/shared";
import { ko } from "@wiw/shared";
import { startGame, type GameBridge } from "../game/startGame";
import { joinWorld } from "../net/room";
import { API_BASE } from "../net/endpoints";
import { useEventFeed } from "./useEventFeed";
import { useObservations } from "./useObservations";
import { useSpeakBubbles } from "./useSpeakBubbles";
import { SettingsModal } from "./SettingsModal";
import { AdminLoginModal } from "./AdminLoginModal";
import { NpcProfileCard } from "./NpcProfileCard";
import { Chronicle } from "./Chronicle";
import { adminFetch, isAdmin, subscribeAdminToken } from "../net/adminAuth";

type BrainStatus = "off" | "mock" | "openrouter" | "local-proxy";
type IntentMap = Record<string, { intent: string; emotion: string }>;

export function ObservatoryShell({ onSwitchMode }: { onSwitchMode: () => void }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const bridgeRef = useRef<GameBridge | null>(null);
  const [world, setWorld] = useState<WorldState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [soul, setSoul] = useState<Soul | null>(null);
  const [thought, setThought] = useState<Thought | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [profileFor, setProfileFor] = useState<{ id: string; name: string } | null>(null);
  const [adminMode, setAdminMode] = useState<boolean>(() => isAdmin());
  useEffect(() => subscribeAdminToken(() => setAdminMode(isAdmin())), []);
  const [brainStatus, setBrainStatus] = useState<BrainStatus>("off");
  const [intentMap, setIntentMap] = useState<IntentMap>({});
  const [feedTab, setFeedTab] = useState<"chronicle" | "today">("today");
  const [showMonsters, setShowMonsters] = useState(false);
  const [showSystemSteps, setShowSystemSteps] = useState(false);
  type ViewMode = "default" | "expand-feed" | "expand-inspector" | "expand-residents";
  const [viewMode, setViewMode] = useState<ViewMode>("default");
  const [feedHeight, setFeedHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const root = document.querySelector(".obs-root") as HTMLElement | null;
    const feedEl = root?.querySelector(".obs-feed") as HTMLElement | null;
    const h0 = feedEl?.getBoundingClientRect().height ?? 180;
    dragRef.current = { startY: e.clientY, startH: h0 };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY; // 위로 끌면 높이↑
    const next = Math.max(80, Math.min(window.innerHeight - 200, dragRef.current.startH + dy));
    setFeedHeight(next);
  };
  const onDragEnd = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
  };
  type MobileTab = "story" | "stage" | "residents" | "inspector";
  const [mobileTab, setMobileTab] = useState<MobileTab>("stage");
  const [isMobile, setIsMobile] = useState<boolean>(typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  const events = useEventFeed(120);
  const speakBubbles = useSpeakBubbles();

  // Connect + stage. Colyseus join is kept for action dispatch (sendMessage),
  // but we authoritatively pull world state from REST every 400ms because
  // Colyseus 0.16 with plain-object state does not broadcast diffs.
  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;
    (async () => {
      try { await joinWorld(); } catch {}
      if (cancelled) return;
      const stage = stageRef.current;
      if (stage) {
        bridgeRef.current = startGame(stage);
        bridgeRef.current.setMode("PLAY");
      }
      const pull = async () => {
        try {
          const r = await fetch(`${API_BASE}/world`);
          const w = await r.json();
          if (cancelled) return;
          setWorld(w);
          bridgeRef.current?.updateWorld(w);
        } catch {}
      };
      void pull();
      pollTimer = window.setInterval(pull, 400);
    })();
    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      bridgeRef.current?.destroy();
    };
  }, []);

  // Load brain status
  useEffect(() => {
    const pull = () => fetch(`${API_BASE}/config/brain`)
      .then((r) => r.json())
      .then((j: { config: { provider: Exclude<BrainStatus, "off">; enabled: boolean } }) => {
        if (!j.config.enabled) setBrainStatus("off");
        else setBrainStatus(j.config.provider);
      })
      .catch(() => {});
    pull();
    const id = setInterval(pull, 5000);
    return () => clearInterval(id);
  }, [showSettings]);

  // Load actor intent bubbles
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const pull = () => {
      controller?.abort();
      controller = new AbortController();
      fetch(`${API_BASE}/thoughts/summary`, { signal: controller.signal })
        .then((r) => r.json())
        .then((j: { intents: Record<string, { intent: string; emotion: string; updatedAtTick: number }> }) => {
          if (cancelled) return;
          const next = Object.fromEntries(
            Object.entries(j.intents).map(([actorId, summary]) => [
              actorId,
              { intent: summary.intent, emotion: summary.emotion }
            ])
          );
          setIntentMap(next);
          bridgeRef.current?.updateIntents(next);
        })
        .catch(() => {});
    };
    pull();
    const id = setInterval(pull, 1000);
    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    bridgeRef.current?.updateIntents(intentMap);
  }, [intentMap]);

  useEffect(() => {
    bridgeRef.current?.updateBubbles(speakBubbles);
  }, [speakBubbles]);

  // Load soul / thought for selected
  useEffect(() => {
    if (!selectedId) { setSoul(null); setThought(null); return; }
    fetch(`${API_BASE}/souls/${selectedId}`).then((r) => r.json()).then((j: { soul: Soul }) => setSoul(j.soul)).catch(() => setSoul(null));
    fetch(`${API_BASE}/thoughts/${selectedId}`).then((r) => r.json()).then((j: { thought: Thought }) => setThought(j.thought)).catch(() => setThought(null));
  }, [selectedId]);

  // 2026-05-09: monster (deer/boar/wolf 등 무지성 동물) 은 Residents 목록에서 제외 — humanoid + player 만 표기.
  const actors: Actor[] = world ? Object.values(world.actors).filter((a) => a.kind !== "monster") : [];
  const selected = selectedId ? actors.find((a) => a.id === selectedId) : undefined;
  const todHours = world ? world.timeOfDay : 0;

  const dayPhase = useCallback((h: number) => {
    if (h < 5)  return { icon: "🌙", label: "night" };
    if (h < 7)  return { icon: "🌅", label: "dawn" };
    if (h < 11) return { icon: "🌞", label: "morning" };
    if (h < 15) return { icon: "☀️", label: "day" };
    if (h < 18) return { icon: "🌤️", label: "afternoon" };
    if (h < 21) return { icon: "🌇", label: "evening" };
    return { icon: "🌙", label: "night" };
  }, []);

  const phase = dayPhase(todHours);
  const dayN = world ? Math.floor(world.tick / 2400) + 1 : 1;
  // Residents 카드 클릭 = 선택만. 카메라 Move은 별도 "보기" 버튼.
  const selectResident = useCallback((actorId: string) => {
    const next = actorId === selectedId ? null : actorId;
    setSelectedId(next);
  }, [selectedId]);
  const focusResident = useCallback((actorId: string) => {
    bridgeRef.current?.focusActor(actorId);
  }, []);

  const rootClasses = ["obs-root"];
  if (!isMobile && viewMode !== "default") rootClasses.push(viewMode);
  if (isMobile) rootClasses.push(`mobile-tab-${mobileTab}`);
  const rootStyle: React.CSSProperties | undefined = !isMobile && feedHeight && viewMode === "default"
    ? { gridTemplateRows: `56px 1fr ${feedHeight}px` }
    : undefined;

  // 모바일 Residents 카드 탭 시 inspector tab 으로 전환 (sheet 형태)
  const selectResidentMobile = useCallback((id: string) => {
    selectResident(id);
    if (isMobile) setMobileTab("inspector");
  }, [selectResident, isMobile]);

  return (
    <div className={rootClasses.join(" ")} style={rootStyle}>
      <div className="obs-top">
        <div className="obs-brand">🌼 what is world{!isMobile && <span className="sub">cozy observatory</span>}</div>
        {!isMobile && (
          <div className="obs-time">
            {phase.icon} Day {dayN} · {phase.label} {String(Math.floor(todHours)).padStart(2, "0")}:{String(Math.floor((todHours % 1) * 60)).padStart(2, "0")}
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {!isMobile && (
            <div className="viewmode-seg" title="Panel view mode">
              <button className={viewMode === "default" ? "active" : ""} onClick={() => setViewMode("default")}>Default</button>
              <button className={viewMode === "expand-feed" ? "active" : ""} onClick={() => setViewMode("expand-feed")}>Expand feed</button>
              <button className={viewMode === "expand-inspector" ? "active" : ""} onClick={() => setViewMode("expand-inspector")}>Inspector</button>
              <button className={viewMode === "expand-residents" ? "active" : ""} onClick={() => setViewMode("expand-residents")}>Residents</button>
            </div>
          )}
          <BrainBadge status={brainStatus} disabled={!adminMode} onToggle={() => {
            if (!adminMode) { setShowLogin(true); return; }
            const next = brainStatus === "off";
            adminFetch(`${API_BASE}/config/brain`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: next })
            }).then((r) => r.json()).then((j: { config: { provider: Exclude<BrainStatus, "off">; enabled: boolean } }) => {
              if (!j.config.enabled) setBrainStatus("off");
              else setBrainStatus(j.config.provider);
            }).catch(() => {});
          }} />
          {!isMobile && adminMode && (
            <div className="mode-seg">
              <button className="active">Observe</button>
              <button onClick={onSwitchMode}>Edit</button>
            </div>
          )}
          <button
            className="icon-btn"
            onClick={() => (adminMode ? setShowSettings(true) : setShowLogin(true))}
            title={adminMode ? "Settings" : "Admin login"}
          >{adminMode ? "⚙️" : "🔐"}</button>
        </div>
      </div>

      <div className="obs-left">
        <h4 style={{ margin: "4px 6px 8px", fontSize: 11, letterSpacing: ".08em", color: "var(--text3)" }}>Residents ({actors.length})</h4>
        {actors.length === 0 && <div className="empty">No residents yet.</div>}
        {actors.map((a) => (
          <ResidentCard
            key={a.id}
            actor={a}
            selected={a.id === selectedId}
            onClick={() => selectResidentMobile(a.id)}
            onFocus={() => focusResident(a.id)}
            onProfile={() => setProfileFor({ id: a.id, name: displayActorName(a) })}
          />
        ))}
      </div>

      <div
        className="obs-stage"
        ref={stageRef}
        onClick={isMobile && mobileTab !== "stage" ? () => setMobileTab("stage") : undefined}
      />

      <div className="obs-right">
        {!selected && <div className="empty">Pick a resident on the left.</div>}
        {selected && (
          <AgentDetail
            actor={selected}
            soul={soul}
            thought={thought}
            onSoulUpdate={(s) => setSoul(s)}
            selectedId={selectedId}
            adminMode={adminMode}
            onRequestLogin={() => setShowLogin(true)}
          />
        )}
      </div>

      <div className="obs-feed">
        {!isMobile && (
          <div
            className="feed-drag-handle"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onDoubleClick={() => setFeedHeight(null)}
            title="Drag to resize (double-click = default)"
          >
            <span className="grip" />
          </div>
        )}
        <div className="feed">
          <div className="feed-head">
            <div className="mode-seg">
              <button className={feedTab === "chronicle" ? "active" : ""} onClick={() => setFeedTab("chronicle")}>Chronicle</button>
              <button className={feedTab === "today" ? "active" : ""} onClick={() => setFeedTab("today")}>Today's stories</button>
            </div>
            <span style={{ color: "var(--text3)", fontSize: 11 }}>
              {feedTab === "today" ? `${events.length} events` : "history.ndjson"}
            </span>
            {!isMobile && (
              <button
                className="icon-btn"
                style={{ marginLeft: "auto", fontSize: 14 }}
                title={viewMode === "expand-feed" ? "Restore default height" : "Expand feed panel"}
                onClick={() => setViewMode(viewMode === "expand-feed" ? "default" : "expand-feed")}
              >{viewMode === "expand-feed" ? "⤓" : "⤒"}</button>
            )}
          </div>
          {feedTab === "chronicle" && (
            <Chronicle world={world} onActorClick={selectResident} />
          )}
          {feedTab === "today" && (
            <>
              <div style={{ display: "flex", gap: 8, padding: "4px 6px", fontSize: 10, color: "var(--text3)" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input type="checkbox" checked={showMonsters} onChange={(e) => setShowMonsters(e.target.checked)} />
                  Monsters & animals
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input type="checkbox" checked={showSystemSteps} onChange={(e) => setShowSystemSteps(e.target.checked)} />
                  Verbose (system steps · MOVE · WAIT · failures)
                </label>
              </div>
              {(() => {
                const QUIET_TYPES = new Set([
                  "SYSTEM_SKIP", "AGENDA_PATH_FAIL", "WAIT", "wait", "MOVE", "move",
                  "blocked_tile", "blocked_actor", "target_dead_or_missing", "target_not_found",
                  "path_unreachable", "out_of_bounds", "stuck"
                ]);
                const QUIET_REASON_RE = /^(blocked_|target_|path_|out_of_bounds|stuck|no_path|use_target_required|item_not_in_inventory|trade_not_found|cooldown)/;
                const filtered = events.filter((n) => {
                  const a = n.raw?.actorId ?? n.actorIds[0] ?? "";
                  if (!showMonsters && a.startsWith("monster-")) return false;
                  if (!showSystemSteps) {
                    if (n.raw?.payload && (n.raw.payload as { provider?: string }).provider === "system") return false;
                    const rt = n.raw?.type ?? "";
                    if (QUIET_TYPES.has(rt)) return false;
                    if (n.raw?.result === "failed" && QUIET_REASON_RE.test(n.raw.reason ?? "")) return false;
                  }
                  return true;
                });
                if (filtered.length === 0) return <div className="empty">Nothing has happened yet.</div>;
                return filtered.slice(-60).reverse().map((n) => (
                  <div key={n.id} className={`feed-item tone-${n.tone}`}>
                    <span className="feed-icon">{n.icon}</span>
                    <span className="feed-text">{n.text}</span>
                    <span className="feed-time">tick {n.tick}</span>
                  </div>
                ));
              })()}
            </>
          )}
        </div>
      </div>

      {isMobile && (
        <div className="obs-tabbar">
          <button className={mobileTab === "story" ? "active" : ""} onClick={() => setMobileTab("story")}>
            <span className="tab-icon">💬</span><span className="tab-label">Story</span>
          </button>
          <button className={mobileTab === "stage" ? "active" : ""} onClick={() => setMobileTab("stage")}>
            <span className="tab-icon">🗺️</span><span className="tab-label">Map</span>
          </button>
          <button className={mobileTab === "residents" ? "active" : ""} onClick={() => setMobileTab("residents")}>
            <span className="tab-icon">👥</span><span className="tab-label">Residents</span>
          </button>
          <button className={mobileTab === "inspector" ? "active" : ""} onClick={() => setMobileTab("inspector")}>
            <span className="tab-icon">📖</span><span className="tab-label">Status</span>
          </button>
        </div>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showLogin && <AdminLoginModal onClose={() => setShowLogin(false)} />}
      {profileFor && (
        <NpcProfileCard
          actorId={profileFor.id}
          actorName={profileFor.name}
          onClose={() => setProfileFor(null)}
        />
      )}
    </div>
  );
}

function BrainBadge({ status, onToggle, disabled }: { status: BrainStatus; onToggle?: () => void; disabled?: boolean }) {
  const map: Record<string, { dot: string; label: string; color: string }> = {
    off:              { dot: "",   label: "Brain off",     color: "var(--text3)" },
    mock:             { dot: "ok", label: "Mock brain",     color: "var(--accent3)" },
    openrouter:       { dot: "ok", label: "OpenRouter",   color: "var(--accent)" },
    "local-proxy":    { dot: "ok", label: "Local proxy",     color: "var(--accent)" },
    "chatgpt-direct": { dot: "ok", label: "ChatGPT direct",  color: "var(--accent)" }
  };
  const m = map[status] ?? { dot: "", label: status, color: "var(--text3)" };
  if (onToggle) {
    return (
      <button
        onClick={onToggle}
        title={disabled ? "Admin login required" : status === "off" ? "Brain off — click to turn on" : "Brain on — click to turn off"}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, color: m.color, fontSize: 12, background: "transparent", border: "1px solid var(--border)", borderRadius: 5, padding: "4px 8px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}
      >
        <span className={`status-dot ${m.dot}`} /> {m.label}
      </button>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: m.color, fontSize: 12 }}>
      <span className={`status-dot ${m.dot}`} /> {m.label}
    </span>
  );
}

function ResidentCard({ actor, selected, onClick, onFocus, onProfile }: { actor: Actor; selected: boolean; onClick: () => void; onFocus?: () => void; onProfile?: () => void }) {
  const hpPct = actor.maxHp > 0 ? (actor.hp / actor.maxHp) * 100 : 0;
  const stPct = actor.maxStamina > 0 ? (actor.stamina / actor.maxStamina) * 100 : 0;
  const hgPct = Math.min(100, actor.hunger);
  const mood = hpPct < 25 ? "😣" : hgPct > 70 ? "😩" : stPct < 20 ? "😴" : "🙂";
  const hpColor = hpPct > 50 ? "var(--accent3)" : hpPct > 25 ? "var(--accent4)" : "var(--stop)";
  const cardTone = !actor.alive ? "dead" : hpPct < 25 ? "critical" : "healthy";
  return (
    <div className={`rcard ${cardTone}${selected ? " selected" : ""}`} onClick={onClick}>
      <div className="rcard-avatar" aria-hidden="true">
        <span>{iconForActor(actor)}</span>
      </div>
      <div className="rcard-main">
        <div className="rcard-head">
          <span className="rcard-name">{displayActorName(actor)}</span>
          {onProfile && (
            <button
              type="button"
              className="rcard-focus-btn"
              title="View profile"
              onClick={(e) => { e.stopPropagation(); onProfile(); }}
              style={{ marginRight: 4 }}
            >ⓘ</button>
          )}
          {onFocus && (
            <button
              type="button"
              className="rcard-focus-btn"
              title="Move camera to this resident"
              onClick={(e) => { e.stopPropagation(); onFocus(); }}
            >🎯</button>
          )}
        </div>
        <div className="rcard-meta">
          <span>{mood}</span>
          <span>({actor.x}, {actor.y})</span>
        </div>
        <Meter label="HP" pct={hpPct} color={hpColor} />
        <Meter label="STM" pct={stPct} color="var(--accent4)" />
        <Meter label="HGR" pct={hgPct} color={hgPct > 70 ? "var(--pause)" : "var(--text3)"} />
      </div>
    </div>
  );
}

function Meter({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="rcard-bar-row">
      <span className="lbl">{label}</span>
      <div className="rcard-bar"><div style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}

// 2026-05-09: 몬스터 표시명 — assetKey/name 에서 종 이름만 추출 (Wolf/Boar/Bear/Deer/Slime/Spirit), tier 면 prefix.
export function displayActorName(actor: Actor): string {
  if (actor.kind !== "monster") return actor.name;
  const ak = (actor.assetKey ?? "").toLowerCase();
  let species = "";
  for (const k of ["boar","wolf","bear","deer","slime","spirit"]) if (ak.includes(k)) { species = k.charAt(0).toUpperCase() + k.slice(1); break; }
  if (!species) species = "Beast";
  const tier = ak.includes(".dire") ? "Dire " : ak.includes(".alpha") ? "Alpha " : "";
  return `${tier}${species}`;
}

function roleForActor(actor: Actor): "hero" | "baker" | "farmer" | "merchant" | "guard" | "monster" | "villager" {
  const key = `${actor.assetKey ?? ""} ${actor.name}`.toLowerCase();
  if (actor.kind === "monster") return "monster";
  if (actor.kind === "player") return "hero";
  if (key.includes("baker")) return "baker";
  if (key.includes("farmer") || key.includes("villager")) return "farmer";
  if (key.includes("merchant") || key.includes("yui")) return "merchant";
  if (key.includes("guard") || key.includes("jin")) return "guard";
  return "villager";
}

function roleLabel(role: ReturnType<typeof roleForActor>): string {
  switch (role) {
    case "hero": return "hero";
    case "baker": return "baker";
    case "farmer": return "farmer";
    case "merchant": return "merchant";
    case "guard": return "guard";
    case "monster": return "boar";
    default: return "npc";
  }
}

function iconForActor(actor: Actor): string {
  if (actor.kind === "player") return "👤";
  if (actor.kind === "monster") return "🐗";
  return "🧑‍🌾";
}

function AgentDetail({ actor, soul, thought, onSoulUpdate, selectedId, adminMode, onRequestLogin }: {
  actor: Actor;
  soul: Soul | null;
  thought: Thought | null;
  onSoulUpdate: (s: Soul) => void;
  selectedId: string | null;
  adminMode: boolean;
  onRequestLogin: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Soul | null>(null);
  const [tab, setTab] = useState<"now" | "memories">("now");
  const obs = useObservations(selectedId, 60);

  const [speakDraft, setSpeakDraft] = useState("");
  const [speakStatus, setSpeakStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [oracleDraft, setOracleDraft] = useState("");
  const [oracleStatus, setOracleStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const sendSpeak = async () => {
    const text = speakDraft.trim();
    if (!text || !selectedId) return;
    setSpeakStatus("sending");
    try {
      await adminFetch(`${API_BASE}/agent/${selectedId}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, from: "visitor" })
      });
      setSpeakDraft("");
      setSpeakStatus("sent");
      window.setTimeout(() => setSpeakStatus("idle"), 1400);
    } catch {
      setSpeakStatus("idle");
    }
  };
  const toggleFollower = async (next: boolean) => {
    if (!selectedId) return;
    const url = next ? `${API_BASE}/agent/${selectedId}/follow` : `${API_BASE}/agent/${selectedId}/unfollow`;
    const r = await adminFetch(url, { method: "POST" });
    const j = await r.json() as { soul?: Soul };
    if (j.soul) onSoulUpdate(j.soul);
  };
  const sendOracle = async () => {
    const text = oracleDraft.trim();
    if (!text || !selectedId) return;
    setOracleStatus("sending");
    try {
      const r = await adminFetch(`${API_BASE}/agent/${selectedId}/oracle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text })
      });
      const j = await r.json() as { ok: boolean; soul?: Soul };
      if (!j.ok) { setOracleStatus("error"); window.setTimeout(() => setOracleStatus("idle"), 2000); return; }
      if (j.soul) onSoulUpdate(j.soul);
      setOracleDraft("");
      setOracleStatus("sent");
      window.setTimeout(() => setOracleStatus("idle"), 1600);
    } catch {
      setOracleStatus("error");
      window.setTimeout(() => setOracleStatus("idle"), 2000);
    }
  };

  const startEdit = () => { if (soul) { setDraft({ ...soul }); setEditing(true); } };
  const saveEdit = async () => {
    if (!draft) return;
    const r = await adminFetch(`${API_BASE}/souls/${actor.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft)
    });
    const j = await r.json() as { soul: Soul };
    onSoulUpdate(j.soul);
    setEditing(false);
  };

  return (
    <>
      <div className="acard">
        <h4>Current soul</h4>
        <p style={{ fontWeight: 600, fontSize: 15 }}>{displayActorName(actor)}</p>
        <div className="meta">{actor.kind} · ({actor.x}, {actor.y})</div>
        <div className="mode-seg" style={{ marginTop: 10 }}>
          <button className={tab === "now" ? "active" : ""} onClick={() => setTab("now")}>Now</button>
          <button className={tab === "memories" ? "active" : ""} onClick={() => setTab("memories")}>Recent memories</button>
        </div>
      </div>

      <div className="acard">
        <h4>Current action</h4>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text2)" }}>
          {currentActionLines(actor).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>

      {tab === "memories" && (
        <div className="acard">
          <h4>Recent memories ({obs.length})</h4>
          <div className="meta" style={{ marginBottom: 6 }}>top = newest, bottom = older</div>
          {obs.length === 0 && <div className="empty">No memories collected yet.</div>}
          <ul className="memories">
            {obs.slice().sort((a, b) => (b.tick - a.tick) || (b.timestamp - a.timestamp)).map((o) => (
              <li key={o.id} className={`mem kind-${o.kind}`}>
                <span className="mem-icon">{memIcon(o.kind)}</span>
                <span className="mem-text">{o.text}</span>
                <span className="mem-tick">tick {o.tick}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "now" && soul && !editing && (
        <div className="acard">
          <h4>Story (soul)</h4>
          <p>{soul.backstory}</p>
          <div className="meta" style={{ marginTop: 8 }}>Persona: {soul.persona}</div>
          <div className="meta">Tone: {soul.tone}</div>
          {soul.goals.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>Today's goals</div>
              <ul>{soul.goals.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </>
          )}
          {adminMode && <button className="ghost-btn" style={{ marginTop: 10 }} onClick={startEdit}>Edit soul</button>}
        </div>
      )}

      {tab === "now" && adminMode && editing && draft && (
        <div className="acard">
          <h4>Edit soul</h4>
          <div className="form-row">
            <label>Backstory</label>
            <textarea rows={3} value={draft.backstory} onChange={(e) => setDraft({ ...draft, backstory: e.target.value })} />
          </div>
          <div className="form-row">
            <label>Persona</label>
            <input value={draft.persona} onChange={(e) => setDraft({ ...draft, persona: e.target.value })} />
          </div>
          <div className="form-row">
            <label>Tone</label>
            <input value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value })} />
          </div>
          <div className="form-row">
            <label>Goals (comma-separated)</label>
            <input
              value={draft.goals.join(", ")}
              onChange={(e) => setDraft({ ...draft, goals: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="ghost-btn" onClick={() => setEditing(false)}>Cancel</button>
            <button className="primary-btn" onClick={saveEdit}>Save</button>
          </div>
        </div>
      )}

      {tab === "now" && thought && (
        <div className="acard">
          <h4>Today's thoughts</h4>
          <p>{thought.priority}</p>
          <div className="meta">Mood: {thought.emotion} · Next action: {thought.nextIntent}</div>
          {thought.beliefs.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>Current beliefs</div>
              <ul>{thought.beliefs.slice(-5).map((b, i) => <li key={i}>{b}</li>)}</ul>
            </>
          )}
          {thought.recentEvents.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>Recent observations</div>
              <ul>{thought.recentEvents.slice(-5).map((e, i) => <li key={i}>{e}</li>)}</ul>
            </>
          )}
        </div>
      )}

      {!adminMode && actor.kind !== "monster" && actor.alive && (
        <div className="acard" style={{ opacity: 0.7 }}>
          <div className="meta" style={{ fontSize: 12 }}>
            🔐 Resident interaction (talk to, oracle, disciple) is operator-only.
            <button className="ghost-btn" style={{ marginLeft: 8 }} onClick={onRequestLogin}>Admin login</button>
          </div>
        </div>
      )}

      {adminMode && actor.kind !== "monster" && actor.alive && (
        <>
          <div className="acard" style={{ borderColor: soul?.isFollower ? "#d97a4b" : undefined, borderWidth: soul?.isFollower ? 2 : 1, borderStyle: "solid" }}>
            <h4 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {soul?.isFollower ? "⚡" : "✨"} Appoint disciple
              {soul?.isFollower && <span style={{ fontSize: 11, color: "var(--accent)", marginLeft: "auto" }}>faith {(soul.faith ?? 0).toFixed(2)}</span>}
            </h4>
            <p className="meta" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {soul?.isFollower
                ? `${actor.name} is your disciple. They follow oracles with absolute priority.`
                : `${actor.name}Appointing them as disciple makes your oracles directly shape ${actor.name}'s actions, memories, and faith.`}
            </p>
            <button
              className={soul?.isFollower ? "ghost-btn" : "primary-btn"}
              style={{ marginTop: 8 }}
              onClick={() => void toggleFollower(!soul?.isFollower)}
            >
              {soul?.isFollower ? "Remove disciple" : "Appoint as disciple"}
            </button>
          </div>

          {soul?.isFollower && (
            <div className="acard" style={{ background: "linear-gradient(180deg, rgba(217,122,75,0.06), transparent)" }}>
              <h4>⚡ {actor.name} — issue oracle</h4>
              <textarea
                rows={2}
                value={oracleDraft}
                onChange={(e) => setOracleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void sendOracle(); }
                }}
                placeholder={`Write the divine voice. ${actor.name} will follow immediately.`}
                style={{
                  width: "100%", boxSizing: "border-box", padding: 8,
                  border: "1px solid var(--accent)", borderRadius: 8,
                  fontSize: 12, fontFamily: "inherit", background: "var(--surface)",
                  color: "var(--ink)", resize: "vertical"
                }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                <span className="meta" style={{ fontSize: 11, color: oracleStatus === "error" ? "var(--stop)" : "var(--text3)" }}>
                  {oracleStatus === "sending" ? "Oracle descending..."
                    : oracleStatus === "sent" ? "✨ Oracle inscribed on the soul."
                    : oracleStatus === "error" ? "Delivery failed"
                    : "Cmd/Ctrl + Enter to send oracle"}
                </span>
                <button
                  className="primary-btn"
                  disabled={!oracleDraft.trim() || oracleStatus === "sending"}
                  onClick={() => void sendOracle()}
                >
                  ⚡ Oracle
                </button>
              </div>
            </div>
          )}

          <div className="acard">
            <h4>💬 {actor.name} — talk to</h4>
            <textarea
              rows={2}
              value={speakDraft}
              onChange={(e) => setSpeakDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void sendSpeak(); }
              }}
              placeholder={soul?.isFollower
                ? `Casual talk, not as strong as an oracle.`
                : `${actor.name} will consider this in their next beat.`}
              style={{
                width: "100%", boxSizing: "border-box", padding: 8,
                border: "1px solid var(--line)", borderRadius: 8,
                fontSize: 12, fontFamily: "inherit", background: "var(--surface)",
                color: "var(--ink)", resize: "vertical"
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
              <span className="meta" style={{ fontSize: 11 }}>
                {speakStatus === "sending" ? "Sending..." : speakStatus === "sent" ? "Delivered." : "Cmd/Ctrl + Enter to send"}
              </span>
              <button
                className="primary-btn"
                disabled={!speakDraft.trim() || speakStatus !== "idle"}
                onClick={() => void sendSpeak()}
              >
                Send
              </button>
            </div>
          </div>
        </>
      )}

      <div className="acard">
        <h4>Status</h4>
        <Bar label="HP" cur={actor.hp} max={actor.maxHp} color="#3fb950" />
        <Bar label="MP" cur={actor.mp} max={actor.maxMp} color="#58a6ff" />
        <Bar label="STM" cur={actor.stamina} max={actor.maxStamina} color="#d29922" />
        <Bar label="HGR" cur={actor.hunger} max={100} color="#e94560" reverse />
        <div className="meta" style={{ marginTop: 4 }}>💰 {actor.gold} gold</div>
      </div>

      <div className="acard">
        <h4>Stats</h4>
        {(() => {
          const s = actor.status;
          if (!s) return <div className="meta">—</div>;
          return (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <div className="meta">STR {s.strength}</div>
              <div className="meta">DEX {s.dexterity}</div>
              <div className="meta">CON {s.constitution}</div>
              <div className="meta">INT {s.intelligence}</div>
            </div>
          );
        })()}
      </div>

      <div className="acard">
        <h4>Skills ({(actor.skills ?? []).length})</h4>
        {(actor.skills ?? []).length === 0 && <div className="meta">—</div>}
        {(actor.skills ?? []).map((sk) => {
          const TH = [0, 10, 30, 80, 200, 500, 1200, 3000, 7000, 15000, 30000];
          const xp = sk.xp ?? 0;
          const prev = TH[sk.level] ?? 0;
          const next = TH[Math.min(sk.level + 1, TH.length - 1)];
          const pct = next > prev ? Math.max(0, Math.min(100, ((xp - prev) / (next - prev)) * 100)) : 0;
          return (
            <div key={sk.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 0" }} title={sk.description}>
              <span style={{ minWidth: 64 }}>{sk.name}</span>
              <div style={{ flex: 1, height: 5, background: "var(--surface3)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: sk.level > 0 ? "var(--accent3)" : "var(--text3)" }} />
              </div>
              <span style={{ fontSize: 10, color: "var(--text3)", minWidth: 70, textAlign: "right" }}>lv{sk.level} {xp}/{next}</span>
            </div>
          );
        })}
      </div>

      <div className="acard">
        <h4>Inventory ({actor.inventory.length})</h4>
        {actor.inventory.length === 0 ? (
          <div className="meta">empty</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {(() => {
              const counts = new Map<string, number>();
              for (const slot of actor.inventory) {
                counts.set(slot.item, (counts.get(slot.item) ?? 0) + (slot.kind === "stack" ? slot.count : 1));
              }
              return [...counts.entries()].map(([key, n]) => (
                <span key={key} style={{ fontSize: 11, padding: "3px 8px", background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 4 }} title={`${key} × ${n}`}>
                  {ko.items(key)}{n > 1 ? ` × ${n}` : ""}
                </span>
              ));
            })()}
          </div>
        )}
      </div>
    </>
  );
}

function Bar({ label, cur, max, color, reverse }: { label: string; cur: number; max: number; color: string; reverse?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
  const bar = reverse ? pct : pct;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "2px 0" }}>
      <span style={{ minWidth: 32, color: "var(--text2)" }}>{label}</span>
      <div style={{ flex: 1, height: 6, background: "var(--surface3)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${bar}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontSize: 10, color: "var(--text3)", minWidth: 50, textAlign: "right" }}>{Math.round(cur)}/{max}</span>
    </div>
  );
}

function currentActionLines(actor: Actor): string[] {
  if (actor.attackTargetId) {
    const since = actor.attackStartedAtTick === undefined ? "" : ` since t${actor.attackStartedAtTick}`;
    return [`ATTACK -> ${actor.attackTargetId}${since}`, `until: ${actor.attackUntil?.map((u) => u.kind).join(", ") ?? "default"}`];
  }
  if (actor.gatherIntent) {
    const g = actor.gatherIntent;
    const scope = g.area?.placeId ? ` @${g.area.placeId}` : g.area?.radius ? ` radius ${g.area.radius}` : "";
    return [`GATHER ${g.item} ${g.collected}/${g.count}${scope}`];
  }
  if (actor.movePath?.length) {
    const target = actor.movePathTarget ? ` -> (${actor.movePathTarget.x}, ${actor.movePathTarget.y})` : "";
    return [`MOVE${target}`, `${actor.movePath.length} step${actor.movePath.length === 1 ? "" : "s"} remaining`];
  }
  return ["idle"];
}

function memIcon(kind: Observation["kind"]): string {
  switch (kind) {
    case "perceive":   return "👁";
    case "action":     return "🚶";
    case "dialogue":   return "💬";
    case "reflection": return "🪞";
    case "memory":     return "📎";
    default:           return "·";
  }
}
