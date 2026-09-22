"use strict";

// ============================================================
// COMMANDER MODULE
// Lets one trusted "owner" player control the bot in chat:
// mine blocks, walk to a spot, follow, and build simple
// structures using creative-mode block placement.
// ============================================================

const { Vec3 } = require("vec3");
const { Movements, goals } = require("mineflayer-pathfinder");
const { GoalNear, GoalFollow, GoalBlock } = goals;

function commanderModule(bot, mcData, defaultMove, config, addLog) {
  const ownerName = (config.owner || "").toLowerCase().trim();
  if (!ownerName) {
    addLog("[Commander] No owner set in settings.json - module disabled.");
    return;
  }

  // Separate Movements for command tasks (mining/building/goto) so digging
  // is allowed here without changing how the bot moves while just AFK-idling.
  const taskMove = new Movements(bot, mcData);
  taskMove.canDig = true;
  taskMove.allowFreeMotion = false;

  let cancelRequested = false;
  let busy = false;
  let followInterval = null;

  function say(msg) {
    if (bot && bot.chat) bot.chat(msg);
  }

  function stopEverything() {
    cancelRequested = true;
    if (followInterval) {
      clearInterval(followInterval);
      followInterval = null;
    }
    try {
      bot.pathfinder.stop();
      bot.pathfinder.setGoal(null);
    } catch (e) {
      /* ignore */
    }
  }

  async function withTask(fn) {
    if (busy) {
      say("I'm already doing something - send !stop first if you want to cancel it.");
      return;
    }
    busy = true;
    cancelRequested = false;
    try {
      await fn();
    } catch (e) {
      addLog(`[Commander] Task error: ${e.message}`);
      say(`Something went wrong: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------- HELP ----------
  function sendHelp() {
    say("Commands: !help !mine <block> [count] !mine this !goto x y z !come !follow !stop");
    say("!build box w h d [block] [hollow] | !build wall len h [block] | !build tower h [block] | !build platform w d [block]");
    say("!give <item> [count] (creative only) | !creative");
  }

  // ---------- MINING ----------
  async function mineBlockByName(blockName, count) {
    const blockDef = mcData.blocksByName[blockName];
    if (!blockDef) {
      say(`I don't know a block called "${blockName}".`);
      return;
    }
    let mined = 0;
    for (let i = 0; i < count; i++) {
      if (cancelRequested) {
        say("Mining cancelled.");
        return;
      }
      const target = bot.findBlock({
        matching: blockDef.id,
        maxDistance: 48,
      });
      if (!target) {
        say(`Couldn't find any more ${blockName} nearby (mined ${mined}).`);
        return;
      }
      try {
        bot.pathfinder.setMovements(taskMove);
        await bot.pathfinder.goto(new GoalBlock(target.position.x, target.position.y, target.position.z));
        if (cancelRequested) return;
        const freshBlock = bot.blockAt(target.position);
        if (freshBlock && freshBlock.type === blockDef.id) {
          await bot.dig(freshBlock);
          mined++;
        }
      } catch (e) {
        addLog(`[Commander] Mine error: ${e.message}`);
        say(`Couldn't reach that ${blockName}: ${e.message}`);
        return;
      }
    }
    say(`Done - mined ${mined} ${blockName}.`);
  }

  async function mineBlockPlayerLooksAt(playerName) {
    const player = bot.players[playerName];
    if (!player || !player.entity) {
      say("I can't see you right now - get closer.");
      return;
    }
    const block = bot.blockAtEntityCursor(player.entity, 24);
    if (!block || block.name === "air") {
      say("I can't tell which block you're looking at - try !mine <blockname> instead.");
      return;
    }
    try {
      bot.pathfinder.setMovements(taskMove);
      await bot.pathfinder.goto(new GoalBlock(block.position.x, block.position.y, block.position.z));
      if (cancelRequested) return;
      const freshBlock = bot.blockAt(block.position);
      if (freshBlock && freshBlock.name !== "air") {
        await bot.dig(freshBlock);
        say(`Mined the ${freshBlock.name}.`);
      }
    } catch (e) {
      say(`Couldn't mine that: ${e.message}`);
    }
  }

  // ---------- MOVEMENT ----------
  async function goTo(x, y, z) {
    bot.pathfinder.setMovements(taskMove);
    say(`Heading to ${x}, ${y}, ${z}...`);
    await bot.pathfinder.goto(new GoalNear(x, y, z, 1));
    if (!cancelRequested) say("Arrived.");
  }

  async function comeToOwner(playerName) {
    const player = bot.players[playerName];
    if (!player || !player.entity) {
      say("I can't see you - come closer first.");
      return;
    }
    const pos = player.entity.position;
    bot.pathfinder.setMovements(taskMove);
    say("On my way.");
    await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
    if (!cancelRequested) say("Here.");
  }

  function followOwner(playerName) {
    const player = bot.players[playerName];
    if (!player || !player.entity) {
      say("I can't see you - come closer first.");
      return;
    }
    bot.pathfinder.setMovements(taskMove);
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);
    say("Following you - send !stop to make me quit following.");
  }

  // ---------- CREATIVE BUILDING ----------
  async function equipCreativeBlock(blockName) {
    const itemDef = mcData.itemsByName[blockName] || mcData.blocksByName[blockName];
    if (!itemDef) throw new Error(`unknown block/item "${blockName}"`);
    if (bot.game.gameMode !== "creative") {
      throw new Error("I need to be in creative mode for this - try !creative first (needs OP)");
    }
    const Item = require("prismarine-item")(bot.registry);
    const item = new Item(itemDef.id, 64);
    const slot = bot.inventory.hotbarStart + bot.quickBarSlot;
    await bot.creative.setInventorySlot(slot, item);
    await bot.equip(itemDef.id, "hand");
  }

  // Places one block at (x,y,z) by finding a solid neighbor to place against.
  // Prefers the block directly below (build bottom-up / stack upward).
  async function placeAt(x, y, z) {
    const target = new Vec3(x, y, z);
    const existing = bot.blockAt(target);
    if (existing && existing.boundingBox === "block") return true; // already solid

    const below = bot.blockAt(target.offset(0, -1, 0));
    let ref = null;
    let face = new Vec3(0, 1, 0);
    if (below && below.boundingBox === "block") {
      ref = below;
      face = new Vec3(0, 1, 0);
    } else {
      // fall back: look for any solid neighbor to place against
      const offsets = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0],
      ];
      for (const [dx, dy, dz] of offsets) {
        const neighbor = bot.blockAt(target.offset(dx, dy, dz));
        if (neighbor && neighbor.boundingBox === "block") {
          ref = neighbor;
          face = new Vec3(-dx, -dy, -dz);
          break;
        }
      }
    }
    if (!ref) return false; // nothing to place against yet

    bot.pathfinder.setMovements(taskMove);
    await bot.pathfinder.goto(new GoalNear(x, y, z, 3));
    if (cancelRequested) return false;
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
    await bot.placeBlock(ref, face);
    await sleep(80);
    return true;
  }

  async function buildColumn(x, yStart, height, z, blockName) {
    for (let i = 0; i < height; i++) {
      if (cancelRequested) return;
      await equipCreativeBlock(blockName);
      const ok = await placeAt(x, yStart + i, z);
      if (!ok) {
        say(`Got stuck placing a block at ${x}, ${yStart + i}, ${z} - stopping.`);
        cancelRequested = true;
        return;
      }
    }
  }

  async function buildTower(height, blockName) {
    const p = bot.entity.position.floored();
    say(`Building a ${height}-block tower out of ${blockName}...`);
    await buildColumn(p.x, p.y, height, p.z, blockName);
    if (!cancelRequested) say("Tower done.");
  }

  async function buildWall(length, height, blockName) {
    const p = bot.entity.position.floored();
    say(`Building a wall ${length} long, ${height} tall, out of ${blockName}...`);
    for (let i = 0; i < length; i++) {
      if (cancelRequested) break;
      await buildColumn(p.x + i, p.y, height, p.z, blockName);
    }
    if (!cancelRequested) say("Wall done.");
  }

  async function buildPlatform(width, depth, blockName) {
    const p = bot.entity.position.floored();
    say(`Building a ${width}x${depth} platform out of ${blockName}...`);
    for (let dx = 0; dx < width; dx++) {
      for (let dz = 0; dz < depth; dz++) {
        if (cancelRequested) break;
        await equipCreativeBlock(blockName);
        await placeAt(p.x + dx, p.y - 1, p.z + dz);
      }
      if (cancelRequested) break;
    }
    if (!cancelRequested) say("Platform done.");
  }

  async function buildBox(width, height, depth, blockName, hollow) {
    const p = bot.entity.position.floored();
    say(`Building a ${width}x${height}x${depth} ${hollow ? "hollow" : "solid"} box out of ${blockName}...`);
    for (let dx = 0; dx < width; dx++) {
      for (let dz = 0; dz < depth; dz++) {
        if (cancelRequested) break;
        const isEdge = dx === 0 || dz === 0 || dx === width - 1 || dz === depth - 1;
        if (hollow && !isEdge) continue; // leave the inside empty
        await buildColumn(p.x + dx, p.y, height, p.z + dz, blockName);
      }
      if (cancelRequested) break;
    }
    if (!cancelRequested) say("Box done.");
  }

  // ---------- COMMAND PARSER ----------
  async function handleCommand(username, raw) {
    const body = raw.slice(1).trim(); // strip leading "!"
    const lower = body.toLowerCase();
    const parts = body.split(/\s+/);
    const cmd = (parts[0] || "").toLowerCase();

    if (cmd === "help") return sendHelp();

    if (cmd === "stop" || cmd === "cancel") {
      stopEverything();
      say("Stopped.");
      return;
    }

    if (cmd === "creative") {
      bot.chat("/gamemode creative");
      say("Requested creative mode (needs OP on the server).");
      return;
    }

    if (cmd === "come") {
      return withTask(() => comeToOwner(username));
    }

    if (cmd === "follow") {
      return followOwner(username);
    }

    if (cmd === "goto") {
      const [, xs, ys, zs] = parts;
      const x = parseInt(xs, 10), y = parseInt(ys, 10), z = parseInt(zs, 10);
      if ([x, y, z].some(Number.isNaN)) {
        say("Usage: !goto <x> <y> <z>");
        return;
      }
      return withTask(() => goTo(x, y, z));
    }

    if (cmd === "mine") {
      if (lower.includes("this") || lower.includes("that") || parts.length === 1) {
        return withTask(() => mineBlockPlayerLooksAt(username));
      }
      const blockName = parts[1];
      const count = parts[2] ? parseInt(parts[2], 10) : 1;
      if (!blockName || Number.isNaN(count) || count < 1) {
        say("Usage: !mine <blockname> [count]  or  !mine this");
        return;
      }
      return withTask(() => mineBlockByName(blockName.toLowerCase(), Math.min(count, 64)));
    }

    if (cmd === "give") {
      const itemName = parts[1];
      if (!itemName) {
        say("Usage: !give <item> [count]");
        return;
      }
      return withTask(async () => {
        await equipCreativeBlock(itemName.toLowerCase());
        say(`Equipped ${itemName}.`);
      });
    }

    if (cmd === "build") {
      const shape = (parts[1] || "").toLowerCase();
      return withTask(async () => {
        if (shape === "tower") {
          const height = parseInt(parts[2], 10) || 5;
          const blockName = (parts[3] || "cobblestone").toLowerCase();
          await buildTower(height, blockName);
        } else if (shape === "wall") {
          const length = parseInt(parts[2], 10) || 5;
          const height = parseInt(parts[3], 10) || 3;
          const blockName = (parts[4] || "cobblestone").toLowerCase();
          await buildWall(length, height, blockName);
        } else if (shape === "platform") {
          const width = parseInt(parts[2], 10) || 5;
          const depth = parseInt(parts[3], 10) || 5;
          const blockName = (parts[4] || "cobblestone").toLowerCase();
          await buildPlatform(width, depth, blockName);
        } else if (shape === "box" || shape === "house") {
          const width = parseInt(parts[2], 10) || 5;
          const height = parseInt(parts[3], 10) || 4;
          const depth = parseInt(parts[4], 10) || 5;
          const blockName = (parts[5] || "cobblestone").toLowerCase();
          const hollow = lower.includes("hollow");
          await buildBox(width, height, depth, blockName, hollow);
        } else {
          say("Usage: !build box|wall|tower|platform <dimensions> [block] [hollow]");
        }
      });
    }

    say(`Unknown command "${cmd}". Send !help for the list.`);
  }

  // ---------- CHAT LISTENER ----------
  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (username.toLowerCase() !== ownerName) return;
    if (!message.startsWith("!")) return;

    handleCommand(username, message.trim()).catch((e) => {
      addLog(`[Commander] Unhandled error: ${e.message}`);
    });
  });

  addLog(`[Commander] Ready - listening for "!" commands from ${config.owner}.`);
}

module.exports = { commanderModule };
