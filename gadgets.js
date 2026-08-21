// ═══════════════════════════════════════════════════════════════════
// GADGETS — the kit roster, what a squad is allowed to bring, and the
// damage pools that shields put in front of a defender
//
// csv/gadgets/ carries every specialization, gadget and carriable in the
// game. Most of them are roster entries and nothing more: this file can
// tell you that a Dome Shield is a Heavy gadget and that a Light cannot
// bring one, which is all the loadout rules need. Two of them — the Mesh
// Shield and the Dome Shield — carry numbers, and turn into a damage pool
// the sustain solver walks through before it reaches anybody's health.
//
// ── Why a loadout rule belongs in the simulation ──────────────────
// The sustain screen answers "what keeps you standing on the objective",
// and the honest version of that question is asked of a *squad of three*,
// not of a wish list. A Heal Beam is a Medium specialization, an H+
// Infuser is a Light gadget, and a Mesh Shield is a Heavy specialization —
// wanting all three means wanting three specific teammates, and you only
// have two. Enumerating combinations without that rule produces a ranking
// whose top rows nobody can actually field, which is worse than useless:
// it looks like advice.
//
// So `isLegalKit` does the seating: it hands every item to a player, with
// the defender's class fixed and two teammates free, respecting one
// specialization and three gadgets each. What comes back is exactly the
// set of kits a real squad can bring.
//
// ── Why a shield is a pool and not a health bonus ─────────────────
// Shield health is not the defender's health. It absorbs first, it does
// not benefit from healing, and — for the Dome — it disappears on a timer
// whether or not it was used. All three matter on a 7 second hold, so the
// solver tracks it as its own layer. See duel_solver.js for the walk.
// ═══════════════════════════════════════════════════════════════════

// ── Squad shape ───────────────────────────────────────────────────
// One specialization and three gadgets each, three players to a squad.
// These are the rules the game enforces on the loadout screen.
const SQUAD_SIZE = 3;
const SPECIALIZATION_SLOTS = 1;
const GADGET_SLOTS = 3;

// How much of the time a shield is actually between you and the people
// shooting at you.
//
// The Dome is a bubble: at any range outside its radius it covers you from
// every direction, and at any range inside it the attacker is in there with
// you and it covers nothing. That is geometry, so it is computed rather
// than assumed — see `shieldCoverageAt`.
//
// The Mesh is a flat panel held in front of the user, so it covers one
// arc and no more. Whether it is the right arc depends on where the
// attacker is standing, whether they moved, and whether you turned to face
// them, none of which this model has any way to know. MESH_COVERAGE is the
// fraction of engagements it is assumed to be facing the right way for.
// It is an assumption, not a measurement, and it is a single number here
// so it can be argued with in one place; the sustain screen exposes it as
// a control for the same reason.
const MESH_COVERAGE = 0.6;

// ── Version ordering ──────────────────────────────────────────────
// Same rule as heals.js and the ingests. Defined again rather than shared
// so this file can be loaded on its own by a test harness.
function compareGadgetVersions(a, b) {
  const A = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const B = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const diff = (A[i] ?? 0) - (B[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * Look up one kit item as it stood at a given data version.
 *
 * Provenance works exactly as it does for heals: asking about a version
 * before the item existed is answered from its earliest snapshot and
 * labelled `theoretical` rather than refused. An item with no snapshots at
 * all — most of the roster — resolves with `fields: null` and
 * `provenance: 'roster'`, which is a real answer to "is a Light allowed to
 * bring this" and an honest refusal of "how much health does it have".
 */
function resolveGadgetAt(timeline, id, version) {
  const item = timeline && timeline.items && timeline.items[id];
  if (!item) return null;

  const base = {
    id: item.id,
    name: item.name,
    classes: item.classes,
    slot: item.slot,
    category: item.category,
    self_use: item.self_use,
    heal_id: item.heal_id,
    model: item.model,
    introducedAt: item.introduced
  };

  const versions = Object.keys(item.snapshots).sort(compareGadgetVersions);
  if (!versions.length) {
    return { ...base, fields: null, provenance: 'roster', sourceVersion: null };
  }

  let sourceVersion = null;
  for (const v of versions) {
    if (compareGadgetVersions(v, version) <= 0) sourceVersion = v;
    else break;
  }

  let provenance;
  if (sourceVersion === null) {
    sourceVersion = versions[0];
    provenance = 'theoretical';
  } else {
    provenance = sourceVersion === version ? 'exact' : 'carried';
  }

  return { ...base, fields: item.snapshots[sourceVersion].fields, provenance, sourceVersion };
}

// ── Loadout legality ──────────────────────────────────────────────

/** Can a player of this class carry this item at all? */
function classCanCarry(item, playerClass) {
  return item.slot === 'carriable' || item.classes.includes(playerClass);
}

/**
 * Can the squad described by `defenderClass` bring all of these items?
 *
 * The defender is one of the three players and their class is fixed; the
 * other two are whatever the squad wants them to be. An item whose carrier
 * gets nothing out of it — the Heal Beam cannot heal its own user, the
 * Infuser cannot heal its own user — has to sit with a teammate, because
 * the whole question is what is keeping *the defender* alive.
 *
 * Carriables cost no slot: the Healing Barrel is picked up off the map
 * rather than equipped, so it neither needs a class nor displaces a gadget.
 *
 * Small enough to answer by exhaustive search — at most a handful of items
 * over three seats — so there is nothing clever here to get wrong.
 */
function isLegalKit(items, defenderClass) {
  const needSeat = items.filter(it => it.slot !== 'carriable');
  if (!needSeat.length) return true;

  // Seat 0 is the defender. The other two are free, and only the multiset
  // of their classes matters, so pairs are enumerated without order.
  const CLASSES = ['light', 'medium', 'heavy'];
  for (let a = 0; a < CLASSES.length; a++) {
    for (let b = a; b < CLASSES.length; b++) {
      const squad = [defenderClass, CLASSES[a], CLASSES[b]];
      if (seatItems(needSeat, squad)) return true;
    }
  }
  return false;
}

/**
 * Try to give every item a seat in this squad. Depth-first over the items,
 * which is exact and, at this size, instant.
 */
function seatItems(items, squad) {
  const specs = squad.map(() => 0);
  const gadgets = squad.map(() => 0);

  const place = i => {
    if (i === items.length) return true;
    const item = items[i];

    for (let seat = 0; seat < squad.length; seat++) {
      // Seat 0 is the defender, and an item that does nothing for its own
      // carrier does nothing for the defender when the defender carries it.
      if (seat === 0 && !item.self_use) continue;
      if (!classCanCarry(item, squad[seat])) continue;

      if (item.slot === 'specialization') {
        if (specs[seat] >= SPECIALIZATION_SLOTS) continue;
        specs[seat]++;
        if (place(i + 1)) return true;
        specs[seat]--;
      } else {
        if (gadgets[seat] >= GADGET_SLOTS) continue;
        gadgets[seat]++;
        if (place(i + 1)) return true;
        gadgets[seat]--;
      }
    }
    return false;
  };

  return place(0);
}

/**
 * Every legal combination of the given items for a defender of this class.
 *
 * Returns subsets in the order the ids were given, smallest first, each as
 * `{ ids, items }`. The empty kit is always legal and always included — it
 * is the baseline every other row is read against.
 */
function allLegalKits(resolvedItems, defenderClass) {
  const kits = [];
  for (let mask = 0; mask < (1 << resolvedItems.length); mask++) {
    const items = resolvedItems.filter((_, i) => mask & (1 << i));
    if (!isLegalKit(items, defenderClass)) continue;
    kits.push({ ids: items.map(it => it.id), items });
  }
  return kits.sort((x, y) => x.ids.length - y.ids.length);
}

// ── Shields ───────────────────────────────────────────────────────

/**
 * How much of the incoming fire this shield is between you and, at this
 * range. 1 means every shot has to go through it; 0 means it may as well
 * not be there.
 *
 * The Dome is decided by geometry: an attacker closer than its radius is
 * standing inside the bubble with you, and the bubble stops nothing. The
 * Mesh is decided by MESH_COVERAGE, for the reasons written there — the
 * caller may override it, and the sustain screen does.
 */
function shieldCoverageAt(resolved, distance, meshCoverage = MESH_COVERAGE) {
  if (!resolved || resolved.model !== 'shield' || !resolved.fields) return 0;

  const radius = resolved.fields.radius;
  if (radius != null) return distance >= radius ? 1 : 0;

  return meshCoverage;
}

/**
 * Turn resolved shield items into the one damage pool the solver walks.
 *
 * Pools add up, and they are consumed from the outside in. The Dome is a
 * 4m bubble and the Mesh is a panel held at arm's length inside it, so
 * incoming fire meets the Dome first and whatever is left of the Mesh is
 * the layer nearest your health.
 *
 * That ordering is what makes an expiry a single clamp. When the Dome's
 * timer runs out, everything still absorbing is Mesh, so the remaining
 * pool is capped at what the surviving layers are worth — no matter how
 * much damage had already been soaked, and no matter which layer soaked
 * it. `expiries` carries that cap per moment, and the solver applies it.
 *
 * Everything here starts at t=0, on the same assumption the heal schedules
 * make: the support is already set up when the hold begins. Dropping a
 * Dome late to cover the end of a steal is a real play and this does not
 * model it; the sustain screen says so.
 *
 * @returns {null | { pool: number, expiries: Array<{at:number, poolAfter:number}> }}
 */
function combineShields(resolvedShields) {
  const shields = (resolvedShields || []).filter(s => s && s.fields && s.fields.device_hp > 0);
  if (!shields.length) return null;

  const pool = shields.reduce((sum, s) => sum + s.fields.device_hp, 0);

  const times = [...new Set(
    shields.map(s => s.fields.duration).filter(d => d != null)
  )].sort((a, b) => a - b);

  const expiries = times.map(at => ({
    at,
    // What is still absorbing the instant after this moment.
    poolAfter: shields
      .filter(s => s.fields.duration == null || s.fields.duration > at)
      .reduce((sum, s) => sum + s.fields.device_hp, 0)
  }));

  return { pool, expiries };
}

// The page and the worker load this as a plain script; the Node tests read
// and wrap it. Same arrangement as heals.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SQUAD_SIZE, SPECIALIZATION_SLOTS, GADGET_SLOTS, MESH_COVERAGE,
    compareGadgetVersions, resolveGadgetAt,
    classCanCarry, isLegalKit, allLegalKits,
    shieldCoverageAt, combineShields
  };
}
