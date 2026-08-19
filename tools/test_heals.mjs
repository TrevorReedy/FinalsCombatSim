#!/usr/bin/env node
// Heal data and schedule checks. Runs heals.js against hand-computed values
// and against figures the wiki quotes independently of the rows they were
// reconstructed from.
//
//   node tools/test_heals.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// heals.js is a plain script for the page; load it the same way the other
// harnesses load simulate.js rather than adding module syntax for tests.
const src = readFileSync(join(ROOT, 'heals.js'), 'utf8');
const load = new Function(src + `
  return { CLASS_HP, CLASS_REGEN, MAX_TIME, compareHealVersions, resolveHealAt,
           healScheduleFor, combineSchedules, allHealStacks };`);
const {
  CLASS_HP, CLASS_REGEN, compareHealVersions,
  resolveHealAt, healScheduleFor, combineSchedules, allHealStacks
} = load();

const timeline = JSON.parse(
  readFileSync(join(ROOT, 'csv', 'cleaned', 'heal_timeline.json'), 'utf8'));

let failures = 0;
const check = (label, actual, expected, tol = 1e-6) => {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} ${
    typeof actual === 'number' ? actual.toFixed(3) : actual} (expected ${expected})`);
};
const same = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} ${actual} (expected ${expected})`);
};

const at = (id, version) => resolveHealAt(timeline, id, version);
const sched = (id, version) => healScheduleFor(at(id, version));

// ── Data ──────────────────────────────────────────────────────────
console.log('\nDATA');
same('item count', Object.keys(timeline.items).length, 4);
same('beam heal rate at 11.4.1', at('beam', '11.4.1').fields.heal_rate, 46);
same('beam heal rate at 5.0.0', at('beam', '5.0.0').fields.heal_rate, 40);
same('beam heal rate at 1.5 (Season 1)', at('beam', '1.5').fields.heal_rate, 50);
same('infuser heal per shot at 11.4.1', at('infuser', '11.4.1').fields.heal_per_shot, 11);
same('infuser heal per shot at 7.3.0', at('infuser', '7.3.0').fields.heal_per_shot, 15);
same('ball cooldown at 7.0.0', at('ball', '7.0.0').fields.cooldown, 35);
same('ball cooldown at 11.4.1', at('ball', '11.4.1').fields.cooldown, 30);

// ── Provenance ────────────────────────────────────────────────────
// The three labels are the whole basis for whether the UI marks a number
// as real, so each one gets pinned.
console.log('\nPROVENANCE');
same('beam at 8.0.0 is exact', at('beam', '8.0.0').provenance, 'exact');
same('beam at 9.2.0 is carried', at('beam', '9.2.0').provenance, 'carried');
same('beam at 9.2.0 sourced from', at('beam', '9.2.0').sourceVersion, '8.0.0');
same('beam at 1.5 is carried (existed at launch)', at('beam', '1.5').provenance, 'carried');

same('ball at 1.5 is theoretical', at('ball', '1.5').provenance, 'theoretical');
same('ball at 1.5 sourced from', at('ball', '1.5').sourceVersion, '7.0.0');
same('ball at 1.5 introducedAt', at('ball', '1.5').introducedAt, '7.0.0');
same('ball at 1.5 uses launch ramp', at('ball', '1.5').fields.ramp_to, 20);
same('ball at 6.11.0 is theoretical', at('ball', '6.11.0').provenance, 'theoretical');
same('ball at 7.0.0 is exact', at('ball', '7.0.0').provenance, 'exact');

same('infuser at 6.11.0 is theoretical', at('infuser', '6.11.0').provenance, 'theoretical');
same('canister at 5.0.0 is theoretical', at('canister', '5.0.0').provenance, 'theoretical');
same('canister at 6.6.0 is exact', at('canister', '6.6.0').provenance, 'exact');

// ── Schedules ─────────────────────────────────────────────────────
// Hand-computed. Each is the cumulative heal delivered by time t.
console.log('\nSCHEDULES (current, 11.4.1)');

const beam = sched('beam', '11.4.1');
check('beam at 1s              46/s',            beam.deliveredBy(1), 46);
check('beam at 5.5s            overheats',       beam.deliveredBy(5.5), 253);
check('beam at 13s             still overheated', beam.deliveredBy(13), 253);
check('beam at 13.001s         cycle restarts',  beam.deliveredBy(13.001), 253 + 0.001 * 46);
check('beam at 18.5s           two full cycles', beam.deliveredBy(18.5), 506);

const ball = sched('ball', '11.4.1');
check('ball at 2s              end of ramp',     ball.deliveredBy(2), 30);
check('ball at 1s              mid ramp',        ball.deliveredBy(1), 12.5);
check('ball at 12s             30 + 20*10',      ball.deliveredBy(12), 230);

const infuser = sched('infuser', '11.4.1');
check('infuser at 0s           first shot lands', infuser.deliveredBy(0), 11);
check('infuser at 1.425s       magazine dumped',  infuser.deliveredBy(1.425), 220);
check('infuser at 7s           still empty',      infuser.deliveredBy(7), 220);

const canister = sched('canister', '11.4.1');
check('canister at 0s          contact heal',    canister.deliveredBy(0), 50);
check('canister at 14s         zone expires',    canister.deliveredBy(14), 190);
check('canister at 30s         flat after',      canister.deliveredBy(30), 190);

// ── Historical schedules ──────────────────────────────────────────
// The wiki quotes the beam's overheat capacity and the infuser's magazine
// as standalone figures. They are not stored — they fall out of rate and
// time — so agreeing with them is a real check on the reconstruction.
console.log('\nDERIVED FIGURES vs FIGURES THE WIKI QUOTES SEPARATELY');
check('beam overheat capacity at 11.4.1  (wiki: 253)',
  sched('beam', '11.4.1').deliveredBy(5.5), 253);
check('infuser magazine at 11.4.1        (wiki: 220)',
  sched('infuser', '11.4.1').deliveredBy(2), 220);
check('beam overheat capacity at 1.5     (50/s x 7s)',
  sched('beam', '1.5').deliveredBy(7), 350);
check('infuser magazine at 7.0.0         (20/shot x 20)',
  sched('infuser', '7.0.0').deliveredBy(2), 400);

// ── Stacking ──────────────────────────────────────────────────────
console.log('\nSTACKING');
const ids = ['beam', 'ball', 'infuser', 'canister'];
const resolved = ids.map(id => at(id, '11.4.1'));
same('stack count for 4 items', allHealStacks(ids).length, 16);

const all4 = combineSchedules(resolved);
// The 7s anchor from the plan: this is what a full stack buys you across a
// cashout steal, and it is the number to check first if output looks wrong.
//
// Beam and Infuser are added whole. The two zones are not: the Emitter's
// ramp sits at or above the Barrel's flat 10/s from t=0 onwards, so the
// Emitter's 130 is the whole field contribution and the Barrel adds only
// its 50 on contact. Summing the zones instead would read 723.
check('all four at 7s (steal window)', all4.deliveredBy(7), 253 + 220 + 130 + 50);
check('beam+ball at 7s', combineSchedules([at('beam', '11.4.1'), at('ball', '11.4.1')]).deliveredBy(7), 383);
check('beam+infuser at 7s      non-zones sum',
  combineSchedules([at('beam', '11.4.1'), at('infuser', '11.4.1')]).deliveredBy(7), 253 + 220);
check('ball+canister at 7s     zones take the higher rate',
  combineSchedules([at('ball', '11.4.1'), at('canister', '11.4.1')]).deliveredBy(7), 130 + 50);
check('empty stack delivers nothing', combineSchedules([]).deliveredBy(60), 0);

// Overlapping zones can never be worth less than the better one alone, and
// never worth more than both — the bracket the max rule has to sit inside.
const zonePair = combineSchedules([at('ball', '11.4.1'), at('canister', '11.4.1')]);
const ballOnly = sched('ball', '11.4.1'), canOnly = sched('canister', '11.4.1');
let bracketed = true;
for (let t = 0; t <= 30; t += 0.1) {
  const both = zonePair.deliveredBy(t);
  const best = Math.max(ballOnly.deliveredBy(t), canOnly.deliveredBy(t));
  if (both < best - 1e-6 || both > ballOnly.deliveredBy(t) + canOnly.deliveredBy(t) + 1e-6) bracketed = false;
}
same('zone pair sits between the better one and the sum', bracketed, true);

let threw = false;
try { combineSchedules([at('ball', '11.4.1'), at('ball', '11.4.1')]); } catch { threw = true; }
same('two of the same source is rejected', threw, true);

// Monotonic: cumulative heal can never go down.
let monotonic = true;
for (let t = 0; t < 60; t += 0.05) {
  if (all4.deliveredBy(t + 0.05) < all4.deliveredBy(t) - 1e-9) monotonic = false;
}
same('cumulative heal is non-decreasing', monotonic, true);

// ── Constants ─────────────────────────────────────────────────────
console.log('\nCONSTANTS');
same('light HP', CLASS_HP.light, 150);
same('medium HP', CLASS_HP.medium, 250);
same('heavy HP', CLASS_HP.heavy, 350);
same('light regen delay', CLASS_REGEN.light.delay, 7);
same('medium regen delay', CLASS_REGEN.medium.delay, 9);
same('heavy regen delay', CLASS_REGEN.heavy.delay, 10);
same('regen rate (measured in game)', CLASS_REGEN.medium.rate, 40);

// A Medium that breaks contact should be full 250/40 = 6.25s after its
// 9s delay. This is the arithmetic the sustain timeout cells depend on.
check('medium full again at', CLASS_REGEN.medium.delay + CLASS_HP.medium / CLASS_REGEN.medium.rate, 15.25);

same('version compare 5.8 < 5.12.0', compareHealVersions('5.8', '5.12.0') < 0, true);
same('version compare 10.0.0 > 9.14.0', compareHealVersions('10.0.0', '9.14.0') > 0, true);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all passed\n');
process.exit(failures ? 1 : 0);
