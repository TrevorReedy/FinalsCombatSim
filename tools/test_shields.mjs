#!/usr/bin/env node
// Checks the shield layer in the exact solver, and the loadout rules that
// decide which kits are allowed to reach it.
//
// The solver walks a shield as extra buckets above full health, with three
// rules bolted on: healing stops at full, a broken shield eats the whole
// shot that broke it, and an expiry throws away whatever is left. None of
// those are visible in the output, so the reference here is a plain Monte
// Carlo of the same rules written the obvious way — one simulated hold at a
// time, health and shield as two numbers. If the walk and the obvious
// version disagree, the walk is wrong.
//
//   node tools/test_shields.mjs

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const healsSrc = readFileSync(join(ROOT, 'heals.js'), 'utf8');
const heals = new Function(healsSrc + `
  return { CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, MAX_TIME,
           resolveHealAt, combineSchedules };`)();
const { CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, resolveHealAt, combineSchedules } = heals;

const gadgets = require(join(ROOT, 'gadgets.js'));
const { resolveGadgetAt, combineShields, isLegalKit, allLegalKits, shieldCoverageAt } = gadgets;

const parseNum = s => { if (!s) return null; const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };
const engineSrc = readFileSync(join(ROOT, 'simulate.js'), 'utf8');
const { getStats, dropMult } = new Function(
  'CLASS_SPEED', 'CLASS_HP', 'MELEE_RANGE', 'DT', 'parseNum',
  engineSrc + '\nreturn { simulate, getStats, dropMult, useSeededRandom };'
)(CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, parseNum);

const {
  solveSurvival, buildVolleySchedule, describeShot, toSeconds
} = require(join(ROOT, 'duel_solver.js'));

const WEAPONS = JSON.parse(readFileSync(join(ROOT, 'weapons_s10_cleaned.json'), 'utf8'));
const healTimeline = JSON.parse(readFileSync(join(ROOT, 'csv', 'cleaned', 'heal_timeline.json'), 'utf8'));
const gadgetTimeline = JSON.parse(readFileSync(join(ROOT, 'csv', 'cleaned', 'gadget_timeline.json'), 'utf8'));

const VERSION = '11.4.1';
const byName = n => {
  const w = WEAPONS.find(x => x.name.toUpperCase() === n.toUpperCase());
  if (!w) throw new Error(`weapon not found: ${n}`);
  return w;
};
const healStack = ids => ids.length
  ? combineSchedules(ids.map(id => resolveHealAt(healTimeline, id, VERSION)))
  : null;
const gadget = id => resolveGadgetAt(gadgetTimeline, id, VERSION);
const shieldOf = ids => combineShields(ids.map(gadget));

let failures = 0;
const ok = (label, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${detail}`);
};
const near = (label, actual, expected, tol) => {
  ok(label, Math.abs(actual - expected) <= tol,
    `${actual.toFixed(4)} (expected ${expected.toFixed(4)} +/- ${tol.toFixed(4)})`);
};

// ── Deterministic RNG, so a failure is always reproducible ────────
let seed = 0x2f6e2b1;
function rand() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5;  seed >>>= 0;
  return seed / 4294967296;
}

/**
 * The obvious version: one hold at a time, health and shield as numbers.
 *
 * Deliberately written without reference to how the solver does it — the
 * whole value of this file is that the two are independent statements of
 * the same rules.
 */
function sampleSurvival({ shotTimes, shot, maxHealth, heal, shield, sampleSeconds, runs }) {
  const deaths = new Array(sampleSeconds.length).fill(0);
  const pool = shield ? shield.pool : 0;
  const expiries = shield ? shield.expiries : [];

  for (let run = 0; run < runs; run++) {
    let health = maxHealth;
    let shieldLeft = pool;
    let previous = 0;
    let expiryIndex = 0;
    let diedAt = null;

    for (const atMicros of shotTimes) {
      const at = toSeconds(atMicros);

      // Events on the clock, in the order they happen.
      while (expiryIndex < expiries.length && expiries[expiryIndex].at <= at) {
        const e = expiries[expiryIndex];
        if (heal) health = Math.min(maxHealth, health + heal.deliveredBy(e.at) - heal.deliveredBy(previous));
        previous = e.at;
        shieldLeft = Math.min(shieldLeft, e.poolAfter);
        expiryIndex++;
      }
      if (heal) health = Math.min(maxHealth, health + heal.deliveredBy(at) - heal.deliveredBy(previous));
      previous = at;

      const roll = rand();
      let damage = 0;
      if (roll < shot.headChance) damage = shot.headDamage;
      else if (roll < shot.headChance + shot.bodyChance) damage = shot.bodyDamage;

      if (damage > 0) {
        // The shield takes the whole shot, and keeps none of the overflow.
        if (shieldLeft > 0) shieldLeft = Math.max(0, shieldLeft - damage);
        else health -= damage;
      }

      if (health <= 0) { diedAt = at; break; }
    }

    if (diedAt !== null) {
      for (let i = 0; i < sampleSeconds.length; i++) {
        if (sampleSeconds[i] >= diedAt) { deaths[i]++; }
      }
    }
  }

  return deaths.map(d => 1 - d / runs);
}

// ═══════════════════════════════════════════════════════════════════
// Part 1: the shield walk against a sampler of the same rules
// ═══════════════════════════════════════════════════════════════════
const RUNS = 60000;
const SAMPLE_STEP = 0.25, SAMPLE_MAX = 20;
const sampleSeconds = [];
for (let t = 0; t <= SAMPLE_MAX + 1e-9; t += SAMPLE_STEP) sampleSeconds.push(+t.toFixed(3));

console.log(`\nSHIELD WALK vs SAMPLING  (${RUNS} runs, 4 standard errors)`);

const CASES = [
  { label: 'Medium, dome, AKM @ 15m',            cls: 'medium', w: 'AKM',   d: 15, acc: 0.7,  hs: 0.3, shields: ['dome'] },
  { label: 'Medium, mesh, AKM @ 15m',            cls: 'medium', w: 'AKM',   d: 15, acc: 0.7,  hs: 0.3, shields: ['mesh'] },
  { label: 'Medium, mesh+dome, AKM @ 15m',       cls: 'medium', w: 'AKM',   d: 15, acc: 0.7,  hs: 0.3, shields: ['mesh', 'dome'] },
  { label: 'Light, dome, FCAR @ 25m',            cls: 'light',  w: 'FCAR',  d: 25, acc: 0.8,  hs: 0.4, shields: ['dome'] },
  { label: 'Heavy, mesh+dome, M60 @ 30m',        cls: 'heavy',  w: 'M60',   d: 30, acc: 0.9,  hs: 0.5, shields: ['mesh', 'dome'] },
  { label: 'Medium, dome, beam, AKM @ 15m',      cls: 'medium', w: 'AKM',   d: 15, acc: 0.7,  hs: 0.3, shields: ['dome'], heals: ['beam'] },
  { label: 'Medium, mesh+dome, beam+ball @ 15m', cls: 'medium', w: 'AKM',   d: 15, acc: 0.7,  hs: 0.3, shields: ['mesh', 'dome'], heals: ['beam', 'ball'] },
  { label: 'Light, dome, 3 attackers @ 20m',     cls: 'light',  w: 'AKM',   d: 20, acc: 0.7,  hs: 0.3, shields: ['dome'], count: 3 },
  { label: 'Medium, dome, sniper @ 40m',         cls: 'medium', w: 'SR-84', d: 40, acc: 0.6,  hs: 0.2, shields: ['dome'] }
];

// Sampled at a handful of moments rather than all 81: the curve is
// monotone and these bracket the Dome's 5.5s expiry, which is the only
// place the two versions could disagree in an interesting way.
const CHECK_AT = [3, 5, 5.5, 6, 7, 10, 20];

for (const c of CASES) {
  const weapon = byName(c.w);
  const stats = getStats(weapon);
  const heal = healStack(c.heals || []);
  const shield = shieldOf(c.shields);
  const count = c.count || 1;

  const exact = solveSurvival({
    attackerStats: stats,
    attackerAccuracy: c.acc, attackerHeadshotChance: c.hs,
    defenderMaxHealth: CLASS_HP[c.cls],
    defenderHeal: heal, defenderShield: shield,
    distance: c.d, dropMultiplierFor: dropMult,
    sampleSeconds, maxTime: SAMPLE_MAX,
    attackerCount: count, attackerStagger: 'spread'
  });

  const sampled = sampleSurvival({
    shotTimes: buildVolleySchedule(stats, count, 'spread', SAMPLE_MAX),
    shot: describeShot(stats, c.acc, c.hs, c.d, dropMult(c.d, stats)),
    maxHealth: CLASS_HP[c.cls],
    heal, shield, sampleSeconds, runs: RUNS
  });

  let worst = 0, worstAt = 0;
  for (const t of CHECK_AT) {
    const i = sampleSeconds.indexOf(t);
    const gap = Math.abs(exact.survival[i] - sampled[i]);
    if (gap > worst) { worst = gap; worstAt = t; }
  }
  // Four standard errors of the sampler, floored so a curve pinned at 0 or
  // 1 does not demand exact equality of two different arithmetics.
  const tolerance = Math.max(0.008, 4 * Math.sqrt(0.25 / RUNS));
  ok(c.label, worst <= tolerance, `worst gap ${worst.toFixed(4)} at ${worstAt}s (tol ${tolerance.toFixed(4)})`);
}

// ═══════════════════════════════════════════════════════════════════
// Part 2: the rules that make a shield different from more health
// ═══════════════════════════════════════════════════════════════════
console.log('\nSHIELD BEHAVIOUR');

const dome = gadget('dome'), mesh = gadget('mesh');

ok('dome resolves to 250 HP / 5.5s / 4m at ' + VERSION,
  dome.fields.device_hp === 250 && dome.fields.duration === 5.5 && dome.fields.radius === 4,
  `${dome.fields.device_hp} HP, ${dome.fields.duration}s, ${dome.fields.radius}m`);
ok('mesh resolves to 900 HP at ' + VERSION, mesh.fields.device_hp === 900, `${mesh.fields.device_hp} HP`);
ok('mesh at 9.0.0 is the 850 snapshot',
  resolveGadgetAt(gadgetTimeline, 'mesh', '9.0.0').fields.device_hp === 850);
ok('dome before it existed is labelled theoretical',
  resolveGadgetAt(gadgetTimeline, 'dome', '0.9.0').provenance === 'theoretical');
ok('a roster-only gadget resolves with no fields',
  gadget('jump_pad').fields === null && gadget('jump_pad').provenance === 'roster');

ok('dome covers nothing at 1m (attacker inside the bubble)', shieldCoverageAt(dome, 1) === 0);
ok('dome covers everything at 5m', shieldCoverageAt(dome, 5) === 1);
ok('mesh coverage is the assumption, not geometry',
  shieldCoverageAt(mesh, 1) === gadgets.MESH_COVERAGE, `${gadgets.MESH_COVERAGE}`);

// A Dome is not 250 more health. A shot bigger than what is left of the
// shield is wasted on it, and the same 250 added to a health bar is not.
{
  const { solveKillTimes, toSeconds } = require(join(ROOT, 'duel_solver.js'));
  const shots = [];
  for (let i = 0; i < 12; i++) shots.push(i * 1e6);
  const big = { bodyDamage: 300, headDamage: 300, bodyChance: 1, headChance: 0, missChance: 0 };

  const firstKill = result => (result.kills.length ? toSeconds(result.kills[0].atMicros) : null);

  // 250 health behind a 250 Dome: the Dome eats one whole 300 damage shot
  // and 50 of it is thrown away, so the second shot kills. 500 health takes
  // two shots to bring down and dies on the second as well — but 350 health
  // behind the Dome outlives 600 health flat, because the Dome throws away
  // the overflow twice and a health bar never does.
  const domeOnly = combineShields([dome]);
  ok('dome absorbs the whole shot that breaks it',
    firstKill(solveKillTimes(shots, big, 250, null, domeOnly)) === 1,
    `dies at ${firstKill(solveKillTimes(shots, big, 250, null, domeOnly))}s (one shot on the dome, one on health)`);
  ok('the same 250 added to health does not waste the overflow',
    firstKill(solveKillTimes(shots, big, 500, null, null)) === 1,
    `dies at ${firstKill(solveKillTimes(shots, big, 500, null, null))}s`);
  ok('a 100 HP dome still costs the attacker a full 300 damage shot',
    firstKill(solveKillTimes(shots, big, 250, null, { pool: 100, expiries: [] })) === 1);
}

// The Dome's timer is real: past 5.5s it is worth nothing at all.
{
  const stats = getStats(byName('AKM'));
  const late = solveSurvival({
    attackerStats: stats, attackerAccuracy: 0.8, attackerHeadshotChance: 0,
    defenderMaxHealth: 250, defenderHeal: null, defenderShield: combineShields([dome]),
    distance: 15, dropMultiplierFor: dropMult,
    sampleSeconds, maxTime: SAMPLE_MAX, attackerCount: 1, attackerStagger: 'spread'
  });
  const noShield = solveSurvival({
    attackerStats: stats, attackerAccuracy: 0.8, attackerHeadshotChance: 0,
    defenderMaxHealth: 250, defenderHeal: null, defenderShield: null,
    distance: 15, dropMultiplierFor: dropMult,
    sampleSeconds, maxTime: SAMPLE_MAX, attackerCount: 1, attackerStagger: 'spread'
  });
  ok('dome still helps at 5s', late.survival[sampleSeconds.indexOf(5)] > noShield.survival[sampleSeconds.indexOf(5)] + 0.05);
  ok('everyone is dead well after the dome expires',
    late.survival[sampleSeconds.indexOf(20)] < 0.01 && noShield.survival[sampleSeconds.indexOf(20)] < 0.01);
}

// ═══════════════════════════════════════════════════════════════════
// Part 3: loadout legality
// ═══════════════════════════════════════════════════════════════════
console.log('\nLOADOUT RULES  (three players, one specialization and three gadgets each)');

const kit = (...ids) => ids.map(gadget);
const legal = (label, ids, cls, expected) => {
  const got = isLegalKit(kit(...ids), cls);
  ok(label, got === expected, `${got ? 'legal' : 'illegal'} for ${cls}`);
};

legal('nothing at all',                    [],                                        'medium', true);
legal('beam on a medium teammate',         ['beam'],                                  'medium', true);
legal('beam cannot be carried by yourself alone is fine', ['beam'],                   'light',  true);
legal('mesh on yourself as heavy',         ['mesh'],                                  'heavy',  true);
legal('mesh + dome on one heavy',          ['mesh', 'dome'],                          'heavy',  true);
legal('mesh + dome + ball on one heavy',   ['mesh', 'dome', 'ball'],                  'heavy',  true);
legal('beam + mesh + dome + ball',         ['beam', 'mesh', 'dome', 'ball'],          'medium', true);
legal('adding the infuser needs a fourth player',
  ['beam', 'infuser', 'mesh', 'dome', 'ball'],                                        'medium', false);
legal('infuser + beam + shields, light defender',
  ['beam', 'infuser', 'mesh', 'dome'],                                                'light',  false);
legal('infuser cannot heal its own carrier',
  ['infuser'],                                                                        'light',  true);
legal('barrel costs no slot',              ['beam', 'mesh', 'dome', 'ball', 'canister'], 'medium', true);
legal('three medium specializations, one each',
  ['beam', 'guardian_turret', 'dematerializer'],                                       'medium', true);
legal('four specializations need a fourth player',
  ['beam', 'guardian_turret', 'dematerializer', 'shockwave'],                          'medium', false);

// The count itself is worth pinning: it is what sizes every sustain run.
for (const cls of ['light', 'medium', 'heavy']) {
  const kits = allLegalKits(kit('beam', 'ball', 'infuser', 'canister', 'mesh', 'dome'), cls);
  console.log(`  ${String(kits.length).padStart(3)} legal kits of 64 for a ${cls} defender`);
}

// ═══════════════════════════════════════════════════════════════════
// Part 4: the job round trip
//
// The kit leaves ui_shell.js, is cut into jobs by cross_analysis_pool.js
// and read back by cross_analysis_worker.js — three files agreeing on the
// same field names, with a structured clone in the middle and no type
// checker anywhere. This runs one job through the real pool builder and the
// real worker, so a renamed field fails here rather than as a blank screen.
// ═══════════════════════════════════════════════════════════════════
console.log('\nJOB ROUND TRIP  (pool builder -> worker, no browser)');

{
  const poolSrc = readFileSync(join(ROOT, 'cross_analysis_pool.js'), 'utf8');
  const { buildSustainJobs } = new Function('navigator', 'window', 'document',
    poolSrc + '\nreturn { buildSustainJobs };'
  )({ hardwareConcurrency: 4 }, {}, { getElementById: () => null });

  const workerSrc = readFileSync(join(ROOT, 'cross_analysis_worker.js'), 'utf8');
  const runJob = new Function(
    'importScripts', 'self', 'CLASS_HP', 'MAX_TIME', 'getStats', 'dropMult',
    'combineSchedules', 'combineShields', 'shieldCoverageAt', 'solveSurvival',
    workerSrc + '\nreturn runJob;'
  )(
    () => {}, { addEventListener: () => {}, postMessage: () => {} },
    CLASS_HP, 20, getStats, dropMult,
    combineSchedules, combineShields, shieldCoverageAt, solveSurvival
  );

  const kit = {
    ids: ['beam', 'mesh', 'dome'],
    healIds: ['beam'],
    shieldIds: ['mesh', 'dome'],
    healItems: [resolveHealAt(healTimeline, 'beam', VERSION)],
    shieldItems: [gadget('mesh'), gadget('dome')]
  };

  const jobs = buildSustainJobs({
    weapons: [byName('AKM')],
    distances: [1, 15],
    profiles: [{ name: 'Average', acc: 0.75, hs: 0.35 }],
    kits: [kit],
    defenderClass: 'medium',
    sampleStep: SAMPLE_STEP,
    sampleMax: SAMPLE_MAX,
    attackerCounts: [1],
    attackerStagger: 'spread'
  });

  ok('the pool builds one job per range', jobs.length === 2, `${jobs.length} jobs`);
  ok('the job carries the kit the screen chose',
    jobs[0].shieldIds.join('+') === 'mesh+dome' && jobs[0].defenderShield.length === 2);

  const close = runJob(jobs.find(j => j.distance === 1));
  const far = runJob(jobs.find(j => j.distance === 15));

  ok('the worker answers with the kit key', far.kitKey === 'beam+mesh+dome', far.kitKey);
  ok('both shields count at 15m', far.activeShieldIds.join('+') === 'mesh+dome', far.activeShieldIds.join('+'));
  ok('the dome is dropped at 1m', close.activeShieldIds.join('+') === 'mesh', close.activeShieldIds.join('+'));
  ok('the survival curve comes back whole',
    Array.isArray(far.survival) && far.survival.length === sampleSeconds.length,
    `${far.survival.length} samples`);
  ok('being further away is better here', far.survival[sampleSeconds.indexOf(7)] >= close.survival[sampleSeconds.indexOf(7)],
    `${far.survival[sampleSeconds.indexOf(7)].toFixed(3)} at 15m vs ${close.survival[sampleSeconds.indexOf(7)].toFixed(3)} at 1m`);
}

console.log(failures ? `\n  ${failures} FAILURE(S)\n` : '\n  all good\n');
process.exit(failures ? 1 : 0);
