# what_is_world

A generative-agent village simulation. Six residents wake up each day with bodies, hunger, memory, beliefs, relationships, and goals. They talk, trade, gather, craft, fight monsters, reflect on what happened, and slowly become someone slightly different from who the seed wrote them as. You watch.

This repo is the full stack: Fastify + Colyseus server, React/Phaser web client, world-core simulation library, and shared types.

## What you see in a 30-minute live run

- Six villagers wandering, eating, crafting at oven/forge/workbench/alchemy table, trading wheat-for-apple, occasionally fighting wolves at the forest edge.
- Each villager's inner monologue: a rolling 5-beat timeline showing what they felt, what they decided, what they did and why, and how it landed.
- "Lately I find myself..." lines that update from a villager's own decisions — not from a seed, from what they actually did and observed.
- A chronicle that summarizes the day in a few lines.

## Live demo

`https://<your-domain>/wiw` (read-only for visitors)

Visitors see the world, residents, story stream, chronicle pages, and profile cards. Operator actions (editing souls, oracles, talking to residents, switching to edit mode) require an admin token.

## Architecture

- `apps/server` — Fastify HTTP + Colyseus WebSocket. Drives the tick loop, persists souls/observations/snapshots to `data/`, routes brain decisions through a configurable provider.
- `apps/client` — Vite + React + Phaser. Observatory shell for spectators; editor mode for operators. Two-tab Chrome.
- `packages/world-core` — pure simulation: actions, economy, monsters, placement, recipes. No I/O.
- `packages/shared` — types shared between server, client, world-core.

The brain provider is pluggable: `chatgpt-direct` (uses your ChatGPT Plus OAuth at `~/.codex/auth.json`), `local-proxy` (OpenAI-compatible, default `127.0.0.1:18796/v1`), or `mock` (deterministic, no LLM cost). Brain can be disabled entirely for a public demo where residents stand still — the world still ticks.

Semantic memory uses [bge-m3](https://ollama.com/library/bge-m3) via local Ollama at `http://localhost:11434`. Embeddings stay in-memory (LRU cap 5000) and are stripped from on-disk JSONL.

## Cognitive layer

Each villager picks one atomic action per beat (every ~25 LLM-seconds), but the surrounding context aims to make every choice feel grounded:

- **`# MY RECENT BEATS`** — rolling 5-row monologue, one row per LLM call: emotion, priority, next intent, then the action with its `reason`. The villager re-reads this each beat so plans are continuous instead of restarting each tick. Semantically identical rows collapse into one `(×N)` row.
- **`# MY RECENT AGENDA PIVOTS`** — last 1–3 CHANGE/COMPLETE/ABANDON entries with the villager's stated reason for each pivot.
- **`action.reason`** — every non-WAIT action carries a one-clause justification ("easing hunger before the long walk home", "Mira shared with me yesterday, I should bring her this"). Empty reason is treated as a bug, not a feature.
- **`selfNarrative`** — a single first-person line that reflection occasionally writes, gated on real evidence (lifeEvent / completed agenda / relationship moment / death). Renders inside `# IDENTITY` as "Lately I find myself...". A villager doesn't get seeded with one; it accumulates from their own decisions.
- **Death is permanent** — a villager who hits 0 HP stays down. Reviving requires an admin oracle call that delivers a caution message and abandons their stale agenda, so the next beat reasons from "I just fell" rather than continuing their pre-death plan.
- **Importance is magnitude-based** — observations get a score from the actual deltas (Δhp / Δhunger / Δstamina / Δaffinity / Δgold) and any milestone tags, so a dramatic moment stays dramatic in retrieval instead of competing on a flat anchor.

## Run it locally

```
# 1. install
cd apps/what_is_world
npm install

# 2. build (in order)
npm run -w @wiw/shared build
npm run -w @wiw/world-core build
npm run -w @wiw/client build
npm run -w @wiw/server build

# 3. start ollama and pull bge-m3
ollama serve &
ollama pull bge-m3

# 4. set admin token
export WIW_ADMIN_TOKEN="$(openssl rand -hex 24)"

# 5. start the server (from apps/server so data/ resolves correctly)
cd apps/server
UNIFIED=1 API_PORT=3011 \
  CLIENT_DIST="$(pwd)/../client/dist" \
  node dist/main.js
```

Open `http://localhost:3011/wiw` for the spectator view. Click the 🔐 icon (top-right) and paste your `WIW_ADMIN_TOKEN` to unlock operator actions.

For development, use `npm run -w @wiw/server dev` (tsx watch) and `npm run -w @wiw/client dev` (Vite on 5173).

## Environment

| Var | Default | Notes |
|---|---|---|
| `WIW_ADMIN_TOKEN` | (empty) | Required for production. Empty = admin routes are open (dev only). |
| `API_PORT` | `3011` | HTTP port. |
| `UNIFIED` | `1` | If `1`, client and Colyseus share `API_PORT`. If `0`, Colyseus listens on `PORT`. |
| `PORT` | `2568` | Only used when `UNIFIED=0`. |
| `CLIENT_DIST` | `../client/dist` | Path to built client when running from `apps/server`. |
| `VITE_API_URL` | (auto) | Override REST base on the client. Usually leave unset. |
| `VITE_WS_URL` | (auto) | Override WebSocket URL on the client. |

## Auth model

There is no signup, no database of users, no third-party identity provider.

- **Visitor**: any browser. Reads world state, chronicles, profile cards, story stream. WebSocket joins as guest. Cannot mutate anything.
- **Operator**: anyone who pastes the admin token into the gear/lock modal. Token is stored in `localStorage` under `wiw.adminToken` and sent as `Authorization: Bearer <token>`. Same token unlocks: edit mode, brain toggle, soul edits, oracle/disciple, visitor SPEAK injection, chronicle regenerate, snapshot save/load, world reseed, spawn, asset rescan.

The server only checks the token; it doesn't know who is on the other end. Treat it like a shared admin password.

## Brain provider

`POST /config/brain` updates the runtime config (admin only). Read with `GET /config/brain` (public; API key is masked to `hasApiKey`).

- `chatgpt-direct`: uses `~/.codex/auth.json` (the same OAuth file Codex CLI uses). No API key in config. Requires a logged-in Codex session on the host.
- `local-proxy`: any OpenAI-compatible endpoint. Default base URL `http://127.0.0.1:18796/v1`. Set `apiKey` if needed.
- `mock`: rule-based, no LLM. Useful for stress-testing the simulation without cost.

Disable the brain entirely with `enabled: false`. The world keeps ticking; residents just stop generating new actions.

## Persistent data

Everything is stored under `apps/server/data/`:

- `souls/*.jsonl` — one file per actor; values, goals, life events, beliefs.
- `memories/*.jsonl` — one file per actor; observations (perception, action, dialogue, reflection, memory).
- `thoughts/*.jsonl` — one file per actor; the rolling thought state.
- `pause.json` — pause flag (survives tsx-watch reloads).
- `brain-config.json` — runtime brain provider config (contains API key when applicable).
- `chronicle_pages.json` — generated chronicle pages keyed by `dayId`.
- `events-YYYY-MM-DD.ndjson` — daily event log.
- `kpi-snapshots.jsonl`, `history.ndjson`, `snapshots/` — telemetry and world snapshots.

Back up `apps/server/data/` to preserve a save.

## Roadmap

Content layer (next): see `doc/dungeon-boss-season-spec.md` for the worked plan.

- **Seasonal crop windows** — `worldContext.harvestSeason` for ~3-day periods when one or two crops yield 1.5-2× via existing GATHER, no new actions.
- **Outer-area bosses** — kept rule-based; a `BossSpec` on existing monster kinds (`Skeleton King`, `Naga Queen`) with bumped HP/atk and one or two short behavior phases.
- **Epic monsters** — bosses with `command` (focus_fire / flank / retreat_regroup / guard_treasure) that drives nearby same-kind minions. Optional one-line SPEAK at HP thresholds for in-world dialogue.
- **Dungeon interiors** at temple / cemetery / ruins / deep_ruins — `place.interior` with 1-3 layers, shrinking visibility, loot at depth, automatic transition by walking the entry tile.

Adjacent ergonomics:

- Continuous camera follow ("focus mode") for one resident's day.
- Relationship graph view (data exists in `/relationships`).
- Spectator commentary generated from durable lessons.
- Public chronicle tab as a village newspaper.

## Credits

Inspired by Joon Sung Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*. Built with React, Phaser, Fastify, Colyseus, Ollama, and either ChatGPT Plus or a local OpenAI-compatible proxy.

## License

Source code is © 2026 the wiw contributors. Asset license depends on the source pack inside `assets/`.
