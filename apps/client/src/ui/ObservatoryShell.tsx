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
import { Chronicle } from "./Chronicle";

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

  const actors: Actor[] = world ? Object.values(world.actors) : [];
  const selected = selectedId ? actors.find((a) => a.id === selectedId) : undefined;
  const todHours = world ? world.timeOfDay : 0;

  const dayPhase = useCallback((h: number) => {
    if (h < 5)  return { icon: "🌙", label: "밤" };
    if (h < 7)  return { icon: "🌅", label: "새벽" };
    if (h < 11) return { icon: "🌞", label: "아침" };
    if (h < 15) return { icon: "☀️", label: "낮" };
    if (h < 18) return { icon: "🌤️", label: "오후" };
    if (h < 21) return { icon: "🌇", label: "저녁" };
    return { icon: "🌙", label: "밤" };
  }, []);

  const phase = dayPhase(todHours);
  const dayN = world ? Math.floor(world.tick / 2400) + 1 : 1;
  // 주민 카드 클릭 = 선택만. 카메라 이동은 별도 "보기" 버튼.
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

  // 모바일 주민 카드 탭 시 inspector tab 으로 전환 (sheet 형태)
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
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
          {!isMobile && (
            <div className="viewmode-seg" title="패널 보기 모드">
              <button className={viewMode === "default" ? "active" : ""} onClick={() => setViewMode("default")}>기본</button>
              <button className={viewMode === "expand-feed" ? "active" : ""} onClick={() => setViewMode("expand-feed")}>이야기 확장</button>
              <button className={viewMode === "expand-inspector" ? "active" : ""} onClick={() => setViewMode("expand-inspector")}>인스펙터</button>
              <button className={viewMode === "expand-residents" ? "active" : ""} onClick={() => setViewMode("expand-residents")}>주민</button>
            </div>
          )}
          <BrainBadge status={brainStatus} />
          {!isMobile && (
            <div className="mode-seg">
              <button className="active">관측</button>
              <button onClick={onSwitchMode}>편집</button>
            </div>
          )}
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="설정">⚙️</button>
        </div>
      </div>

      <div className="obs-left">
        <h4 style={{ margin: "4px 6px 8px", fontSize: 11, letterSpacing: ".08em", color: "var(--text3)" }}>주민 ({actors.length})</h4>
        {actors.length === 0 && <div className="empty">주민이 아직 없어요.</div>}
        {actors.map((a) => (
          <ResidentCard
            key={a.id}
            actor={a}
            selected={a.id === selectedId}
            onClick={() => selectResidentMobile(a.id)}
            onFocus={() => focusResident(a.id)}
          />
        ))}
      </div>

      <div
        className="obs-stage"
        ref={stageRef}
        onClick={isMobile && mobileTab !== "stage" ? () => setMobileTab("stage") : undefined}
      />

      <div className="obs-right">
        {!selected && <div className="empty">왼쪽에서 주민을 골라보세요.</div>}
        {selected && (
          <AgentDetail
            actor={selected}
            soul={soul}
            thought={thought}
            onSoulUpdate={(s) => setSoul(s)}
            selectedId={selectedId}
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
            title="드래그로 높이 조절 (더블클릭 = 기본)"
          >
            <span className="grip" />
          </div>
        )}
        <div className="feed">
          <div className="feed-head">
            <div className="mode-seg">
              <button className={feedTab === "chronicle" ? "active" : ""} onClick={() => setFeedTab("chronicle")}>연대기</button>
              <button className={feedTab === "today" ? "active" : ""} onClick={() => setFeedTab("today")}>오늘의 이야기</button>
            </div>
            <span style={{ color: "var(--text3)", fontSize: 11 }}>
              {feedTab === "today" ? `${events.length}건` : "history.ndjson"}
            </span>
            {!isMobile && (
              <button
                className="icon-btn"
                style={{ marginLeft: "auto", fontSize: 14 }}
                title={viewMode === "expand-feed" ? "기본 높이로 줄이기" : "이야기 패널 위로 늘리기"}
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
                  몬스터·동물
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input type="checkbox" checked={showSystemSteps} onChange={(e) => setShowSystemSteps(e.target.checked)} />
                  시스템 운반(MOVE)
                </label>
              </div>
              {(() => {
                const filtered = events.filter((n) => {
                  const a = n.raw?.actorId ?? n.actorIds[0] ?? "";
                  if (!showMonsters && a.startsWith("monster-")) return false;
                  if (!showSystemSteps && n.raw?.payload && (n.raw.payload as { provider?: string }).provider === "system") return false;
                  // SYSTEM_SKIP / AGENDA_PATH_FAIL 같은 디버그 이벤트는 시스템 토글 따라
                  if (!showSystemSteps && (n.raw?.type === "SYSTEM_SKIP" || n.raw?.type === "AGENDA_PATH_FAIL")) return false;
                  return true;
                });
                if (filtered.length === 0) return <div className="empty">아직 아무 일도 없어요.</div>;
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
            <span className="tab-icon">💬</span><span className="tab-label">이야기</span>
          </button>
          <button className={mobileTab === "stage" ? "active" : ""} onClick={() => setMobileTab("stage")}>
            <span className="tab-icon">🗺️</span><span className="tab-label">지도</span>
          </button>
          <button className={mobileTab === "residents" ? "active" : ""} onClick={() => setMobileTab("residents")}>
            <span className="tab-icon">👥</span><span className="tab-label">주민</span>
          </button>
          <button className={mobileTab === "inspector" ? "active" : ""} onClick={() => setMobileTab("inspector")}>
            <span className="tab-icon">📖</span><span className="tab-label">상태</span>
          </button>
        </div>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function BrainBadge({ status }: { status: BrainStatus }) {
  const map: Record<string, { dot: string; label: string; color: string }> = {
    off:              { dot: "",   label: "두뇌 꺼짐",     color: "var(--text3)" },
    mock:             { dot: "ok", label: "Mock 두뇌",     color: "var(--accent3)" },
    openrouter:       { dot: "ok", label: "OpenRouter",   color: "var(--accent)" },
    "local-proxy":    { dot: "ok", label: "로컬 프록시",     color: "var(--accent)" },
    "chatgpt-direct": { dot: "ok", label: "ChatGPT 직접",  color: "var(--accent)" }
  };
  const m = map[status] ?? { dot: "", label: status, color: "var(--text3)" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: m.color, fontSize: 12 }}>
      <span className={`status-dot ${m.dot}`} /> {m.label}
    </span>
  );
}

function ResidentCard({ actor, selected, onClick, onFocus }: { actor: Actor; selected: boolean; onClick: () => void; onFocus?: () => void }) {
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
          <span className="rcard-name">{actor.name}</span>
          {onFocus && (
            <button
              type="button"
              className="rcard-focus-btn"
              title="이 주민이 있는 자리로 카메라 이동"
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

function AgentDetail({ actor, soul, thought, onSoulUpdate, selectedId }: {
  actor: Actor;
  soul: Soul | null;
  thought: Thought | null;
  onSoulUpdate: (s: Soul) => void;
  selectedId: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Soul | null>(null);
  const [tab, setTab] = useState<"now" | "memories">("now");
  const obs = useObservations(tab === "memories" ? selectedId : null, 60);

  const [speakDraft, setSpeakDraft] = useState("");
  const [speakStatus, setSpeakStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [oracleDraft, setOracleDraft] = useState("");
  const [oracleStatus, setOracleStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const sendSpeak = async () => {
    const text = speakDraft.trim();
    if (!text || !selectedId) return;
    setSpeakStatus("sending");
    try {
      await fetch(`${API_BASE}/agent/${selectedId}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, from: "방문자" })
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
    const r = await fetch(url, { method: "POST" });
    const j = await r.json() as { soul?: Soul };
    if (j.soul) onSoulUpdate(j.soul);
  };
  const sendOracle = async () => {
    const text = oracleDraft.trim();
    if (!text || !selectedId) return;
    setOracleStatus("sending");
    try {
      const r = await fetch(`${API_BASE}/agent/${selectedId}/oracle`, {
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
    const r = await fetch(`${API_BASE}/souls/${actor.id}`, {
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
        <h4>지금의 영혼</h4>
        <p style={{ fontWeight: 600, fontSize: 15 }}>{actor.name}</p>
        <div className="meta">{actor.kind} · ({actor.x}, {actor.y})</div>
        <div className="mode-seg" style={{ marginTop: 10 }}>
          <button className={tab === "now" ? "active" : ""} onClick={() => setTab("now")}>지금</button>
          <button className={tab === "memories" ? "active" : ""} onClick={() => setTab("memories")}>최근 기억</button>
        </div>
      </div>

      {tab === "memories" && (
        <div className="acard">
          <h4>최근 기억 ({obs.length})</h4>
          <div className="meta" style={{ marginBottom: 6 }}>위 = 가장 최근, 아래 = 오래됨</div>
          {obs.length === 0 && <div className="empty">아직 기억이 모이지 않았어요.</div>}
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
          <h4>이야기 (soul)</h4>
          <p>{soul.backstory}</p>
          <div className="meta" style={{ marginTop: 8 }}>성격: {soul.persona}</div>
          <div className="meta">어조: {soul.tone}</div>
          {soul.goals.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>오늘의 목표</div>
              <ul>{soul.goals.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </>
          )}
          <button className="ghost-btn" style={{ marginTop: 10 }} onClick={startEdit}>영혼 편집</button>
        </div>
      )}

      {tab === "now" && editing && draft && (
        <div className="acard">
          <h4>영혼 편집</h4>
          <div className="form-row">
            <label>뼈대 이야기</label>
            <textarea rows={3} value={draft.backstory} onChange={(e) => setDraft({ ...draft, backstory: e.target.value })} />
          </div>
          <div className="form-row">
            <label>성격</label>
            <input value={draft.persona} onChange={(e) => setDraft({ ...draft, persona: e.target.value })} />
          </div>
          <div className="form-row">
            <label>어조</label>
            <input value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value })} />
          </div>
          <div className="form-row">
            <label>목표 (쉼표 구분)</label>
            <input
              value={draft.goals.join(", ")}
              onChange={(e) => setDraft({ ...draft, goals: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="ghost-btn" onClick={() => setEditing(false)}>취소</button>
            <button className="primary-btn" onClick={saveEdit}>저장</button>
          </div>
        </div>
      )}

      {tab === "now" && thought && (
        <div className="acard">
          <h4>오늘의 생각</h4>
          <p>{thought.priority}</p>
          <div className="meta">기분: {thought.emotion} · 다음 행동: {thought.nextIntent}</div>
          {thought.beliefs.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>지금 믿고 있는 것</div>
              <ul>{thought.beliefs.slice(-5).map((b, i) => <li key={i}>{b}</li>)}</ul>
            </>
          )}
          {thought.recentEvents.length > 0 && (
            <>
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>최근 본 것</div>
              <ul>{thought.recentEvents.slice(-5).map((e, i) => <li key={i}>{e}</li>)}</ul>
            </>
          )}
        </div>
      )}

      {actor.kind !== "monster" && actor.alive && (
        <>
          <div className="acard" style={{ borderColor: soul?.isFollower ? "#d97a4b" : undefined, borderWidth: soul?.isFollower ? 2 : 1, borderStyle: "solid" }}>
            <h4 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {soul?.isFollower ? "⚡" : "✨"} 사도 임명
              {soul?.isFollower && <span style={{ fontSize: 11, color: "var(--accent)", marginLeft: "auto" }}>faith {(soul.faith ?? 0).toFixed(2)}</span>}
            </h4>
            <p className="meta" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {soul?.isFollower
                ? `${actor.name}은(는) 너의 사도. 신탁은 절대 우선으로 따른다.`
                : `${actor.name}을(를) 사도로 임명하면 너의 신탁이 ${actor.name}의 행동·기억·신앙을 직접 빚는다.`}
            </p>
            <button
              className={soul?.isFollower ? "ghost-btn" : "primary-btn"}
              style={{ marginTop: 8 }}
              onClick={() => void toggleFollower(!soul?.isFollower)}
            >
              {soul?.isFollower ? "사도 해제" : "사도로 임명"}
            </button>
          </div>

          {soul?.isFollower && (
            <div className="acard" style={{ background: "linear-gradient(180deg, rgba(217,122,75,0.06), transparent)" }}>
              <h4>⚡ {actor.name}에게 신탁 내리기</h4>
              <textarea
                rows={2}
                value={oracleDraft}
                onChange={(e) => setOracleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void sendOracle(); }
                }}
                placeholder={`신의 음성을 적어주세요. ${actor.name}은(는) 즉시 따릅니다.`}
                style={{
                  width: "100%", boxSizing: "border-box", padding: 8,
                  border: "1px solid var(--accent)", borderRadius: 8,
                  fontSize: 12, fontFamily: "inherit", background: "var(--surface)",
                  color: "var(--ink)", resize: "vertical"
                }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                <span className="meta" style={{ fontSize: 11, color: oracleStatus === "error" ? "var(--stop)" : "var(--text3)" }}>
                  {oracleStatus === "sending" ? "신탁이 내려가는 중…"
                    : oracleStatus === "sent" ? "✨ 신탁이 영혼에 새겨졌어요."
                    : oracleStatus === "error" ? "전달 실패"
                    : "Cmd/Ctrl + Enter 로 즉시 신탁"}
                </span>
                <button
                  className="primary-btn"
                  disabled={!oracleDraft.trim() || oracleStatus === "sending"}
                  onClick={() => void sendOracle()}
                >
                  ⚡ 신탁
                </button>
              </div>
            </div>
          )}

          <div className="acard">
            <h4>💬 {actor.name}에게 말 걸기</h4>
            <textarea
              rows={2}
              value={speakDraft}
              onChange={(e) => setSpeakDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void sendSpeak(); }
              }}
              placeholder={soul?.isFollower
                ? `사도가 아닌 일반 대화. 신탁만큼 강하지는 않아요.`
                : `${actor.name}이(가) 이 말을 다음 박자 결정에 참고해요.`}
              style={{
                width: "100%", boxSizing: "border-box", padding: 8,
                border: "1px solid var(--line)", borderRadius: 8,
                fontSize: 12, fontFamily: "inherit", background: "var(--surface)",
                color: "var(--ink)", resize: "vertical"
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
              <span className="meta" style={{ fontSize: 11 }}>
                {speakStatus === "sending" ? "보내는 중…" : speakStatus === "sent" ? "전달했어요." : "Cmd/Ctrl + Enter 로 전송"}
              </span>
              <button
                className="primary-btn"
                disabled={!speakDraft.trim() || speakStatus !== "idle"}
                onClick={() => void sendSpeak()}
              >
                보내기
              </button>
            </div>
          </div>
        </>
      )}

      <div className="acard">
        <h4>상태</h4>
        <Bar label="HP" cur={actor.hp} max={actor.maxHp} color="#3fb950" />
        <Bar label="MP" cur={actor.mp} max={actor.maxMp} color="#58a6ff" />
        <Bar label="STM" cur={actor.stamina} max={actor.maxStamina} color="#d29922" />
        <Bar label="HGR" cur={actor.hunger} max={100} color="#e94560" reverse />
        <div className="meta" style={{ marginTop: 4 }}>💰 {actor.gold} gold</div>
      </div>

      <div className="acard">
        <h4>능력치</h4>
        {(() => {
          const s = actor.status;
          if (!s) return <div className="meta">—</div>;
          return (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <div className="meta">힘 STR {s.strength}</div>
              <div className="meta">민첩 DEX {s.dexterity}</div>
              <div className="meta">체력 CON {s.constitution}</div>
              <div className="meta">지능 INT {s.intelligence}</div>
            </div>
          );
        })()}
      </div>

      <div className="acard">
        <h4>숙련 ({(actor.skills ?? []).length})</h4>
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
        <h4>소지품 ({actor.inventory.length})</h4>
        {actor.inventory.length === 0 ? (
          <div className="meta">비어 있음</div>
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
