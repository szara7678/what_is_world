import Phaser from "phaser";
import type { WorldState, Actor, Structure, GroundItem } from "@wiw/shared";
import { sendMessage } from "../net/room";

// ── Public Types ──────────────────────────────────────────────────
export type GameMode = "STOP" | "PLAY" | "PAUSE";
export type EditorTool = "SELECT" | "MOVE" | "TILE" | "SPAWN";

export interface SelectedAsset {
  category: "tile" | "human" | "animal" | "object" | "item";
  key: string;
  path: string;
  tileId?: number;
}

export type SelectedEntity =
  | { type: "actor";       id: string; data: Actor }
  | { type: "structure";   id: string; data: Structure }
  | { type: "groundItem";  id: string; data: GroundItem }
  | { type: "tile"; id?: undefined; data: { x: number; y: number; tileId: number; layer: string } };

export interface GameBridge {
  updateWorld:      (w: WorldState) => void;
  setMode:          (mode: GameMode) => void;
  setTool:          (tool: EditorTool) => void;
  setSelectedAsset: (asset: SelectedAsset | null) => void;
  setCatalog:       (catalog: Record<string, Array<{ key: string; path: string }>>) => void;
  onEntitySelect:   (cb: (entity: SelectedEntity | null) => void) => void;
  onLog:            (cb: (msg: string) => void) => void;
  destroy:          () => void;
}

// ── Constants ─────────────────────────────────────────────────────
const API             = "http://localhost:3001";
const BASE            = `${API}/static`;
const TILESET_URL     = `${BASE}/tile/Pipoya%20RPG%20Tileset%2016x16/%5BBase%5DBaseChip_pipo.png`;

const HUMAN_BASE_PATH = `${BASE}/character/human/game_RESOURCES_cha_spr/%EA%B8%B0%EB%B3%B8/%EB%82%A8`;
const H_IDLE_BASE     = `${HUMAN_BASE_PATH}/%EA%B8%B0%EB%B3%B8%EB%82%A8_%EB%8C%80%EA%B8%B0_`;
const H_WALK_BASE     = `${HUMAN_BASE_PATH}/%EA%B8%B0%EB%B3%B8%EB%82%A8_%EA%B1%B7%EA%B8%B0_`;
const H_ATTACK_BASE   = `${HUMAN_BASE_PATH}/%EA%B8%B0%EB%B3%B8%EB%82%A8_%EA%B8%B0%EB%B3%B8%EA%B3%B5%EA%B2%A9_`;

const ANIMALS         = ["bear", "deer", "boar"] as const;
const TILE_SRC        = 16;
const TILE_SCALE      = 2;
const TILE_DISP       = TILE_SRC * TILE_SCALE; // 32px
const TILESET_COLS    = 8;

// 이동 쿨다운 (ms)
const MOVE_COOLDOWN   = 160;
// 보간 속도 (0~1, 높을수록 빠름)
const LERP_SPEED      = 0.22;

// ── Actor Display ─────────────────────────────────────────────────
interface ActorDisplay {
  container: Phaser.GameObjects.Container;
  sprite:    Phaser.GameObjects.Sprite | null;
  fallback:  Phaser.GameObjects.Rectangle | null;
  label:     Phaser.GameObjects.Text;
  hpBar:     Phaser.GameObjects.Graphics;
  // 보간용 렌더 위치
  renderX:   number;
  renderY:   number;
  targetX:   number;
  targetY:   number;
  // 공격 히트 이펙트
  hitFlash:  number;
}

interface SpriteSet {
  idle:       string;
  walk:       string;
  attack:     string;
  hasTexture: boolean;
}

// ── WorldScene ────────────────────────────────────────────────────
class WorldScene extends Phaser.Scene {
  private mode:          GameMode   = "STOP";
  private tool:          EditorTool = "SELECT";
  private selectedAsset: SelectedAsset | null = null;
  private catalogCache:  Map<string, string>  = new Map();

  private onEntitySelectCb: ((e: SelectedEntity | null) => void) | null = null;
  private onLogCb:          ((msg: string) => void) | null = null;

  private world:         WorldState | null = null;
  private pendingWorld:  WorldState | null = null;
  private sceneReady     = false;
  private mapInitialized = false;

  private tileMap:        Phaser.Tilemaps.Tilemap      | null = null;
  private terrainLayer:   Phaser.Tilemaps.TilemapLayer | null = null;
  private decorLayer:     Phaser.Tilemaps.TilemapLayer | null = null;
  private fallbackGfx:    Phaser.GameObjects.Graphics  | null = null;
  private actorDisplays:  Map<string, ActorDisplay>    = new Map();
  private actorPrevTile:  Map<string, { x: number; y: number }> = new Map();
  private structureObjs:  Map<string, Phaser.GameObjects.Container> = new Map();
  private itemObjs:       Map<string, Phaser.GameObjects.Container> = new Map();
  private hoverGfx!:      Phaser.GameObjects.Graphics;
  private selectionGfx!:  Phaser.GameObjects.Graphics;

  // 입력
  private cursorTileX    = -1;
  private cursorTileY    = -1;
  private selectedId:    string | null = null;
  private isDragging     = false;
  private dragStartX     = 0;
  private dragStartY     = 0;
  private dragCamX       = 0;
  private dragCamY       = 0;
  private cursors:       Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private wasd:          Record<string, Phaser.Input.Keyboard.Key> = {};
  private lastMoveAt     = 0;
  private playerFacing:  "up" | "down" | "left" | "right" = "down";

  // 폴링
  private needsWorldRefresh = false;
  private lastRefreshAt     = 0;

  constructor() { super("world"); }

  // ── Bridge API ────────────────────────────────────────────────
  setWorld(w: WorldState): void {
    if (!this.sceneReady) { this.pendingWorld = w; return; }
    const firstTime    = this.world === null || !this.mapInitialized;
    const prevTerrain  = this.world?.map.terrain;
    this.world = w;
    if (firstTime) {
      this.initMap();
    } else if (prevTerrain && this.terrainLayer) {
      this.updateChangedTiles(prevTerrain, w.map.terrain);
    } else if (prevTerrain && this.fallbackGfx) {
      this.renderFallback();
    }
    this.syncActors();
    this.syncStructures();
    this.syncItems();
  }

  setMode(mode: GameMode): void {
    this.mode = mode;
    if (mode !== "PLAY") this.cameras.main.stopFollow();
    this.log(`모드: ${mode}`);
  }

  setTool(t: EditorTool): void { this.tool = t; }
  setSelectedAsset(a: SelectedAsset | null): void { this.selectedAsset = a; }

  setCatalog(catalog: Record<string, Array<{ key: string; path: string }>>): void {
    this.catalogCache.clear();
    for (const items of Object.values(catalog)) {
      for (const item of items) {
        const url = item.path.startsWith("http") ? item.path : `${API}${item.path}`;
        this.catalogCache.set(item.key, url);
      }
    }
  }

  onEntitySelect(cb: (e: SelectedEntity | null) => void): void { this.onEntitySelectCb = cb; }
  onLog(cb: (msg: string) => void): void { this.onLogCb = cb; }

  private log(msg: string): void { this.onLogCb?.(msg); }
  private textureKeyFor(k: string): string { return k.replace(/[^a-zA-Z0-9_\-]/g, "_"); }

  private loadTextureIfNeeded(key: string, url: string, cb: () => void): void {
    const tk = this.textureKeyFor(key);
    if (this.textures.exists(tk)) { cb(); return; }
    this.load.image(tk, url);
    this.load.once(Phaser.Loader.Events.COMPLETE, cb);
    this.load.start();
  }

  private scheduleRefresh(): void { this.needsWorldRefresh = true; }

  private async doWorldRefresh(): Promise<void> {
    if (Date.now() - this.lastRefreshAt < 350) return;
    this.lastRefreshAt = Date.now();
    this.needsWorldRefresh = false;
    try {
      const snap = await fetch(`${API}/world`).then((r) => r.json()) as WorldState;
      if (snap.map && snap.actors) this.setWorld(snap);
    } catch { /**/ }
  }

  // ── Phaser Lifecycle ──────────────────────────────────────────
  preload(): void {
    this.load.image("tileset", TILESET_URL);

    for (let i = 1; i <= 2; i++)
      this.load.image(`human_idle_${i}`,   `${H_IDLE_BASE}${String(i).padStart(3,"0")}.png`);
    for (let i = 1; i <= 6; i++)
      this.load.image(`human_walk_${i}`,   `${H_WALK_BASE}${String(i).padStart(3,"0")}.png`);
    for (let i = 1; i <= 3; i++)
      this.load.image(`human_attack_${i}`, `${H_ATTACK_BASE}${String(i).padStart(3,"0")}.png`);

    for (const animal of ANIMALS)
      for (let i = 1; i <= 4; i++)
        this.load.image(`${animal}_walk_${i}`,
          `${BASE}/character/animal/${animal}/walk/${animal}_1_walk${i}.png`);

    this.load.on("loaderror", (f: { key: string }) => console.warn(`[WorldScene] load fail: ${f.key}`));
  }

  create(): void {
    this.hoverGfx     = this.add.graphics().setDepth(90);
    this.selectionGfx = this.add.graphics().setDepth(91);

    this.cursors = this.input.keyboard?.createCursorKeys() ?? null;
    this.wasd = {
      up:    this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      attack: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      attackZ: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.Z),
    };

    this.createAnimations();
    this.setupInput();

    this.sceneReady = true;
    if (this.pendingWorld) {
      const w = this.pendingWorld;
      this.pendingWorld = null;
      this.setWorld(w);
    }

    this.cameras.main.setBackgroundColor(0x0d1117);
    this.log("게임 씬 준비됨");
  }

  update(_time: number, delta: number): void {
    // 보간 이동 업데이트
    this.updateActorInterpolation(delta);
    // 호버 그래픽
    this.updateHoverGfx();
    // 히트 플래시
    this.updateHitFlash(delta);

    if (this.needsWorldRefresh && Date.now() - this.lastRefreshAt > 400)
      void this.doWorldRefresh();

    const cam   = this.cameras.main;
    const speed = 5 / cam.zoom;

    if (this.mode === "PLAY") {
      this.handlePlayInput();
      this.updatePlayerCamera();
    } else if (this.tool !== "MOVE" && !this.isDragging && this.cursors) {
      if (this.cursors.up.isDown)    cam.scrollY -= speed;
      if (this.cursors.down.isDown)  cam.scrollY += speed;
      if (this.cursors.left.isDown)  cam.scrollX -= speed;
      if (this.cursors.right.isDown) cam.scrollX += speed;
    }
  }

  // ── Interpolation ─────────────────────────────────────────────
  private updateActorInterpolation(_delta: number): void {
    for (const d of this.actorDisplays.values()) {
      const dx = d.targetX - d.renderX;
      const dy = d.targetY - d.renderY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.5) {
        d.renderX = d.targetX;
        d.renderY = d.targetY;
      } else {
        d.renderX += dx * LERP_SPEED;
        d.renderY += dy * LERP_SPEED;
      }
      d.container.setPosition(d.renderX, d.renderY);
    }
  }

  private updateHitFlash(delta: number): void {
    for (const d of this.actorDisplays.values()) {
      if (d.hitFlash > 0) {
        d.hitFlash -= delta;
        const alpha = Math.max(0, Math.sin((d.hitFlash / 300) * Math.PI));
        if (d.sprite) d.sprite.setTint(Phaser.Display.Color.GetColor(
          255, Math.round(255 * (1 - alpha)), Math.round(255 * (1 - alpha))
        ));
        if (d.fallback) d.fallback.setFillStyle(
          Phaser.Display.Color.GetColor(255, Math.round(128 * (1 - alpha)), 0)
        );
        if (d.hitFlash <= 0) {
          d.sprite?.clearTint();
        }
      }
    }
  }

  // ── Play Input ───────────────────────────────────────────────
  private handlePlayInput(): void {
    const now = Date.now();
    if (now - this.lastMoveAt < MOVE_COOLDOWN) return;

    const up    = this.cursors?.up.isDown    || (this.wasd.up   as Phaser.Input.Keyboard.Key).isDown;
    const down  = this.cursors?.down.isDown  || (this.wasd.down as Phaser.Input.Keyboard.Key).isDown;
    const left  = this.cursors?.left.isDown  || (this.wasd.left as Phaser.Input.Keyboard.Key).isDown;
    const right = this.cursors?.right.isDown || (this.wasd.right as Phaser.Input.Keyboard.Key).isDown;

    let dx = 0, dy = 0;
    if (up)    { dy = -1; this.playerFacing = "up"; }
    if (down)  { dy =  1; this.playerFacing = "down"; }
    if (left)  { dx = -1; this.playerFacing = "left"; }
    if (right) { dx =  1; this.playerFacing = "right"; }

    if (dx !== 0 || dy !== 0) {
      this.lastMoveAt = now;
      sendMessage({ kind: "action", payload: { actorId: "player-1", action: { type: "MOVE", dx, dy } } });
      // 이동 중 walk 애니메이션
      const d = this.actorDisplays.get("player-1");
      if (d?.sprite && this.anims.exists("human_walk")) {
        if (d.sprite.anims.currentAnim?.key !== "human_walk")
          d.sprite.play("human_walk", true);
      }
    }

    // 공격: Space 또는 Z
    const atk = Phaser.Input.Keyboard.JustDown(this.wasd.attack as Phaser.Input.Keyboard.Key)
             || Phaser.Input.Keyboard.JustDown(this.wasd.attackZ as Phaser.Input.Keyboard.Key);
    if (atk) this.doPlayerAttack();
  }

  private doPlayerAttack(): void {
    if (!this.world) return;
    const player = this.world.actors["player-1"];
    if (!player || !player.alive) return;

    // 바라보는 방향 기준으로 공격 대상 찾기
    const facingVec = {
      up:    { dx: 0, dy: -1 }, down:  { dx: 0, dy:  1 },
      left:  { dx: -1, dy: 0 }, right: { dx: 1, dy:  0 },
    }[this.playerFacing];

    const tx = player.x + facingVec.dx;
    const ty = player.y + facingVec.dy;

    // 해당 방향 타일에 있는 적 찾기
    let target = Object.values(this.world.actors)
      .find((a) => a.alive && a.id !== "player-1" && a.x === tx && a.y === ty);

    // 없으면 맨해튼 거리 1 이내 가장 가까운 적
    if (!target) {
      target = Object.values(this.world.actors)
        .filter((a) => a.alive && a.id !== "player-1")
        .sort((a, b) => {
          const da = Math.abs(a.x - player.x) + Math.abs(a.y - player.y);
          const db = Math.abs(b.x - player.x) + Math.abs(b.y - player.y);
          return da - db;
        })[0];
      if (target && (Math.abs(target.x - player.x) + Math.abs(target.y - player.y)) > 1)
        target = undefined;
    }

    if (target) {
      sendMessage({ kind: "action", payload: { actorId: "player-1", action: { type: "ATTACK", targetId: target.id } } });
      this.log(`공격: ${target.name}`);
      // 공격 애니메이션
      const playerD = this.actorDisplays.get("player-1");
      if (playerD?.sprite && this.anims.exists("human_attack")) {
        playerD.sprite.play("human_attack", true);
        this.time.delayedCall(400, () => {
          if (playerD.sprite && this.anims.exists("human_idle"))
            playerD.sprite.play("human_idle", true);
        });
      }
      // 피격 히트 플래시
      const targetD = this.actorDisplays.get(target.id);
      if (targetD) targetD.hitFlash = 300;
      // 300ms 후 상태 갱신
      this.time.delayedCall(300, () => this.scheduleRefresh());
    } else {
      this.log("공격 범위 내 대상 없음");
    }
  }

  // ── Animations ───────────────────────────────────────────────
  private createAnimations(): void {
    const make = (key: string, frames: Phaser.Types.Animations.AnimationFrame[], rate: number) => {
      if (!this.anims.exists(key))
        this.anims.create({ key, frames, frameRate: rate, repeat: -1 });
    };
    make("human_idle",   Array.from({length:2}, (_,i) => ({key:`human_idle_${i+1}`})),   3);
    make("human_walk",   Array.from({length:6}, (_,i) => ({key:`human_walk_${i+1}`})),   8);
    make("human_attack", Array.from({length:3}, (_,i) => ({key:`human_attack_${i+1}`})), 12);
    for (const a of ANIMALS)
      make(`${a}_walk`, Array.from({length:4}, (_,i) => ({key:`${a}_walk_${i+1}`})), 6);
  }

  // ── Input Setup ──────────────────────────────────────────────
  private setupInput(): void {
    this.input.on("pointermove", (ptr: Phaser.Input.Pointer) => {
      const wp = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
      this.cursorTileX = Math.floor(wp.x / TILE_DISP);
      this.cursorTileY = Math.floor(wp.y / TILE_DISP);

      if (this.isDragging) {
        const dx = (ptr.x - this.dragStartX) / this.cameras.main.zoom;
        const dy = (ptr.y - this.dragStartY) / this.cameras.main.zoom;
        this.cameras.main.scrollX = this.dragCamX - dx;
        this.cameras.main.scrollY = this.dragCamY - dy;
      }

      if (ptr.isDown && !ptr.rightButtonDown() && this.tool === "TILE")
        this.handleEditorClick(this.cursorTileX, this.cursorTileY);
    });

    this.input.on("pointerdown", (ptr: Phaser.Input.Pointer) => {
      const startDrag = () => {
        this.isDragging = true;
        this.dragStartX = ptr.x; this.dragStartY = ptr.y;
        this.dragCamX   = this.cameras.main.scrollX;
        this.dragCamY   = this.cameras.main.scrollY;
      };
      if (ptr.rightButtonDown() || this.tool === "MOVE") { startDrag(); return; }
      if (this.mode === "STOP" || this.mode === "PAUSE")
        this.handleEditorClick(this.cursorTileX, this.cursorTileY);
    });

    this.input.on("pointerup", () => { this.isDragging = false; });

    this.input.on("wheel", (_p: Phaser.Input.Pointer, _gx: number, _gy: number, dY: number) => {
      const cam = this.cameras.main;
      const wp  = cam.getWorldPoint(_p.x, _p.y);
      const nz  = Phaser.Math.Clamp(cam.zoom * (dY > 0 ? 0.88 : 1.12), 0.25, 8);
      cam.setZoom(nz);
      const wp2 = cam.getWorldPoint(_p.x, _p.y);
      cam.scrollX -= wp2.x - wp.x;
      cam.scrollY -= wp2.y - wp.y;
    });
  }

  // ── Editor Click ─────────────────────────────────────────────
  private handleEditorClick(tx: number, ty: number): void {
    if (!this.world) return;
    if (tx < 0 || ty < 0 || tx >= this.world.map.width || ty >= this.world.map.height) return;

    switch (this.tool) {
      case "TILE": {
        const asset = this.selectedAsset;
        if (asset?.category === "tile" && asset.tileId !== undefined) {
          const id = asset.tileId;
          if (this.terrainLayer) this.terrainLayer.putTileAt(id, tx, ty);
          if (this.world) {
            if (!this.world.map.terrain[ty]) this.world.map.terrain[ty] = [];
            this.world.map.terrain[ty][tx] = id;
            if (this.fallbackGfx) this.renderFallback();
          }
          sendMessage({ kind: "edit", payload: { type: "PLACE_TILE", layer: "terrain", x: tx, y: ty, tileId: id } });
        } else { this.log("타일을 먼저 선택하세요"); }
        break;
      }
      case "SPAWN":
        if (!this.selectedAsset) { this.log("에셋을 먼저 선택하세요"); break; }
        this.doSpawn(this.selectedAsset, tx, ty);
        break;
      case "SELECT":
        this.doSelect(tx, ty);
        break;
    }
  }

  private doSpawn(asset: SelectedAsset, tx: number, ty: number): void {
    const shortName = (key: string) => {
      const last = key.split(".").pop() ?? key;
      return last
        .replace(/_대기_?\d*$/, "").replace(/_걷기_?\d*$/, "")
        .replace(/_기본공격_?\d*$/, "").replace(/_\d+$/, "")
        .slice(0, 16);
    };
    const post = (url: string, body: unknown) =>
      fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) })
        .then(() => { this.log(`스폰 완료 (${tx},${ty})`); this.scheduleRefresh(); })
        .catch(() => this.log("스폰 실패"));

    switch (asset.category) {
      case "human":  post(`${API}/spawn/actor`, { kind:"npc",     name:shortName(asset.key), x:tx, y:ty, assetKey:asset.key }); break;
      case "animal": post(`${API}/spawn/actor`, { kind:"monster", name:shortName(asset.key), x:tx, y:ty, assetKey:asset.key }); break;
      case "item":   post(`${API}/spawn/item`,  { type:asset.key, x:tx, y:ty, iconKey:asset.key }); break;
      case "object":
        sendMessage({ kind:"edit", payload:{ type:"PLACE_STRUCTURE", structureType:asset.key, x:tx, y:ty, width:1, height:1, assetKey:asset.key } });
        this.log(`구조물 배치 (${tx},${ty})`);
        this.scheduleRefresh();
        break;
    }
  }

  private doSelect(tx: number, ty: number): void {
    if (!this.world) return;
    for (const a of Object.values(this.world.actors)) {
      if (!a.alive) continue;
      if (Math.round(a.x) === tx && Math.round(a.y) === ty) {
        this.selectedId = a.id;
        this.onEntitySelectCb?.({ type:"actor", id:a.id, data:a });
        this.log(`선택: ${a.name} (${a.kind})`);
        return;
      }
    }
    for (const s of Object.values(this.world.structures)) {
      if (tx >= s.x && tx < s.x+s.width && ty >= s.y && ty < s.y+s.height) {
        this.selectedId = s.id;
        this.onEntitySelectCb?.({ type:"structure", id:s.id, data:s });
        this.log(`선택: 구조물 ${s.type}`);
        return;
      }
    }
    for (const item of Object.values(this.world.groundItems)) {
      if (Math.round(item.x) === tx && Math.round(item.y) === ty) {
        this.selectedId = item.id;
        this.onEntitySelectCb?.({ type:"groundItem", id:item.id, data:item });
        this.log(`선택: 아이템 ${item.type}`);
        return;
      }
    }
    const tileId = this.world.map.terrain[ty]?.[tx] ?? 0;
    this.selectedId = null;
    this.onEntitySelectCb?.({ type:"tile", data:{ x:tx, y:ty, tileId, layer:"terrain" } });
  }

  // ── Map ───────────────────────────────────────────────────────
  private updateChangedTiles(prev: number[][], next: number[][]): void {
    if (!this.terrainLayer) return;
    for (let y = 0; y < next.length; y++)
      for (let x = 0; x < (next[y]?.length ?? 0); x++)
        if ((prev[y]?.[x] ?? -1) !== next[y][x])
          this.terrainLayer.putTileAt(next[y][x], x, y);
  }

  private initMap(): void {
    if (!this.world) return;
    this.tileMap?.destroy();
    this.tileMap = null; this.terrainLayer = null; this.decorLayer = null;
    this.fallbackGfx?.clear();

    const { terrain, decor, width, height } = this.world.map;

    if (this.textures.exists("tileset")) {
      try {
        const map = this.make.tilemap({ data:terrain, tileWidth:TILE_SRC, tileHeight:TILE_SRC, width, height });
        const ts  = map.addTilesetImage("tileset","tileset",TILE_SRC,TILE_SRC,0,0);
        if (ts) {
          const layer = map.createLayer(0, ts, 0, 0);
          if (layer) { layer.setScale(TILE_SCALE).setDepth(0); this.terrainLayer = layer; }
          const dd = decor.map((r) => r.map((v) => (v > 0 ? v : -1)));
          const dm = this.make.tilemap({ data:dd, tileWidth:TILE_SRC, tileHeight:TILE_SRC, width, height });
          const dt = dm.addTilesetImage("tileset","tileset",TILE_SRC,TILE_SRC,0,0);
          if (dt) {
            const dl = dm.createLayer(0, dt, 0, 0);
            if (dl) { dl.setScale(TILE_SCALE).setDepth(2); this.decorLayer = dl; }
          }
          this.tileMap = map;
        }
      } catch (e) { console.warn("[WorldScene] tilemap fail", e); this.renderFallback(); }
    } else { this.renderFallback(); }

    this.mapInitialized = true;
    this.cameras.main.setZoom(2);
    this.cameras.main.centerOn(width * TILE_DISP * 0.3, height * TILE_DISP * 0.3);
    this.log(`맵 초기화: ${width}×${height}`);
  }

  private renderFallback(): void {
    if (!this.world) return;
    if (!this.fallbackGfx) this.fallbackGfx = this.add.graphics().setDepth(0);
    const g = this.fallbackGfx; g.clear();
    const { terrain, collision, width, height } = this.world.map;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const blocked = collision[y]?.[x] === 1;
        const t = (terrain[y]?.[x] ?? 0) % 5;
        const c = blocked ? 0x2a1e14 : [0x3a6b3a,0x4a7c4a,0x3d6440,0x5a8a5a,0x6a9e6a][t];
        g.fillStyle(c,1); g.fillRect(x*TILE_DISP, y*TILE_DISP, TILE_DISP, TILE_DISP);
        g.fillStyle(0,0.12); g.fillRect(x*TILE_DISP, y*TILE_DISP, TILE_DISP, 1);
        g.fillRect(x*TILE_DISP, y*TILE_DISP, 1, TILE_DISP);
      }
    }
  }

  // ── Sprite set ────────────────────────────────────────────────
  private spriteSetForActor(actor: Actor): SpriteSet | null {
    const ak = actor.assetKey ?? "";
    if (ak.includes("human") || actor.kind === "npc" || actor.kind === "player") {
      return { idle:"human_idle", walk:"human_walk", attack:"human_attack",
               hasTexture: this.textures.exists("human_idle_1") };
    }
    for (const a of ANIMALS) {
      if (ak.includes(a) || (a==="boar" && actor.kind==="monster")) {
        return { idle:`${a}_walk`, walk:`${a}_walk`, attack:`${a}_walk`,
                 hasTexture: this.textures.exists(`${a}_walk_1`) };
      }
    }
    return null;
  }

  // ── Actor Sync ────────────────────────────────────────────────
  private syncActors(): void {
    if (!this.world) return;
    const alive = new Set(Object.keys(this.world.actors).filter((id) => this.world!.actors[id].alive));

    for (const [id, d] of this.actorDisplays) {
      if (!alive.has(id)) { d.container.destroy(); this.actorDisplays.delete(id); this.actorPrevTile.delete(id); }
    }

    for (const actor of Object.values(this.world.actors)) {
      if (!actor.alive) continue;

      // 목표 픽셀 위치 (타일 중앙 아래쪽, 발이 타일 바닥에 맞도록)
      const targetX = actor.x * TILE_DISP + TILE_DISP * 0.5;
      const targetY = actor.y * TILE_DISP + TILE_DISP * 0.5;

      let d = this.actorDisplays.get(actor.id);
      const isNew = !d;
      if (!d) {
        d = this.buildActorDisplay(actor, targetX, targetY);
        this.actorDisplays.set(actor.id, d);
      }

      d.targetX = targetX;
      d.targetY = targetY;

      // 이동 감지 → 애니메이션 전환
      const prev = this.actorPrevTile.get(actor.id);
      const isMoving = !isNew && prev && (prev.x !== actor.x || prev.y !== actor.y);
      this.actorPrevTile.set(actor.id, { x:actor.x, y:actor.y });

      if (d.sprite) {
        const ss = this.spriteSetForActor(actor);
        if (ss && d.hitFlash <= 0) {
          const targetAnim = isMoving ? ss.walk : ss.idle;
          if (d.sprite.anims.currentAnim?.key !== targetAnim && this.anims.exists(targetAnim))
            d.sprite.play(targetAnim, true);
        }
      }

      // HP 바
      const ratio = actor.maxHp > 0 ? actor.hp / actor.maxHp : 1;
      const bw = TILE_DISP * 1.4, bh = 4;
      const barY = TILE_DISP * 0.35;
      d.hpBar.clear();
      d.hpBar.fillStyle(0x111111, 0.85);
      d.hpBar.fillRect(-bw/2, barY, bw, bh);
      const barColor = ratio > 0.5 ? 0x22cc55 : ratio > 0.25 ? 0xffaa00 : 0xff3322;
      d.hpBar.fillStyle(barColor, 1);
      d.hpBar.fillRect(-bw/2, barY, bw * ratio, bh);

      d.label.setText(actor.name);
    }
  }

  private buildActorDisplay(actor: Actor, startX: number, startY: number): ActorDisplay {
    const container = this.add.container(startX, startY).setDepth(10);
    const ss = this.spriteSetForActor(actor);
    let spr: Phaser.GameObjects.Sprite | null = null;
    let fallback: Phaser.GameObjects.Rectangle | null = null;

    if (ss?.hasTexture) {
      spr = this.add.sprite(0, 0, `${ss.idle}_1`);
      // 발이 타일 중앙에, 몸이 위로 뻗도록: origin 하단 중앙
      const size = (actor.kind==="npc"||actor.kind==="player") ? TILE_DISP*2 : TILE_DISP*1.6;
      spr.setDisplaySize(size, size);
      spr.setOrigin(0.5, 1);
      // 발을 타일 중심 아래로 살짝 (TILE_DISP * 0.4)
      spr.setPosition(0, TILE_DISP * 0.35);
      if (this.anims.exists(ss.idle)) spr.play(ss.idle);
    } else {
      const color = actor.kind==="player" ? 0x3399ff : actor.kind==="npc" ? 0xffaa33 : 0xff4444;
      fallback = this.add.rectangle(0, 0, TILE_DISP*0.9, TILE_DISP*0.9, color)
        .setStrokeStyle(2, 0xffffff, 0.9);
    }

    // 이름 레이블: 스프라이트 위 (타일 상단보다 위)
    const label = this.add.text(0, -(TILE_DISP * 1.2), actor.name, {
      fontSize: "10px", color: "#ffffff",
      stroke: "#000000", strokeThickness: 3,
    }).setOrigin(0.5, 1);

    const hpBar = this.add.graphics();

    const items: Phaser.GameObjects.GameObject[] = [];
    if (spr)      items.push(spr);
    if (fallback) items.push(fallback);
    items.push(label, hpBar);
    container.add(items);

    return { container, sprite:spr, fallback, label, hpBar,
             renderX:startX, renderY:startY, targetX:startX, targetY:startY, hitFlash:0 };
  }

  private updatePlayerCamera(): void {
    const d = this.actorDisplays.get("player-1");
    if (!d) return;
    const cam = this.cameras.main;
    const tx  = d.renderX - cam.width  / 2 / cam.zoom;
    const ty  = d.renderY - cam.height / 2 / cam.zoom;
    cam.scrollX = Phaser.Math.Linear(cam.scrollX, tx, 0.1);
    cam.scrollY = Phaser.Math.Linear(cam.scrollY, ty, 0.1);
  }

  // ── Structures ───────────────────────────────────────────────
  private syncStructures(): void {
    if (!this.world) return;
    const ids = new Set(Object.keys(this.world.structures));
    for (const [id, c] of this.structureObjs)
      if (!ids.has(id)) { c.destroy(); this.structureObjs.delete(id); }
    for (const s of Object.values(this.world.structures)) {
      const wx=s.x*TILE_DISP, wy=s.y*TILE_DISP, ww=s.width*TILE_DISP, wh=s.height*TILE_DISP;
      if (!this.structureObjs.has(s.id)) this.buildStructureDisplay(s, wx, wy, ww, wh);
      else this.structureObjs.get(s.id)!.setPosition(wx, wy);
    }
  }

  private buildStructureDisplay(s: Structure, wx:number, wy:number, ww:number, wh:number): void {
    const url = s.assetKey ? this.catalogCache.get(s.assetKey) : undefined;
    const fallback = () => {
      const c = this.add.container(wx, wy).setDepth(5);
      c.add(this.makeStructureFallback(s.type, ww, wh)); this.structureObjs.set(s.id, c);
    };
    if (s.assetKey && url) {
      const tk = this.textureKeyFor(s.assetKey);
      const build = () => {
        this.structureObjs.get(s.id)?.destroy(); this.structureObjs.delete(s.id);
        const c = this.add.container(wx, wy).setDepth(5);
        c.add(this.add.image(ww/2, wh/2, tk).setDisplaySize(ww, wh)); this.structureObjs.set(s.id, c);
      };
      if (this.textures.exists(tk)) { build(); return; }
      fallback(); this.loadTextureIfNeeded(s.assetKey, url, build); return;
    }
    fallback();
  }

  private makeStructureFallback(lbl:string, ww:number, wh:number): Phaser.GameObjects.GameObject[] {
    const g = this.add.graphics();
    g.fillStyle(0x8b4513, 0.5); g.fillRect(0,0,ww,wh);
    g.lineStyle(2, 0xe8a87c, 1); g.strokeRect(0,0,ww,wh);
    const t = this.add.text(ww/2, wh/2, lbl, {fontSize:"10px",color:"#e8c9a0",stroke:"#000",strokeThickness:1}).setOrigin(0.5);
    return [g, t];
  }

  // ── Ground Items ─────────────────────────────────────────────
  private syncItems(): void {
    if (!this.world) return;
    const ids = new Set(Object.keys(this.world.groundItems));
    for (const [id, c] of this.itemObjs)
      if (!ids.has(id)) { c.destroy(); this.itemObjs.delete(id); }
    for (const item of Object.values(this.world.groundItems)) {
      const wx = item.x*TILE_DISP + TILE_DISP/2, wy = item.y*TILE_DISP + TILE_DISP/2;
      if (!this.itemObjs.has(item.id)) this.buildItemDisplay(item, wx, wy);
      else this.itemObjs.get(item.id)!.setPosition(wx, wy);
    }
  }

  private buildItemDisplay(item: GroundItem, wx:number, wy:number): void {
    const url = item.iconKey ? this.catalogCache.get(item.iconKey) : undefined;
    const fallback = () => {
      const c = this.add.container(wx, wy).setDepth(8);
      c.add(this.makeItemFallback()); this.itemObjs.set(item.id, c);
    };
    if (item.iconKey && url) {
      const tk = this.textureKeyFor(item.iconKey);
      const build = () => {
        this.itemObjs.get(item.id)?.destroy(); this.itemObjs.delete(item.id);
        const c = this.add.container(wx, wy).setDepth(8);
        c.add(this.add.image(0,0,tk).setDisplaySize(TILE_DISP,TILE_DISP)); this.itemObjs.set(item.id, c);
      };
      if (this.textures.exists(tk)) { build(); return; }
      fallback(); this.loadTextureIfNeeded(item.iconKey, url, build); return;
    }
    fallback();
  }

  private makeItemFallback(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    g.fillStyle(0xf4d03f,1); g.fillCircle(0,0,7);
    g.lineStyle(2, 0xb7950b, 1); g.strokeCircle(0,0,7);
    return g;
  }

  // ── Hover + Selection ─────────────────────────────────────────
  private updateHoverGfx(): void {
    this.hoverGfx.clear();
    this.selectionGfx.clear();

    if (this.selectedId && this.world) {
      const actor = this.world.actors[this.selectedId];
      if (actor?.alive) {
        const d = this.actorDisplays.get(this.selectedId);
        const rx = d ? d.renderX - TILE_DISP/2 : actor.x * TILE_DISP;
        const ry = d ? d.renderY - TILE_DISP/2 : actor.y * TILE_DISP;
        this.selectionGfx.lineStyle(2, 0xffff00, 1);
        this.selectionGfx.strokeRect(rx, ry, TILE_DISP, TILE_DISP);
        this.selectionGfx.fillStyle(0xffff00, 0.08);
        this.selectionGfx.fillRect(rx, ry, TILE_DISP, TILE_DISP);
      }
      const s = this.world.structures[this.selectedId];
      if (s) {
        this.selectionGfx.lineStyle(2, 0xffff00, 1);
        this.selectionGfx.strokeRect(s.x*TILE_DISP, s.y*TILE_DISP, s.width*TILE_DISP, s.height*TILE_DISP);
      }
    }

    if (this.mode !== "STOP" && this.mode !== "PAUSE") return;
    if (!this.world || this.cursorTileX < 0 || this.cursorTileY < 0) return;
    if (this.cursorTileX >= this.world.map.width || this.cursorTileY >= this.world.map.height) return;

    const wx = this.cursorTileX * TILE_DISP, wy = this.cursorTileY * TILE_DISP;
    const color = this.tool==="TILE" ? 0x4488ff : this.tool==="SPAWN" ? 0x44ff88 : this.tool==="SELECT" ? 0xffff44 : 0xaaaaaa;
    this.hoverGfx.lineStyle(2, color, 0.9);
    this.hoverGfx.strokeRect(wx, wy, TILE_DISP, TILE_DISP);
    this.hoverGfx.fillStyle(color, 0.12);
    this.hoverGfx.fillRect(wx, wy, TILE_DISP, TILE_DISP);
  }
}

// ── Factory ───────────────────────────────────────────────────────
export const startGame = (container: HTMLDivElement): GameBridge => {
  const scene = new WorldScene();
  const game  = new Phaser.Game({
    type:            Phaser.CANVAS,
    backgroundColor: "#0d1117",
    parent:          container,
    scene:           [scene],
    scale: { mode:Phaser.Scale.RESIZE, width:"100%", height:"100%", autoCenter:Phaser.Scale.CENTER_BOTH },
    dom: { createContainer: false },
  });

  return {
    updateWorld:      (w)  => scene.setWorld(w),
    setMode:          (m)  => scene.setMode(m),
    setTool:          (t)  => scene.setTool(t),
    setSelectedAsset: (a)  => scene.setSelectedAsset(a),
    setCatalog:       (c)  => scene.setCatalog(c),
    onEntitySelect:   (cb) => scene.onEntitySelect(cb),
    onLog:            (cb) => scene.onLog(cb),
    destroy:          ()   => game.destroy(true),
  };
};

export { TILESET_COLS, TILE_SRC };
