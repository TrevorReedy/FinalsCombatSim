// ═══════════════════════════════════════════════════════════════════
// HEALS — shared combat constants, heal schedules, and stack composition
//
// Loaded first by the page and by the worker, so everything downstream
// shares one definition of how big a Light is and how fast a beam heals.
//
// ── Why healing is a function of time and nothing else ────────────
// A heal here comes from an off-screen support — a "pocket healer" — not
// from the fighter itself. That matters more than it sounds: the support
// heals on its own clock regardless of how the fight is going, so the
// heal delivered by time t is fixed before the duel starts.
//
// That is what lets duel_solver.js stay exact. Its whole argument is that
// the two fighters never influence each other, so their kill-time
// distributions can be solved separately. A heal that reacted to damage
// would couple them and collapse the argument; a heal that only watches
// the clock does not.
//
// So every schedule below answers exactly one question — "how much health
// has been delivered by time t" — in closed form, with no reference to
// what has happened in the fight.
// ═══════════════════════════════════════════════════════════════════

// ── Combat constants ──────────────────────────────────────────────
// These used to be copy-pasted into battle_simulator.js, the worker, and
// both test harnesses. A comment in the worker recorded what that cost:
// a mismatch "silently gave the meta analysis a different game than the
// 1v1 simulation". One definition, loaded everywhere.
const CLASS_SPEED = { light: 7.0, medium: 5.0, heavy: 3.5 };
const CLASS_HP    = { light: 150, medium: 250, heavy: 350 };
const MELEE_RANGE = 2.0;
const DT          = 0.01;
const MAX_TIME    = 60;

// Out-of-combat regeneration. The delays are documented; the rate is not
// published anywhere and is measured in game — see the memory note and
// csv/heals/README.md. Kept per-class even though all three currently
// share a rate, so a later finding that they differ is a data edit.
const CLASS_REGEN = {
  light:  { delay: 7,  rate: 40 },
  medium: { delay: 9,  rate: 40 },
  heavy:  { delay: 10, rate: 40 }
};

// Whether two healing zones overlapping sum or take the higher rate.
//
// Everything stacks except the placed zones. The beam and the H+ Infuser
// add on top of anything else — two supports pouring into one fighter
// deliver both rates. The Healing Emitter does not: standing in two
// overlapping fields is worth no more than standing in the better one,
// so the Emitter and the Healing Barrel take the higher rate rather than
// the sum. The Barrel's contact burst is an instant heal rather than a
// field rate, and still lands on top.
//
// 'sum' is left here as a single flip if the Barrel turns out to combine
// with the Emitter after all — that pairing is assumed, not measured.
const ZONE_STACKING = 'max';   // 'sum' | 'max'

// ── Version ordering ──────────────────────────────────────────────
// Same rule as ingest_heals.mjs and ui_shell.js: compare numerically,
// segment by segment, so 5.8 and 5.12.0 sort correctly against each other.
function compareHealVersions(a, b) {
  const A = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const B = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const diff = (A[i] ?? 0) - (B[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

// ── Resolving an item at a version ────────────────────────────────
/**
 * Look up one heal item as it stood at a given data version.
 *
 * Asking for an item before it existed is allowed, not an error. The
 * point of this tool is to be able to put Season 1's beam against the
 * ball's launch build; refusing the question would be worse than
 * answering it with a label. Callers get `provenance: 'theoretical'`
 * and are expected to say so.
 *
 * @returns {null | {
 *   id, name, kind, self_heal, fields,
 *   provenance: 'exact' | 'carried' | 'theoretical',
 *   sourceVersion,        // which snapshot the numbers actually came from
 *   introducedAt          // when the item first existed
 * }}
 */
function resolveHealAt(timeline, id, version) {
  const item = timeline && timeline.items && timeline.items[id];
  if (!item) return null;

  const versions = Object.keys(item.snapshots).sort(compareHealVersions);

  // Newest snapshot at or before the version asked for.
  let sourceVersion = null;
  for (const v of versions) {
    if (compareHealVersions(v, version) <= 0) sourceVersion = v;
    else break;
  }

  let provenance;
  if (sourceVersion === null) {
    // Predates the item entirely — fall forward to its launch state.
    sourceVersion = versions[0];
    provenance = 'theoretical';
  } else {
    provenance = sourceVersion === version ? 'exact' : 'carried';
  }

  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    self_heal: item.self_heal,
    fields: item.snapshots[sourceVersion].fields,
    provenance,
    sourceVersion,
    introducedAt: item.introduced
  };
}

// ── Schedules ─────────────────────────────────────────────────────
// Each returns { deliveredBy(t), rateAt(t) }, both closed form.
//
// `deliveredBy` is what the solver and the tick engine both read, and it
// is the cumulative total rather than a rate on purpose: the tick engine
// advances health by the *difference* of it across a tick, so the two
// engines cannot drift apart no matter how the curve is shaped.
//
// Every schedule assumes the support is healing continuously from t=0.
// That is the strongest case for the person being healed, which is the
// interesting one for a sustain question — the fields describing partial
// recovery after a voluntary pause (recharge_delay, recharge_rate on the
// beam) are recorded in the data but unused here, because modelling a
// healer who stops early would mean modelling a healer's judgement.

function beamSchedule(f) {
  // Heals flat out until it overheats, then nothing until it has cooled.
  // A square wave: `overheat_time` on, `overheat_cooldown` off.
  const rate = f.heal_rate;
  const on = f.overheat_time;
  const period = on + f.overheat_cooldown;
  const perCycle = rate * on;

  return {
    deliveredBy(t) {
      if (t <= 0) return 0;
      const cycles = Math.floor(t / period);
      const rem = t - cycles * period;
      return cycles * perCycle + Math.min(rem, on) * rate;
    },
    rateAt(t) {
      if (t < 0) return 0;
      return (t - Math.floor(t / period) * period) < on ? rate : 0;
    }
  };
}

function ballSchedule(f) {
  // Ramps from `ramp_from` to `ramp_to` over `ramp_time`, then holds.
  // Integrating the ramp gives from*t + (to-from)*t^2/(2*T); the ramp
  // contributes the mean of its endpoints times its duration.
  const from = f.ramp_from, to = f.ramp_to, T = f.ramp_time;
  const rampTotal = (from + to) / 2 * T;

  return {
    deliveredBy(t) {
      if (t <= 0) return 0;
      if (t < T) return from * t + (to - from) * t * t / (2 * T);
      return rampTotal + to * (t - T);
    },
    rateAt(t) {
      if (t < 0) return 0;
      return t < T ? from + (to - from) * t / T : to;
    }
  };
}

function infuserSchedule(f) {
  // Dumps its whole magazine at the weapon's rate of fire, sits empty for
  // `recharge_delay`, refills at `recharge_rate`, repeats. Discrete
  // pulses, so this steps rather than slopes.
  const interval = 60 / f.rpm;
  const shots = f.capacity;
  const per = f.heal_per_shot;
  const dumpTime = (shots - 1) * interval;      // first shot lands at t=0
  const refill = shots / f.recharge_rate;
  const period = dumpTime + f.recharge_delay + refill;
  const perCycle = shots * per;

  return {
    deliveredBy(t) {
      if (t < 0) return 0;
      const cycles = Math.floor(t / period);
      const rem = t - cycles * period;
      const fired = Math.min(shots, Math.floor(rem / interval) + 1);
      return cycles * perCycle + fired * per;
    },
    // Averaged across the shot interval — an instantaneous rate for
    // something that fires in pulses is only meaningful as a mean.
    rateAt(t) {
      if (t < 0) return 0;
      const rem = t - Math.floor(t / period) * period;
      return rem <= dumpTime ? per / interval : 0;
    }
  };
}

function canisterSchedule(f) {
  // A one-shot: heals on contact, then leaves a zone that runs for a
  // fixed time and never comes back.
  const burst = f.burst_heal, rate = f.heal_rate, dur = f.active_duration;

  return {
    deliveredBy(t) {
      if (t < 0) return 0;
      return burst + rate * Math.min(t, dur);
    },
    rateAt(t) {
      return (t >= 0 && t < dur) ? rate : 0;
    }
  };
}

const SCHEDULE_BUILDERS = {
  beam: beamSchedule,
  ball: ballSchedule,
  infuser: infuserSchedule,
  canister: canisterSchedule
};

/** Build the schedule for one resolved heal item. */
function healScheduleFor(resolved) {
  const build = SCHEDULE_BUILDERS[resolved.id];
  if (!build) throw new Error(`No schedule for heal item "${resolved.id}"`);
  return build(resolved.fields);
}

// ── Stacking ──────────────────────────────────────────────────────
// One item per source, up to four. Two of the same never stack, which is
// enforced here rather than trusted from the UI.

const NO_HEAL = { deliveredBy: () => 0, rateAt: () => 0, isEmpty: true };

/**
 * Combine several resolved heal items into one schedule.
 *
 * A stack with at most one zone in it is a straight sum, and stays closed
 * form. Two zones under ZONE_STACKING 'max' contribute the higher of their
 * rates rather than both, which is not expressible as a sum of cumulative
 * curves — so that path integrates the instantaneous maximum onto a prefix
 * table once, and reads it back by interpolation. Only 16 distinct stacks
 * ever exist, so building a table per stack is cheap.
 */
function combineSchedules(resolvedItems) {
  const items = resolvedItems || [];
  if (!items.length) return NO_HEAL;

  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) throw new Error(`Heal stack contains two of "${it.id}"`);
    seen.add(it.id);
  }

  const parts = items.map(it => ({ kind: it.kind, sched: healScheduleFor(it) }));

  if (ZONE_STACKING === 'sum' || parts.filter(p => p.kind === 'zone').length < 2) {
    return {
      deliveredBy(t) {
        let total = 0;
        for (const p of parts) total += p.sched.deliveredBy(t);
        return total;
      },
      rateAt(t) {
        let total = 0;
        for (const p of parts) total += p.sched.rateAt(t);
        return total;
      }
    };
  }

  return zoneMaxSchedule(parts);
}

// Take the higher of the overlapping zone rates, and add everything else
// on top.
//
// Only the zones go onto a grid. A maximum of two rates is not the sum of
// two cumulative curves, so there is nothing to add up in closed form and
// the instantaneous maximum has to be integrated. Everything else keeps
// its own exact `deliveredBy` — integrating those too would quietly lose
// anything that arrives as a pulse rather than a rate, which is most of
// what the H+ Infuser does: its first shot lands at t=0 with no width for
// a rate to live in, and integrating a rate curve would drop it.
//
// Instant bursts have the same problem within the zone group, so they are
// added at the step they land rather than integrated.
function zoneMaxSchedule(parts) {
  const STEP = 0.001;
  const steps = Math.ceil(MAX_TIME / STEP) + 1;
  const table = new Float64Array(steps);

  const zones = parts.filter(p => p.kind === 'zone');
  const others = parts.filter(p => p.kind !== 'zone');

  const zoneRateAt = t => {
    let r = 0;
    for (const p of zones) r = Math.max(r, p.sched.rateAt(t));
    return r;
  };

  // Bursts show up as a jump in deliveredBy at t=0 that rateAt cannot see.
  // They are summed rather than maxed even though the fields they come with
  // are not: an instant heal on contact is not a field rate, so two of them
  // both land. Only the Barrel has one today, so this changes nothing yet.
  let acc = 0;
  for (const p of zones) acc += p.sched.deliveredBy(0);

  // Trapezoid rather than left-hand sum, which makes a linear ramp — the
  // Emitter's whole opening — exact instead of a step behind.
  table[0] = acc;
  let prevRate = zoneRateAt(0);
  for (let i = 1; i < steps; i++) {
    const rate = zoneRateAt(i * STEP);
    acc += (prevRate + rate) / 2 * STEP;
    prevRate = rate;
    table[i] = acc;
  }

  const zoneDeliveredBy = t => {
    if (t <= 0) return table[0];
    if (t >= MAX_TIME) return table[steps - 1];
    const x = t / STEP;
    const i = Math.floor(x);
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  };

  return {
    deliveredBy(t) {
      let total = zoneDeliveredBy(t);
      for (const p of others) total += p.sched.deliveredBy(t);
      return total;
    },
    rateAt(t) {
      let total = zoneRateAt(t);
      for (const p of others) total += p.sched.rateAt(t);
      return total;
    }
  };
}

/** Every legal stack: each item present or absent, one of each. 2^n. */
function allHealStacks(ids) {
  const out = [];
  for (let mask = 0; mask < (1 << ids.length); mask++) {
    out.push(ids.filter((_, i) => mask & (1 << i)));
  }
  return out;
}

// The page loads this as a plain script; the Node tests read and wrap it.
// Neither wants module syntax, so exports go on globalThis when present.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CLASS_SPEED, CLASS_HP, MELEE_RANGE, DT, MAX_TIME, CLASS_REGEN, ZONE_STACKING,
    compareHealVersions, resolveHealAt, healScheduleFor, combineSchedules,
    allHealStacks, NO_HEAL
  };
}
