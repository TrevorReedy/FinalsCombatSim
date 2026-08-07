// ═══════════════════════════════════════
// CROSS ANALYSIS WORKER
// Receives jobs, resolves each matchup, posts results back.
// Also participates in work stealing — can request
// more jobs when its local queue runs dry.
//
// Each job is resolved one of two ways:
//   * exactly, by duel_solver.js, whenever nobody moves (which is every
//     job in the stand-and-fight grid) — no sampling, no noise;
//   * by sampling with simulate.js otherwise, from a per-job seed so a
//     surprising number can always be replayed.
// ═══════════════════════════════════════
importScripts('./simulate.js', './duel_solver.js');

// ── Simulation constants (mirrored from main thread) ──
// Must stay in step with battle_simulator.js — a mismatch here silently gave
// the meta analysis a different game than the 1v1 simulation.
const CLASS_SPEED = { light: 7.0, medium: 5.0, heavy: 3.5 };
const CLASS_HP    = { light: 150, medium: 250, heavy: 350 };
const MELEE_RANGE = 2.0;
const DT          = 0.01;
const MAX_TIME    = 60;

function parseNum(s) {
  if (!s) return null;
  const m = String(s).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}
// ═══════════════════════════════════════
// WORKER PROFILING
// ═══════════════════════════════════════
let workerProfiling = true;
let workerId = Math.random().toString(36).substring(7);

// Listen for profiling commands
self.addEventListener('message', function(e) {
  if (e.data.type === 'start_profiling') {
    workerProfiling = true;
    if (typeof console.profile === 'function') {
      console.profile(`Worker-${workerId}`);
    }
    console.log(`🔴 Worker ${workerId} profiling started`);
  }
  
  if (e.data.type === 'stop_profiling') {
    if (workerProfiling && typeof console.profileEnd === 'function') {
      console.profileEnd();
    }
    console.log(`🟢 Worker ${workerId} profiling complete`);
    workerProfiling = false;
  }
  

});


// function getStats(w) {


//   const rpm = parseNum(w.rpm) || 60;




//   const bodyDmg = parseNum(w.body_dmg) || 0;
//   const headDmg = parseNum(w.head_damage) || bodyDmg;
//   const isMelee = w.type === 'Melee';
//   const isBurst = w.shots_per_burst != null;
//   const bSize = isBurst ? parseInt(w.shots_per_burst) : 1;
//   const bDelay = isBurst ? parseFloat(w.delay_in_bursts) : 0;
//   const dropMin = parseNum(w.damage_dropoff_min_range);
//   const dropMax = parseNum(w.damage_dropoff_max_range);
//   const dropR = w.damage_reduction_at_max
//     ? parseFloat(String(w.damage_reduction_at_max).replace(/[~%]/g, ''))
//     : 0;
//   const interval = 60 / rpm;
//   const classSpd = CLASS_SPEED[w.class];

//   const magSize = Number.isFinite(parseInt(w.magazine_size)) ? parseInt(w.magazine_size) : null;
//   const tacticalReload = parseNum(w.tactical_reload_time) || 0;
//   const emptyReload = parseNum(w.empty_reload_time) || tacticalReload || 0;

//   return {
//     bodyDmg,
//     headDmg,
//     rpm,
//     interval,
//     isMelee,
//     isBurst,
//     bSize,
//     bDelay,
//     dropMin,
//     dropMax,
//     dropR,
//     classSpd,
//     magSize,
//     tacticalReload,
//     emptyReload
//   };
// }

// function dropMult(dist, s) {
//   if (!s.dropMin || !s.dropMax) return 1;
//   if (dist <= s.dropMin) return 1;
//   if (dist >= s.dropMax) return 1 - s.dropR;
//   return 1 - ((dist - s.dropMin) / (s.dropMax - s.dropMin)) * s.dropR;
// }

function runJob(job) {
  const {
    attacker, defender, distance, profile, runs,
    speedOverride, meleeAdv,
    attackerAcc, attackerHs, defenderAcc, defenderHs,
    seed, forceSampling
  } = job;

  const attackerStats = getStats(attacker);
  const defenderStats = getStats(defender);

  const settings = {
    attacker, defender, attackerStats, defenderStats, distance,
    attackerAcc, attackerHs, defenderAcc, defenderHs,
    speedOverride, meleeAdv, runs, seed
  };

  const solvable = !forceSampling && canSolveExactly({
    meleeAdvance: meleeAdv,
    speedOverride,
    p1Stats: attackerStats,
    p2Stats: defenderStats
  });

  const outcome = solvable ? resolveExactly(settings) : resolveBySampling(settings);

  return {
    jobId: job.jobId,
    defender: defender.name,
    class: defender.class,
    distance,
    profile: profile.name,

    attackerAcc,
    attackerHs,
    defenderAcc,
    defenderHs,

    // Probabilities, not counts. The exact solver has no notion of a
    // sample; the sampling path reports the fractions it measured, so both
    // paths mean the same thing and the heat map reads them the same way.
    winRate: outcome.attackerWinRate,
    lossRate: outcome.defenderWinRate,
    tieRate: outcome.tieRate,
    timeoutRate: outcome.timeoutRate,

    avgAttackerTTK: outcome.attackerKillTime,
    avgDefenderTTK: outcome.defenderKillTime,

    // How this number was arrived at, so nothing downstream has to guess.
    method: outcome.method,
    samples: outcome.samples,

    // A matchup nobody can win is not an unfavourable one. Checked first,
    // because a stalemate always reads as a 0% win rate.
    result: outcome.timeoutRate > 0.5 ? 'stalemate'
          : outcome.attackerWinRate >= 0.6 ? 'favorable'
          : outcome.attackerWinRate >= 0.4 ? 'even'
          : 'unfavorable'
  };
}

/** Exact probabilities, straight from the solver. */
function resolveExactly(s) {
  const exact = solveDuelExactly({
    p1Stats: s.attackerStats,
    p2Stats: s.defenderStats,
    p1Accuracy: s.attackerAcc,
    p1HeadshotChance: s.attackerHs,
    p2Accuracy: s.defenderAcc,
    p2HeadshotChance: s.defenderHs,
    p1MaxHealth: CLASS_HP[s.attacker.class],
    p2MaxHealth: CLASS_HP[s.defender.class],
    distance: s.distance,
    firstShot: 'both',
    maxTime: MAX_TIME,
    dropMultiplierFor: dropMult
  });

  return {
    attackerWinRate: exact.p1WinRate,
    defenderWinRate: exact.p2WinRate,
    tieRate: exact.tieRate,
    timeoutRate: exact.timeoutRate,
    attackerKillTime: exact.p1AvgKillTime,
    defenderKillTime: exact.p2AvgKillTime,
    method: 'exact',
    samples: 0
  };
}

/**
 * Sampling fallback for matchups the solver cannot express — currently
 * anything where a fighter moves, since that changes damage shot to shot.
 * Seeded per job so the same analysis always produces the same table.
 */
function resolveBySampling(s) {
  useSeededRandom(s.seed);

  let wins = 0, losses = 0, ties = 0, timeouts = 0;
  let attackerTimeSum = 0, defenderTimeSum = 0;

  for (let i = 0; i < s.runs; i++) {
    const duel = simulate(
      s.attacker, s.defender,
      s.attackerAcc, s.attackerHs, s.defenderAcc, s.defenderHs,
      s.distance, s.speedOverride, s.meleeAdv, 'both'
    );

    // simulate() awards a 60 second stalemate to whoever has more health
    // left, which invents a winner nobody earned. Both still standing means
    // nobody landed a killing blow, so it is counted as a timeout here —
    // the same way the exact solver reports it.
    const bothStillStanding = duel.hp1 > 0 && duel.hp2 > 0;

    if (bothStillStanding) timeouts++;
    else if (duel.winner === 'p1') { wins++; attackerTimeSum += duel.time; }
    else if (duel.winner === 'p2') { losses++; defenderTimeSum += duel.time; }
    else ties++;
  }

  return {
    attackerWinRate: wins / s.runs,
    defenderWinRate: losses / s.runs,
    tieRate: ties / s.runs,
    timeoutRate: timeouts / s.runs,
    attackerKillTime: wins > 0 ? attackerTimeSum / wins : null,
    defenderKillTime: losses > 0 ? defenderTimeSum / losses : null,
    method: 'sampled',
    samples: s.runs
  };
}

// ── Message handler ──
// Protocol:
//   { type: 'jobs',     jobs: [...] }          — initial batch assignment
//   { type: 'stolen',   jobs: [...] }          — stolen jobs from another worker
//   { type: 'no_work'                }          — coordinator says nothing left to steal
self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'jobs' || msg.type === 'stolen') {
    const jobs = msg.jobs;
console.log(`📦 Worker ${workerId} received ${jobs.length} jobs`);
const __batchStart = performance.now();
    for (let i = 0; i < jobs.length; i++) {
      const result = runJob(jobs[i]);
      // Post each result immediately so the main thread can update progress
      self.postMessage({ type: 'result', result });
    }
    const __batchEnd = performance.now();
console.log(`📊 Worker ${workerId} finished batch in ${( __batchEnd - __batchStart ).toFixed(2)}ms`);

    // Queue is empty — request more work (work stealing)
    console.log(`🕵️ Worker ${workerId} requesting more work`);
    self.postMessage({ type: 'steal_request' });
  }

  if (msg.type === 'no_work') {
    // Nothing left anywhere, signal done
    console.log(`🏁 Worker ${workerId} DONE — no more work`);
    self.postMessage({ type: 'done' });
  }
};
