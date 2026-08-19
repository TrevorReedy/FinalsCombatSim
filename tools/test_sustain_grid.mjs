#!/usr/bin/env node
// End-to-end check of the sustain pipeline, minus the DOM.
//
// Replicates what cross_analysis_worker.js does per job and what
// ui_shell.js renderSustain() does with the results, so the grid shape,
// the stack enumeration and the ranking maths are exercised outside a
// browser. Prints the ranking table for eyeballing.
//
//   node tools/test_sustain_grid.mjs [class] [distance] [profile] [window] [stagger]

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const healsSrc = readFileSync(join(ROOT, 'heals.js'), 'utf8');
const heals = new Function(healsSrc + `
  return { CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, MAX_TIME,
           resolveHealAt, combineSchedules, allHealStacks };`)();
const { CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, resolveHealAt, combineSchedules, allHealStacks } = heals;

const parseNum = s => { if (!s) return null; const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };
const engineSrc = readFileSync(join(ROOT, 'simulate.js'), 'utf8');
const { getStats, dropMult } = new Function(
  'CLASS_SPEED', 'CLASS_HP', 'MELEE_RANGE', 'DT', 'parseNum',
  engineSrc + '\nreturn { simulate, getStats, dropMult, useSeededRandom };'
)(CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, parseNum);

const { solveSurvival, buildVolleySchedule } = require(join(ROOT, 'duel_solver.js'));

const WEAPONS = JSON.parse(readFileSync(join(ROOT, 'weapons_s10_cleaned.json'), 'utf8'));
const timeline = JSON.parse(readFileSync(join(ROOT, 'csv', 'cleaned', 'heal_timeline.json'), 'utf8'));

const HEAL_ORDER = ['beam', 'ball', 'infuser', 'canister'];
const STEP = 0.25, MAXS = 20;

const defenderClass = process.argv[2] || 'medium';
const distance = +(process.argv[3] || 15);
const profileName = process.argv[4] || 'Average';
const holdWindow = +(process.argv[5] || 7);
const attackerStagger = process.argv[6] || 'spread';
const version = '11.4.1';
const SQUAD_SIZES = [1, 2, 3];

const PROFILES = {
  Poor: { acc: 0.50, hs: 0.20 }, Average: { acc: 0.75, hs: 0.35 },
  Strong: { acc: 0.90, hs: 0.55 }, Elite: { acc: 0.99, hs: 0.80 }
};
const profile = PROFILES[profileName];

const sampleSeconds = [];
for (let t = 0; t <= MAXS + 1e-9; t += STEP) sampleSeconds.push(+t.toFixed(3));
const idx = Math.round(holdWindow / STEP);

const at = id => resolveHealAt(timeline, id, version);
const stacks = allHealStacks(HEAL_ORDER).map(ids => ({ ids, items: ids.map(at).filter(Boolean) }));

let failures = 0;
const same = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} ${actual} (expected ${expected})`);
};

console.log('\nGRID SHAPE');
same('heal stacks enumerated', stacks.length, 16);
same('no stack repeats a source',
  stacks.every(s => new Set(s.ids).size === s.ids.length), true);
same('survival samples per cell', sampleSeconds.length, 81);
same(`index for ${holdWindow}s`, idx, holdWindow / STEP);

// ── Run the slice ──
const started = Date.now();
const allRows = [];
for (const attacker of WEAPONS) {
  const stats = getStats(attacker);
  for (const attackerCount of SQUAD_SIZES) {
    for (const stack of stacks) {
      const out = solveSurvival({
        attackerStats: stats,
        attackerAccuracy: profile.acc,
        attackerHeadshotChance: profile.hs,
        defenderMaxHealth: CLASS_HP[defenderClass],
        defenderHeal: stack.items.length ? combineSchedules(stack.items) : null,
        distance,
        dropMultiplierFor: dropMult,
        sampleSeconds,
        maxTime: MAXS,
        attackerCount,
        attackerStagger
      });
      allRows.push({
        attacker: attacker.name,
        attackerCount,
        healKey: stack.ids.join('+') || 'none',
        ids: stack.ids,
        survival: Array.from(out.survival)
      });
    }
  }
}
const elapsed = Date.now() - started;

// The conservation and ranking checks below are written against one squad
// size; they run over the 1v1 slice, and the squad-size checks that follow
// are what exercise the rest.
const rows = allRows.filter(r => r.attackerCount === 1);

console.log('\nCONSERVATION');

// P(survive >= 0) is 1 for everything except a weapon that can kill with
// its opening shot — the schedule puts that shot at t=0, so "survived zero
// seconds" is genuinely false for it. Rather than exempt the boundary, this
// checks the exceptions are exactly the weapons that can one-shot: anything
// else dipping below 1 at t=0 would mean a kill scheduled before the fight.
const oneShotCapable = new Set();
for (const attacker of WEAPONS) {
  const s = getStats(attacker);
  const mult = dropMult(distance, s);
  const most = Math.max(s.bodyDmg, s.headDmg > s.bodyDmg ? s.headDmg : 0) * mult;
  if (most >= CLASS_HP[defenderClass]) oneShotCapable.add(attacker.name);
}
const dipsAtZero = [...new Set(rows.filter(r => r.survival[0] < 1 - 1e-9).map(r => r.attacker))];
same('only one-shot weapons dip at t=0',
  dipsAtZero.every(n => oneShotCapable.has(n)), true);
if (dipsAtZero.length) console.log(`        (${dipsAtZero.join(', ')} can kill a ${defenderClass} outright at ${distance}m)`);
same('every curve is non-increasing',
  allRows.every(r => r.survival.every((v, i) => i === 0 || v <= r.survival[i - 1] + 1e-12)), true);
same('every probability is in range',
  allRows.every(r => r.survival.every(v => v >= -1e-12 && v <= 1 + 1e-12)), true);

// More healing can never make you die sooner. Compares each stack against
// every stack it is a strict subset of — catches a sign flip or a schedule
// that subtracts instead of adds.
//
// The tolerance is loose because healed walks run on a bucketed health grid
// and adding a heal that changes nothing — the Barrel's contact burst
// against a target still at full health — moves mass across bucket
// boundaries differently. That shows up as noise a few parts in a billion,
// which is quantisation, not an inversion. A real sign flip is not subtle.
const byWeapon = new Map();
for (const r of rows) {
  if (!byWeapon.has(r.attacker)) byWeapon.set(r.attacker, new Map());
  byWeapon.get(r.attacker).set(r.healKey, r);
}
let monotoneInHealing = true;
let worstHealingDrop = 0, worstHealingPair = '';
for (const [, m] of byWeapon) {
  for (const r of m.values()) {
    for (const bigger of m.values()) {
      if (bigger.ids.length <= r.ids.length) continue;
      if (!r.ids.every(id => bigger.ids.includes(id))) continue;
      if (bigger.survival[idx] < r.survival[idx] - 1e-6) {
        monotoneInHealing = false;
        if (worstHealingDrop < r.survival[idx] - bigger.survival[idx]) {
          worstHealingDrop = r.survival[idx] - bigger.survival[idx];
          worstHealingPair = `${r.attacker}: ${r.healKey} ${r.survival[idx].toFixed(6)} -> ${bigger.healKey} ${bigger.survival[idx].toFixed(6)}`;
        }
      }
    }
  }
}
same('adding a heal never lowers survival', monotoneInHealing, true);
if (worstHealingPair) console.log(`        worst: ${worstHealingPair}  (drop ${worstHealingDrop.toExponential(2)})`);

// ── Squad size ──
// The one property that must hold no matter what the merge does: another
// gun on you can never help. If the schedules were concatenated without
// sorting, or an offset landed a shot before t=0, this is what would catch
// it. Checked at every sample point, not just the hold window.
const bySquad = new Map();
for (const r of allRows) bySquad.set(`${r.attacker}|${r.healKey}|${r.attackerCount}`, r);

let monotoneInSquad = true;
let squadPairs = 0;
for (const r of allRows) {
  if (r.attackerCount === SQUAD_SIZES[SQUAD_SIZES.length - 1]) continue;
  const bigger = bySquad.get(`${r.attacker}|${r.healKey}|${r.attackerCount + 1}`);
  if (!bigger) continue;
  squadPairs++;
  for (let i = 0; i < r.survival.length; i++) {
    if (bigger.survival[i] > r.survival[i] + 1e-9) monotoneInSquad = false;
  }
}
same('another attacker never raises survival', monotoneInSquad, true);
same('squad pairs compared', squadPairs > 0, true);

// N attackers fire N times as often, so the shot list has to be N times as
// long. A merge that dropped or duplicated a schedule would still pass the
// monotonicity check above, and would fail here.
{
  const stats = getStats(WEAPONS[0]);
  const lengths = SQUAD_SIZES.map(n =>
    buildVolleySchedule(stats, n, attackerStagger, MAXS).length);
  same('shot count scales with squad size',
    lengths.every((len, i) => Math.abs(len - lengths[0] * SQUAD_SIZES[i]) <= SQUAD_SIZES[i]), true);
  same('merged schedule is sorted', (() => {
    const t = buildVolleySchedule(stats, 3, 'spread', MAXS);
    return t.every((v, i) => i === 0 || v >= t[i - 1]);
  })(), true);
  // 'sync' is the same schedule three times over, so every shot time comes
  // in a group of three. That is the artificial lockstep the 'spread'
  // default exists to avoid, and asserting it here is what says the two
  // settings are actually doing different things.
  const sync = buildVolleySchedule(stats, 3, 'sync', MAXS);
  same('sync stacks every shot into one instant',
    new Set(sync).size * 3 === sync.length, true);
  const spread = buildVolleySchedule(stats, 3, 'spread', MAXS);
  same('spread does not', new Set(spread).size === spread.length, true);
}

// ── Rank exactly as the UI does ──
const grouped = new Map();
for (const r of rows) {
  if (!grouped.has(r.healKey)) grouped.set(r.healKey, { ids: r.ids, rows: [] });
  grouped.get(r.healKey).rows.push(r);
}
const label = ids => ids.length ? ids.map(id => timeline.items[id].name).join(' + ') : 'none';
const rateOf = ids => ids.length
  ? combineSchedules(ids.map(at)).deliveredBy(holdWindow) / holdWindow : 0;

// Mean hold across the roster, for one stack at one squad size — the same
// number renderSustain() puts in each column.
const holdFor = (ids, n) => {
  const key = ids.join('+') || 'none';
  const rs = allRows.filter(r => r.healKey === key && r.attackerCount === n);
  return rs.reduce((a, r) => a + r.survival[idx], 0) / (rs.length || 1);
};

const ranked = [...grouped.values()].map(g => ({
  label: label(g.ids),
  hold: g.rows.reduce((a, r) => a + r.survival[idx], 0) / g.rows.length,
  bySquad: SQUAD_SIZES.map(n => holdFor(g.ids, n)),
  rate: rateOf(g.ids),
  broke: g.rows.filter(r => r.survival[idx] < 0.5).length,
  total: g.rows.length
})).sort((a, b) => b.hold - a.hold);

console.log(`\nHOLD ${holdWindow}s AS ${defenderClass.toUpperCase()} — ${distance}m, ${profileName} aim, ${attackerStagger} opening, data ${version}`);
console.log(`${WEAPONS.length} weapons x ${stacks.length} stacks x ${SQUAD_SIZES.length} squad sizes = ${allRows.length} cells, solved in ${elapsed}ms\n`);
console.log('  ' + 'heal stack'.padEnd(42) +
  SQUAD_SIZES.map(n => `${n}v1`.padStart(7)).join('') +
  'HP/s'.padStart(8) + '   break the 1v1 hold');
for (const r of ranked) {
  console.log('  ' + r.label.padEnd(42) +
    r.bySquad.map(h => (h * 100).toFixed(1).padStart(6) + '%').join('') +
    r.rate.toFixed(0).padStart(8) +
    `   ${r.broke} of ${r.total}`);
}

same('\n  none ranks last', ranked[ranked.length - 1].label, 'none');

// The full stack ties for first rather than winning outright. With zones
// taking the higher rate, the Barrel's only contribution alongside the
// Emitter is its contact burst, and that lands at t=0 against a defender
// still at full health — entirely wasted. So it is a tie, not a lead, and
// asserting a strict win would only be asserting the sort's tie-break.
const fullStack = ranked.find(r => r.label === label(HEAL_ORDER));
same('  no stack holds better than the full stack',
  ranked.every(r => r.hold <= fullStack.hold + 1e-9), true);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all passed\n');
process.exit(failures ? 1 : 0);
