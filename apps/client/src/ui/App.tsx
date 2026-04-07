import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldState } from "@wiw/shared";
import {
  startGame,
  TILESET_COLS,
  TILE_SRC,
  type GameBridge,
  type GameMode,
  type EditorTool,
  type SelectedAsset,
  type SelectedEntity,
} from "../game/startGame";
import { joinWorld, sendMessage } from "../net/room";
import "./App.css";

// ── Constants ─────────────────────────────────────────────────────
const BASE_URL    = "http://localhost:3001";
const TILESET_URL = `${BASE_URL}/static/tile/Pipoya%20RPG%20Tileset%2016x16/%5BBase%5DBaseChip_pipo.png`;
const TILESET_ROWS = 249;  // 3984 / 16

type AssetCategory = "tiles" | "humans" | "animals" | "objects" | "items";

interface LogLine { time: string; msg: string; kind: "info" | "warn" | "error" | "success"; }
interface SpawnName { npc: string; animal: string; }

// ── Asset Grouping ────────────────────────────────────────────────
interface CatalogEntry { key: string; path: string; }
interface GroupedEntry { groupKey: string; label: string; rep: CatalogEntry; }

// 액션 접미사 목록 (기본남_걷기_001 → 기본남 로 그룹핑)
const HUMAN_ACTION_SUFFIXES = ["_걷기", "_대기", "_기본공격", "_기쁨", "_승리", "_식사", "_아픔", "_달리기"];

function extractHumanBaseName(key: string): string {
  const lastPart = key.split(".").pop() ?? "";
  let base = lastPart;
  for (const suffix of HUMAN_ACTION_SUFFIXES) {
    const idx = base.indexOf(suffix);
    if (idx !== -1) { base = base.slice(0, idx); break; }
  }
  return base.replace(/_\d+$/, ""); // 프레임 번호 제거
}

function groupHumans(items: CatalogEntry[], search: string): GroupedEntry[] {
  const groups = new Map<string, GroupedEntry>();
  for (const item of items) {
    const baseName = extractHumanBaseName(item.key);
    if (!groups.has(baseName)) {
      groups.set(baseName, { groupKey: baseName, label: baseName, rep: item });
    } else {
      // 대기_001 프레임을 대표 이미지로 우선 사용
      const lastPart = item.key.split(".").pop() ?? "";
      if (lastPart.includes("_대기_001")) {
        groups.get(baseName)!.rep = item;
      }
    }
  }
  const all = Array.from(groups.values());
  if (!search) return all.slice(0, 100);
  const q = search.toLowerCase();
  return all.filter((g) => g.label.toLowerCase().includes(q)).slice(0, 100);
}

function groupAnimals(items: CatalogEntry[], search: string): GroupedEntry[] {
  const groups = new Map<string, GroupedEntry>();
  for (const item of items) {
    const parts = item.key.split(".");
    const animalName = parts[3] ?? parts[parts.length - 1];
    if (!groups.has(animalName)) {
      groups.set(animalName, { groupKey: animalName, label: animalName, rep: item });
    }
  }
  const all = Array.from(groups.values());
  if (!search) return all.slice(0, 100);
  const q = search.toLowerCase();
  return all.filter((g) => g.label.toLowerCase().includes(q)).slice(0, 100);
}

function groupGeneric(items: CatalogEntry[], search: string): GroupedEntry[] {
  const groups = new Map<string, GroupedEntry>();
  for (const item of items) {
    const lastPart = item.key.split(".").pop() ?? "";
    const groupName = lastPart.replace(/_\d+$/, "");
    if (!groups.has(groupName)) {
      groups.set(groupName, { groupKey: groupName, label: groupName, rep: item });
    }
  }
  const all = Array.from(groups.values());
  if (!search) return all.slice(0, 100);
  const q = search.toLowerCase();
  return all.filter((g) => g.label.toLowerCase().includes(q)).slice(0, 100);
}

// ── Helper: tile ID → tileset position ───────────────────────────
function tileIdToBackground(id: number): React.CSSProperties {
  const col = id % TILESET_COLS;
  const row = Math.floor(id / TILESET_COLS);
  const size = TILESET_COLS * TILE_SRC; // 512
  return {
    backgroundImage:    `url(${TILESET_URL})`,
    backgroundRepeat:   "no-repeat",
    backgroundSize:     `${size * 2}px ${size * 2}px`,  // 2× zoom
    backgroundPosition: `-${col * TILE_SRC * 2}px -${row * TILE_SRC * 2}px`,
    imageRendering:     "pixelated",
    width:              TILE_SRC * 2,
    height:             TILE_SRC * 2,
  };
}

// ── Tileset Picker ────────────────────────────────────────────────
function TilesetPicker({
  selectedTile,
  onSelect,
}: {
  selectedTile: number;
  onSelect: (id: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef    = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  const drawOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      const tx = (selectedTile % TILESET_COLS) * TILE_SRC * scale;
      const ty = Math.floor(selectedTile / TILESET_COLS) * TILE_SRC * scale;
      const ts = TILE_SRC * scale;
      ctx.strokeStyle = "#e94560";
      ctx.lineWidth   = 2;
      ctx.strokeRect(tx + 1, ty + 1, ts - 2, ts - 2);
      ctx.fillStyle   = "rgba(233,69,96,0.25)";
      ctx.fillRect(tx + 1, ty + 1, ts - 2, ts - 2);
    },
    [selectedTile]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgLoaded) return;
    const ctx    = canvas.getContext("2d");
    if (!ctx) return;
    const scale  = canvas.width / (TILESET_COLS * TILE_SRC);
    drawOverlay(ctx, scale);
  }, [selectedTile, imgLoaded, drawOverlay]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const img = imgRef.current;
    if (!img) return;
    const rect  = img.getBoundingClientRect();
    const px    = e.clientX - rect.left;
    const py    = e.clientY - rect.top;
    const scale = rect.width / (TILESET_COLS * TILE_SRC);
    const tx    = Math.floor(px / (TILE_SRC * scale));
    const ty    = Math.floor(py / (TILE_SRC * scale));
    onSelect(ty * TILESET_COLS + tx);
  };

  return (
    <div>
      <div
        style={{ position: "relative", cursor: "crosshair", lineHeight: 0 }}
        onClick={handleClick}
      >
        <img
          ref={imgRef}
          src={TILESET_URL}
          alt="tileset"
          onLoad={() => setImgLoaded(true)}
          style={{ width: "100%", imageRendering: "pixelated", display: "block", border: "1px solid var(--border)", borderRadius: 3 }}
        />
        <canvas
          ref={canvasRef}
          width={TILESET_COLS * TILE_SRC}
          height={TILESET_ROWS * TILE_SRC}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        />
      </div>
      <div className="tile-info">
        선택된 타일: #{selectedTile} &nbsp;(col {selectedTile % TILESET_COLS}, row {Math.floor(selectedTile / TILESET_COLS)})
      </div>
    </div>
  );
}

// ── Inspector: Actor ──────────────────────────────────────────────
function ActorInspector({ entity, onAction }: { entity: Extract<SelectedEntity, { type: "actor" }>; onAction: (msg: string) => void }) {
  const a = entity.data;
  const hpPct = a.maxHp > 0 ? (a.hp / a.maxHp) * 100 : 100;
  const mpPct = a.maxMp > 0 ? (a.mp / a.maxMp) * 100 : 100;
  const stPct = a.maxStamina > 0 ? (a.stamina / a.maxStamina) * 100 : 100;

  return (
    <div>
      <div className="inspector-section">
        <div className="inspector-section-title">Entity</div>
        <div className="inspector-row">
          <span className="inspector-label">ID</span>
          <span className="inspector-value" style={{ fontFamily: "monospace", fontSize: 10 }}>{a.id}</span>
        </div>
        <div className="inspector-row">
          <span className="inspector-label">Name</span>
          <span className="inspector-value">{a.name}</span>
        </div>
        <div className="inspector-row">
          <span className="inspector-label">Kind</span>
          <span className={`kind-badge ${a.kind}`}>{a.kind}</span>
        </div>
        <div className="inspector-row">
          <span className="inspector-label">Asset</span>
          <span className="inspector-value">{a.assetKey ?? "—"}</span>
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-section-title">Transform</div>
        <div className="inspector-row">
          <span className="inspector-label">Position</span>
          <span className="inspector-value">({a.x.toFixed(1)}, {a.y.toFixed(1)})</span>
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-section-title">Stats</div>
        <div className="inspector-row">
          <span className="inspector-label">HP</span>
          <div className="hp-bar-wrap" title={`${a.hp}/${a.maxHp}`}>
            <div className="hp-bar-fill" style={{ width: `${hpPct}%`, background: hpPct > 50 ? "#3fb950" : hpPct > 25 ? "#d29922" : "#e94560" }} />
          </div>
          <span style={{ fontSize: 10, color: "var(--text2)", minWidth: 44 }}>{a.hp}/{a.maxHp}</span>
        </div>
        <div className="inspector-row">
          <span className="inspector-label">MP</span>
          <div className="hp-bar-wrap">
            <div className="hp-bar-fill" style={{ width: `${mpPct}%`, background: "#58a6ff" }} />
          </div>
          <span style={{ fontSize: 10, color: "var(--text2)", minWidth: 44 }}>{a.mp}/{a.maxMp}</span>
        </div>
        <div className="inspector-row">
          <span className="inspector-label">Stamina</span>
          <div className="hp-bar-wrap">
            <div className="hp-bar-fill" style={{ width: `${stPct}%`, background: "#d29922" }} />
          </div>
          <span style={{ fontSize: 10, color: "var(--text2)", minWidth: 44 }}>{a.stamina}/{a.maxStamina}</span>
        </div>
        <div className="inspector-row">
          <span className="inspector-label">Hunger</span>
          <span className="inspector-value">{a.hunger}</span>
        </div>
        <div className="inspector-row">
          <span className="inspector-label">Gold</span>
          <span className="inspector-value" style={{ color: "#d29922" }}>💰 {a.gold}</span>
        </div>
      </div>

      <div className="inspector-action-row">
        <button
          className="inspector-btn"
          onClick={() => {
            sendMessage({ kind: "action", payload: { actorId: a.id, action: { type: "SPEAK", message: "안녕!" } } });
            onAction(`${a.name} 발화`);
          }}
        >발화</button>
        <button
          className="inspector-btn"
          onClick={() => {
            sendMessage({ kind: "action", payload: { actorId: a.id, action: { type: "USE" } } });
            onAction(`${a.name} 사용`);
          }}
        >사용</button>
      </div>
    </div>
  );
}

// ── Inspector: Structure ──────────────────────────────────────────
function StructureInspector({ entity }: { entity: Extract<SelectedEntity, { type: "structure" }> }) {
  const s = entity.data;
  return (
    <div>
      <div className="inspector-section">
        <div className="inspector-section-title">Structure</div>
        <div className="inspector-row"><span className="inspector-label">ID</span><span className="inspector-value" style={{ fontFamily: "monospace", fontSize: 10 }}>{s.id}</span></div>
        <div className="inspector-row"><span className="inspector-label">Type</span><span className="inspector-value">{s.type}</span></div>
        <div className="inspector-row"><span className="inspector-label">Asset</span><span className="inspector-value">{s.assetKey ?? "—"}</span></div>
        <div className="inspector-row"><span className="inspector-label">Position</span><span className="inspector-value">({s.x}, {s.y})</span></div>
        <div className="inspector-row"><span className="inspector-label">Size</span><span className="inspector-value">{s.width}×{s.height}</span></div>
      </div>
      {Object.keys(s.props).length > 0 && (
        <div className="inspector-section">
          <div className="inspector-section-title">Props</div>
          {Object.entries(s.props).map(([k, v]) => (
            <div key={k} className="inspector-row">
              <span className="inspector-label">{k}</span>
              <span className="inspector-value">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inspector: Tile ────────────────────────────────────────────────
function TileInspector({ entity }: { entity: Extract<SelectedEntity, { type: "tile" }> }) {
  const t = entity.data;
  return (
    <div>
      <div className="inspector-section">
        <div className="inspector-section-title">Tile</div>
        <div className="inspector-row"><span className="inspector-label">Layer</span><span className="inspector-value">{t.layer}</span></div>
        <div className="inspector-row"><span className="inspector-label">Position</span><span className="inspector-value">({t.x}, {t.y})</span></div>
        <div className="inspector-row"><span className="inspector-label">Tile ID</span><span className="inspector-value">{t.tileId}</span></div>
        <div className="inspector-row">
          <span className="inspector-label">Preview</span>
          <div style={tileIdToBackground(t.tileId)} />
        </div>
      </div>
    </div>
  );
}

// ── Inspector: GroundItem ─────────────────────────────────────────
function GroundItemInspector({ entity }: { entity: Extract<SelectedEntity, { type: "groundItem" }> }) {
  const item = entity.data;
  return (
    <div className="inspector-section">
      <div className="inspector-section-title">Ground Item</div>
      <div className="inspector-row"><span className="inspector-label">ID</span><span className="inspector-value" style={{ fontFamily: "monospace", fontSize: 10 }}>{item.id}</span></div>
      <div className="inspector-row"><span className="inspector-label">Type</span><span className="inspector-value">{item.type}</span></div>
      <div className="inspector-row"><span className="inspector-label">Icon</span><span className="inspector-value">{item.iconKey ?? "—"}</span></div>
      <div className="inspector-row"><span className="inspector-label">Position</span><span className="inspector-value">({item.x}, {item.y})</span></div>
    </div>
  );
}

// ── World Stats ───────────────────────────────────────────────────
function WorldStats({ world }: { world: WorldState | null }) {
  if (!world) return null;
  const actors     = Object.keys(world.actors).length;
  const structures = Object.keys(world.structures).length;
  const items      = Object.keys(world.groundItems).length;
  const tod        = ((world.timeOfDay / 24000) * 24).toFixed(1);

  return (
    <div className="inspector-section">
      <div className="inspector-section-title">World</div>
      <div className="world-stats-grid">
        <div className="stat-chip">
          <div className="stat-chip-label">Tick</div>
          <div className="stat-chip-value">{world.tick}</div>
        </div>
        <div className="stat-chip">
          <div className="stat-chip-label">Time</div>
          <div className="stat-chip-value">{tod}h</div>
        </div>
        <div className="stat-chip">
          <div className="stat-chip-label">Actors</div>
          <div className="stat-chip-value">{actors}</div>
        </div>
        <div className="stat-chip">
          <div className="stat-chip-label">Structures</div>
          <div className="stat-chip-value">{structures}</div>
        </div>
        <div className="stat-chip">
          <div className="stat-chip-label">Items</div>
          <div className="stat-chip-value">{items}</div>
        </div>
        <div className="stat-chip">
          <div className="stat-chip-label">Map</div>
          <div className="stat-chip-value" style={{ fontSize: 11 }}>{world.map.width}×{world.map.height}</div>
        </div>
      </div>
    </div>
  );
}

// ── Actor Status Card (PLAY mode left panel) ──────────────────────
function ActorStatusCard({
  actor,
  isPlayer,
  onClick,
  selected,
}: {
  actor: import("@wiw/shared").Actor;
  isPlayer: boolean;
  onClick: () => void;
  selected: boolean;
}) {
  const hpPct  = actor.maxHp     > 0 ? (actor.hp / actor.maxHp) * 100 : 0;
  const mpPct  = actor.maxMp     > 0 ? (actor.mp / actor.maxMp) * 100 : 0;
  const stPct  = actor.maxStamina > 0 ? (actor.stamina / actor.maxStamina) * 100 : 0;
  const hgPct  = Math.min(100, (actor.hunger / 100) * 100);
  const kindColor = actor.kind === "player" ? "#3399ff" : actor.kind === "npc" ? "#ffaa33" : "#ff4444";

  return (
    <div
      className={`actor-card${selected ? " selected" : ""}${isPlayer ? " player-card" : ""}`}
      onClick={onClick}
    >
      <div className="actor-card-header">
        <span className="actor-dot" style={{ background: kindColor }} />
        <span className="actor-card-name">{actor.name}</span>
        <span className={`actor-kind-badge ${actor.kind}`}>{actor.kind}</span>
        <span className="actor-pos">({actor.x},{actor.y})</span>
      </div>
      <div className="actor-bars">
        <div className="actor-bar-row" title={`HP ${actor.hp.toFixed(0)}/${actor.maxHp}`}>
          <span className="actor-bar-label">HP</span>
          <div className="actor-bar-bg">
            <div className="actor-bar-fill" style={{
              width: `${hpPct}%`,
              background: hpPct > 50 ? "#22cc55" : hpPct > 25 ? "#ffaa00" : "#ff3322",
            }} />
          </div>
          <span className="actor-bar-val">{actor.hp.toFixed(0)}</span>
        </div>
        <div className="actor-bar-row" title={`MP ${actor.mp.toFixed(0)}/${actor.maxMp}`}>
          <span className="actor-bar-label">MP</span>
          <div className="actor-bar-bg">
            <div className="actor-bar-fill" style={{ width:`${mpPct}%`, background:"#4488ff" }} />
          </div>
          <span className="actor-bar-val">{actor.mp.toFixed(0)}</span>
        </div>
        <div className="actor-bar-row" title={`Stamina ${actor.stamina.toFixed(0)}/${actor.maxStamina}`}>
          <span className="actor-bar-label">STM</span>
          <div className="actor-bar-bg">
            <div className="actor-bar-fill" style={{ width:`${stPct}%`, background:"#d29922" }} />
          </div>
          <span className="actor-bar-val">{actor.stamina.toFixed(0)}</span>
        </div>
        <div className="actor-bar-row" title={`Hunger ${actor.hunger.toFixed(0)}/100`}>
          <span className="actor-bar-label">HGR</span>
          <div className="actor-bar-bg">
            <div className="actor-bar-fill" style={{ width:`${hgPct}%`, background: hgPct > 70 ? "#e94560" : "#888" }} />
          </div>
          <span className="actor-bar-val">{actor.hunger.toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Player HUD Overlay (PLAY mode bottom bar) ─────────────────────
function PlayerHUD({ world }: { world: WorldState | null }) {
  // PLAY 모드일 때만 표시 (world가 null이면 숨김)
  if (!world) return null;
  const player = world.actors["player-1"];
  if (!player || !player.alive) return (
    <div className="player-hud">
      <span style={{ color: "var(--stop)", fontSize: 11 }}>⚠ 플레이어 사망 — STOP 눌러 리셋</span>
    </div>
  );

  const hpPct  = (player.hp      / player.maxHp)      * 100;
  const mpPct  = (player.mp      / player.maxMp)      * 100;
  const stPct  = (player.stamina / player.maxStamina) * 100;
  const hgPct  = Math.min(100, player.hunger);

  return (
    <div className="player-hud">
      <div className="hud-stat">
        <span className="hud-icon">❤</span>
        <div className="hud-bar-bg">
          <div className="hud-bar-fill" style={{ width:`${hpPct}%`, background: hpPct>50?"#22cc55":hpPct>25?"#ffaa00":"#ff3322" }} />
        </div>
        <span className="hud-val">{player.hp.toFixed(0)}/{player.maxHp}</span>
      </div>
      <div className="hud-stat">
        <span className="hud-icon">💧</span>
        <div className="hud-bar-bg">
          <div className="hud-bar-fill" style={{ width:`${mpPct}%`, background:"#4488ff" }} />
        </div>
        <span className="hud-val">{player.mp.toFixed(0)}/{player.maxMp}</span>
      </div>
      <div className="hud-stat">
        <span className="hud-icon">⚡</span>
        <div className="hud-bar-bg">
          <div className="hud-bar-fill" style={{ width:`${stPct}%`, background:"#d29922" }} />
        </div>
        <span className="hud-val">{player.stamina.toFixed(0)}</span>
      </div>
      <div className="hud-stat">
        <span className="hud-icon">🍖</span>
        <div className="hud-bar-bg">
          <div className="hud-bar-fill" style={{ width:`${hgPct}%`, background: hgPct>70?"#e94560":"#888" }} />
        </div>
        <span className="hud-val">{player.hunger.toFixed(0)}</span>
      </div>
      <div className="hud-gold">💰 {player.gold}</div>
      <div className="hud-keys">WASD/↑↓←→: 이동 &nbsp;|&nbsp; Space/Z: 공격</div>
    </div>
  );
}

// ── Quick Spawn Panel ─────────────────────────────────────────────
function QuickSpawn({ onLog }: { onLog: (msg: string) => void }) {
  const [names, setNames] = useState<SpawnName>({ npc: "Human NPC", animal: "Bear" });

  const spawnActor = (kind: "npc" | "monster", name: string, assetKey: string) => {
    fetch(`${BASE_URL}/spawn/actor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name, x: 10, y: 8, assetKey }),
    })
      .then(() => onLog(`스폰 완료: ${name}`))
      .catch(() => onLog("스폰 실패"));
  };

  const spawnItem = () => {
    fetch(`${BASE_URL}/spawn/item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "food", x: 12, y: 8, iconKey: "item.food.bread" }),
    })
      .then(() => onLog("아이템 스폰 완료"))
      .catch(() => onLog("아이템 스폰 실패"));
  };

  return (
    <div className="spawn-panel">
      <div className="inspector-section-title" style={{ marginBottom: 6 }}>Quick Spawn</div>
      <div className="spawn-row">
        <input
          className="spawn-input"
          value={names.npc}
          onChange={(e) => setNames((p) => ({ ...p, npc: e.target.value }))}
          placeholder="NPC 이름"
        />
        <button className="spawn-btn" onClick={() => spawnActor("npc", names.npc, "human.default")}>
          👤 NPC
        </button>
      </div>
      <div className="spawn-row">
        <input
          className="spawn-input"
          value={names.animal}
          onChange={(e) => setNames((p) => ({ ...p, animal: e.target.value }))}
          placeholder="동물 이름"
        />
        <button className="spawn-btn" onClick={() => spawnActor("monster", names.animal, "animal.bear")}>
          🐻 동물
        </button>
      </div>
      <div className="spawn-row">
        <button className="spawn-btn" style={{ flex: 1 }} onClick={spawnItem}>💎 아이템 드랍</button>
        <button
          className="spawn-btn"
          style={{ flex: 1 }}
          onClick={() => {
            sendMessage({ kind: "edit", payload: { type: "PLACE_STRUCTURE", structureType: "chest", x: 6, y: 6, width: 1, height: 1, assetKey: "object.chest" } });
            onLog("상자 배치");
          }}
        >📦 상자</button>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────
export const App = () => {
  const gameRef   = useRef<HTMLDivElement | null>(null);
  const bridgeRef = useRef<GameBridge | null>(null);
  const logsRef   = useRef<HTMLDivElement | null>(null);

  const [gameMode,       setGameModeState]   = useState<GameMode>("STOP");
  const [editorTool,     setEditorToolState] = useState<EditorTool>("SELECT");
  const [selectedAsset,  setSelectedAssetState] = useState<SelectedAsset | null>(null);
  const [selectedEntity, setSelectedEntity]  = useState<SelectedEntity | null>(null);
  const [logs,           setLogs]            = useState<LogLine[]>([]);
  const [world,          setWorld]           = useState<WorldState | null>(null);
  const [catalog,        setCatalog]         = useState<Record<string, Array<{ key: string; path: string }>>>({});
  const [status,         setStatus]          = useState<"connecting" | "connected" | "error">("connecting");
  const [activeCategory, setActiveCategory]  = useState<AssetCategory>("tiles");
  const [selectedTileId, setSelectedTileId]  = useState<number>(0);
  const [tick,           setTick]            = useState(0);
  const [assetSearch,    setAssetSearch]     = useState("");

  const addLog = useCallback((msg: string, kind: LogLine["kind"] = "info") => {
    const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    setLogs((prev) => [...prev.slice(-80), { time, msg, kind }]);
  }, []);

  // ── 월드 상태 업데이트 헬퍼 ───────────────────────────────────
  const applyWorldSnap = useCallback((snap: WorldState) => {
    setWorld(snap);
    setTick(snap.tick);
    bridgeRef.current?.updateWorld(snap);
  }, []);

  // Init game engine
  useEffect(() => {
    if (gameRef.current && !bridgeRef.current) {
      const bridge = startGame(gameRef.current);
      bridgeRef.current = bridge;
      bridge.onEntitySelect((e) => setSelectedEntity(e));
      bridge.onLog((msg) => addLog(msg));
    }

    // 초기 월드 로드
    fetch(`${BASE_URL}/world`)
      .then((r) => r.json())
      .then((snap: WorldState) => {
        applyWorldSnap(snap);
        addLog(`초기 월드 로드 완료 (액터: ${Object.keys(snap.actors).length})`, "info");
      })
      .catch(() => addLog("초기 월드 로드 실패", "warn" as LogLine["kind"]));

    // ── HTTP 폴링: 1초마다 서버 상태 동기화 (Colyseus plain-object 한계 보완) ──
    const pollInterval = setInterval(() => {
      fetch(`${BASE_URL}/world`)
        .then((r) => r.json())
        .then((snap: WorldState) => { applyWorldSnap(snap); })
        .catch(() => {/* silent */});
    }, 1000);

    joinWorld()
      .then((room) => {
        setStatus("connected");
        addLog("서버 연결 완료", "success");
        room.onStateChange((state) => {
          try {
            const snap = JSON.parse(JSON.stringify(state)) as WorldState;
            if (!snap.map || !snap.actors) return;
            applyWorldSnap(snap);
          } catch { /* silent */ }
        });
        room.onMessage("result", (r: { message: string }) => addLog(`서버: ${r.message}`));
      })
      .catch(() => {
        setStatus("error");
        addLog("서버 연결 실패", "error");
      });

    fetch(`${BASE_URL}/assets/catalog`)
      .then((r) => r.json())
      .then((data: Record<string, Array<{ key: string; path: string }>>) => {
        setCatalog(data);
        bridgeRef.current?.setCatalog(data);
      })
      .catch(() => setCatalog({}));

    return () => clearInterval(pollInterval);
  }, [addLog, applyWorldSnap]);

  // Auto-scroll console
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  // ── Control Handlers ─────────────────────────────────────────
  const setGameMode = (mode: GameMode) => {
    setGameModeState(mode);
    bridgeRef.current?.setMode(mode);
  };

  const setEditorTool = (tool: EditorTool) => {
    setEditorToolState(tool);
    bridgeRef.current?.setTool(tool);
  };

  const selectAsset = (asset: SelectedAsset) => {
    setSelectedAssetState(asset);
    bridgeRef.current?.setSelectedAsset(asset);
  };

  const handleTileSelect = (id: number) => {
    setSelectedTileId(id);
    const asset: SelectedAsset = { category: "tile", key: `tile_${id}`, path: "", tileId: id };
    selectAsset(asset);
  };

  const rescanAssets = () => {
    fetch(`${BASE_URL}/assets/rescan`, { method: "POST" })
      .then(() => fetch(`${BASE_URL}/assets/catalog`).then((r) => r.json()).then(setCatalog))
      .then(() => addLog("에셋 재스캔 완료", "success"))
      .catch(() => addLog("에셋 재스캔 실패", "error"));
  };

  // ── Asset Panel Content ───────────────────────────────────────
  const renderGroupedGrid = (
    entries: GroupedEntry[],
    category: "human" | "animal" | "object" | "item"
  ) => (
    <div className="asset-grid">
      {entries.map((g) => (
        <div
          key={g.groupKey}
          className={`asset-thumb${selectedAsset?.key === g.rep.key ? " active" : ""}`}
          onClick={() => selectAsset({ category, key: g.rep.key, path: g.rep.path })}
        >
          <img src={`${BASE_URL}${g.rep.path}`} alt={g.label} />
          <div className="asset-thumb-label">{g.label}</div>
        </div>
      ))}
      {entries.length === 0 && (
        <div style={{ color: "var(--text3)", fontSize: 10, gridColumn: "1/-1", padding: "8px 0" }}>에셋 없음</div>
      )}
    </div>
  );

  const searchBar = (
    <input
      type="text"
      placeholder="검색..."
      value={assetSearch}
      onChange={(e) => setAssetSearch(e.target.value)}
      style={{
        width: "100%", boxSizing: "border-box", padding: "4px 6px",
        background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 3,
        color: "var(--text1)", fontSize: 11, marginBottom: 6,
      }}
    />
  );

  const renderAssetPanel = () => {
    switch (activeCategory) {
      case "tiles":
        return (
          <div className="panel-body">
            <TilesetPicker selectedTile={selectedTileId} onSelect={handleTileSelect} />
          </div>
        );

      case "humans":
        return (
          <div className="panel-body">
            {searchBar}
            {renderGroupedGrid(groupHumans(catalog.humans ?? [], assetSearch), "human")}
          </div>
        );

      case "animals":
        return (
          <div className="panel-body">
            {searchBar}
            {renderGroupedGrid(groupAnimals(catalog.animals ?? [], assetSearch), "animal")}
          </div>
        );

      case "objects":
        return (
          <div className="panel-body">
            {searchBar}
            {renderGroupedGrid(groupGeneric(catalog.objects ?? [], assetSearch), "object")}
          </div>
        );

      case "items":
        return (
          <div className="panel-body">
            {searchBar}
            {renderGroupedGrid(groupGeneric(catalog.items ?? [], assetSearch), "item")}
          </div>
        );
    }
  };

  // ── Inspector Content ─────────────────────────────────────────
  const renderInspector = () => {
    if (!selectedEntity) {
      return (
        <>
          <WorldStats world={world} />
          {selectedAsset && (selectedAsset.category === "human" || selectedAsset.category === "animal") && (
            <div className="inspector-section">
              <div className="inspector-section-title">선택된 에셋</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <img
                  src={`${BASE_URL}${selectedAsset.path}`}
                  alt={selectedAsset.key}
                  style={{ width: 64, height: 64, imageRendering: "pixelated", objectFit: "contain", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg3)" }}
                />
                <span style={{ fontSize: 10, color: "var(--text2)", wordBreak: "break-all" }}>
                  {selectedAsset.key.split(".").pop()}
                </span>
              </div>
            </div>
          )}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
            <QuickSpawn onLog={(msg) => addLog(msg)} />
          </div>
          <div className="inspector-empty">
            엔티티를 클릭하거나<br />
            SELECT 도구로<br />
            선택하세요
          </div>
        </>
      );
    }

    switch (selectedEntity.type) {
      case "actor":
        return (
          <>
            <ActorInspector entity={selectedEntity} onAction={(msg) => addLog(msg)} />
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 8 }}>
              <WorldStats world={world} />
            </div>
          </>
        );
      case "structure":
        return (
          <>
            <StructureInspector entity={selectedEntity} />
            <div className="inspector-action-row">
              <button
                className="inspector-btn danger"
                onClick={() => {
                  sendMessage({ kind: "edit", payload: { type: "REMOVE_STRUCTURE", structureId: selectedEntity.id } });
                  setSelectedEntity(null);
                  addLog(`구조물 삭제: ${selectedEntity.data.type}`);
                }}
              >삭제</button>
            </div>
          </>
        );
      case "groundItem":
        return <GroundItemInspector entity={selectedEntity} />;
      case "tile":
        return <TileInspector entity={selectedEntity} />;
    }
  };

  // ── Toolbar mode badge ────────────────────────────────────────
  const modeBadgeClass = gameMode === "PLAY" ? "play" : gameMode === "PAUSE" ? "pause" : "stop";
  const modeBadgeText  = gameMode === "PLAY" ? "▶ PLAY" : gameMode === "PAUSE" ? "⏸ PAUSE" : "⬛ EDIT";

  return (
    <div className="app-root">
      {/* ── Toolbar ── */}
      <div className="toolbar">
        <div className="toolbar-brand">
          <span>◈</span> WORLD ENGINE
        </div>

        {/* Play controls */}
        <div className="toolbar-group">
          <button
            className={`toolbar-btn play${gameMode === "PLAY" ? " active" : ""}`}
            onClick={() => setGameMode("PLAY")}
            title="Play (WASD/방향키로 플레이어 이동)"
          >▶ PLAY</button>
          <button
            className={`toolbar-btn pause${gameMode === "PAUSE" ? " active" : ""}`}
            onClick={() => setGameMode("PAUSE")}
            title="Pause"
          >⏸ PAUSE</button>
          <button
            className={`toolbar-btn stop${gameMode === "STOP" ? " active" : ""}`}
            onClick={() => setGameMode("STOP")}
            title="Stop / Edit Mode"
          >⏹ STOP</button>
        </div>

        <div className="toolbar-sep" />

        {/* Editor tools (available in STOP/PAUSE mode) */}
        <div className="toolbar-group">
          <span className="toolbar-label">도구</span>
          {(["SELECT", "MOVE", "TILE", "SPAWN"] as EditorTool[]).map((tool) => {
            const icons: Record<EditorTool, string> = { SELECT: "↖ SELECT", MOVE: "✋ MOVE", TILE: "🖌 TILE", SPAWN: "➕ SPAWN" };
            return (
              <button
                key={tool}
                className={`toolbar-btn${editorTool === tool ? " active" : ""}`}
                onClick={() => setEditorTool(tool)}
                disabled={gameMode === "PLAY"}
                title={tool}
              >{icons[tool]}</button>
            );
          })}
        </div>

        <div className="toolbar-sep" />

        {/* Selected asset indicator */}
        {selectedAsset && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text2)" }}>
            {selectedAsset.category === "tile" ? (
              <div style={{ ...tileIdToBackground(selectedAsset.tileId ?? 0), flexShrink: 0 }} />
            ) : (
              <img
                src={`${BASE_URL}${selectedAsset.path}`}
                alt=""
                style={{ width: 24, height: 24, imageRendering: "pixelated", objectFit: "contain" }}
              />
            )}
            <span>{selectedAsset.key}</span>
          </div>
        )}

        <button
          className="toolbar-btn"
          onClick={rescanAssets}
          style={{ marginLeft: 8 }}
          title="에셋 재스캔"
        >↺ 재스캔</button>

        <div
          className={`toolbar-status${status === "connected" ? " connected" : status === "error" ? " error" : ""}`}
        >
          {status === "connecting" ? "● 연결중..." : status === "connected" ? "● 연결됨" : "● 연결 실패"}
          &nbsp;|&nbsp; Tick: {tick}
        </div>
      </div>

      {/* ── Workspace ── */}
      <div className="workspace">

        {/* ── Left Panel: PLAY mode = Actors, EDIT mode = Assets ── */}
        {gameMode === "PLAY" ? (
          <div className="panel actors-panel">
            <div className="panel-header">
              <span className="panel-header-icon">👥</span> ACTORS
              <span style={{ marginLeft:"auto", fontSize:10, color:"var(--text3)" }}>
                {world ? Object.values(world.actors).filter(a=>a.alive).length : 0} alive
              </span>
            </div>
            <div className="panel-body" style={{ overflowY:"auto", padding:"6px 8px", gap:6, display:"flex", flexDirection:"column" }}>
              {world ? Object.values(world.actors)
                .filter((a) => a.alive)
                .sort((a, b) => (a.kind === "player" ? -1 : b.kind === "player" ? 1 : 0))
                .map((a) => (
                  <ActorStatusCard
                    key={a.id}
                    actor={a}
                    isPlayer={a.kind === "player"}
                    selected={selectedEntity?.type === "actor" && selectedEntity.id === a.id}
                    onClick={() => {
                      setSelectedEntity({ type: "actor", id: a.id, data: a });
                    }}
                  />
                )) : (
                <div style={{ color:"var(--text3)", fontSize:11, textAlign:"center", marginTop:20 }}>
                  서버 연결 대기중...
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="panel assets-panel">
            <div className="panel-header">
              <span className="panel-header-icon">🗂</span> ASSETS
            </div>
            <div className="asset-category-tabs">
              {(["tiles", "humans", "animals", "objects", "items"] as AssetCategory[]).map((cat) => {
                const labels: Record<AssetCategory, string> = {
                  tiles: "TILES", humans: "NPC", animals: "MOB", objects: "OBJ", items: "ITEM"
                };
                return (
                  <button
                    key={cat}
                    className={`cat-tab${activeCategory === cat ? " active" : ""}`}
                    onClick={() => { setActiveCategory(cat); setAssetSearch(""); }}
                  >{labels[cat]}</button>
                );
              })}
            </div>
            {renderAssetPanel()}
          </div>
        )}

        {/* ── Viewport ── */}
        <div className="viewport-area">
          <div className="viewport-header">
            <span className={`viewport-header-badge ${modeBadgeClass}`}>{modeBadgeText}</span>
            SCENE VIEW
            {gameMode !== "PLAY" && (
              <span style={{ fontSize: 10, color: "var(--text3)" }}>
                우클릭+드래그: 카메라이동 &nbsp;|&nbsp; 스크롤: 줌
              </span>
            )}
            {gameMode === "PLAY" && (
              <span style={{ fontSize: 10, color: "var(--text3)" }}>
                WASD/↑↓←→: 이동 &nbsp;|&nbsp; Space/Z: 공격
              </span>
            )}
            {world && (
              <span style={{ fontSize:10, color:"var(--text3)", marginLeft:"auto" }}>
                Tick: {tick} &nbsp;|&nbsp; {((world.timeOfDay / 24000) * 24).toFixed(1)}h
              </span>
            )}
          </div>
          <div className="game-container" ref={gameRef} />
          {/* Player HUD overlay */}
          <PlayerHUD world={gameMode === "PLAY" ? world : null} />
        </div>

        {/* ── Right Panel: Inspector ── */}
        <div className="panel inspector-panel">
          <div className="panel-header">
            <span className="panel-header-icon">🔍</span> INSPECTOR
            {selectedEntity && (
              <button
                style={{ marginLeft:"auto", background:"none", border:"none", color:"var(--text3)", cursor:"pointer", fontSize:12, padding:"0 4px" }}
                onClick={() => setSelectedEntity(null)}
                title="선택 해제"
              >✕</button>
            )}
          </div>
          <div className="panel-body">
            {renderInspector()}
          </div>
        </div>
      </div>

      {/* ── Console ── */}
      <div className="console-panel">
        <div className="console-header">
          <span>⬛ CONSOLE</span>
          <span className="console-stat">Tick: <span>{tick}</span></span>
          <span className="console-stat">Actors: <span>{world ? Object.keys(world.actors).length : 0}</span></span>
          <span className="console-stat">Structures: <span>{world ? Object.keys(world.structures).length : 0}</span></span>
          <span className="console-stat">Items: <span>{world ? Object.keys(world.groundItems).length : 0}</span></span>
          {world && <span className="console-stat">Time: <span>{((world.timeOfDay / 24000) * 24).toFixed(1)}h</span></span>}
          <button
            style={{ marginLeft: "auto", background: "none", border: "1px solid var(--border)", color: "var(--text3)", borderRadius: 3, padding: "1px 6px", cursor: "pointer", fontSize: 10 }}
            onClick={() => setLogs([])}
          >지우기</button>
        </div>
        <div className="console-body" ref={logsRef}>
          {logs.map((line, i) => (
            <div key={i} className={`console-line ${line.kind}`}>
              <span className="console-line-time">{line.time}</span>
              <span className="console-line-msg">{line.msg}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div style={{ color: "var(--text3)", fontSize: 11 }}>— 로그 없음 —</div>
          )}
        </div>
      </div>
    </div>
  );
};
