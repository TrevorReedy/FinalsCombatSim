// ═══════════════════════════════════════════════════════════════════
// SHARED SIMULATION ENGINE
//
// Plays out one duel shot by shot on a 10ms tick, rolling for each hit.
// Used by battle_simulator.js for animated playback (captureFrames = true)
// and as the sampling fallback for matchups duel_solver.js cannot solve
// exactly — which today means any duel where the fighters move, since
// moving changes the damage of every shot.
//
// For a fixed-range duel, prefer duel_solver.js: it computes the same
// model's outcome exactly and about 200x faster.
// ═══════════════════════════════════════════════════════════════════

// ── Randomness ────────────────────────────────────────────────────
// Every roll goes through this one function so a run can be replayed.
// Left on the system generator by default; seed it to get a duel you can
// reproduce exactly, which is what makes a surprising result debuggable
// and a published win-rate table checkable.
let rollRandom = Math.random;

/**
 * Installs a seeded generator and returns it. The same seed always replays
 * the same duels.
 *
 * This is xoshiro128** with its 128 bits of state expanded from the seed by
 * splitmix32. The state size is the point: a 32-bit generator has a single
 * cycle roughly 4.3 billion numbers long, so two differently-seeded runs are
 * only ever different starting points on that one loop. A cross analysis at
 * 50,000 runs per scenario draws about 2 million numbers per scenario across
 * 1,260 scenarios, which is enough to lap the short cycle and have separate
 * matchups quietly sharing the same random numbers. 128 bits of state makes
 * that impossible.
 */
function useSeededRandom(seed) {
  // splitmix32: turns one number into four well-mixed ones, so neighbouring
  // seeds do not produce related starting states.
  let mix = seed >>> 0;
  const nextSeedWord = () => {
    mix = (mix + 0x9E3779B9) >>> 0;
    let z = mix;
    z = Math.imul(z ^ (z >>> 16), 0x21F0AAAD);
    z = Math.imul(z ^ (z >>> 15), 0x735A2D97);
    return (z ^ (z >>> 15)) >>> 0;
  };

  let a = nextSeedWord(), b = nextSeedWord(), c = nextSeedWord(), d = nextSeedWord();

  rollRandom = function () {
    const scrambled = Math.imul(rotateLeft32(Math.imul(b, 5), 7), 9) >>> 0;
    const t = (b << 9) >>> 0;

    c = (c ^ a) >>> 0;
    d = (d ^ b) >>> 0;
    b = (b ^ c) >>> 0;
    a = (a ^ d) >>> 0;
    c = (c ^ t) >>> 0;
    d = rotateLeft32(d, 11);

    return scrambled / 4294967296;
  };
  return rollRandom;
}

function rotateLeft32(value, bits) {
  return (((value << bits) | (value >>> (32 - bits))) >>> 0);
}

/** Back to the system generator: every run different. */
function useSystemRandom() {
  rollRandom = Math.random;
}
// `opts` is a trailing options bag rather than three more positional
// parameters — there were already eleven, and the two call sites are
// battle_simulator.js runSim() and the worker's resolveBySampling().
//
//   opts.p1Heal, opts.p2Heal   schedules from heals.js combineSchedules(),
//                              or null for nobody healing that fighter
//   opts.regen                 per-class {delay, rate} table, or null for off
function simulate(p1w, p2w, p1acc, p1hs, p2acc, p2hs, startDist, speedOverride, meleeAdv, fsa, captureFrames, opts = {}) {
const s1 = getStats(p1w), s2 = getStats(p2w);
const p1Heal = opts.p1Heal || null;
const p2Heal = opts.p2Heal || null;
const regen  = opts.regen  || null;
let meleeRange1 = null;
let meleeRange2 = null;

if (s1.isMelee) {
  meleeRange1 = s1.dropMin ?? MELEE_RANGE;
}
if (s2.isMelee) {
  meleeRange2 = s2.dropMin ?? MELEE_RANGE;
}

  const maxHP1 = CLASS_HP[p1w.class], maxHP2 = CLASS_HP[p2w.class];
  let hp1 = maxHP1, hp2 = maxHP2;

  // `?? 99` rather than `|| 99`: a speedOverride of 0 means "nobody moves",
  // which is a real setting (the Meta Simulation runs stand-and-fight, and the
  // 1v1 speed slider goes down to 0). Treating 0 as absent ran them at full
  // class speed instead.
  const spd1 = Math.min(s1.classSpd, speedOverride ?? 99);
  const spd2 = Math.min(s2.classSpd, speedOverride ?? 99);

  let dist = startDist;
  let p1pos = 0, p2pos = startDist;
  let time = 0;

  // First shot advantage
  let t1 = fsa === 'p2' ? s1.interval : 0;
  let t2 = fsa === 'p1' ? s2.interval : 0;

  // Burst tracking
  let b1shots = 0, b2shots = 0;

  // Magazine state — Infinity = no reload ever
  let mag1 = s1.magSize !== null ? s1.magSize : Infinity;
  let mag2 = s2.magSize !== null ? s2.magSize : Infinity;
  let reloading1 = false, reloading2 = false;
  let reloadEnd1 = 0,     reloadEnd2 = 0;

  // Stats
  let dmg1 = 0, dmg2 = 0;
  let shots1 = 0, hits1 = 0, hs1count = 0;
  let shots2 = 0, hits2 = 0, hs2count = 0;

  // Healing actually absorbed — what landed on a fighter below full health,
  // not what the support poured out. Overheal is thrown away, so the two
  // differ whenever a heal outpaces incoming damage.
  let healed1 = 0, healed2 = 0;
  const regen1 = regen ? regen[p1w.class] : null;
  const regen2 = regen ? regen[p2w.class] : null;
  let lastHit1 = 0, lastHit2 = 0;

  const frames      = captureFrames ? [] : null;
  const log         = captureFrames ? [] : null;
  let   projectiles = [];

  const MAX_TIME = 60;
//firing
  while (time < MAX_TIME && hp1 > 0 && hp2 > 0) {
    let p1fired = false, p1hit = false, p1isHS = false;
    let p2fired = false, p2hit = false, p2isHS = false;

    // ── Movement ──
    // Only melee users (or everyone, in melee mode) close the gap, and they
    // stop at melee range. Advancing unconditionally on top of this made every
    // duel collapse to point blank and defeated the clamp.
    if (s1.isMelee || meleeAdv) p1pos = Math.min(p1pos + spd1 * DT, p2pos - MELEE_RANGE);
    if (s2.isMelee || meleeAdv) p2pos = Math.max(p2pos - spd2 * DT, p1pos + MELEE_RANGE);

    dist = Math.max(0, p2pos - p1pos);

    // ── Reload completion ──
    if (reloading1 && time >= reloadEnd1) {
      reloading1 = false;
      mag1 = s1.magSize;
      if (log) log.push({ type: 'reload', text: `[${time.toFixed(2)}s] P1 ✅ RELOAD COMPLETE (${mag1} in mag)` });
    }
    if (reloading2 && time >= reloadEnd2) {
      reloading2 = false;
      mag2 = s2.magSize;
      if (log) log.push({ type: 'reload', text: `[${time.toFixed(2)}s] P2 ✅ RELOAD COMPLETE (${mag2} in mag)` });
    }

    let pendingDmgToP1 = 0;
    let pendingDmgToP2 = 0;

    // ── P1 Fire ──
    if (!reloading1 && time >= t1) {
      shots1++;
      p1fired = true;
      if (mag1 !== Infinity) mag1--;

const p1InRange = !s1.isMelee || dist <= meleeRange1;

const shot1 = rollShot(s1, p1acc, p1hs, dist, p1InRange, p2w.class);

if (shot1.landed) {
  const { isHS, dmg } = shot1;
  pendingDmgToP2 += dmg;
  dmg1 += dmg; hits1++;
  if (isHS) hs1count++;
  p1hit = true; p1isHS = isHS;
  const spread1 = s1.pellets > 1 ? ` (${shot1.pellets}/${s1.pellets} pellets)` : '';
  if (log) log.push({ type: isHS ? 'hs' : 'hp1', text: `[${time.toFixed(2)}s] P1 ${isHS ? '🎯 HEADSHOT' : '→ HIT'} for ${dmg.toFixed(1)}${spread1} @ ${dist.toFixed(1)}m` });
  if (frames) projectiles.push({ x: (p1pos + p2pos) / 2, owner: 1, isHS, age: 0 });
} else {
  if (log) {
    const reason = s1.isMelee && !p1InRange
      ? `OUT OF RANGE @ ${dist.toFixed(1)}m`
      : shot1.onTarget
        ? `SPREAD MISSED @ ${dist.toFixed(1)}m (${mag1 === Infinity ? '∞' : mag1} left)`
        : `MISS (${mag1 === Infinity ? '∞' : mag1} left)`;
    log.push({ type: 'info', text: `[${time.toFixed(2)}s] P1 → ${reason}` });
  }
}

      if (mag1 <= 0) {
        reloading1 = true;
        const reloadTime1 = s1.emptyReload || s1.tacticalReload || 0;
        reloadEnd1 = time + reloadTime1;
        t1 = reloadEnd1;
        b1shots = 0;
        if (log) log.push({ type: 'reload', text: `[${time.toFixed(2)}s] P1 🔄 RELOAD (${reloadTime1.toFixed(2)}s)` });
      } else if (s1.isBurst) {
        b1shots++;
        // delay_in_bursts is an extra pause on top of the normal shot interval.
        // Verified against Krome's 10.0.0 sheet — the source of weapons_s10_cleaned.json —
        // whose published TTKs match this convention exactly for the 93R, FAMAS and
        // Throwing Knives. (Zafferman's sheets use the opposite convention, so their
        // published TTKs are not directly comparable.)
        t1 += b1shots < s1.bSize ? s1.interval : (b1shots = 0, s1.bDelay + s1.interval);
      } else {
        t1 += s1.interval;
      }
    }

    // ── P2 Fire ──
    if (!reloading2 && time >= t2) {
      shots2++;
      p2fired = true;
      if (mag2 !== Infinity) mag2--;

        const p2InRange = !s2.isMelee || dist <= meleeRange2;

        const shot2 = rollShot(s2, p2acc, p2hs, dist, p2InRange, p1w.class);

        if (shot2.landed) {
        const { isHS, dmg } = shot2;
        pendingDmgToP1 += dmg;
        dmg2 += dmg; hits2++;
        if (isHS) hs2count++;
        p2hit = true; p2isHS = isHS;
        const spread2 = s2.pellets > 1 ? ` (${shot2.pellets}/${s2.pellets} pellets)` : '';
        if (log) log.push({ type: isHS ? 'hs' : 'hp2', text: `[${time.toFixed(2)}s] P2 ${isHS ? '🎯 HEADSHOT' : '→ HIT'} for ${dmg.toFixed(1)}${spread2} @ ${dist.toFixed(1)}m` });
        if (frames) projectiles.push({ x: (p1pos + p2pos) / 2, owner: 2, isHS, age: 0 });
        } else {
        if (log) {
            const reason = s2.isMelee && !p2InRange
            ? `OUT OF RANGE @ ${dist.toFixed(1)}m`
            : shot2.onTarget ? `SPREAD MISSED @ ${dist.toFixed(1)}m` : 'MISS';
            log.push({ type: 'info', text: `[${time.toFixed(2)}s] P2 → ${reason}` });
        }
        }

      if (mag2 <= 0) {
        reloading2 = true;
        const reloadTime2 = s2.emptyReload || s2.tacticalReload || 0;
        reloadEnd2 = time + reloadTime2;
        t2 = reloadEnd2;
        b2shots = 0;
        if (log) log.push({ type: 'reload', text: `[${time.toFixed(2)}s] P2 🔄 RELOAD (${reloadTime2})` });
      } else if (s2.isBurst) {
        b2shots++;
        t2 += b2shots < s2.bSize ? s2.interval : (b2shots = 0, s2.bDelay + s2.interval);
      } else {
        t2 += s2.interval;
      }
    }

    // ── Apply damage simultaneously ──
    hp2 = Math.max(0, hp2 - pendingDmgToP2);
    hp1 = Math.max(0, hp1 - pendingDmgToP1);

    if (pendingDmgToP1 > 0) lastHit1 = time;
    if (pendingDmgToP2 > 0) lastHit2 = time;

    // ── Apply healing, to whoever is still standing ──
    // Healing is taken as the difference of the schedule's cumulative
    // total across this tick rather than as rate x DT. The solver reads
    // the same cumulative function, so differencing it is what stops the
    // two engines drifting apart on a curve that ramps or pulses.
    //
    // Clamping at max health here is exact, and that is the point: this
    // engine is the reference the solver's cheaper approximation gets
    // checked against.
    if (hp1 > 0) {
      let gain = 0;
      if (p1Heal) gain += p1Heal.deliveredBy(time + DT) - p1Heal.deliveredBy(time);
      if (regen1 && time - lastHit1 >= regen1.delay) gain += regen1.rate * DT;
      if (gain > 0) {
        const before = hp1;
        hp1 = Math.min(maxHP1, hp1 + gain);
        healed1 += hp1 - before;
      }
    }
    if (hp2 > 0) {
      let gain = 0;
      if (p2Heal) gain += p2Heal.deliveredBy(time + DT) - p2Heal.deliveredBy(time);
      if (regen2 && time - lastHit2 >= regen2.delay) gain += regen2.rate * DT;
      if (gain > 0) {
        const before = hp2;
        hp2 = Math.min(maxHP2, hp2 + gain);
        healed2 += hp2 - before;
      }
    }

    // ── Projectile aging (visual only) ──
    projectiles = projectiles.filter(p => p.age < 3);
    projectiles.forEach(p => p.age++);

    if (frames) {
      frames.push({
        time, dist,
        p1_position: p1pos, p2_position: p2pos,
        hp1, hp2, maxHP1, maxHP2,
        p1class: p1w.class, p2class: p2w.class,
        p1flash: p1fired, p2flash: p2fired,
        p1hit, p2hit, p1hs: p1isHS, p2hs: p2isHS,
        initDist: startDist,
        projectiles: JSON.parse(JSON.stringify(projectiles))
      });
    }

    if (hp1 <= 0 || hp2 <= 0) break;
    time += DT;
  }

  const winner =
    hp1 <= 0 && hp2 <= 0 ? 'tie' :
    hp2 <= 0 ? 'p1' :
    hp1 <= 0 ? 'p2' :
    hp1 > hp2 ? 'p1' : hp2 > hp1 ? 'p2' : 'tie';

  if (frames) {
    frames.push({
      time, dist,
      p1_position: p1pos, p2_position: p2pos,
      hp1: Math.max(0, hp1), hp2: Math.max(0, hp2),
      maxHP1, maxHP2,
      p1class: p1w.class, p2class: p2w.class,
      p1flash: false, p2flash: false,
      p1hit: false, p2hit: false, p1hs: false, p2hs: false,
      initDist: startDist, projectiles: [], winner
    });
    log.push({ type: 'kill', text: winner === 'tie' ? '⚡ TIE — BOTH ELIMINATED' : winner === 'p1' ? '🏆 PLAYER 1 WINS' : '🏆 PLAYER 2 WINS' });
  }

  return {
    winner, time, dist,
    hp1: Math.max(0, hp1), hp2: Math.max(0, hp2),
    maxHP1, maxHP2,
    dmg1, dmg2,
    healed1, healed2,
    shots1, hits1, hs1: hs1count,
    shots2, hits2, hs2: hs2count,
    frames, log
  };
}


// ═══════════════════════════════════════════════════════════════════
// DISPERSION
//
// The accuracy slider says whether the crosshair is on the target. For
// most guns that is the whole story; for a shotgun or the minigun it is
// only half of it, because the shot leaves the barrel as a cone and only
// the part of the cone that overlaps the target lands.
//
// The model, kept deliberately simple:
//   * the cone has a half-angle θ, so at distance d it covers a disc of
//     radius r = d · tan θ, centred on the target;
//   * pellets (or minigun bullets) land uniformly over that disc;
//   * the target is a disc of radius R, set by class.
// Each pellet then lands with probability q = min(1, (R / r)²), and the
// pellets are independent, so a shot lands Binomial(N, q) of them.
//
// LIMITATION — the numbers are not measured. No source publishes per-weapon
// spread, so every dispersed weapon shares one standard cone, calibrated to
// the only figure anyone states: the minigun note "100% accurate only at
// extreme close range (within ~5m)", read against a Medium. The hitbox
// radii are placeholders of the same standing. Real patterns are not
// uniform discs either — the Model 1887 has an inner and an outer ring. All
// of this is user-adjustable, and switching dispersion off restores the old
// "accuracy is the hit chance" reading exactly.
// ═══════════════════════════════════════════════════════════════════
const HITBOX_RADIUS = { light: 0.35, medium: 0.45, heavy: 0.55 };   // metres, placeholders
const DISPERSION_CALIBRATION_RANGE = 5;                              // metres, minigun note

const DEFAULT_DISPERSION = Object.freeze({
  enabled: true,
  halfAngleDeg: +(Math.atan(HITBOX_RADIUS.medium / DISPERSION_CALIBRATION_RANGE) * 180 / Math.PI).toFixed(2)
});

// One setting for the whole page. Workers have their own copy of this
// global, so the pool hands the current value over on every job — see
// configureDispersion() in cross_analysis_worker.js.
let dispersionSettings = { ...DEFAULT_DISPERSION };

function configureDispersion(settings) {
  dispersionSettings = { ...DEFAULT_DISPERSION, ...(settings || {}) };
  return dispersionSettings;
}

function currentDispersion() {
  return { ...dispersionSettings };
}

/**
 * Chance one pellet (or one minigun bullet) lands, given the crosshair is on
 * a target of `targetClass` at `distance`. 1 for any weapon without a cone,
 * and for every weapon while dispersion is switched off.
 */
function pelletHitChance(stats, distance, targetClass) {
  if (!stats.dispersed || !dispersionSettings.enabled) return 1;
  const radius = HITBOX_RADIUS[targetClass] ?? HITBOX_RADIUS.medium;
  const spread = distance * Math.tan(dispersionSettings.halfAngleDeg * Math.PI / 180);
  return spread <= radius ? 1 : (radius / spread) ** 2;
}

/**
 * One trigger pull, rolled: was it on target, how many pellets connected,
 * and what that came to. Shared by both fighters so the two sides of the
 * duel cannot drift apart.
 *
 * Shotguns have no headshot bonus in any sheet, so a pellet weapon never
 * rolls for one; the minigun is a single bullet and rolls as before once it
 * has landed.
 */
function rollShot(s, acc, hsChance, dist, inRange, targetClass) {
  if (!inRange || rollRandom() >= acc) return { landed: false, onTarget: false };

  const q = pelletHitChance(s, dist, targetClass);
  const drop = dropMult(dist, s);

  if (s.pellets > 1) {
    let pellets = 0;
    for (let i = 0; i < s.pellets; i++) if (rollRandom() < q) pellets++;
    if (pellets === 0) return { landed: false, onTarget: true };
    return { landed: true, isHS: false, pellets, dmg: s.bodyDmg * (pellets / s.pellets) * drop };
  }

  if (q < 1 && rollRandom() >= q) return { landed: false, onTarget: true };
  const isHS = (s.headDmg > s.bodyDmg) && rollRandom() < hsChance;
  return { landed: true, isHS, pellets: 1, dmg: (isHS ? s.headDmg : s.bodyDmg) * drop };
}

function getStats(w) {


  const rpm = parseNum(w.rpm) || 60;




  const bodyDmg = parseNum(w.body_dmg) || 0;
  const headDmg = parseNum(w.head_damage) || bodyDmg;
  const isMelee = w.type === 'Melee';
  const isBurst = w.shots_per_burst != null;
  const bSize = isBurst ? parseInt(w.shots_per_burst) : 1;
  const bDelay = isBurst ? parseFloat(w.delay_in_bursts) : 0;
  const dropMin = parseNum(w.damage_dropoff_min_range);
  const dropMax = parseNum(w.damage_dropoff_max_range);
  // Damage KEPT at max range, as a fraction. Every source records it that way:
  // the sheets print "~72%", the patch notes write it as a multiplier ("falloff
  // multiplier from 0.65 to 0.7, increasing the weapon's damage at range"), and
  // the history screen labels the column "Damage kept at max range".
  //
  // It used to be read here as damage LOST, which silently ran every gun at the
  // complement of its recorded falloff — an SR-84 at 100m did 25% of its damage
  // rather than 75% — and inverted the direction of every falloff change: the
  // KS-23's 11.6.0 nerf came out as a buff. A melee weapon's hard reach limit is
  // the same field with 0 in it: nothing is kept past the swing.
  //
  // A missing value means "no falloff recorded", which is 1 and not 0. Values
  // above 1 are read as percentages, so "72%" and 0.72 both work.
  const rawKeep = w.damage_reduction_at_max;
  const parsedKeep = (rawKeep === null || rawKeep === undefined || rawKeep === '')
    ? 1
    : parseFloat(String(rawKeep).replace(/[~%]/g, ''));
  const dropKeep = !Number.isFinite(parsedKeep) ? 1 : (parsedKeep > 1 ? parsedKeep / 100 : parsedKeep);
  const interval = 60 / rpm;
  const classSpd = CLASS_SPEED[w.class];

  const magSize = Number.isFinite(parseInt(w.magazine_size)) ? parseInt(w.magazine_size) : null;
  const tacticalReload = parseNum(w.tactical_reload_time) || 0;
  const emptyReload = parseNum(w.empty_reload_time) || tacticalReload || 0;

  // body_dmg is the whole shot, every pellet landing — the sheets' unit.
  // `dispersion` marks the single-bullet weapons with a cone (the minigun).
  const pellets = Math.max(1, parseInt(w.pellets) || 1);
  const dispersed = pellets > 1 || !!w.dispersion;

  return {
    pellets,
    dispersed,
    bodyDmg,
    headDmg,
    rpm,
    interval,
    isMelee,
    isBurst,
    bSize,
    bDelay,
    dropMin,
    dropMax,
    dropKeep,
    classSpd,
    magSize,
    tacticalReload,
    emptyReload
  };
}

function dropMult(dist, s) {
  if (!s.dropMin || !s.dropMax) return 1;
  if (dist <= s.dropMin) return 1;
  if (dist >= s.dropMax) return s.dropKeep;
  return 1 - ((dist - s.dropMin) / (s.dropMax - s.dropMin)) * (1 - s.dropKeep);
}