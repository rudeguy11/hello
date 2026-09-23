"use strict";

// ============================================================
// VILLAGE BUILDER
// Generates a stylized "Chinese pagoda" house (and a small
// village of them) as a list of /setblock and /fill commands,
// then sends those commands through the bot's chat one at a
// time. Needs the bot to have OP on the server - /fill and
// /setblock (and /summon for villagers) are operator commands.
// ============================================================

function fillCmd(x1, y1, z1, x2, y2, z2, block, mode) {
  const lowX = Math.min(x1, x2), highX = Math.max(x1, x2);
  const lowY = Math.min(y1, y2), highY = Math.max(y1, y2);
  const lowZ = Math.min(z1, z2), highZ = Math.max(z1, z2);
  const base = `/fill ${lowX} ${lowY} ${lowZ} ${highX} ${highY} ${highZ} minecraft:${block}`;
  return mode ? `${base} ${mode}` : base;
}

function setblockCmd(x, y, z, block) {
  return `/setblock ${x} ${y} ${z} minecraft:${block}`;
}

function summonCmd(entity, x, y, z) {
  return `/summon minecraft:${entity} ${x} ${y} ${z}`;
}

// Builds one pagoda-style house with its footprint's south-west
// corner at (ox, oy, oz). Returns an array of command strings.
function chineseHouseCommands(ox, oy, oz, opts = {}) {
  const width = opts.width || 7;
  const depth = opts.depth || 7;
  const wallHeight = opts.wallHeight || 4;
  const cmds = [];

  const top = oy + wallHeight; // topmost wall course

  // Raised stone platform the house sits on.
  cmds.push(fillCmd(ox - 1, oy - 1, oz - 1, ox + width, oy - 1, oz + depth, "stone_bricks"));
  // Wood floor.
  cmds.push(fillCmd(ox, oy, oz, ox + width - 1, oy, oz + depth - 1, "dark_oak_planks"));
  // Hollow walls.
  cmds.push(fillCmd(ox, oy + 1, oz, ox + width - 1, top, oz + depth - 1, "red_terracotta", "hollow"));
  // Corner pillars.
  cmds.push(fillCmd(ox, oy + 1, oz, ox, top, oz, "dark_oak_log"));
  cmds.push(fillCmd(ox + width - 1, oy + 1, oz, ox + width - 1, top, oz, "dark_oak_log"));
  cmds.push(fillCmd(ox, oy + 1, oz + depth - 1, ox, top, oz + depth - 1, "dark_oak_log"));
  cmds.push(fillCmd(ox + width - 1, oy + 1, oz + depth - 1, ox + width - 1, top, oz + depth - 1, "dark_oak_log"));
  // Doorway on the south wall.
  const doorX = ox + Math.floor((width - 2) / 2);
  cmds.push(fillCmd(doorX, oy + 1, oz + depth - 1, doorX + 1, oy + 3, oz + depth - 1, "air"));
  // A couple of window slits on the side walls.
  const midZ = oz + Math.floor(depth / 2);
  cmds.push(setblockCmd(ox, oy + 2, midZ, "red_stained_glass_pane"));
  cmds.push(setblockCmd(ox + width - 1, oy + 2, midZ, "red_stained_glass_pane"));
  // Lanterns flanking the door.
  cmds.push(setblockCmd(doorX - 1, oy + 2, oz + depth - 1, "lantern"));
  cmds.push(setblockCmd(doorX + 2, oy + 2, oz + depth - 1, "lantern"));

  // Tiered "pagoda" roof: gold trim band + black tiled band, each
  // tier shrinking inward by one block as it rises.
  let rx0 = ox - 1, rz0 = oz - 1, rx1 = ox + width, rz1 = oz + depth;
  let ry = top + 1;
  const maxTiers = Math.max(2, Math.min(4, Math.floor(Math.min(width, depth) / 2)));
  for (let t = 0; t < maxTiers && rx1 - rx0 > 1 && rz1 - rz0 > 1; t++) {
    cmds.push(fillCmd(rx0, ry, rz0, rx1, ry, rz1, "gold_block", "hollow"));
    ry++;
    cmds.push(fillCmd(rx0, ry, rz0, rx1, ry, rz1, "black_concrete", "hollow"));
    rx0++; rz0++; rx1--; rz1--;
    ry++;
  }
  // Cap the peak and top it with a lantern finial.
  cmds.push(fillCmd(rx0, ry, rz0, rx1, ry, rz1, "black_concrete"));
  const peakX = Math.floor((rx0 + rx1) / 2);
  const peakZ = Math.floor((rz0 + rz1) / 2);
  cmds.push(setblockCmd(peakX, ry + 1, peakZ, "lantern"));

  return cmds;
}

// Lays out several houses in a ring around (cx, cy, cz), with a
// stone plaza and a bell in the middle. Returns { commands, houses }
// where houses is the list of house origins (useful for populating
// them with villagers afterward).
function chineseVillageCommands(cx, cy, cz, houseCount = 5, opts = {}) {
  const width = opts.width || 7;
  const depth = opts.depth || 7;
  const wallHeight = opts.wallHeight || 4;
  const radius = Math.max(12, Math.round((houseCount * (width + 4)) / (2 * Math.PI)));

  const cmds = [];
  const houses = [];

  // Plaza.
  cmds.push(fillCmd(cx - radius - 3, cy - 1, cz - radius - 3, cx + radius + 3, cy - 1, cz + radius + 3, "andesite"));
  // Bell platform + bell in the centre.
  cmds.push(fillCmd(cx - 1, cy - 1, cz - 1, cx + 1, cy, cz + 1, "stone_bricks"));
  cmds.push(setblockCmd(cx, cy + 1, cz, "bell"));

  for (let i = 0; i < houseCount; i++) {
    const angle = (i / houseCount) * Math.PI * 2;
    const hx = Math.round(cx + Math.cos(angle) * radius) - Math.floor(width / 2);
    const hz = Math.round(cz + Math.sin(angle) * radius) - Math.floor(depth / 2);
    houses.push({ x: hx, y: cy, z: hz, width, depth });
    cmds.push(...chineseHouseCommands(hx, cy, hz, { width, depth, wallHeight }));
    // Short path segment from the house back toward the plaza centre.
    cmds.push(fillCmd(Math.round(cx + Math.cos(angle) * (radius - 2)), cy - 1, Math.round(cz + Math.sin(angle) * (radius - 2)), Math.round(cx + Math.cos(angle) * (radius + 3)), cy - 1, Math.round(cz + Math.sin(angle) * (radius + 3)), "andesite"));
  }

  return { commands: cmds, houses };
}

function villagerSpawnCommands(houses, perHouse = 1) {
  const cmds = [];
  for (const h of houses) {
    for (let i = 0; i < perHouse; i++) {
      const vx = h.x + 1 + i;
      const vz = h.z + 1;
      cmds.push(summonCmd("villager", vx, h.y + 1, vz));
    }
  }
  return cmds;
}

// Sends a list of command strings through bot.chat, one at a time,
// with a short delay to avoid tripping anti-spam / message-rate
// kicks. Calls onProgress(sent, total) periodically. Stops early if
// isCancelled() returns true.
async function runCommands(bot, commands, { delayMs = 250, onProgress, isCancelled } = {}) {
  for (let i = 0; i < commands.length; i++) {
    if (isCancelled && isCancelled()) return i;
    bot.chat(commands[i]);
    if (onProgress && i % 10 === 0) onProgress(i + 1, commands.length);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (onProgress) onProgress(commands.length, commands.length);
  return commands.length;
}

module.exports = {
  chineseHouseCommands,
  chineseVillageCommands,
  villagerSpawnCommands,
  runCommands,
};
