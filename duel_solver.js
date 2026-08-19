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
// Out-of-combat regeneration is the other exclusion, for a different
// reason: it keys off time since the last damage taken, which depends on
// which shots landed, so it cannot be read off the clock.
//
// ── Healing changes the state, not the argument ───────────────────
// A pocket healer works off the clock rather than off the fight, so it
// leaves the independence argument intact. What it does change is what
// the walk should be indexed by.
//
// Hit counts are the natural state for an unhealed fighter: damage is
// damage whenever it lands, so the total is all that matters. Healing
// breaks that, because health poured into someone already full is lost —
// so how much of a heal survives depends on how big the hole was at the
// moment it arrived, and a hit count cannot say when its hits landed.
//
// That is not a correction term waiting to be found. Absorbed healing is
// a path integral of min(rate, deficit), and no function of a hit count
// recovers a path. An earlier version tried anyway, discounting the
// expected heal wasted before first contact and capping absorbed heal at
// the damage taken so far. It held up on the fast weapons it was tested
// against and came apart elsewhere: against an H+ Infuser emptying 220 HP
// into a Light in a second and a half, it credited that heal against
// damage arriving four seconds later and reported a target both sampling
// engines agreed dies an eighth of the time as unkillable. Thirty-five
// points, not the half a point the tests of the day suggested.
//
// So healed walks index by health instead — see solveKillTimesByHealth —
// where the clamp is something the walk performs rather than something it
// approximates. Unhealed walks keep the hit-count grid, which is exact and
// cheaper. Agreement with an exact-clamp sampler is now inside a fifth of
// a point across the roster, shotguns and grenade launchers included, and
// tools/test_sustain.mjs pins it.
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
 * Could this fighter kill the target at all, given the healing it is
 * receiving? Answered by the luckiest possible run — every shot a
 * headshot — because if that cannot get there, nothing can.
 *
 * This exists for the sustain grid, where most cells pit a weapon against
 * a heal stack that simply outpaces it. Deciding those in one pass over
 * the schedule, rather than by walking a grid sized for a minute of
 * accumulated healing, is the difference between the screen being
 * affordable and not.
 *
 * Exact, not a heuristic: it is the same lethality test the walk applies,
 * evaluated on an upper bound of the damage. A `false` here means every
 * cell in that walk would also have failed it.
 */
function killIsReachable(shotTimes, maxShotDamage, targetHealth, healSchedule) {
  if (shotTimes.length === 0) return false;

  // This walks the best case for the attacker — every shot lands, every one
  // a headshot. On that path the first hit is the opening shot, so the heal
  // wasted before it is exactly what had been delivered by then, with no
  // expectation to take. Discounting the roster-wide average here instead
  // would credit the attacker with heal this path never let go to waste,
  // and could call a target killable that no run can kill.
  const wasted = healSchedule.deliveredBy(toSeconds(shotTimes[0]));

  for (let shotCount = 1; shotCount <= shotTimes.length; shotCount++) {
    const atSeconds = toSeconds(shotTimes[shotCount - 1]);
    const damageBefore = (shotCount - 1) * maxShotDamage;
    const healed = Math.max(0, healSchedule.deliveredBy(atSeconds) - wasted);
    const threshold = targetHealth + Math.min(healed, damageBefore);
    if (damageBefore + maxShotDamage >= threshold) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// 3b. THE SAME WALK, INDEXED BY HEALTH
//
// Hit counts are the right state for an unhealed fighter and the wrong one
// for a healed one, and the reason is worth spelling out because it took a
// grenade launcher to make it obvious.
//
// A cell holding "two body hits" knows how much damage arrived but not
// *when*. Without healing that is a distinction without a difference —
// damage is damage whenever it lands. With healing it is the whole
// problem, because healing past full is discarded, so how much of a heal
// survives depends on how big the hole was at the moment it arrived. The
// H+ Infuser empties 220 HP into a target in a second and a half; against
// a 150 HP Light who has taken one hit, almost all of it is thrown away.
// Credit it against damage that arrives four seconds later and the Light
// looks unkillable. It is not — both sampling engines agree it dies about
// an eighth of the time, and the hit-count grid said never.
//
// The fix is not a better correction term. Absorbed healing is a path
// integral of min(rate, deficit), and no function of a hit count can
// recover a path. So the state changes: track the distribution of the
// target's *health*, which is the quantity being clamped, and the clamp
// becomes something the walk can just do.
//
// Health is continuous, so it goes on a grid of HEALTH_BUCKETS steps and
// mass that lands between two of them is split across both in proportion.
// That is unbiased rather than rounded — a bias here would accumulate over
// a hundred shots — and leaves an error on the order of one bucket, which
// at 2048 buckets is under a tenth of a hit point.
//
// Costs about the same as the hit-count grid and is used only when there
// is healing to model; without it the hit-count walk is exact, cheaper,
// and stays in charge.
// ═══════════════════════════════════════════════════════════════════

const HEALTH_BUCKETS = 2048;

function solveKillTimesByHealth(shotTimes, shot, targetHealth, healSchedule) {
  const step = targetHealth / HEALTH_BUCKETS;
  const TOP = HEALTH_BUCKETS;

  // Mass at bucket i means health i * step. Bucket 0 is dead.
  let alive = new Float64Array(TOP + 1);
  let next = new Float64Array(TOP + 1);
  alive[TOP] = 1;

  const kills = [];
  let aliveProbability = 1;
  let previousSeconds = 0;

  // Damage is fixed for the whole walk, so its bucket split is worked out
  // once rather than per shot.
  const bodyDrop = shot.bodyDamage / step;
  const headDrop = shot.headDamage / step;
  const outcomes = [];
  if (shot.bodyChance > 0) outcomes.push({ chance: shot.bodyChance, whole: Math.floor(bodyDrop), frac: bodyDrop - Math.floor(bodyDrop) });
  if (shot.headChance > 0) outcomes.push({ chance: shot.headChance, whole: Math.floor(headDrop), frac: headDrop - Math.floor(headDrop) });

  for (const atMicros of shotTimes) {
    if (aliveProbability < NEGLIGIBLE_PROBABILITY) break;

    const atSeconds = toSeconds(atMicros);

    // ── Heal since the previous shot, clamped at full ──
    // Everything the support delivered in the gap, moved up the grid.
    // Anything that would go past full piles up at the top, and that pile
    // is the overheal the hit-count grid could not see.
    const gained = healSchedule
      ? (healSchedule.deliveredBy(atSeconds) - healSchedule.deliveredBy(previousSeconds)) / step
      : 0;
    previousSeconds = atSeconds;

    if (gained > 0) {
      next.fill(0);
      const whole = Math.floor(gained);
      const frac = gained - whole;
      for (let i = 1; i <= TOP; i++) {
        const mass = alive[i];
        if (mass === 0) continue;
        const lower = i + whole;
        if (lower >= TOP) { next[TOP] += mass; continue; }
        next[lower] += mass * (1 - frac);
        const upper = lower + 1;
        next[upper >= TOP ? TOP : upper] += mass * frac;
      }
      const swap = alive; alive = next; next = swap;
    }

    // ── The shot ──
    next.fill(0);
    let killedByThisShot = 0;

    for (let i = 1; i <= TOP; i++) {
      const mass = alive[i];
      if (mass === 0) continue;

      if (shot.missChance > 0) next[i] += mass * shot.missChance;

      for (const outcome of outcomes) {
        const share = mass * outcome.chance;
        // The drop lands between two buckets, so it is split across both
        // rather than rounded to one — over a long fight rounding would
        // drift in whichever direction the remainder happened to fall.
        const high = i - outcome.whole;
        const low = high - 1;
        const toHigh = share * (1 - outcome.frac);
        const toLow = share * outcome.frac;
        if (toHigh > 0) { if (high <= 0) killedByThisShot += toHigh; else next[high] += toHigh; }
        if (toLow > 0) { if (low <= 0) killedByThisShot += toLow; else next[low] += toLow; }
      }
    }

    if (killedByThisShot > 0) {
      kills.push({ atMicros, probability: killedByThisShot });
      aliveProbability -= killedByThisShot;
    }
    const swap = alive; alive = next; next = swap;
  }

  return { kills, neverKillsProbability: Math.max(0, aliveProbability) };
}

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
function solveKillTimes(shotTimes, shot, targetHealth, healSchedule = null) {
  const maxShotDamage = Math.max(shot.bodyDamage, shot.headDamage);

  // A fighter who cannot do damage at all never kills.
  if (maxShotDamage <= 0 || shotTimes.length === 0) {
    return { kills: [], neverKillsProbability: 1 };
  }

  // ── Phase 0: can a kill happen at all? ──
  // With healing this is not rhetorical. A target healing faster than the
  // attacker can land damage is unkillable, and saying so here costs one
  // pass over the schedule instead of a full walk over a grid sized for
  // sixty seconds of accumulated healing. On the sustain grid most cells
  // land here, which is what makes it affordable.
  if (healSchedule && !killIsReachable(shotTimes, maxShotDamage, targetHealth, healSchedule)) {
    return { kills: [], neverKillsProbability: 1 };
  }

  // Healing makes hit counts the wrong state to walk — see the block above
  // solveKillTimesByHealth. Without it they are exact and cheaper, so the
  // grid below stays in charge of every unhealed matchup, which is most of
  // them.
  if (healSchedule) return solveKillTimesByHealth(shotTimes, shot, targetHealth, healSchedule);

  // ── Phase 1: the grid of hit combinations the target survives ──
  // A cell is worth tracking only while its damage is under the kill
  // threshold, and the threshold is at its highest on the last shot. It is
  // also capped by what the schedule can physically deliver — landing every
  // shot as a headshot. Without healing the first term is just targetHealth,
  // so this reduces to the original bound.
  // Everything past this point is unhealed, so the bar a shot has to clear
  // is just the target's health, and a cell is worth tracking only while its
  // damage is under it.
  const trackableDamage = Math.min(targetHealth, shotTimes.length * maxShotDamage);

  const bodyHitsToKill = shot.bodyDamage > 0 ? Math.ceil(trackableDamage / shot.bodyDamage) : 0;
  const headHitsToKill = shot.headDamage > 0 ? Math.ceil(trackableDamage / shot.headDamage) : 0;

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
        const threshold = targetHealth;

        // A miss leaves the fighter exactly where it was.
        if (shot.missChance > 0) {
          stillAlive[cellFor(bodyHits, headHits)] += probability * shot.missChance;
        }

        // ── Phase 3: lethal outcomes leave the grid ──
        // Anything that reaches the target's health is siphoned into this
        // shot's kill mass, so it can never be counted twice or fire again.
        if (shot.bodyChance > 0) {
          const mass = probability * shot.bodyChance;
          if (damageSoFar + shot.bodyDamage >= threshold) killedByThisShot += mass;
          else stillAlive[cellFor(bodyHits + 1, headHits)] += mass;
        }

        if (shot.headChance > 0) {
          const mass = probability * shot.headChance;
          if (damageSoFar + shot.headDamage >= threshold) killedByThisShot += mass;
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
 * The merged firing schedule of several attackers on one target.
 *
 * Nothing in `solveKillTimes` cares how many guns produced its shot list —
 * its grid is indexed by hit counts, and hit counts stay meaningful as long
 * as every shot in the list has the same damage profile. So a 3v1 with one
 * weapon type is the 1v1 walk over a list three times as long, and the
 * independence argument in the header is untouched: none of the attackers
 * reacts to anything, so their clocks still never interact.
 *
 * This is only valid while the attackers share a weapon *and* an aim
 * profile. Mixed loadouts would need a damage-indexed grid rather than a
 * hit-count one; `solveSurvival` takes a single `attackerStats`, so the
 * restriction is structural rather than checked.
 *
 * ── Why the opening offsets matter ────────────────────────────────
 * Three attackers all opening at t=0 fire in perfect lockstep for the whole
 * fight, landing simultaneous volleys that no squad actually produces. It
 * is a real worst case, not a wrong one, but it is a *narrow* one — it
 * roughly triples the chance of dying in the first half second against the
 * spread alternative.
 *
 * 'spread' opens attacker i one N-th of a fire interval after attacker
 * i-1, which distributes the volley evenly across one cycle. That is the
 * maximum-entropy arrangement rather than a tuned constant, and it scales
 * with the weapon instead of hard-coding a number of milliseconds. The
 * first shot still lands at t=0 either way, so the heal wasted before first
 * contact is unaffected.
 */
function buildVolleySchedule(stats, attackerCount, stagger, maxTime) {
  const count = Math.max(1, Math.floor(attackerCount) || 1);
  if (count === 1) return buildFiringSchedule(stats, 0, maxTime);

  const offset = stagger === 'sync' ? 0 : automaticGapSeconds(stats) / count;

  const shotTimes = [];
  for (let i = 0; i < count; i++) {
    for (const t of buildFiringSchedule(stats, i * offset, maxTime)) shotTimes.push(t);
  }
  // solveKillTimes walks this in order and reads healing off each entry's
  // clock, so the merge has to be sorted rather than concatenated.
  shotTimes.sort((a, b) => a - b);
  return shotTimes;
}

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
 *
 * Healing does not disqualify a matchup. A pocket healer works off the
 * clock rather than off the fight, so the two timelines stay independent
 * and the argument in the header still holds.
 *
 * Out-of-combat regeneration does disqualify it. Regen keys off time since
 * the last damage taken, which depends on which shots happened to land —
 * so it cannot be read off the clock, the state stops collapsing to two
 * hit counts, and the caller has to fall back to sampling exactly as it
 * already does for movement.
 */
function canSolveExactly({ meleeAdvance, speedOverride, p1Stats, p2Stats, regenRate = 0 }) {
  const anyoneMoves = meleeAdvance
    || ((p1Stats.isMelee || p2Stats.isMelee) && (speedOverride ?? 99) > 0);
  return !anyoneMoves && !(regenRate > 0);
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
  dropMultiplierFor,
  // Schedules for the healing each fighter is receiving, from
  // heals.js combineSchedules(). Null means nobody is healing them.
  p1Heal = null, p2Heal = null
}) {
  // First-shot advantage: whoever does not open waits one of their own
  // shot intervals, exactly as the engine sets it up.
  const p1FirstShotDelay = firstShot === 'p2' ? p1Stats.interval : 0;
  const p2FirstShotDelay = firstShot === 'p1' ? p2Stats.interval : 0;

  const p1Shot = describeShot(p1Stats, p1Accuracy, p1HeadshotChance,
    distance, dropMultiplierFor(distance, p1Stats));
  const p2Shot = describeShot(p2Stats, p2Accuracy, p2HeadshotChance,
    distance, dropMultiplierFor(distance, p2Stats));

  // P1 is shooting at P2, so it is P2's healing that raises the bar.
  const p1Kills = solveKillTimes(
    buildFiringSchedule(p1Stats, p1FirstShotDelay, maxTime), p1Shot, p2MaxHealth, p2Heal);
  const p2Kills = solveKillTimes(
    buildFiringSchedule(p2Stats, p2FirstShotDelay, maxTime), p2Shot, p1MaxHealth, p1Heal);

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

// ═══════════════════════════════════════════════════════════════════
// 6. HOW LONG DOES SOMEBODY LAST?
//
// The sustain question is not "who wins" but "did they live long enough" —
// long enough to finish a steal, open a vault, hold a deposit. That is a
// different reading of something the solver already produces: the kill
// time distribution below is exactly the information needed, so a survival
// curve costs a running sum rather than another analysis.
// ═══════════════════════════════════════════════════════════════════

/**
 * P(still alive) at each of `sampleSeconds`, from a solveKillTimes result.
 *
 * Kills arrive in time order, so this is one pass. Somebody killed exactly
 * at the sample time counts as dead — a steal interrupted on the final
 * frame did not go through.
 */
function survivalCurve(killResult, sampleSeconds) {
  const curve = new Float64Array(sampleSeconds.length);
  let killed = 0;
  let killIndex = 0;

  for (let i = 0; i < sampleSeconds.length; i++) {
    const cutoff = toMicros(sampleSeconds[i]);
    while (killIndex < killResult.kills.length && killResult.kills[killIndex].atMicros <= cutoff) {
      killed += killResult.kills[killIndex].probability;
      killIndex++;
    }
    curve[i] = Math.max(0, 1 - killed);
  }

  return curve;
}

/**
 * One-sided: how long does a defender last under fire while not shooting
 * back? The model for standing on a cashout station — you are interacting,
 * not duelling.
 *
 * Cheaper than a duel rather than more expensive: one firing schedule, one
 * walk, no comparison of two distributions. `attackerCount` above 1 puts a
 * whole squad on you and costs only a longer shot list — see
 * buildVolleySchedule.
 *
 * @returns {{ survival: Float64Array, survivedToEnd: number,
 *             medianKillTime: number|null, exact: true }}
 *          `survival` lines up with `sampleSeconds`.
 */
function solveSurvival({
  attackerStats, attackerAccuracy, attackerHeadshotChance,
  defenderMaxHealth, defenderHeal = null,
  distance, dropMultiplierFor,
  sampleSeconds, maxTime = 60,
  // How many attackers are firing on the defender. They all carry
  // `attackerStats` and shoot to `attackerAccuracy` — see
  // buildVolleySchedule for why that restriction is load-bearing.
  attackerCount = 1, attackerStagger = 'spread'
}) {
  const shot = describeShot(attackerStats, attackerAccuracy, attackerHeadshotChance,
    distance, dropMultiplierFor(distance, attackerStats));

  const killResult = solveKillTimes(
    buildVolleySchedule(attackerStats, attackerCount, attackerStagger, maxTime),
    shot, defenderMaxHealth, defenderHeal);

  const survival = survivalCurve(killResult, sampleSeconds);

  // The moment survival first drops through a half. Null when the defender
  // is more likely than not to still be standing when the clock runs out,
  // which under a heavy heal stack is the common case.
  let medianKillTime = null;
  let cumulative = 0;
  for (const kill of killResult.kills) {
    cumulative += kill.probability;
    if (cumulative >= 0.5) { medianKillTime = toSeconds(kill.atMicros); break; }
  }

  return {
    survival,
    survivedToEnd: killResult.neverKillsProbability,
    medianKillTime,
    exact: true
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MICROS_PER_SECOND, toMicros, toSeconds,
    buildFiringSchedule, buildVolleySchedule, describeShot, killIsReachable,
    solveKillTimes, solveKillTimesByHealth,
    scanAgainst, compareKillTimes, warnIfProbabilitiesDoNotSumToOne,
    canSolveExactly, solveDuelExactly,
    survivalCurve, solveSurvival
  };
}
