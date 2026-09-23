"use strict";

// ============================================================
// COMMANDER MODULE
// Lets one trusted "owner" player control the bot in chat using
// loose natural phrasing (no strict "!command" syntax required):
// mine blocks, walk to a spot, follow, build simple structures,
// and build a pagoda-style house/village.
// ============================================================

const { Vec3 } = require("vec3");
const { Movements, goals } = require("mineflayer-pathfinder");
const { GoalNear, GoalFollow, GoalBlock } = goals;
const villageBuilder = require("./village");

// Words to ignore when picking out the meaningful parts of a sentence.
const FILLERS = new Set([
  "a", "an", "the", "please", "pls", "plz", "to", "for", "me", "now",
  "kindly", "my", "some", "just", "can", "you", "could", "would", "also",
  "then", "and", "with", "of", "up", "one", "style", "styled", "themed",
  "type", "kind", "out", "little", "small",
]);

// The first meaningful word of the sentence decides which command runs.
const ACTION_SYNONYMS = {
  help: ["help", "commands", "command"],
  stop: ["stop", "cancel", "halt", "quit", "wait"],
  creative: ["creative"],
  come: ["come"],
  follow: ["follow"],
  goto: ["goto", "go", "walk", "move", "head"],
  mine: ["mine", "dig", "break", "harvest", "chop", "get", "collect"],
  give: ["give"],
  build: ["build", "make", "construct", "create"],
};

function classifyAction(firstWord) {
  for (const [canonical, words] of Object.entries(ACTION_SYNONYMS)) {
    if (words.includes(firstWord)) return canonical;
  }
  return null;
}

function commanderModule(bot, mcData, defaultMove, config, addLog, botState) {
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

  function setBusy(value) {
    busy = value;
    if (botState) botState.commanderBusy = value;
  }

  function say(msg) {
    if (bot && bot.chat) bot.chat(msg);
  }

  function stopEverything() {
    cancelRequested = true;
    setBusy(false);
    try {
      bot.pathfinder.stop();
      bot.pathfinder.setGoal(null);
    } catch (e) {
      /* ignore */
    }
  }

  async function withTask(fn) {
    if (busy) {
      say("I'm already doing something - say stop first if you want to cancel it.");
      return;
    }
    setBusy(true);
    cancelRequested = false;
    try {
      await fn();
    } catch (e) {
      addLog(`[Commander] Task error: ${e.message}`);
      say(`Something went wrong: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------- HELP ----------
  function sendHelp() {
    say("Just talk to me normally, no ! needed. Examples:");
    say("'mine 10 stone' / 'mine this' / 'go to 100 65 200' / 'come here' / 'follow me' / 'stop'");
    say("'build a tower 10 cobblestone' / 'build a wall 8 3' / 'build a box 5 4 5 hollow'");
    say("'build a house chinese style' / 'build a village chinese 5 villagers' / 'give me a diamond_block' / 'creative'");
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
      say("I can't tell which block you're looking at - try naming it instead, like 'mine stone'.");
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
    setBusy(true);
    cancelRequested = false;
    bot.pathfinder.setMovements(taskMove);
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);
    say("Following you - say stop when you want me to quit.");
  }

  // ---------- CREATIVE BUILDING ----------
  async function equipCreativeBlock(blockName) {
    const itemDef = mcData.itemsByName[blockName] || mcData.blocksByName[blockName];
    if (!itemDef) throw new Error(`unknown block/item "${blockName}"`);
    if (bot.game.gameMode !== "creative") {
      throw new Error("I need to be in creative mode for this - say 'creative' first (needs OP)");
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

  // ---------- STYLED (PAGODA / "CHINESE MONASTERY" LOOK) BUILDING ----------
  // These use /fill and /setblock (via villageBuilder) instead of placing
  // blocks one at a time - much faster and more reliable for a whole house
  // or village, but it means the bot's account MUST be OP on the server
  // (vanilla restricts /fill, /setblock and /summon to operators).
  async function buildPagodaHouse(originX, originY, originZ, width, depth, wallHeight) {
    const cmds = villageBuilder.chineseHouseCommands(originX, originY, originZ, { width, depth, wallHeight });
    say(`Building a ${width}x${depth} pagoda-style house (${cmds.length} commands) - the bot needs to be OP for this to work...`);
    await villageBuilder.runCommands(bot, cmds, {
      delayMs: 250,
      isCancelled: () => cancelRequested,
    });
    if (!cancelRequested) say("Pagoda house commands sent. If nothing appeared, make sure the bot's account is OP'd.");
  }

  async function buildVillage(count, spawnVillagers) {
    count = Math.max(1, Math.min(count, 9));
    const p = bot.entity.position.floored();
    const { commands, houses } = villageBuilder.chineseVillageCommands(p.x, p.y, p.z, count, {});
    say(`Laying out a ${count}-house pagoda village (${commands.length} commands) - the bot needs to be OP for this to work...`);
    await villageBuilder.runCommands(bot, commands, {
      delayMs: 250,
      isCancelled: () => cancelRequested,
    });
    if (spawnVillagers && !cancelRequested) {
      say("Spawning villagers...");
      const vcmds = villageBuilder.villagerSpawnCommands(houses, 1);
      await villageBuilder.runCommands(bot, vcmds, {
        delayMs: 300,
        isCancelled: () => cancelRequested,
      });
    }
    if (!cancelRequested) say(`Village of ${count} houses sent. If nothing appeared, make sure the bot's account is OP'd.`);
  }

  // ---------- NATURAL-LANGUAGE COMMAND PARSER ----------
  // No "!" prefix required. The FIRST meaningful word of the message must be
  // a recognized action word (see ACTION_SYNONYMS) or the message is treated
  // as ordinary chat and ignored. Everything after that is parsed loosely:
  // filler words are dropped, numbers are pulled out in order regardless of
  // what's between them, and the first leftover word is taken as a block/
  // item/shape name. This lets things like "build me a house chinese style"
  // or "mine 5 stone please" work without exact syntax.
  async function handleCommand(username, rawMessage) {
    let text = rawMessage.trim();
    if (text.startsWith("!")) text = text.slice(1); // still allow the old "!" prefix
    const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const allTokens = cleaned.split(/\s+/).filter(Boolean);
    if (allTokens.length === 0) return;

    const action = classifyAction(allTokens[0]);
    if (!action) return; // ordinary chat, not a command - stay quiet

    const rest = allTokens.slice(1).filter((t) => !FILLERS.has(t));
    const numbers = rest.filter((t) => /^\d+$/.test(t)).map(Number);
    const words = rest.filter((t) => !/^\d+$/.test(t));
    const hollow = rest.includes("hollow");
    const wantsVillagers = rest.some((t) => t.startsWith("villager"));

    if (action === "help") return sendHelp();

    if (action === "stop") {
      stopEverything();
      say("Stopped - back to wandering around.");
      return;
    }

    if (action === "creative") {
      bot.chat("/gamemode creative");
      say("Requested creative mode (needs OP on the server).");
      return;
    }

    if (action === "come") {
      return withTask(() => comeToOwner(username));
    }

    if (action === "follow") {
      return followOwner(username);
    }

    if (action === "goto") {
      const [x, y, z] = numbers;
      if ([x, y, z].some((n) => n === undefined || Number.isNaN(n))) {
        say("Tell me where, like: go to 100 65 200");
        return;
      }
      return withTask(() => goTo(x, y, z));
    }

    if (action === "mine") {
      if (words.includes("this") || words.includes("that") || words.includes("here") || words.length === 0) {
        return withTask(() => mineBlockPlayerLooksAt(username));
      }
      const blockName = words[0];
      const count = Math.min(Math.max(numbers[0] || 1, 1), 64);
      return withTask(() => mineBlockByName(blockName, count));
    }

    if (action === "give") {
      const itemName = words[0];
      if (!itemName) {
        say("What should I give myself? e.g. 'give diamond_block'");
        return;
      }
      return withTask(async () => {
        await equipCreativeBlock(itemName);
        say(`Equipped ${itemName}.`);
      });
    }

    if (action === "build") {
      const shape = (words[0] || "").replace(/s$/, ""); // de-pluralize: houses -> house
      const shapeWords = ["tower", "wall", "platform", "box", "house", "home", "cottage", "village"];
      const extraWords = words.slice(1).filter((w) => !shapeWords.includes(w));
      const p = bot.entity.position.floored();

      return withTask(async () => {
        if (shape === "tower") {
          const height = numbers[0] || 5;
          await buildTower(height, extraWords[0] || "cobblestone");
        } else if (shape === "wall") {
          const length = numbers[0] || 5;
          const height = numbers[1] || 3;
          await buildWall(length, height, extraWords[0] || "cobblestone");
        } else if (shape === "platform") {
          const width = numbers[0] || 5;
          const depth = numbers[1] || width;
          await buildPlatform(width, depth, extraWords[0] || "cobblestone");
        } else if (shape === "box") {
          const width = numbers[0] || 5;
          const height = numbers[1] || 4;
          const depth = numbers[2] || 5;
          await buildBox(width, height, depth, extraWords[0] || "cobblestone", hollow);
        } else if (shape === "house" || shape === "home" || shape === "cottage") {
          const isStyled = extraWords.some((w) =>
            ["chinese", "china", "pagoda", "asian", "monastery", "temple"].includes(w)
          );
          if (isStyled) {
            const width = numbers[0] || 6;
            const depth = numbers[1] || 6;
            const height = numbers[2] || 4;
            await buildPagodaHouse(p.x, p.y, p.z, width, depth, height);
          } else {
            const width = numbers[0] || 5;
            const height = numbers[1] || 4;
            const depth = numbers[2] || 5;
            await buildBox(width, height, depth, extraWords[0] || "cobblestone", hollow);
          }
        } else if (shape === "village") {
          const count = numbers[0] || 4;
          await buildVillage(count, wantsVillagers);
        } else {
          say("I can build: tower, wall, platform, box, house (try saying 'chinese style'), or village.");
        }
      });
    }
  }

  // ---------- CHAT LISTENER ----------
  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (username.toLowerCase() !== ownerName) return;

    handleCommand(username, message.trim()).catch((e) => {
      addLog(`[Commander] Unhandled error: ${e.message}`);
    });
  });

  addLog(`[Commander] Ready - understanding natural commands from ${config.owner}.`);
}

module.exports = { commanderModule };
