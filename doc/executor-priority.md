# Executor Priority

This note documents the current automatic execution paths before further WIW expansion.

## Execution Owners

1. Server tick executors in `tickWorld`
   - Sticky actor state is advanced without another LLM call.
   - Current sticky states: `movePath`, `gatherIntent`, `attackTargetId`/`attackUntil`, `sleeping`.
   - This is the preferred model for actions that naturally continue across ticks.

2. Plan executor in `apps/server/src/brain/loop.ts`
   - Runs validated plan steps and records plan metrics.
   - It should bridge high-level intent to existing dispatchable actions, not bypass dispatch validation.

3. Legacy agenda executor in `apps/server/src/brain/loop.ts`
   - Keeps older goal/agenda behavior alive for compatibility.
   - Treat as transitional. New work should avoid adding behavior here unless it is needed to preserve an existing live flow.

## Tick Order

The server interval in `apps/server/src/main.ts` calls `tickWorld`, drains `world.eventQueue` into `appendRawEvent`, records threat/history side effects, then lets the brain loop schedule or dispatch actor decisions. In practice:

1. Sticky world state advances in world-core.
2. World events are drained to the event log.
3. Brain decisions create atomic actions, plans, or metrics.
4. Dispatch validation remains the final authority for action success/failure.

## Priority Rule

When behavior overlaps, prefer this order:

1. Dispatch validation and world-core invariants.
2. Sticky executor for already-started physical actions.
3. Plan executor for validated multi-step intent.
4. Legacy agenda executor only as compatibility fallback.
5. LLM atomic decision for the current beat.

## Adding A New Action

Use this path:

1. Add or update the shared `ActionRequest` type.
2. Add prompt schema and examples in `apps/server/src/brain/prompt.ts`.
3. Update parser/coercion in the brain loop if the model can omit or alias fields.
4. Implement validation and effects in `packages/world-core/src/actions/dispatchAction.ts`.
5. Emit world events with `category`, `type`, `result`, `reason`, and enough payload for narrative/debugging.
6. Add metric fields or rollups only for observability, not behavior steering.
7. Add focused tests or a smoke script when the action touches stamina, inventory, pathing, or trade state.

## Adding A Station Or Recipe

Use this path:

1. Add catalog data in shared/world-core recipe or station catalogs.
2. Ensure prompt exposure uses canonical ids (`structureId`, item prefix, station kind).
3. Implement crafting/use validation through `dispatchAction`, including skill and input checks.
4. Add narrative/event coverage for success and failure.
5. Keep recipe discovery rules consistent: known recipes are from successful craft; heard recipes come through social facts.

## Direction

Keep sticky executors. Retire legacy agenda behavior once plan and sticky coverage can reproduce its remaining live behaviors.
