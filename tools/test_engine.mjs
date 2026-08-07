#!/usr/bin/env node
// Engine checks. Runs simulate.js in isolation against values the community
// sheets publish, so timing regressions surface as numbers rather than vibes.
//
//   node tools/test_engine.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CLASS_SPEED = { light: 7.0, medium: 5.0, heavy: 3.5 };
const CLASS_HP = { light: 150, medium: 250, heavy: 350 };
const MELEE_RANGE = 2.0;
const DT = 0.01;

// simulate.js expects these from its host (battle_simulator.js in the page,
// cross_analysis_worker.js in a worker).
function parseNum(s) {
  if (!s) return null;
  const m = String(s).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

const src = readFileSync(join(ROOT, 'simulate.js'), 'utf8');
const load = new Function('CLASS_SPEED', 'CLASS_HP', 'MELEE_RANGE', 'DT', 'parseNum',
  src + '\nreturn { simulate, getStats, dropMult, useSeededRandom, useSystemRandom };');
const { simulate, getStats, useSeededRandom, useSystemRandom } =
  load(CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, parseNum);

const WEAPONS = JSON.parse(readFileSync(join(ROOT, 'weapons_s10_cleaned.json'), 'utf8'));
const byName = n => {
  const w = WEAPONS.find(x => x.name.toUpperCase() === n.toUpperCase());
  if (!w) throw new Error(`weapon not found: ${n}`);
  return w;
};

let failures = 0;
const check = (label, actual, expected, tol = 0.02) => {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${actual.toFixed(3)} (expected ${expected})`);
};

// A perfectly accurate duel against a target that never fires back isolates
// the attacker's timeline: result.time is its time to kill. The dummy is
// explicitly non-melee and speedOverride is 0, so it holds the test range
// instead of walking into the attacker and softening its dropoff.
function ttk(weaponName, targetClass, { dist = 5, hs = 0 } = {}) {
  const attacker = byName(weaponName);
  const dummy = {
    name: 'TEST-DUMMY', class: targetClass, type: 'Handgun', firing_mode: 'Single',
    body_dmg: 0, head_damage: 0, rpm: 1, magazine_size: null
  };
  const r = simulate(attacker, dummy, 1, hs, 0, 0, dist, 0, false, 'p1', false);
  return r.time;
}

console.log("\nBURST TIMING (oracle: Krome's 10.0.0 published TTK — the source of weapons_s10_cleaned.json)");
check('93R TTK vs Light', ttk('93R', 'light'), 0.91);
check('93R TTK vs Medium', ttk('93R', 'medium'), 1.43);
check('93R TTK vs Heavy', ttk('93R', 'heavy'), 1.94);
check('FAMAS TTK vs Light', ttk('FAMAS', 'light'), 0.87);
check('FAMAS TTK vs Heavy', ttk('FAMAS', 'heavy'), 2.18);
check('Throwing Knives TTK vs Light', ttk('THROWING KNIVES', 'light'), 0.81);

console.log('\nAUTOMATIC TIMING (plain interval)');
// ARN-220: 17 body, 725 RPM -> 9 shots vs Light -> 8 intervals of 0.0828s.
check('ARN-220 TTK vs Light', ttk('ARN-220', 'light'), 0.66, 0.03);
// M11: 16 body, 1000 RPM -> 10 shots vs Light -> 9 intervals of 0.06s.
check('M11 TTK vs Light', ttk('M11', 'light'), 0.54, 0.03);

console.log('\nRELOAD CROSSING (first principles)');
{
  // 50 damage, 2-round magazine, 60 RPM (1s interval), 2s empty reload.
  // A 350 HP Heavy needs 7 shots. A reload replaces the shot interval rather
  // than adding to it (you fire the moment it completes), so the timeline is
  // 0, 1, [reload] 3, 4, [reload] 6, 7, [reload] 9 -> 9s.
  // The 10ms tick can round each reload up by one tick, hence the tolerance.
  const synthetic = {
    name: 'TEST-2RND', class: 'medium', type: 'Handgun', firing_mode: 'Single',
    body_dmg: 50, head_damage: 50, rpm: 60, magazine_size: 2,
    empty_reload_time: 2, tactical_reload_time: 2
  };
  const dummy = {
    name: 'TEST-DUMMY', class: 'heavy', type: 'Handgun', firing_mode: 'Single',
    body_dmg: 0, head_damage: 0, rpm: 1, magazine_size: null
  };
  const r = simulate(synthetic, dummy, 1, 0, 0, 0, 5, 0, false, 'p1', false);
  check('2-round magazine vs Heavy (3 reloads)', r.time, 9.0, 0.05);
}

console.log('\nMOVEMENT: ranged duellists hold their ground');
{
  const a = byName('FCAR'), b = byName('AKM');
  const r = simulate(a, b, 0, 0, 0, 0, 30, 3, false, 'both', false);
  check('range after 60s with melee mode off', r.dist, 30, 0.001);

  const r2 = simulate(a, b, 0, 0, 0, 0, 30, 3, true, 'both', false);
  const closed = r2.dist < 29;
  if (!closed) failures++;
  console.log(`  ${closed ? 'PASS' : 'FAIL'}  ${'melee mode closes the gap'.padEnd(52)} ${r2.dist.toFixed(2)}m`);
}

console.log('\nMOVEMENT: speedOverride 0 means nobody moves (Meta Simulation model)');
{
  // Stand and fight: even a melee user stays put, so it cannot reach a target
  // held outside its own range.
  const dagger = byName('DAGGER');
  const r = simulate(dagger, byName('AKM'), 1, 0, 0, 0, 20, 0, false, 'p1', false);
  const stayed = Math.abs(r.dist - 20) < 0.001 && r.hits1 === 0;
  if (!stayed) failures++;
  console.log(`  ${stayed ? 'PASS' : 'FAIL'}  ${'Dagger held at 20m lands nothing'.padEnd(52)} ${r.hits1} hits, final range ${r.dist.toFixed(2)}m`);

  // Inside its reach it still connects without moving.
  const close = simulate(dagger, byName('AKM'), 1, 0, 0, 0, 1, 0, false, 'p1', false);
  const connects = close.hits1 > 0;
  if (!connects) failures++;
  console.log(`  ${connects ? 'PASS' : 'FAIL'}  ${'Dagger held at 1m still connects'.padEnd(52)} ${close.hits1} hits`);

  // Ranged weapons are unaffected by the range they are held at, bar dropoff.
  const r2 = simulate(byName('FCAR'), byName('AKM'), 1, 0, 1, 0, 25, 0, false, 'both', false);
  const held = Math.abs(r2.dist - 25) < 0.001;
  if (!held) failures++;
  console.log(`  ${held ? 'PASS' : 'FAIL'}  ${'FCAR vs AKM stays at 25m'.padEnd(52)} ${r2.dist.toFixed(2)}m`);
}

console.log('\nMOVEMENT: melee users advance and connect');
{
  const dagger = byName('DAGGER');
  const r = simulate(dagger, byName('AKM'), 1, 0, 0, 0, 20, 99, false, 'p1', false);
  const hit = r.hits1 > 0;
  if (!hit) failures++;
  console.log(`  ${hit ? 'PASS' : 'FAIL'}  ${'Dagger closes 20m and lands hits'.padEnd(52)} ${r.hits1} hits, final range ${r.dist.toFixed(1)}m`);
}

console.log('\nSTALEMATES (nobody died, so nobody won)');
{
  // simulate() ends a 60 second stalemate by comparing remaining health,
  // which is wrong twice over: it awards a win with no kill, and it
  // compares raw health across classes, so an untouched Light "loses" to
  // a wounded Heavy that still has more points left. Callers must detect
  // a stalemate themselves, by both fighters still standing.
  const sniper = byName('SR-84');
  const heavyTarget = { ...byName('SR-84'), class: 'heavy' };

  useSeededRandom(1);
  const r = simulate(sniper, heavyTarget, 0.02, 0, 0, 0, 50, 0, false, 'p1', false);
  useSystemRandom();

  const nobodyDied = r.hp1 > 0 && r.hp2 > 0;
  const engineNamedAWinner = r.winner !== 'tie';
  // The Light was never shot at; the Heavy was the only one taking damage.
  const engineNamedTheWrongOne = r.winner === 'p2';

  if (!nobodyDied) failures++;
  console.log(`  ${nobodyDied ? 'PASS' : 'FAIL'}  ${'stalemate leaves both fighters standing'.padEnd(52)} hp ${r.hp1.toFixed(0)} vs ${r.hp2.toFixed(0)}`);
  console.log(`  ${engineNamedAWinner ? 'NOTE' : '....'}  ${'...yet the engine still names a winner'.padEnd(52)} "${r.winner}"${engineNamedTheWrongOne ? ' — the fighter that was losing' : ''}`);
  console.log(`        this is why callers test hp1 > 0 && hp2 > 0 instead of trusting winner`);
}

console.log('\nREPRODUCIBILITY');
{
  // A win-rate table nobody can reproduce cannot be checked or debugged,
  // so every roll goes through a generator that can be seeded.
  const a = byName('FCAR'), b = byName('AKM');
  const batch = () => Array.from({ length: 25 }, () =>
    simulate(a, b, 0.75, 0.35, 0.75, 0.35, 25, 0, false, 'p1', false))
    .map(r => `${r.winner}@${r.time.toFixed(2)}`).join(' ');

  useSeededRandom(12345);
  const first = batch();
  useSeededRandom(12345);
  const replay = batch();
  useSeededRandom(54321);
  const otherSeed = batch();
  useSystemRandom();

  const replays = first === replay;
  const seedMatters = first !== otherSeed;
  if (!replays) failures++;
  if (!seedMatters) failures++;
  console.log(`  ${replays ? 'PASS' : 'FAIL'}  ${'same seed replays the same duels'.padEnd(52)}`);
  console.log(`  ${seedMatters ? 'PASS' : 'FAIL'}  ${'a different seed gives different duels'.padEnd(52)}`);
}

console.log('\nDROPOFF');
{
  const lh1 = byName('LH1');                       // 50m -> 55m, ~72% reduction
  const s = getStats(lh1);
  const near = ttk('LH1', 'medium', { dist: 5 });
  const far = ttk('LH1', 'medium', { dist: 60 });
  const worse = far > near;
  if (!worse) failures++;
  console.log(`  ${worse ? 'PASS' : 'FAIL'}  ${'LH1 kills slower past its dropoff range'.padEnd(52)} ${near.toFixed(2)}s at 5m vs ${far.toFixed(2)}s at 60m`);
  console.log(`        (body ${s.bodyDmg}, dropoff ${s.dropMin}-${s.dropMax}m, reduction ${s.dropR})`);
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
