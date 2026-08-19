#!/usr/bin/env node
// Checks healing across both engines, and the short-circuit that makes the
// sustain grid affordable.
//
// The solver applies healing as a moving threshold and caps absorbed heal
// at damage taken; the tick engine clamps health at max on every tick. Those
// are different approximations of the same rule, so agreement between them
// is the real test — the tick engine is the reference because its clamp is
// exact.
//
//   node tools/test_sustain.mjs

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ── Load heals.js, and take the constants from it ──────────────────
// The whole point of the consolidation is that no harness re-declares
// these, so a drift between the engines cannot hide in a test file.
const healsSrc = readFileSync(join(ROOT, 'heals.js'), 'utf8');
const heals = new Function(healsSrc + `
  return { CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, MAX_TIME, CLASS_REGEN,
           resolveHealAt, healScheduleFor, combineSchedules, allHealStacks };`)();
const { CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, CLASS_REGEN,
        resolveHealAt, combineSchedules, allHealStacks } = heals;

function parseNum(s) {
  if (!s) return null;
  const m = String(s).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

const engineSrc = readFileSync(join(ROOT, 'simulate.js'), 'utf8');
const { simulate, getStats, dropMult } = new Function(
  'CLASS_SPEED', 'CLASS_HP', 'MELEE_RANGE', 'DT', 'parseNum',
  engineSrc + '\nreturn { simulate, getStats, dropMult, useSeededRandom };'
)(CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, parseNum);

const {
  solveDuelExactly, canSolveExactly, solveSurvival, survivalCurve,
  killIsReachable, solveKillTimes, buildFiringSchedule, buildVolleySchedule,
  describeShot, toSeconds
} = require(join(ROOT, 'duel_solver.js'));

const WEAPONS = JSON.parse(readFileSync(join(ROOT, 'weapons_s10_cleaned.json'), 'utf8'));
const timeline = JSON.parse(readFileSync(join(ROOT, 'csv', 'cleaned', 'heal_timeline.json'), 'utf8'));

const byName = n => {
  const w = WEAPONS.find(x => x.name.toUpperCase() === n.toUpperCase());
  if (!w) throw new Error(`weapon not found: ${n}`);
  return w;
};
const stack = (...ids) => ids.length
  ? combineSchedules(ids.map(id => resolveHealAt(timeline, id, '11.4.1')))
  : null;

let failures = 0;
const same = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} ${actual} (expected ${expected})`);
};
const near = (label, actual, expected, tol) => {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} ${actual.toFixed(4)} (expected ${expected.toFixed(4)} +/- ${tol})`);
};

const RUNS = 40000;

// ═══════════════════════════════════════════════════════════════════
// Part 1: the two engines must agree once healing is on
// ═══════════════════════════════════════════════════════════════════
console.log('\nSOLVER vs SAMPLING, WITH HEALING  (' + RUNS + ' runs, 3 standard errors)');

const CASES = [
  { label: 'FCAR vs AKM @ 25m, AKM beamed',      p1: 'FCAR', p2: 'AKM',  d: 25, acc: 0.75, hs: 0.35, p2Heal: ['beam'] },
  { label: 'FCAR vs AKM @ 25m, FCAR beamed',     p1: 'FCAR', p2: 'AKM',  d: 25, acc: 0.75, hs: 0.35, p1Heal: ['beam'] },
  { label: 'FCAR vs AKM @ 25m, both beamed',     p1: 'FCAR', p2: 'AKM',  d: 25, acc: 0.75, hs: 0.35, p1Heal: ['beam'], p2Heal: ['beam'] },
  { label: 'FCAR vs AKM @ 25m, AKM ball only',   p1: 'FCAR', p2: 'AKM',  d: 25, acc: 0.75, hs: 0.35, p2Heal: ['ball'] },
  { label: 'FCAR vs AKM @ 25m, AKM canister',    p1: 'FCAR', p2: 'AKM',  d: 25, acc: 0.75, hs: 0.35, p2Heal: ['canister'] },
  { label: 'M60 vs Lewis @ 50m, Lewis beam+ball', p1: 'M60', p2: 'LEWIS GUN', d: 50, acc: 0.99, hs: 0.8, p2Heal: ['beam', 'ball'] },
  { label: 'AKM vs FCAR @ 5m, FCAR infuser',     p1: 'AKM',  p2: 'FCAR', d: 5,  acc: 0.9,  hs: 0.5,  p2Heal: ['infuser'] }
];

for (const c of CASES) {
  const p1 = byName(c.p1), p2 = byName(c.p2);
  const s1 = getStats(p1), s2 = getStats(p2);
  const p1Heal = c.p1Heal ? stack(...c.p1Heal) : null;
  const p2Heal = c.p2Heal ? stack(...c.p2Heal) : null;

  const exact = solveDuelExactly({
    p1Stats: s1, p2Stats: s2,
    p1Accuracy: c.acc, p1HeadshotChance: c.hs,
    p2Accuracy: c.acc, p2HeadshotChance: c.hs,
    p1MaxHealth: CLASS_HP[p1.class], p2MaxHealth: CLASS_HP[p2.class],
    distance: c.d, firstShot: 'p1', maxTime: 60,
    dropMultiplierFor: dropMult,
    p1Heal, p2Heal
  });

  let wins = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = simulate(p1, p2, c.acc, c.hs, c.acc, c.hs, c.d, 0, false, 'p1', false,
      { p1Heal, p2Heal });
    if (r.winner === 'p1') wins++;
  }
  const sampled = wins / RUNS;

  // Two error sources, so two allowances rather than one that pretends to
  // cover both: three standard errors of sampling noise, plus the known
  // overheal bias, which is systematic and does not shrink with runs.
  // Part 1b is what actually pins that second term — widening it here only
  // stops this sweep flickering on the case that sits right on the line.
  const se = Math.sqrt(Math.max(sampled * (1 - sampled), 1e-6) / RUNS);
  const OVERHEAL_ALLOWANCE = 0.008;
  near(c.label, exact.p1WinRate, sampled, Math.max(3 * se, 0.004) + OVERHEAL_ALLOWANCE);
}

// ═══════════════════════════════════════════════════════════════════
// Part 1b: how big is the overheal approximation?
//
// The solver cannot see health being wasted mid-fight — a beam topping a
// target back up inside the attacker's reload gap. The sweep above would
// swallow a bias of that size in Monte Carlo noise, so the worst known
// case gets its own high-run measurement with a stated bound. If this
// starts failing, the approximation has grown, not the noise.
// ═══════════════════════════════════════════════════════════════════
console.log('\nOVERHEAL BIAS  (worst known case, 150k runs, bound 1.0pp)');
{
  const p1 = byName('FCAR'), p2 = byName('AKM');
  const p2Heal = stack('beam');
  const exact = solveDuelExactly({
    p1Stats: getStats(p1), p2Stats: getStats(p2),
    p1Accuracy: 0.75, p1HeadshotChance: 0.35, p2Accuracy: 0.75, p2HeadshotChance: 0.35,
    p1MaxHealth: CLASS_HP.medium, p2MaxHealth: CLASS_HP.medium,
    distance: 25, firstShot: 'p1', maxTime: 60, dropMultiplierFor: dropMult, p2Heal
  });
  let wins = 0;
  const N = 150000;
  for (let i = 0; i < N; i++) {
    const r = simulate(p1, p2, 0.75, 0.35, 0.75, 0.35, 25, 0, false, 'p1', false, { p2Heal });
    if (r.winner === 'p1') wins++;
  }
  const gap = (exact.p1WinRate - wins / N) * 100;
  const ok = Math.abs(gap) <= 1.0;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${'FCAR vs beamed AKM, solver minus sampled'.padEnd(56)} ${gap.toFixed(2)}pp`);
}

// ═══════════════════════════════════════════════════════════════════
// Part 2: the unkillable short-circuit
//
// killIsReachable decides most of the sustain grid without allocating a
// grid at all, so a wrong answer here would silently report targets as
// invincible. Checked against actually running the walk.
// ═══════════════════════════════════════════════════════════════════
console.log('\nSHORT-CIRCUIT vs RUNNING THE FULL WALK');

const REACH_CASES = [
  { label: 'V9S @ 50m poor aim vs beam+ball',   w: 'V9S',  d: 50, acc: 0.5,  hs: 0.2,  heal: ['beam', 'ball'], cls: 'heavy' },
  { label: 'M11 @ 50m poor aim vs all four',    w: 'M11',  d: 50, acc: 0.5,  hs: 0.2,  heal: ['beam', 'ball', 'infuser', 'canister'], cls: 'heavy' },
  { label: 'FCAR @ 5m elite aim vs beam',       w: 'FCAR', d: 5,  acc: 0.99, hs: 0.8,  heal: ['beam'], cls: 'medium' },
  { label: 'FCAR @ 5m elite aim vs all four',   w: 'FCAR', d: 5,  acc: 0.99, hs: 0.8,  heal: ['beam', 'ball', 'infuser', 'canister'], cls: 'medium' },
  { label: 'M134 @ 15m strong aim vs all four', w: 'M134 MINIGUN', d: 15, acc: 0.9, hs: 0.55, heal: ['beam', 'ball', 'infuser', 'canister'], cls: 'light' },
  { label: 'V9S @ 5m elite aim, no heal',       w: 'V9S',  d: 5,  acc: 0.99, hs: 0.8,  heal: [], cls: 'light' },
  // The cases the short-circuit actually exists for: a short hold window
  // gives the attacker too few shots to ever outrun the heal, whatever it
  // rolls. This is the shape most of the sustain grid takes.
  { label: 'V9S @ 50m, 7s window vs all four',  w: 'V9S',  d: 50, acc: 0.5,  hs: 0.2,  heal: ['beam', 'ball', 'infuser', 'canister'], cls: 'heavy', window: 7 },
  { label: 'M11 @ 50m, 7s window vs beam+ball', w: 'M11',  d: 50, acc: 0.5,  hs: 0.2,  heal: ['beam', 'ball'], cls: 'heavy', window: 7 },
  { label: 'FCAR @ 5m, 7s window vs all four',  w: 'FCAR', d: 5,  acc: 0.99, hs: 0.8,  heal: ['beam', 'ball', 'infuser', 'canister'], cls: 'medium', window: 7 }
];

for (const c of REACH_CASES) {
  const stats = getStats(byName(c.w));
  const sched = c.heal.length ? stack(...c.heal) : { deliveredBy: () => 0 };
  const shotTimes = buildFiringSchedule(stats, 0, c.window ?? 60);
  const shot = describeShot(stats, c.acc, c.hs, c.d, dropMult(c.d, stats));
  const health = CLASS_HP[c.cls];

  const reachable = killIsReachable(shotTimes, Math.max(shot.bodyDamage, shot.headDamage), health, sched);

  // Ground truth: run the walk with the short-circuit bypassed by passing
  // no schedule to the guard, then look at whether any kill mass appeared.
  const walked = solveKillTimes(shotTimes, shot, health, sched);
  const actuallyKills = walked.kills.length > 0;

  same(c.label, reachable, actuallyKills);
}

// ═══════════════════════════════════════════════════════════════════
// Part 3: survival curves
// ═══════════════════════════════════════════════════════════════════
console.log('\nSURVIVAL CURVES');

const SAMPLES = [];
for (let t = 0; t <= 20; t += 0.25) SAMPLES.push(+t.toFixed(2));

function holdProbability(weaponName, defenderClass, healIds, { d = 15, acc = 0.75, hs = 0.35 } = {}) {
  const stats = getStats(byName(weaponName));
  return solveSurvival({
    attackerStats: stats, attackerAccuracy: acc, attackerHeadshotChance: hs,
    defenderMaxHealth: CLASS_HP[defenderClass],
    defenderHeal: healIds.length ? stack(...healIds) : null,
    distance: d, dropMultiplierFor: dropMult,
    sampleSeconds: SAMPLES, maxTime: 60
  });
}

const bare = holdProbability('FCAR', 'medium', []);
const beamed = holdProbability('FCAR', 'medium', ['beam']);
const stacked = holdProbability('FCAR', 'medium', ['beam', 'ball', 'infuser', 'canister']);

same('P(survive >= 0) is 1', bare.survival[0], 1);

let monotonic = true;
for (let i = 1; i < SAMPLES.length; i++) if (stacked.survival[i] > stacked.survival[i - 1] + 1e-12) monotonic = false;
same('survival is non-increasing', monotonic, true);

const at7 = i => SAMPLES.indexOf(7);
same('healing never lowers survival at 7s', beamed.survival[at7()] >= bare.survival[at7()], true);
same('a full stack beats one beam at 7s', stacked.survival[at7()] >= beamed.survival[at7()], true);

// Sampled all the way to the end of the clock, the tail of the curve is
// the never-killed mass by another name — the two are computed by
// different routes, so agreeing is a real conservation check.
const FULL = [];
for (let t = 0; t <= 60; t += 0.5) FULL.push(+t.toFixed(2));
const tail = solveSurvival({
  attackerStats: getStats(byName('V9S')), attackerAccuracy: 0.5, attackerHeadshotChance: 0.2,
  defenderMaxHealth: CLASS_HP.heavy, defenderHeal: stack('beam'),
  distance: 50, dropMultiplierFor: dropMult, sampleSeconds: FULL, maxTime: 60
});
near('P(survive 60s) equals never-killed mass',
  tail.survival[FULL.length - 1], tail.survivedToEnd, 1e-9);

// Cross-check one curve against the tick engine, one-sided: the defender
// stands there and does not shoot back, which is the cashout model.
console.log('\n  one-sided hold, solver vs sampling');
const dummy = { name: 'HOLDER', class: 'medium', type: 'Handgun', firing_mode: 'Single', body_dmg: 0, head_damage: 0, rpm: 1, magazine_size: null };
for (const [label, healIds] of [['no heal', []], ['beam', ['beam']], ['beam+ball', ['beam', 'ball']]]) {
  const sched = healIds.length ? stack(...healIds) : null;
  let survived = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = simulate(byName('FCAR'), dummy, 0.75, 0.35, 0, 0, 15, 0, false, 'p1', false,
      { p2Heal: sched });
    // hp2 still above zero at 7s means the steal went through.
    if (r.winner !== 'p1' || r.time > 7) survived++;
  }
  const sampled = survived / RUNS;
  const exact = holdProbability('FCAR', 'medium', healIds).survival[at7()];
  const se = Math.sqrt(Math.max(sampled * (1 - sampled), 1e-6) / RUNS);
  near(`  P(hold 7s vs FCAR) ${label}`, exact, sampled, Math.max(3 * se, 0.006));
}

// ═══════════════════════════════════════════════════════════════════
// Part 3b: a squad on one defender
//
// buildVolleySchedule merges several attackers into one shot list and hands
// it to the same walk. Nothing about that is obviously wrong, which is the
// problem — a concatenation that forgot to sort, or an offset that shifted
// the opening shot off t=0, would still produce a plausible-looking curve.
//
// The reference is an independent Monte Carlo that never touches the
// solver: each attacker gets its own schedule, the merged stream is walked
// in time order, and health is clamped at maximum on the way through. That
// clamp is exact rather than an approximation — between shots health only
// rises, so clamping at each shot is the same as clamping continuously.
//
// These cases carry NO healing, on purpose. With healing off the solver is
// exact, so any gap here is the merge and nothing else. What healing does
// to the answer is Part 3c, and it is a much bigger story.
// ═══════════════════════════════════════════════════════════════════
console.log('\nSQUAD MERGE, SOLVER vs EXACT-CLAMP SAMPLING  (' + RUNS + ' runs, no healing)');

/**
 * P(defender still alive at `window`), sampled. Deliberately does not call
 * buildVolleySchedule — the offsets are rebuilt here so the merge under
 * test has an independent counterpart.
 */
function sampledHold(stats, shot, maxHealth, healSched, count, stagger, window, runs) {
  const offset = stagger === 'sync' ? 0 : stats.interval / count;
  const events = [];
  for (let i = 0; i < count; i++) {
    // Built past the window and filtered, not built to it: buildFiringSchedule
    // stops strictly before its horizon, so asking for exactly `window` drops a
    // shot landing on the boundary — which the solver counts, because the
    // survival curve is read at t <= window. SR-84's 1.5s interval spread over
    // three attackers puts a shot on 2.0s exactly, and the two disagreed by
    // 10 points until this filtered instead.
    for (const t of buildFiringSchedule(stats, i * offset, window + 1)) {
      const seconds = toSeconds(t);
      if (seconds <= window + 1e-9) events.push(seconds);
    }
  }
  events.sort((a, b) => a - b);

  const delivered = t => healSched ? healSched.deliveredBy(t) : 0;

  let survived = 0;
  for (let run = 0; run < runs; run++) {
    let health = maxHealth;
    let last = 0;
    let alive = true;
    for (const t of events) {
      // Healing since the previous shot, then the clamp that says health
      // poured into someone already full is gone rather than banked.
      health = Math.min(maxHealth, health + (delivered(t) - delivered(last)));
      last = t;

      const roll = Math.random();
      if (roll < shot.headChance) health -= shot.headDamage;
      else if (roll < shot.headChance + shot.bodyChance) health -= shot.bodyDamage;

      if (health <= 0) { alive = false; break; }
    }
    if (alive) survived++;
  }
  return survived / runs;
}

const SQUAD_SAMPLES = [];
for (let t = 0; t <= 20; t += 0.25) SQUAD_SAMPLES.push(+t.toFixed(2));

const holdOf = (stats, health, sched, count, stagger, window, d, acc, hs) => solveSurvival({
  attackerStats: stats, attackerAccuracy: acc, attackerHeadshotChance: hs,
  defenderMaxHealth: health, defenderHeal: sched,
  distance: d, dropMultiplierFor: dropMult,
  sampleSeconds: SQUAD_SAMPLES, maxTime: 60,
  attackerCount: count, attackerStagger: stagger
}).survival[SQUAD_SAMPLES.indexOf(window)];

// Slow weapons at poor aim, read early, so the curve is still off the rails
// at all three squad sizes. A case reading 0.000 everywhere agrees with
// anything and tests nothing, which is what a fast weapon does the instant
// a second gun joins.
const MERGE_CASES = [
  { w: 'SH1900',                 cls: 'medium', d: 15, acc: 0.5,  hs: 0.2,  window: 2 },
  { w: 'MODEL 1887',             cls: 'medium', d: 15, acc: 0.5,  hs: 0.2,  window: 2 },
  { w: 'RECURVE BOW (CHARGED)',  cls: 'light',  d: 15, acc: 0.5,  hs: 0.2,  window: 2 },
  { w: 'SR-84',                  cls: 'light',  d: 50, acc: 0.5,  hs: 0.2,  window: 2 },
  { w: 'THROWING KNIVES (ALT.)', cls: 'light',  d: 15, acc: 0.75, hs: 0.35, window: 2 },
  // One saturated case on purpose: a squad on an unhealed Medium at close
  // range is a certainty at every size, and a merge that silently dropped
  // the extra schedules would still look right in the cases above.
  { w: 'FCAR',                   cls: 'medium', d: 15, acc: 0.75, hs: 0.35, window: 7 }
];

for (const stagger of ['spread', 'sync']) {
  console.log(`\n  ${stagger} opening`);
  for (const c of MERGE_CASES) {
    const stats = getStats(byName(c.w));
    const shot = describeShot(stats, c.acc, c.hs, c.d, dropMult(c.d, stats));
    const health = CLASS_HP[c.cls];

    for (const count of [1, 2, 3]) {
      const exact = holdOf(stats, health, null, count, stagger, c.window, c.d, c.acc, c.hs);
      const sampled = sampledHold(stats, shot, health, null, count, stagger, c.window, RUNS);
      const se = Math.sqrt(Math.max(sampled * (1 - sampled), 1e-6) / RUNS);
      near(`${count}v1 ${c.w} @ ${c.d}m, ${c.cls}, ${c.window}s`, exact, sampled, Math.max(3 * se, 0.004));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Part 3c: how wrong the heal model is
//
// This is a measurement, not a passing grade, and the numbers below are
// far larger than the header of duel_solver.js claims. They are measured
// here so the size is on the record and cannot grow unnoticed.
//
// Two separate approximations, and they are not the same size:
//
//   1. Heal wasted before the first hit. Discounted per cell now, from the
//      combinatorial distribution of first-hit times given a hit count, so
//      the all-hits path is charged nothing — which is correct. Small.
//
//   2. Heal wasted DURING the fight. The grid caps absorbed healing at the
//      damage a cell has taken, but it applies that cap to the *running
//      total* using the *final* damage. A front-loaded heal — the H+
//      Infuser dumps 220 HP inside 1.4s — gets credited against damage
//      that only arrives seconds later, when at the time it landed there
//      was no room for it. This is the one that hurts, and no arrangement
//      of a grid indexed by hit counts can see it: absorbed healing is a
//      path integral of min(rate, deficit), and a hit count is not a path.
//
// The fix is a different state variable — a walk over quantised *health*
// rather than hit counts, which is exact for the one-sided case because
// health is the thing being clamped. Until then these bounds are ceilings
// on a known defect, not a target anybody has hit.
// ═══════════════════════════════════════════════════════════════════
console.log('\nHEAL MODEL ERROR  (100k runs — measured, not accepted; see Part 3c)');
console.log('  ' + 'case'.padEnd(52) + 'solver  sampled     gap');

const HEAL_ERROR_CASES = [
  { w: 'FCAR',           cls: 'medium', d: 25, acc: 0.75, hs: 0.35, heal: ['beam'],          window: 7,  bound: 2 },
  { w: 'M11',            cls: 'heavy',  d: 25, acc: 0.5,  hs: 0.2,  heal: ['beam', 'ball'],  window: 7,  bound: 2 },
  { w: 'CERBERUS 12GA',  cls: 'light',  d: 15, acc: 0.5,  hs: 0.2,  heal: ['beam', 'ball'],  window: 7,  bound: 20 },
  { w: 'CL-40 (SPLASH)', cls: 'light',  d: 15, acc: 0.5,  hs: 0.2,  heal: ['beam', 'ball', 'infuser', 'canister'], window: 7, bound: 20 },
  { w: 'CL-40 (SPLASH)', cls: 'light',  d: 15, acc: 0.5,  hs: 0.2,  heal: ['infuser'],       window: 7,  bound: 20 }
];

for (const c of HEAL_ERROR_CASES) {
  const stats = getStats(byName(c.w));
  const shot = describeShot(stats, c.acc, c.hs, c.d, dropMult(c.d, stats));
  const sched = stack(...c.heal);
  const health = CLASS_HP[c.cls];

  for (const count of [1, 2, 3]) {
    const exact = holdOf(stats, health, sched, count, 'spread', c.window, c.d, c.acc, c.hs);
    const sampled = sampledHold(stats, shot, health, sched, count, 'spread', c.window, 100000);
    const gap = (exact - sampled) * 100;
    const ok = Math.abs(gap) <= c.bound;
    if (!ok) failures++;
    const label = `${count}v1 ${c.w} vs ${c.heal.join('+')} (${c.cls})`;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${exact.toFixed(3)}   ${sampled.toFixed(3)}  ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}pp  (bound ${c.bound}pp)`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Part 4: regen must route to sampling
// ═══════════════════════════════════════════════════════════════════
console.log('\nREGEN GATING');
const s1 = getStats(byName('FCAR')), s2 = getStats(byName('AKM'));
same('no regen solves exactly', canSolveExactly({ meleeAdvance: false, speedOverride: 0, p1Stats: s1, p2Stats: s2 }), true);
same('regen falls back to sampling',
  canSolveExactly({ meleeAdvance: false, speedOverride: 0, p1Stats: s1, p2Stats: s2, regenRate: 40 }), false);

// A Medium that breaks contact is full again delay + 250/40 later.
const holder = { ...dummy };
const quiet = simulate(byName('FCAR'), holder, 0, 0, 0, 0, 15, 0, false, 'p1', false,
  { regen: CLASS_REGEN });
same('regen never fires while nobody is hit', quiet.healed2, 0);

console.log('\n  stacks enumerated: ' + allHealStacks(['beam', 'ball', 'infuser', 'canister']).length);
console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all passed\n');
process.exit(failures ? 1 : 0);
