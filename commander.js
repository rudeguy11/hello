"use strict";

// ============================================================
// COMMANDER MODULE
// Lets one trusted "owner" player control the bot in chat using
// loose natural phrasing (no strict "!command" syntax required):
// mine blocks, walk to a spot, follow, or stop.
// (Building was removed - it kept placing things in the wrong
// spots. If you want building back later, ask and it can be
// re-added more carefully.)
// ============================================================

const { Movements, goals } = require("mineflayer-pathfinder");
const { GoalNear, GoalFollow, GoalBlock } = goals;

// Words to ignore when picking out the meaningful parts of a sentence.
const FILLERS = new Set([
  "a", "an", "the", "please", "pls", "plz", "to", "for", "me", "now",
  "kindly", "my", "some", "just", "can", "you", "could", "would", "also",
  "then", "and", "with", "of", "up", "one", "out", "little", "small",
]);

// The first meaningful word of the sentence decides which command runs.
const ACTION_SYNONYMS = {
  help: ["help", "commands", "command"],
  stop: ["stop", "cancel", "halt", "quit", "wait"],
  come: ["come"],
  follow: ["follow"],
  goto: ["goto", "go", "walk", "move", "head"],
  mine: ["mine", "dig", "break", "harvest", "chop", "get", "collect"],
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

  // Separate Movements for command tasks (mining/goto) so digging is
  // allowed here without changing how the bot moves while just AFK-idling.
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

  // ---------- HELP ----------
  function sendHelp() {
    say("Just talk to me normally, no ! needed. Examples:");
    say("'mine 10 stone' / 'mine this' / 'go to 100 65 200' / 'come here' / 'follow me' / 'stop'");
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

  // ---------- NATURAL-LANGUAGE COMMAND PARSER ----------
  // No "!" prefix required. The FIRST meaningful word of the message must be
  // a recognized action word (see ACTION_SYNONYMS) or the message is treated
  // as ordinary chat and ignored.
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

    if (action === "help") return sendHelp();

    if (action === "stop") {
      stopEverything();
      say("Stopped - back to wandering around.");
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
