import assert from "node:assert/strict";
import { createWorldState, createMochiVillageState, dispatchAction, tickWorld, createPendingTradeFromIntent, acceptPendingTrade } from "../packages/world-core/src/index";
import { inventoryCountOf } from "../packages/shared/src/index";

function testTradeSettlement() {
  const world = createWorldState();
  const proposer = world.actors["player-1"];
  const receiver = world.actors["npc-1"];
  proposer.gold = 5;
  proposer.inventory = [];
  receiver.gold = 0;
  receiver.inventory = [{ kind: "stack", item: "carrot", count: 2 }];

  createPendingTradeFromIntent(world, proposer.id, receiver.id, { wantItem: "carrot", wantCount: 1, offerGold: 3 });
  const trade = world.pendingTrades?.[0];
  assert.ok(trade, "pending trade should be created");

  const result = acceptPendingTrade(world, receiver.id, trade.id);
  assert.equal(result.ok, true);
  assert.equal(world.pendingTrades?.[0]?.status, "accepted");
  assert.equal(inventoryCountOf(proposer.inventory, "carrot"), 1);
  assert.equal(inventoryCountOf(receiver.inventory, "carrot"), 1);
  assert.equal(proposer.gold, 2);
  assert.equal(receiver.gold, 3);
  assert.ok(world.eventQueue?.some((event) => event.type === "trade_settled"), "trade_settled event should be emitted");
}

function testTradeFailureReason() {
  const world = createWorldState();
  const proposer = world.actors["player-1"];
  const receiver = world.actors["npc-1"];
  proposer.inventory = [];
  receiver.inventory = [];

  createPendingTradeFromIntent(world, proposer.id, receiver.id, { wantItem: "ore", wantCount: 1, offerGold: 1 });
  const trade = world.pendingTrades?.[0];
  assert.ok(trade, "pending trade should be created");

  const result = acceptPendingTrade(world, receiver.id, trade.id);
  assert.equal(result.ok, false);
  assert.equal(result.message, "trade_rejected:missing_want:ore");
  assert.equal(world.pendingTrades?.[0]?.status, "rejected");
  assert.equal(world.pendingTrades?.[0]?.reason, "missing_want:ore");
  assert.ok(world.eventQueue?.some((event) => event.type === "trade_accept_failed:missing_want:ore"), "trade_accept_failed event should include reason");
}

function testRockMining() {
  const world = createMochiVillageState();
  const actor = world.actors["npc-1"];
  const rock = world.structures["structure-rock-1"];
  actor.x = rock.x + 1;
  actor.y = rock.y + 1;
  actor.inventory = [{ kind: "instance", id: "pickaxe-test", item: "pickaxe" }];

  const beforeOre = Object.values(world.groundItems).filter((item) => item.id.startsWith("ore-mine-")).length;
  const result = dispatchAction(world, { actorId: actor.id, action: { type: "USE", objectId: rock.id } });
  assert.equal(result.ok, true);
  assert.match(result.message, /^mined:rock /);
  assert.ok(Object.values(world.groundItems).filter((item) => item.id.startsWith("ore-mine-")).length > beforeOre);
  assert.ok(world.eventQueue?.some((event) => event.type === "mine_success"), "mine_success event should be emitted");
}

function testPendingBreadCraftAddsOutput() {
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  try {
    const world = createWorldState(16, 12);
    const actor = world.actors["player-1"];
    world.actors["animal-1"].alive = false;
    actor.x = 2;
    actor.y = 2;
    actor.stamina = actor.maxStamina;
    actor.inventory = [{ kind: "stack", item: "wheat", count: 2 }];
    const cooking = actor.skills.find((skill) => skill.id === "cooking");
    assert.ok(cooking, "player should have cooking skill");
    cooking.level = 10;
    cooking.xp = 1000;
    world.structures["structure-oven-test"] = {
      id: "structure-oven-test",
      type: "oven",
      x: 8,
      y: 5,
      width: 1,
      height: 1,
      assetKey: "object.feedbox",
      props: { station: "oven" }
    };

    const initial = dispatchAction(world, {
      actorId: actor.id,
      action: { type: "USE", objectId: "structure-oven-test", targetItemId: "bread" }
    });
    assert.equal(initial.ok, true);
    assert.match(initial.message, /^pending_use_approach:/);

    for (let i = 0; i < 40 && inventoryCountOf(actor.inventory, "bread") < 1; i += 1) {
      tickWorld(world);
    }

    assert.equal(inventoryCountOf(actor.inventory, "bread"), 1);
    assert.equal(inventoryCountOf(actor.inventory, "wheat"), 0);
    assert.ok(
      world.eventQueue?.some((event) => event.type === "crafted_output_added" && event.actorId === actor.id),
      "crafted_output_added event should be emitted"
    );
    assert.ok(
      world.eventQueue?.some((event) => event.type === "craft_completed" && event.result === "success" && event.actorId === actor.id),
      "pending use should emit craft_completed success only after real craft"
    );
  } finally {
    Math.random = originalRandom;
  }
}

testTradeSettlement();
testTradeFailureReason();
testRockMining();
testPendingBreadCraftAddsOutput();
console.log("regression checks passed");
