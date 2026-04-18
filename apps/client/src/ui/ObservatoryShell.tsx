import { useCallback, useEffect, useRef, useState } from "react";
import type { Actor, Soul, Thought, WorldState, NarrativeEvent } from "@wiw/shared";
import { startGame, type GameBridge } from "../game/startGame";
import { joinWorld } from "../net/room";
import { API_BASE } from "../net/endpoints";
import { useEventFeed } from "./useEventFeed";
import { SettingsModal } from "./SettingsModal";

export function ObservatoryShell({ onSwitchMode }: { onSwitchMode: () => void }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const bridgeRef = useRef<GameBridge | null>(null);
  const [world, setWorld] = useState<WorldState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [soul, setSoul] = useState<Soul | null>(null);
  const [thought, setThought] = useState<Thought | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [brainStatus, setBrainStatus] = useState<"off" | "mock" | "openrouter">("off");
  const events = useEventFeed(120);

  // Connect + stage
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const room = await joinWorld();
      if (cancelled) return;
      room.onStateChange((s) => setWorld(structuredClone(s)));
      setWorld(structuredClone(room.state));
      const stage = stageRef.current;
      if (stage) {
        bridgeRef.current = startGame(stage);
        bridgeRef.current.setMode("PLAY");
      }
    })();
    return () => { cancelled = true; bridgeRef.current?.destroy(); };
  }, []);

  // Load brain status
  useEffect(() => {
    const pull = () => fetch(`${API_BASE}/config/brain`)
      .then((r) => r.json())
      .then((j: { config: { provider: "openrouter" | "mock"; enabled: boolean } }) => {
        if (!j.config.enabled) setBrainStatus("off");
        else setBrainStatus(j.config.provider);
      })
      .catch(() => {});
    pull();
    const id = setInterval(pull, 5000);
    return () => clearInterval(id);
  }, [showSettings]);

  // Load soul / thought for selected
  useEffect(() => {
    if (!selectedId) { setSoul(null); setThought(null); return; }
    fetch(`${API_BASE}/souls/${selectedId}`).then((r) => r.json()).then((j: { soul: Soul }) => setSoul(j.soul)).catch(() => setSoul(null));
    fetch(`${API_BASE}/thoughts/${selectedId}`).then((r) => r.json()).then((j: { thought: Thought }) => setThought(j.thought)).catch(() => setThought(null));
  }, [selectedId]);

  const actors: Actor[] = world ? Object.values(world.actors) : [];
  const selected = selectedId ? actors.find((a) => a.id === selectedId) : undefined;
  const todHours = world ? ((world.timeOfDay / 24000) * 24) : 0;

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
  const dayN = world ? Math.floor(world.tick / (24000 / 100)) + 1 : 1;

  return (
    <div className="obs-root">
      <div className="obs-top">
        <div className="obs-brand">🌼 what is world <span className="sub">cozy observatory</span></div>
        <div className="obs-time">
          {phase.icon} Day {dayN} · {phase.label} {String(Math.floor(todHours)).padStart(2, "0")}:{String(Math.floor((todHours % 1) * 60)).padStart(2, "0")}
        </div>
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 10, alignItems: "center" }}>
          <BrainBadge status={brainStatus} />
          <div className="mode-seg">
            <button className="active">관측</button>
            <button onClick={onSwitchMode}>편집</button>
          </div>
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
            onClick={() => setSelectedId(a.id)}
          />
        ))}
      </div>

      <div className="obs-stage" ref={stageRef} />

      <div className="obs-right">
        {!selected && <div className="empty">왼쪽에서 주민을 골라보세요.</div>}
        {selected && (
          <AgentDetail
            actor={selected}
            soul={soul}
            thought={thought}
            onSoulUpdate={(s) => setSoul(s)}
          />
        )}
      </div>

      <div className="obs-feed">
        <div className="feed">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <strong>🌿 오늘의 이야기</strong>
            <span style={{ color: "var(--text3)", fontSize: 11 }}>{events.length}건</span>
          </div>
          {events.length === 0 && <div className="empty">아직 아무 일도 없어요.</div>}
          {events.slice(-60).reverse().map((n) => (
            <div key={n.id} className={`feed-item tone-${n.tone}`}>
              <span className="feed-icon">{n.icon}</span>
              <span className="feed-text">{n.text}</span>
              <span className="feed-time">tick {n.tick}</span>
            </div>
          ))}
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function BrainBadge({ status }: { status: "off" | "mock" | "openrouter" }) {
  const map = {
    off:        { dot: "",     label: "두뇌 꺼짐",  color: "var(--text3)" },
    mock:       { dot: "ok",   label: "Mock 두뇌",  color: "var(--accent3)" },
    openrouter: { dot: "ok",   label: "OpenRouter", color: "var(--accent)" }
  } as const;
  const m = map[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: m.color, fontSize: 12 }}>
      <span className={`status-dot ${m.dot}`} /> {m.label}
    </span>
  );
}

function ResidentCard({ actor, selected, onClick }: { actor: Actor; selected: boolean; onClick: () => void }) {
  const hpPct = actor.maxHp > 0 ? (actor.hp / actor.maxHp) * 100 : 0;
  const stPct = actor.maxStamina > 0 ? (actor.stamina / actor.maxStamina) * 100 : 0;
  const hgPct = Math.min(100, actor.hunger);
  const mood = hpPct < 25 ? "😣" : hgPct > 70 ? "😩" : stPct < 20 ? "😴" : "🙂";
  const hpColor = hpPct > 50 ? "var(--accent3)" : hpPct > 25 ? "var(--accent4)" : "var(--stop)";
  return (
    <div className={`rcard${selected ? " selected" : ""}`} onClick={onClick}>
      <div className="rcard-head">
        <span>{actor.kind === "player" ? "👤" : actor.kind === "npc" ? "🧑‍🌾" : "🐗"}</span>
        <span className="rcard-name">{actor.name}</span>
        <span className={`rcard-kind ${actor.kind}`}>{actor.kind}</span>
      </div>
      <div className="rcard-bar-row">
        <span className="lbl">HP</span>
        <div className="rcard-bar"><div style={{ width: `${hpPct}%`, background: hpColor }} /></div>
        <span className="rcard-pos">{mood} ({actor.x},{actor.y})</span>
      </div>
      <div className="rcard-bar-row">
        <span className="lbl">STM</span>
        <div className="rcard-bar"><div style={{ width: `${stPct}%`, background: "var(--accent4)" }} /></div>
      </div>
      <div className="rcard-bar-row">
        <span className="lbl">HGR</span>
        <div className="rcard-bar"><div style={{ width: `${hgPct}%`, background: hgPct > 70 ? "var(--stop)" : "var(--text3)" }} /></div>
      </div>
    </div>
  );
}

function AgentDetail({ actor, soul, thought, onSoulUpdate }: {
  actor: Actor;
  soul: Soul | null;
  thought: Thought | null;
  onSoulUpdate: (s: Soul) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Soul | null>(null);

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
      </div>

      {soul && !editing && (
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

      {editing && draft && (
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

      {thought && (
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

      <div className="acard">
        <h4>상태</h4>
        <div className="meta">HP {actor.hp} / {actor.maxHp}</div>
        <div className="meta">Stamina {actor.stamina} / {actor.maxStamina}</div>
        <div className="meta">Hunger {actor.hunger}</div>
        <div className="meta">Gold {actor.gold}</div>
      </div>
    </>
  );
}
