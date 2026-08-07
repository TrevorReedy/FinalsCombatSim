// ═══════════════════════════════════════════════════════════════════
// DUEL SOLVER — exact outcome probabilities, no sampling
//
// Replaces "run this duel 10,000 times and count the winners" with
// "work out what fraction of duels end each way". Same model, exact
// answer, about 200x faster.
//
// ── Why this works ────────────────────────────────────────────────
// Neither fighter reacts to being shot. Nobody flinches, retreats, or
// stops firing at low health — each simply fires on its own clock until
// somebody dies. So the two fighters' timelines never influence each
// other, which splits the problem in two:
//
//   1. WHEN a fighter fires is fixed by its weapon alone (fire interval,
//      burst delays, magazine size, reload time). No randomness at all.
//   2. WHETHER each shot hits, and for how much, is an independent roll.
//
// So we work out each fighter's "kill time distribution" separately — the
// chance its killing blow lands at each moment — and then compare the two.
// Whoever's killing blow lands first wins. This is mathematically
// equivalent to solving the combined two-fighter state graph, without
// having to build one.
//
// ── When this does NOT apply ──────────────────────────────────────
// It assumes every shot from a given weapon deals the same damage, which
// holds whenever the range is fixed — the Meta Simulation's stand-and-fight
// grid. Once fighters move, damage changes shot by shot and the state
// space stops collapsing. `canSolveExactly()` reports that, and callers
// fall back to the seeded sampling engine in simulate.js.
//
// ── Two deliberate differences from the old tick simulation ───────
//   * Timeout is reported as its own outcome. The tick version awarded
//     the win to whoever had more health left after 60 seconds, inventing
//     a winner where nobody actually landed a kill.
//   * A tie means the two killing blows land at the same instant. The
//     tick version called any two kills inside the same 10 ms tick a tie,
//     which inflated tie rates.
//
// Loaded as a plain script by the page, the worker, and the Node tests.
// ═══════════════════════════════════════════════════════════════════

// ── Time is counted in whole microseconds ─────────────────────────
// Shot times get compared for exact equality to detect double kills, and
// raw floating point cannot be trusted for that: two fighters who
// genuinely fire together can land a rounding step apart.
//
// So schedules accumulate in seconds and are rounded to whole microseconds
// only when each shot is recorded. Rounding at the end rather than per
// interval matters: a 540 RPM weapon and a 600 RPM weapon really do both
// fire at exactly 1.000s, and rounding each interval first would drift
// them a microsecond apart and lose the double kill. A microsecond is
// 10,000x finer than the 10 ms tick this replaces.
const MICROS_PER_SECOND = 1e6;

const toMicros = seconds => Math.round(seconds * MICROS_PER_SECOND);
const toSeconds = micros => micros / MICROS_PER_SECOND;

// Probability small enough to stop tracking. The residual is never thrown
// away — it is reported as "never lands a kill", which at this size is
// hundreds of times smaller than the last digit anyone reads off a chart.
const NEGLIGIBLE_PROBABILITY = 1e-12;

// ═══════════════════════════════════════════════════════════════════
// 1. WHEN DOES THIS FIGHTER FIRE?
// ═══════════════════════════════════════════════════════════════════

/** Seconds until the next shot for a weapon that just keeps firing. */
function automaticGapSeconds(stats) {
  return stats.interval;
}

/**
 * Seconds until the next shot after one that ends a burst. The burst delay
 * is an extra pause on top of the normal interval — the convention Krome's
 * data sheet publishes, and that sheet is where the bundled data comes from.
 */
function burstGapSeconds(stats) {
  return stats.bDelay + stats.interval;
}

/**
 * Seconds until the next shot after the one that empties the magazine. A
 * reload replaces the normal gap rather than adding to it, because firing
 * resumes the instant the reload finishes.
 */
function reloadGapSeconds(stats) {
  return stats.emptyReload || stats.tacticalReload || 0;
}

/**
 * Every moment this fighter pulls the trigger, in order, until `maxTime`.
 *
 * Mirrors the firing loop in simulate.js, with the one intended change of
 * not rounding each event up to the next 10 ms tick.
 *
 * @param {object} stats           from getStats(): interval, magSize, isBurst, ...
 * @param {number} firstShotDelay  seconds before the opening shot
 * @param {number} maxTime         stop scheduling past this many seconds
 * @returns {number[]} shot timestamps, in whole microseconds
 */
function buildFiringSchedule(stats, firstShotDelay, maxTime) {
  const shotTimes = [];
  const magazineSize = stats.magSize != null ? stats.magSize : Infinity;

  let nowSeconds = firstShotDelay;
  let roundsLeft = magazineSize;
  let shotsIntoBurst = 0;

  while (nowSeconds < maxTime) {
    shotTimes.push(toMicros(nowSeconds));
    roundsLeft--;

    const magazineIsEmpty = roundsLeft <= 0 && magazineSize !== Infinity;
    if (magazineIsEmpty) {
      nowSeconds += reloadGapSeconds(stats);
      roundsLeft = magazineSize;
      shotsIntoBurst = 0;
    } else if (stats.isBurst) {
      shotsIntoBurst++;
      const burstIsFinished = shotsIntoBurst >= stats.bSize;
      nowSeconds += burstIsFinished ? burstGapSeconds(stats) : automaticGapSeconds(stats);
      if (burstIsFinished) shotsIntoBurst = 0;
    } else {
      nowSeconds += automaticGapSeconds(stats);
    }
  }

  return shotTimes;
}

// ═══════════════════════════════════════════════════════════════════
// 2. WHAT CAN ONE SHOT DO?
// ═══════════════════════════════════════════════════════════════════

/**
 * The three things a single shot can do, and how likely each is.
 *
 * A melee weapon swinging at someone beyond its reach can only ever miss,
 * so its hit chance collapses to zero here instead of becoming a special
 * case in the solver.
 */
function describeShot(stats, accuracy, headshotChance, distance, dropMultiplier) {
  const withinReach = !stats.isMelee || distance <= (stats.dropMin ?? 2.0);
  const hitChance = withinReach ? accuracy : 0;

  // No headshot bonus means no headshots, matching the engine's
  // `headDmg > bodyDmg` guard. When they are equal every hit is simply a
  // body shot, so the two outcomes never collide in the grid below.
  const canHeadshot = stats.headDmg > stats.bodyDmg;
  const headChance = canHeadshot ? hitChance * headshotChance : 0;

  return {
    missChance: 1 - hitChance,
    bodyChance: hitChance - headChance,
    headChance,
    bodyDamage: stats.bodyDmg * dropMultiplier,
    headDamage: stats.headDmg * dropMultiplier
  };
}

// ═══════════════════════════════════════════════════════════════════
// 3. WHEN DOES THIS FIGHTER LAND THE KILLING BLOW?
// ═══════════════════════════════════════════════════════════════════

/**
 * The chance this fighter's killing blow lands on each of its shots.
 *
 * Because every shot deals one of exactly two amounts, the damage done so
 * far is fully described by two counts: body hits and head hits landed.
 * That is a small grid — a few hundred cells — rather than one branch per
 * possible sequence of shots.
 *
 * The walk has three phases per shot: spread each live cell's probability
 * across miss / body / head, siphon off whatever combination just became
 * lethal, then keep going with what is left alive.
 *
 * @returns {{ kills: Array<{atMicros:number, probability:number}>,
 *             neverKillsProbability: number }}
 *          Probabilities are conserved: every kill chance plus
 *          neverKillsProbability sums to 1.
 */
function solveKillTimes(shotTimes, shot, targetHealth) {
  // ── Phase 1: the grid of hit combinations the target survives ──
  const bodyHitsToKill = shot.bodyDamage > 0 ? Math.ceil(targetHealth / shot.bodyDamage) : 0;
  const headHitsToKill = shot.headDamage > 0 ? Math.ceil(targetHealth / shot.headDamage) : 0;

  // A fighter who cannot do damage at all never kills.
  if (bodyHitsToKill === 0 && headHitsToKill === 0) {
    return { kills: [], neverKillsProbability: 1 };
  }

  const gridWidth = headHitsToKill + 1;
  const cellFor = (bodyHits, headHits) => bodyHits * gridWidth + headHits;

  let alive = new Float64Array((bodyHitsToKill + 1) * gridWidth);
  alive[cellFor(0, 0)] = 1;

  const kills = [];
  let aliveProbability = 1;

  for (const atMicros of shotTimes) {
    // Once survival is this unlikely, the rest is reported as a timeout
    // below rather than discarded, so no probability goes missing.
    if (aliveProbability < NEGLIGIBLE_PROBABILITY) break;

    // ── Phase 2: spread every live cell across the shot's outcomes ──
    const stillAlive = new Float64Array(alive.length);
    let killedByThisShot = 0;

    for (let bodyHits = 0; bodyHits <= bodyHitsToKill; bodyHits++) {
      for (let headHits = 0; headHits <= headHitsToKill; headHits++) {
        const probability = alive[cellFor(bodyHits, headHits)];
        if (probability === 0) continue;

        const damageSoFar = bodyHits * shot.bodyDamage + headHits * shot.headDamage;

        // A miss leaves the fighter exactly where it was.
        if (shot.missChance > 0) {
          stillAlive[cellFor(bodyHits, headHits)] += probability * shot.missChance;
        }

        // ── Phase 3: lethal outcomes leave the grid ──
        // Anything that reaches the target's health is siphoned into this
        // shot's kill mass, so it can never be counted twice or fire again.
        if (shot.bodyChance > 0) {
          const mass = probability * shot.bodyChance;
          if (damageSoFar + shot.bodyDamage >= targetHealth) killedByThisShot += mass;
          else stillAlive[cellFor(bodyHits + 1, headHits)] += mass;
        }

        if (shot.headChance > 0) {
          const mass = probability * shot.headChance;
          if (damageSoFar + shot.headDamage >= targetHealth) killedByThisShot += mass;
          else stillAlive[cellFor(bodyHits, headHits + 1)] += mass;
        }
      }
    }

    if (killedByThisShot > 0) {
      kills.push({ atMicros, probability: killedByThisShot });
      aliveProbability -= killedByThisShot;
    }
    alive = stillAlive;
  }

  // ── Phase 4: anyone still standing when the shots run out never dies ──
  return { kills, neverKillsProbability: Math.max(0, aliveProbability) };
}

// ═══════════════════════════════════════════════════════════════════
// 4. WHO WINS?
// ═══════════════════════════════════════════════════════════════════

/**
 * Splits one fighter's kill chances into "killed first" and "killed at the
 * very same instant", and tracks when its wins happen.
 *
 * The opponent's remaining chances are drained with a moving index as we
 * advance through time, so this stays linear instead of comparing every
 * pair of moments.
 */
function scanAgainst(mine, theirs) {
  let winProbability = 0;
  let tieProbability = 0;
  let winTimeWeightedSum = 0;

  // Their kill chances still ahead of us on the timeline.
  let theirChancesAhead = 1 - theirs.neverKillsProbability;
  let theirIndex = 0;

  for (const myKill of mine.kills) {
    // Drop every kill of theirs landing before this moment: in those
    // duels we were already dead and never got here.
    while (theirIndex < theirs.kills.length && theirs.kills[theirIndex].atMicros < myKill.atMicros) {
      theirChancesAhead -= theirs.kills[theirIndex].probability;
      theirIndex++;
    }

    // A kill of theirs at this exact microsecond is a double kill. Shot
    // times within one schedule strictly increase, so at most one lines up.
    const simultaneous = (theirIndex < theirs.kills.length
      && theirs.kills[theirIndex].atMicros === myKill.atMicros)
      ? theirs.kills[theirIndex].probability
      : 0;

    // They outlive this moment if their kill lands later or never comes.
    const theyOutliveThisMoment =
      (theirChancesAhead - simultaneous) + theirs.neverKillsProbability;

    winProbability += myKill.probability * theyOutliveThisMoment;
    tieProbability += myKill.probability * simultaneous;
    winTimeWeightedSum += myKill.probability * theyOutliveThisMoment * toSeconds(myKill.atMicros);
  }

  return {
    winProbability,
    tieProbability,
    averageWinTime: winProbability > 0 ? winTimeWeightedSum / winProbability : null
  };
}

/**
 * The four ways a duel can end. Exactly one of them happens, so they sum
 * to 1 — and because each side is scanned independently rather than one
 * being derived from the other, that sum is a genuine check on the maths
 * rather than something true by construction.
 */
function compareKillTimes(p1, p2) {
  const fromP1 = scanAgainst(p1, p2);
  const fromP2 = scanAgainst(p2, p1);

  const outcome = {
    p1WinsFirst: fromP1.winProbability,
    p2WinsFirst: fromP2.winProbability,
    // Both scans see the same double kills; either count will do.
    bothDieTogether: fromP1.tieProbability,
    // Neither lands a killing blow before the clock runs out.
    nobodyDies: p1.neverKillsProbability * p2.neverKillsProbability,
    p1AverageWinTime: fromP1.averageWinTime,
    p2AverageWinTime: fromP2.averageWinTime
  };

  warnIfProbabilitiesDoNotSumToOne(outcome);
  return outcome;
}

/**
 * The conservation check. Anything other than 1 means probability has
 * gone missing or been counted twice, which would silently corrupt every
 * win rate downstream — so it is worth saying loudly.
 */
function warnIfProbabilitiesDoNotSumToOne(outcome) {
  const total = outcome.p1WinsFirst + outcome.p2WinsFirst
    + outcome.bothDieTogether + outcome.nobodyDies;
  if (Math.abs(total - 1) > 1e-9) {
    console.warn(`duel_solver: outcome probabilities sum to ${total}, expected 1`);
  }
  return total;
}

// ═══════════════════════════════════════════════════════════════════
// 5. PUBLIC ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

/**
 * True when the exact solver applies. It needs damage to be identical on
 * every shot, so neither fighter may move during the duel.
 */
function canSolveExactly({ meleeAdvance, speedOverride, p1Stats, p2Stats }) {
  const anyoneMoves = meleeAdvance
    || ((p1Stats.isMelee || p2Stats.isMelee) && (speedOverride ?? 99) > 0);
  return !anyoneMoves;
}

/**
 * Exact outcome probabilities for one matchup at one fixed range.
 *
 * @returns {{ p1WinRate, p2WinRate, tieRate, timeoutRate,
 *             p1AvgKillTime, p2AvgKillTime, exact: true }}
 *          The four rates sum to 1. Kill times are averaged over only the
 *          duels that fighter actually wins, and are null if it never wins.
 */
function solveDuelExactly({
  p1Stats, p2Stats,
  p1Accuracy, p1HeadshotChance,
  p2Accuracy, p2HeadshotChance,
  p1MaxHealth, p2MaxHealth,
  distance,
  firstShot = 'p1',
  maxTime = 60,
  dropMultiplierFor
}) {
  // First-shot advantage: whoever does not open waits one of their own
  // shot intervals, exactly as the engine sets it up.
  const p1FirstShotDelay = firstShot === 'p2' ? p1Stats.interval : 0;
  const p2FirstShotDelay = firstShot === 'p1' ? p2Stats.interval : 0;

  const p1Shot = describeShot(p1Stats, p1Accuracy, p1HeadshotChance,
    distance, dropMultiplierFor(distance, p1Stats));
  const p2Shot = describeShot(p2Stats, p2Accuracy, p2HeadshotChance,
    distance, dropMultiplierFor(distance, p2Stats));

  const p1Kills = solveKillTimes(
    buildFiringSchedule(p1Stats, p1FirstShotDelay, maxTime), p1Shot, p2MaxHealth);
  const p2Kills = solveKillTimes(
    buildFiringSchedule(p2Stats, p2FirstShotDelay, maxTime), p2Shot, p1MaxHealth);

  const outcome = compareKillTimes(p1Kills, p2Kills);

  return {
    p1WinRate: outcome.p1WinsFirst,
    p2WinRate: outcome.p2WinsFirst,
    tieRate: outcome.bothDieTogether,
    timeoutRate: outcome.nobodyDies,
    p1AvgKillTime: outcome.p1AverageWinTime,
    p2AvgKillTime: outcome.p2AverageWinTime,
    exact: true
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MICROS_PER_SECOND, toMicros, toSeconds,
    buildFiringSchedule, describeShot, solveKillTimes,
    scanAgainst, compareKillTimes, warnIfProbabilitiesDoNotSumToOne,
    canSolveExactly, solveDuelExactly
  };
}
