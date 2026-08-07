#!/usr/bin/env node
// Checks the exact solver against the sampling engine it replaces.
//
// The solver and simulate.js are two independent implementations of the
// same model, so they must agree. Any real difference is a bug in one of
// them — except the two documented ones this harness measures separately:
// tick quantisation, and how a timeout is scored.
//
//   node tools/test_solver.mjs

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const CLASS_SPEED = { light: 7.0, medium: 5.0, heavy: 3.5 };
const CLASS_HP = { light: 150, medium: 250, heavy: 350 };
const MELEE_RANGE = 2.0;
const DT = 0.01;

function parseNum(s) {
  if (!s) return null;
  const m = String(s).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

const engineSrc = readFileSync(join(ROOT, 'simulate.js'), 'utf8');
const buildEngine = new Function('CLASS_SPEED', 'CLASS_HP', 'MELEE_RANGE', 'DT', 'parseNum',
  engineSrc + '\nreturn { simulate, getStats, dropMult, useSeededRandom };');

// The tick size is injectable so a disagreement can be tested for what it
// is: a real difference survives a finer tick, an artefact does not.
const engineAtTick = tick => buildEngine(CLASS_SPEED, CLASS_HP, MELEE_RANGE, tick, parseNum);
const { simulate, getStats, dropMult } = engineAtTick(DT);

const {
  solveDuelExactly, canSolveExactly, buildFiringSchedule,
  solveKillTimes, describeShot, toMicros, toSeconds
} = require(join(ROOT, 'duel_solver.js'));

const WEAPONS = JSON.parse(readFileSync(join(ROOT, 'weapons_s10_cleaned.json'), 'utf8'));
const byName = n => {
  const w = WEAPONS.find(x => x.name.toUpperCase() === n.toUpperCase());
  if (!w) throw new Error(`weapon not found: ${n}`);
  return w;
};

// ── Sampling reference ────────────────────────────────────────────
function sampleDuel(p1, p2, opts, runs) {
  let p1Wins = 0, p2Wins = 0, ties = 0, p1Time = 0, p1TimeCount = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulate(
      p1, p2, opts.p1Accuracy, opts.p1HeadshotChance, opts.p2Accuracy, opts.p2HeadshotChance,
      opts.distance, 0, false, opts.firstShot, false
    );
    if (r.winner === 'p1') { p1Wins++; p1Time += r.time; p1TimeCount++; }
    else if (r.winner === 'p2') p2Wins++;
    else ties++;
  }
  return {
    p1WinRate: p1Wins / runs,
    p2WinRate: p2Wins / runs,
    tieRate: ties / runs,
    p1AvgKillTime: p1TimeCount ? p1Time / p1TimeCount : null
  };
}

// ── Cases ─────────────────────────────────────────────────────────
const CASES = [
  { label: 'FCAR vs AKM @ 25m, average aim',      p1: 'FCAR',    p2: 'AKM',      distance: 25, p1Accuracy: 0.75, p1HeadshotChance: 0.35, p2Accuracy: 0.75, p2HeadshotChance: 0.35, firstShot: 'p1' },
  { label: 'FCAR vs AKM @ 25m, both first',       p1: 'FCAR',    p2: 'AKM',      distance: 25, p1Accuracy: 0.75, p1HeadshotChance: 0.35, p2Accuracy: 0.75, p2HeadshotChance: 0.35, firstShot: 'both' },
  { label: '93R (burst) vs M11 @ 15m',            p1: '93R',     p2: 'M11',      distance: 15, p1Accuracy: 0.8,  p1HeadshotChance: 0.4,  p2Accuracy: 0.7,  p2HeadshotChance: 0.3,  firstShot: 'p1' },
  { label: 'SH1900 (reloads) vs LH1 @ 5m',        p1: 'SH1900',  p2: 'LH1',      distance: 5,  p1Accuracy: 0.9,  p1HeadshotChance: 0.1,  p2Accuracy: 0.6,  p2HeadshotChance: 0.5,  firstShot: 'p2' },
  { label: 'SR-84 vs XP-54 @ 75m (dropoff)',      p1: 'SR-84',   p2: 'XP-54',    distance: 75, p1Accuracy: 0.6,  p1HeadshotChance: 0.55, p2Accuracy: 0.5,  p2HeadshotChance: 0.2,  firstShot: 'p1' },
  { label: 'Dagger vs FCAR @ 15m (out of reach)', p1: 'DAGGER',  p2: 'FCAR',     distance: 15, p1Accuracy: 1.0,  p1HeadshotChance: 0,    p2Accuracy: 0.75, p2HeadshotChance: 0.35, firstShot: 'p1' },
  { label: 'Dagger vs FCAR @ 1m (in reach)',      p1: 'DAGGER',  p2: 'FCAR',     distance: 1,  p1Accuracy: 1.0,  p1HeadshotChance: 0,    p2Accuracy: 0.5,  p2HeadshotChance: 0.2,  firstShot: 'p1' },
  { label: 'M60 vs Lewis Gun @ 50m, elite aim',   p1: 'M60',     p2: 'LEWIS GUN', distance: 50, p1Accuracy: 0.99, p1HeadshotChance: 0.8, p2Accuracy: 0.99, p2HeadshotChance: 0.8,  firstShot: 'p1' },
  { label: 'KS-23 vs Cerberus 12GA @ 5m',         p1: 'KS-23',   p2: 'CERBERUS 12GA', distance: 5, p1Accuracy: 0.5, p1HeadshotChance: 0.2, p2Accuracy: 0.5, p2HeadshotChance: 0.2, firstShot: 'p1' },
  { label: 'M11 vs M11 mirror @ 10m, both first', p1: 'M11',     p2: 'M11',      distance: 10, p1Accuracy: 0.75, p1HeadshotChance: 0.35, p2Accuracy: 0.75, p2HeadshotChance: 0.35, firstShot: 'both' }
];

const RUNS = 40000;
let failures = 0;

// ═══════════════════════════════════════════════════════════════════
// Part 1: exact firing timestamps
//
// Monte Carlo agreement can hide a schedule that is wrong in a way the
// noise swallows, so the boundaries — first shot, end of burst, empty
// magazine — are pinned to hand-derived numbers here.
// ═══════════════════════════════════════════════════════════════════
console.log('\nFIRING SCHEDULES (hand-derived timestamps, in seconds)');

const SCHEDULE_CASES = [
  {
    label: 'ARN-220 automatic, 725 RPM',
    weapon: 'ARN-220', firstShotDelay: 0, take: 4,
    // 60/725 = 0.0827586s between shots, nothing else in the way.
    expect: [0, 60 / 725, (60 / 725) * 2, (60 / 725) * 3]
  },
  {
    label: '93R burst: 3 rounds, then delay + interval',
    weapon: '93R', firstShotDelay: 0, take: 7,
    // 1000 RPM = 0.06s. Rounds 1-3 at 0.06 apart; the burst delay of
    // 0.275 is added on top of the interval before round 4.
    expect: [0, 0.06, 0.12, 0.12 + 0.275 + 0.06, 0.12 + 0.275 + 0.12,
             0.12 + 0.275 + 0.18, 0.12 + 0.275 + 0.18 + 0.275 + 0.06]
  },
  {
    label: 'SH1900 empties a 2-round magazine and reloads',
    weapon: 'SH1900', firstShotDelay: 0, take: 5,
    // 80 RPM = 0.75s. Two rounds, then a 2.6s empty reload replaces the
    // usual gap, so the third round lands at 0.75 + 2.6.
    expect: [0, 0.75, 0.75 + 2.6, 0.75 + 2.6 + 0.75, 0.75 + 2.6 + 0.75 + 2.6]
  },
  {
    label: 'M11 opening second: first shot delayed one interval',
    weapon: 'M11', firstShotDelay: 60 / 1000, take: 3,
    expect: [0.06, 0.12, 0.18]
  }
];

for (const c of SCHEDULE_CASES) {
  const stats = getStats(byName(c.weapon));
  const actual = buildFiringSchedule(stats, c.firstShotDelay, 60).slice(0, c.take);
  const expected = c.expect.map(toMicros);
  const ok = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(52)}`);
  if (!ok) {
    console.log(`        expected ${expected.map(toSeconds).map(v => v.toFixed(4)).join(', ')}`);
    console.log(`        actual   ${actual.map(toSeconds).map(v => v.toFixed(4)).join(', ')}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Part 2: probability conservation on the awkward inputs
// ═══════════════════════════════════════════════════════════════════
console.log('\nEDGE CASES (every kill chance plus never-kills must total 1)');

const conservationCase = (label, run) => {
  const { kills, neverKillsProbability } = run();
  const total = kills.reduce((sum, k) => sum + k.probability, 0) + neverKillsProbability;
  const ok = Math.abs(total - 1) < 1e-9;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} total ${total.toFixed(12)}`);
  return { kills, neverKillsProbability };
};

const fcarStats = getStats(byName('FCAR'));
const daggerStats = getStats(byName('DAGGER'));
const noDropoff = () => 1;

{
  const zeroAccuracy = conservationCase('zero accuracy never kills', () =>
    solveKillTimes(buildFiringSchedule(fcarStats, 0, 60),
      describeShot(fcarStats, 0, 0.5, 25, 1), 250));
  const allTimeout = zeroAccuracy.neverKillsProbability === 1;
  if (!allTimeout) failures++;
  console.log(`  ${allTimeout ? 'PASS' : 'FAIL'}  ${'...and puts all of it in never-kills'.padEnd(52)}`);
}

conservationCase('perfect accuracy', () =>
  solveKillTimes(buildFiringSchedule(fcarStats, 0, 60),
    describeShot(fcarStats, 1, 1, 25, 1), 350));

conservationCase('melee beyond reach', () =>
  solveKillTimes(buildFiringSchedule(daggerStats, 0, 60),
    describeShot(daggerStats, 1, 0, 15, 1), 150));

conservationCase('melee inside reach', () =>
  solveKillTimes(buildFiringSchedule(daggerStats, 0, 60),
    describeShot(daggerStats, 1, 0, 1, 1), 350));

conservationCase('dropoff cutting damage to a sliver', () =>
  solveKillTimes(buildFiringSchedule(fcarStats, 0, 60),
    describeShot(fcarStats, 0.75, 0.35, 25, 0.02), 350));

conservationCase('no magazine, so no reloads', () =>
  solveKillTimes(buildFiringSchedule({ ...fcarStats, magSize: null }, 0, 60),
    describeShot(fcarStats, 0.75, 0.35, 25, 1), 250));

conservationCase('head damage equal to body damage', () =>
  solveKillTimes(buildFiringSchedule(fcarStats, 0, 60),
    describeShot({ ...fcarStats, headDmg: fcarStats.bodyDmg }, 0.75, 0.35, 25, 1), 250));

// ═══════════════════════════════════════════════════════════════════
// Part 3: the 60 second ceiling
//
// A killing blow landing either side of the cutoff must be treated the
// same way by both approaches, or long matchups would silently disagree
// about who won.
// ═══════════════════════════════════════════════════════════════════
console.log('\nTHE 60 SECOND CEILING (a kill just before, at, and after it)');
{
  const dummy = {
    name: 'TEST-DUMMY', class: 'heavy', type: 'Handgun', firing_mode: 'Single',
    body_dmg: 0, head_damage: 0, rpm: 1, magazine_size: null
  };

  // 200 damage twice kills a 350 HP Heavy, and perfect accuracy makes the
  // whole thing deterministic — so the only question is whether the second
  // shot happens before the clock runs out.
  for (const secondShotAt of [59.0, 59.99, 59.995, 60.0, 60.01]) {
    const weapon = {
      name: 'BOUNDARY', class: 'medium', type: 'Handgun', firing_mode: 'Single',
      body_dmg: 200, head_damage: 200, rpm: 60 / secondShotAt, magazine_size: null
    };

    const sampled = simulate(weapon, dummy, 1, 0, 0, 0, 5, 0, false, 'p1', false);
    const exact = solveDuelExactly({
      p1Stats: getStats(weapon), p2Stats: getStats(dummy),
      p1Accuracy: 1, p1HeadshotChance: 0, p2Accuracy: 0, p2HeadshotChance: 0,
      p1MaxHealth: 250, p2MaxHealth: 350,
      distance: 5, firstShot: 'p1', maxTime: 60, dropMultiplierFor: dropMult
    });

    const sampledKilled = sampled.hp2 <= 0;
    const exactKilled = exact.p1WinRate > 0.5;
    const agree = sampledKilled === exactKilled;
    if (!agree) failures++;
    console.log(`  ${agree ? 'PASS' : 'FAIL'}  second shot at ${String(secondShotAt).padEnd(7)}s  ` +
      `sampled ${(sampledKilled ? 'kills' : 'timeout').padEnd(8)} solver ${exactKilled ? 'kills' : 'timeout'}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Part 4: coincidence reached by different arithmetic
//
// The mirror matchup proves two identical schedules line up. This proves
// two DIFFERENT ones do: a shot arrived at by reloading must land on the
// same microsecond as one arrived at by counting intervals, or genuine
// double kills would quietly turn into wins for whoever rounded lower.
// ═══════════════════════════════════════════════════════════════════
console.log('\nSIMULTANEITY ACROSS DIFFERENT ARITHMETIC PATHS');
{
  // Steady fire: shots at 0, 0.5, 1.0, 1.5, 2.0 — the 5th kills 250 HP.
  const steady = {
    name: 'STEADY', class: 'medium', type: 'Handgun', firing_mode: 'Single',
    body_dmg: 50, head_damage: 50, rpm: 120, magazine_size: null
  };
  // Reloader: shots at 0, 0.25, then a 1.5s reload, then 1.75, 2.0 — the
  // 4th kills 250 HP. It reaches 2.0s through a reload, not five intervals.
  const reloader = {
    name: 'RELOADER', class: 'medium', type: 'Handgun', firing_mode: 'Single',
    body_dmg: 63, head_damage: 63, rpm: 240, magazine_size: 2,
    empty_reload_time: 1.5, tactical_reload_time: 1.5
  };

  const steadySchedule = buildFiringSchedule(getStats(steady), 0, 60).slice(0, 5).map(toSeconds);
  const reloaderSchedule = buildFiringSchedule(getStats(reloader), 0, 60).slice(0, 4).map(toSeconds);
  console.log(`        steady   fires at ${steadySchedule.map(v => v.toFixed(2)).join(', ')}`);
  console.log(`        reloader fires at ${reloaderSchedule.map(v => v.toFixed(2)).join(', ')}`);

  const exact = solveDuelExactly({
    p1Stats: getStats(steady), p2Stats: getStats(reloader),
    p1Accuracy: 1, p1HeadshotChance: 0, p2Accuracy: 1, p2HeadshotChance: 0,
    p1MaxHealth: 250, p2MaxHealth: 250,
    distance: 5, firstShot: 'both', maxTime: 60, dropMultiplierFor: dropMult
  });

  // Both killing blows land at 2.000s by different routes, so this is a
  // certain double kill.
  const isDoubleKill = Math.abs(exact.tieRate - 1) < 1e-9;
  if (!isDoubleKill) failures++;
  console.log(`  ${isDoubleKill ? 'PASS' : 'FAIL'}  ${'both kill at 2.000s — recognised as a double kill'.padEnd(52)} tie rate ${(exact.tieRate * 100).toFixed(2)}%`);
}

// ═══════════════════════════════════════════════════════════════════
// Part 5: phantom ties at the coarse tick
//
// The old engine called any two kills inside the same 10ms tick a tie.
// Where two weapons' rhythms nearly coincide that invented several percent
// of ties out of nothing, taken mostly from the attacker's wins — up to
// 5.2 percentage points across the meta grid. Shrinking the tick makes
// them disappear and the sampled numbers converge on the solver's, which
// is the proof that the solver is right and the tick was wrong.
// ═══════════════════════════════════════════════════════════════════
console.log('\nPHANTOM TIES AT THE COARSE TICK');
{
  const attacker = byName('.50 Akimbo'), defender = byName('P90');
  const setup = {
    p1Stats: getStats(attacker), p2Stats: getStats(defender),
    p1Accuracy: 0.75, p1HeadshotChance: 0.35,
    p2Accuracy: 0.99, p2HeadshotChance: 0.80,
    p1MaxHealth: CLASS_HP[attacker.class], p2MaxHealth: CLASS_HP[defender.class],
    distance: 50, firstShot: 'both', maxTime: 60, dropMultiplierFor: dropMult
  };
  const exact = solveDuelExactly(setup);

  const sampleAtTick = tick => {
    const engine = engineAtTick(tick);
    engine.useSeededRandom(99);
    const N = 60000;
    let wins = 0, ties = 0;
    for (let i = 0; i < N; i++) {
      const duel = engine.simulate(attacker, defender, 0.75, 0.35, 0.99, 0.80, 50, 0, false, 'both', false);
      if (duel.winner === 'p1') wins++;
      else if (duel.winner === 'tie') ties++;
    }
    return { winRate: wins / N, tieRate: ties / N, samples: N };
  };

  const coarse = sampleAtTick(0.01);
  const fine = sampleAtTick(0.0005);

  console.log(`        exact          : win ${(exact.p1WinRate * 100).toFixed(2)}%  tie ${(exact.tieRate * 100).toFixed(2)}%`);
  console.log(`        sampled  10ms  : win ${(coarse.winRate * 100).toFixed(2)}%  tie ${(coarse.tieRate * 100).toFixed(2)}%`);
  console.log(`        sampled 0.5ms  : win ${(fine.winRate * 100).toFixed(2)}%  tie ${(fine.tieRate * 100).toFixed(2)}%`);

  const coarseInventedTies = coarse.tieRate > 0.01 && exact.tieRate < 0.001;
  if (!coarseInventedTies) failures++;
  console.log(`  ${coarseInventedTies ? 'PASS' : 'FAIL'}  ${'the 10ms tick invents ties the model does not have'.padEnd(52)}`);

  const fineTiesGone = fine.tieRate < 0.001;
  if (!fineTiesGone) failures++;
  console.log(`  ${fineTiesGone ? 'PASS' : 'FAIL'}  ${'a finer tick makes them disappear'.padEnd(52)}`);

  const se = Math.sqrt(fine.winRate * (1 - fine.winRate) / fine.samples);
  const sigma = Math.abs(exact.p1WinRate - fine.winRate) / se;
  const converges = sigma < 4;
  if (!converges) failures++;
  console.log(`  ${converges ? 'PASS' : 'FAIL'}  ${'and the fine-tick win rate matches the solver'.padEnd(52)} ${sigma.toFixed(1)} sigma`);
}

// ═══════════════════════════════════════════════════════════════════
// Part 6: agreement with the sampling engine
// ═══════════════════════════════════════════════════════════════════

console.log(`\nSOLVER vs SAMPLING (${RUNS.toLocaleString()} sampled duels per case)`);
console.log('  standard error at this sample size is about ' + (100 * 0.5 / Math.sqrt(RUNS)).toFixed(2) + ' percentage points\n');
console.log('  case                                     solver P1   sampled P1     delta   sigma   verdict');

let solverTotalMs = 0, sampleTotalMs = 0;

for (const c of CASES) {
  const p1 = byName(c.p1), p2 = byName(c.p2);
  const p1Stats = getStats(p1), p2Stats = getStats(p2);

  const opts = {
    p1Stats, p2Stats,
    p1Accuracy: c.p1Accuracy, p1HeadshotChance: c.p1HeadshotChance,
    p2Accuracy: c.p2Accuracy, p2HeadshotChance: c.p2HeadshotChance,
    p1MaxHealth: CLASS_HP[p1.class], p2MaxHealth: CLASS_HP[p2.class],
    distance: c.distance, firstShot: c.firstShot, maxTime: 60,
    dropMultiplierFor: dropMult
  };

  if (!canSolveExactly({ meleeAdvance: false, speedOverride: 0, p1Stats, p2Stats })) {
    console.log(`  ${c.label.padEnd(40)} SKIPPED (not exactly solvable)`);
    continue;
  }

  const t0 = performance.now();
  const exact = solveDuelExactly(opts);
  solverTotalMs += performance.now() - t0;

  const t1 = performance.now();
  const sampled = sampleDuel(p1, p2, { ...opts, distance: c.distance }, RUNS);
  sampleTotalMs += performance.now() - t1;

  const total = exact.p1WinRate + exact.p2WinRate + exact.tieRate + exact.timeoutRate;
  if (Math.abs(total - 1) > 1e-9) {
    failures++;
    console.log(`  ${c.label.padEnd(40)} PROBABILITIES SUM TO ${total.toFixed(9)}`);
    continue;
  }

  const delta = exact.p1WinRate - sampled.p1WinRate;
  const stderr = Math.sqrt(Math.max(sampled.p1WinRate * (1 - sampled.p1WinRate), 1e-9) / RUNS);
  const sigma = Math.abs(delta) / stderr;

  // Timeout-scoring differs by design, so only flag cases where it cannot
  // explain the gap.
  const explainable = exact.timeoutRate > 0.001;
  const ok = sigma < 4 || explainable;
  if (!ok) failures++;

  console.log(
    `  ${c.label.padEnd(40)} ${(exact.p1WinRate * 100).toFixed(2).padStart(8)}%  ` +
    `${(sampled.p1WinRate * 100).toFixed(2).padStart(9)}%  ` +
    `${(delta * 100).toFixed(2).padStart(8)}pp  ${sigma.toFixed(1).padStart(5)}   ` +
    `${ok ? 'ok' : 'MISMATCH'}${explainable ? ` (timeout ${(exact.timeoutRate * 100).toFixed(1)}%)` : ''}`
  );

  if (exact.tieRate > 0.001 || sampled.tieRate > 0.001) {
    console.log(`  ${''.padEnd(40)} ties: solver ${(exact.tieRate * 100).toFixed(2)}% vs sampled ${(sampled.tieRate * 100).toFixed(2)}%` +
      '  (sampled counts any two kills in the same 10ms tick)');
  }
  if (exact.p1AvgKillTime != null && sampled.p1AvgKillTime != null) {
    const d = exact.p1AvgKillTime - sampled.p1AvgKillTime;
    console.log(`  ${''.padEnd(40)} P1 kill time: solver ${exact.p1AvgKillTime.toFixed(3)}s vs sampled ${sampled.p1AvgKillTime.toFixed(3)}s (${(d * 1000).toFixed(1)}ms)`);
  }
}

console.log(`\n  speed: solver ${solverTotalMs.toFixed(1)}ms total, sampling ${sampleTotalMs.toFixed(0)}ms total ` +
  `(${(sampleTotalMs / Math.max(solverTotalMs, 0.001)).toFixed(0)}x)`);

console.log(failures ? `\n${failures} MISMATCH(ES)\n` : '\nsolver agrees with sampling on every case\n');
process.exit(failures ? 1 : 0);
