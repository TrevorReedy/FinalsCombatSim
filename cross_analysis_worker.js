// ═══════════════════════════════════════
// CROSS ANALYSIS WORKER
// Receives jobs, runs simulate(), posts results back.
// Also participates in work stealing — can request
// more jobs when its local queue runs dry.
// ═══════════════════════════════════════
importScripts('./simulate.js');

// ── Simulation constants (mirrored from main thread) ──
const CLASS_SPEED = { light: 7.0, medium: 5.0, heavy: 2.5 };
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
  console.log(`🧠 Worker ${workerId} START job ${job.jobId} | ${job.attacker.name} vs ${job.defender.name} | ${job.distance}m | ${job.profile.name}`);
const __jobStart = performance.now();
let __simTime = 0;
  const {
  attacker,
  defender,
  distance,
  profile,
  runs,
  speedOverride,
  meleeAdv,
  attackerAcc,
  attackerHs,
  defenderAcc,
  defenderHs
} = job;

  let wins = 0, losses = 0, ties = 0;
  let attackerTTKSum = 0, defenderTTKSum = 0;

  for (let i = 0; i < runs; i++) {
    const __simStart = performance.now();
  const r = simulate(
  attacker,
  defender,
  attackerAcc,
  attackerHs,
  defenderAcc,
  defenderHs,
  distance,
  speedOverride,
  meleeAdv,
  'both'
);
__simTime += performance.now() - __simStart;

    if (r.winner === 'p1')       { wins++;   attackerTTKSum += r.time; }
    else if (r.winner === 'p2')  { losses++; defenderTTKSum += r.time; }
    else                         { ties++; }
  }

  const total       = wins + losses + ties;
  const winRate     = total > 0 ? wins / total : 0;
  const avgAttackerTTK = wins   > 0 ? attackerTTKSum / wins   : null;
  const avgDefenderTTK = losses > 0 ? defenderTTKSum / losses : null;
  const __jobEnd = performance.now();
const __jobMs = __jobEnd - __jobStart;

console.log(
  `✅ Worker ${workerId} DONE job ${job.jobId} | ` +
  `time=${__jobMs.toFixed(2)}ms | ` +
  `avgSim=${(__simTime / runs).toFixed(4)}ms | ` +
  `runs=${runs}`
);
return {
  jobId: job.jobId,
  defender: defender.name,
  class: defender.class,
  distance: job.distance,
  profile: profile.name,

  attackerAcc,
  attackerHs,
  defenderAcc,
  defenderHs,

  wins,
  losses,
  ties,
  total,
  winRate,
  avgAttackerTTK,
  avgDefenderTTK,
  result: winRate >= 0.6 ? 'favorable' : winRate >= 0.4 ? 'even' : 'unfavorable'
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
