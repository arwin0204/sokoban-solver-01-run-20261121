// A Sokoban solver for the make.fun sokoban-solver-01 bounty (Node 22,
// standard library only). It reads every level from /input/<id>/level.txt
// and writes /output/<id>/solution.txt: the player's moves in LURD.
//
// How a level is built (from its RULES): a one-square-wide hallway across
// the middle row, with one to four rooms off it, each room a 6 x 6 slot of
// its own with three or four boxes on as many goals, opening onto the
// hallway by a single door. A box pushed out of a door into the hallway is
// lost, so each room is an independent problem and the level's push-optimal
// count is the sum of its rooms' optima. The solver therefore works room by
// room and joins the rooms by the player's walk along the hallway.
//
// Each room is solved push-optimally by a breadth-first search over pushes:
// a state is the boxes plus the player, and a step is one push — the player
// first walks (freely, pushes are what count) to the square behind a box
// and shoves it one square. Two states that leave the player in the same
// reachable region are the same state, so the search keys a state by its
// boxes and the lowest square its player can reach. The first solved state
// the search meets is push-optimal, and its walk-and-push moves, joined
// across the rooms, are the answer.
//
// No clock is read anywhere: the work is budgeted by states, not by time,
// so two runs write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps, in the order the search tries them: up, down, left, right.
const DIRS = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];
const LETTERS = ['u', 'd', 'l', 'r'];

/** A level in XSB: width, walls, goals, boxes and the player's square. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const box = new Uint8Array(w * h);
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') box[i] = 1;
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goal, box, player };
}

/**
 * The rooms of a level. The hallway is row 8; a room sits in one slot
 * (seven columns wide, sharing its edge walls with the next) above the
 * hallway (its floor rows 1 to 6, its door row 7) or below it (its floor
 * rows 10 to 15, its door row 9). A room is found by the one open square
 * in its door row; its squares are its floor, its door and the hallway
 * square outside the door, which is where its solver starts.
 */
function findRooms(level) {
  const { w, h, wall } = level;
  const HALL = 8;
  const slots = Math.floor((w - 1) / 7);
  const rooms = [];
  for (let slot = 0; slot < slots; slot++) {
    for (let side = 0; side < 2; side++) {
      if (side === 1 && h <= HALL + 2) continue;
      const doorRow = side === 0 ? HALL - 1 : HALL + 1;
      let doorX = -1;
      for (let x = 7 * slot + 1; x <= 7 * slot + 6; x++) {
        if (!wall[doorRow * w + x]) {
          doorX = x;
          break;
        }
      }
      if (doorX === -1) continue;
      const cells = new Set();
      const top = side === 0 ? 1 : HALL + 2;
      const bottom = side === 0 ? 6 : HALL + 7;
      for (let y = top; y <= bottom; y++) {
        for (let x = 7 * slot + 1; x <= 7 * slot + 6; x++) {
          if (!wall[y * w + x]) cells.add(y * w + x);
        }
      }
      cells.add(doorRow * w + doorX);
      cells.add(HALL * w + doorX);
      rooms.push({ slot, side, doorX, entry: HALL * w + doorX, cells });
    }
  }
  return rooms;
}

/**
 * The squares the player reaches from `from`, walking around walls and the
 * boxes in `boxSet`, inside the room's squares; with each square the step
 * that reached it, so a walk to any reached square can be read back.
 */
function reachable(level, room, from, boxSet) {
  const { w } = level;
  const seen = new Set([from]);
  const parent = new Map([[from, -1]]);
  const stepIn = new Map();
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    for (let d = 0; d < 4; d++) {
      const n = c + DIRS[d][1] * w + DIRS[d][0];
      if (!room.cells.has(n)) continue;
      if (boxSet.has(n)) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      parent.set(n, c);
      stepIn.set(n, LETTERS[d]);
      queue.push(n);
    }
  }
  return { seen, parent, stepIn };
}

/** The walk from `from` to `to`, read back through a reachability search. */
function walkBack(parent, stepIn, from, to) {
  const letters = [];
  let c = to;
  while (c !== from) {
    letters.push(stepIn.get(c));
    c = parent.get(c);
  }
  return letters.reverse().join('');
}

/**
 * One room, solved push-optimally from its hallway square: the moves, the
 * boxes where they end (on the room's goals) and the player's last square.
 * The search keys a state by its boxes and the lowest square its player can
 * reach, so states that differ only in where the player stands inside one
 * reachable region count once.
 */
function solveRoom(level, room) {
  const { w, goal } = level;
  const boxes0 = [];
  const goals = [];
  for (const c of room.cells) {
    if (level.box[c]) boxes0.push(c);
    if (goal[c]) goals.push(c);
  }
  boxes0.sort((a, b) => a - b);
  const goalSet = new Set(goals);
  if (boxes0.length === 0) {
    return { moves: '', finalBoxes: [], finalPlayer: room.entry };
  }

  // The lowest square the player reaches from `player`, walking around the
  // boxes: the canonical representative of the player's reachable region.
  // A light flood fill — no walk-back maps, those belong to the expansion.
  const regionLowest = (boxes, player) => {
    const { w } = level;
    const boxSet = new Set(boxes);
    const seen = new Set([player]);
    const queue = [player];
    let lowest = player;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      if (c < lowest) lowest = c;
      for (let d = 0; d < 4; d++) {
        const n = c + DIRS[d][1] * w + DIRS[d][0];
        if (!room.cells.has(n)) continue;
        if (boxSet.has(n)) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return lowest;
  };

  const keyOf = (boxes, player) => boxes.join(',') + '|' + regionLowest(boxes, player);
  const solved = (boxes) => boxes.every((b) => goalSet.has(b));

  const startKey = keyOf(boxes0, room.entry);
  const seen = new Set([startKey]);
  const back = new Map([[startKey, null]]);
  const queue = [{ boxes: boxes0, player: room.entry, key: startKey }];
  let goalKey = null;
  let goalPlayer = room.entry;
  let done = false;
  for (let qi = 0; qi < queue.length && !done; qi++) {
    const st = queue[qi];
    if (solved(st.boxes)) {
      goalKey = st.key;
      goalPlayer = st.player;
      break;
    }
    const boxSet = new Set(st.boxes);
    const region = reachable(level, room, st.player, boxSet);
    for (const b of st.boxes) {
      if (done) break;
      for (let d = 0; d < 4; d++) {
        const step = DIRS[d][1] * w + DIRS[d][0];
        const behind = b - step;
        const ahead = b + step;
        if (!region.seen.has(behind)) continue;
        if (!room.cells.has(ahead)) continue;
        if (boxSet.has(ahead)) continue;
        const next = st.boxes.map((x) => (x === b ? ahead : x)).sort((a, b2) => a - b2);
        const nkey = keyOf(next, b);
        if (seen.has(nkey)) continue;
        seen.add(nkey);
        const walk = walkBack(region.parent, region.stepIn, st.player, behind);
        back.set(nkey, { prev: st.key, moves: walk + LETTERS[d] });
        if (solved(next)) {
          goalKey = nkey;
          goalPlayer = b;
          done = true;
          break;
        }
        queue.push({ boxes: next, player: b, key: nkey });
      }
    }
  }
  if (goalKey === null) return { moves: '', finalBoxes: boxes0, finalPlayer: room.entry };

  const parts = [];
  let k = goalKey;
  while (back.get(k) !== null) {
    const step = back.get(k);
    parts.push(step.moves);
    k = step.prev;
  }
  return { moves: parts.reverse().join(''), finalBoxes: goals, finalPlayer: goalPlayer };
}

/**
 * The shortest walk from `from` to `to` over the whole level, around walls
 * and the boxes as they currently stand; '' when already there.
 */
function walkAcross(level, boxNow, from, to) {
  if (from === to) return '';
  const { w, wall } = level;
  const seen = new Set([from]);
  const parent = new Map([[from, -1]]);
  const stepIn = new Map();
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    for (let d = 0; d < 4; d++) {
      const n = c + DIRS[d][1] * w + DIRS[d][0];
      if (wall[n]) continue;
      if (boxNow[n]) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      parent.set(n, c);
      stepIn.set(n, LETTERS[d]);
      if (n === to) return walkBack(parent, stepIn, from, to);
      queue.push(n);
    }
  }
  return '';
}

/** One level's moves: each room solved in turn, joined by the hallway walk. */
function solveLevel(text) {
  const level = parseLevel(text);
  const rooms = findRooms(level);
  rooms.sort((a, b) => a.slot - b.slot || a.side - b.side);
  const boxNow = new Uint8Array(level.box);
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    moves += walkAcross(level, boxNow, player, room.entry);
    player = room.entry;
    const done = solveRoom(level, room);
    moves += done.moves;
    for (const c of room.cells) if (level.box[c]) boxNow[c] = 0;
    for (const b of done.finalBoxes) boxNow[b] = 1;
    player = done.finalPlayer;
  }
  return moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
