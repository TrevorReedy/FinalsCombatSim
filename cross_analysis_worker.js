// ═══════════════════════════════════════
// CROSS ANALYSIS WORKER
// Receives jobs, runs simulate(), posts results back.
// Also participates in work stealing — can request
// more jobs when its local queue runs dry.
// ═══════════════════════════════════════

// ── Simulation constants (mirrored from main thread) ──
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

function getStats(w) {
  const bodyDmg = parseNum(w.body_dmg)      || 0;
  const headDmg = parseNum(w.head_damage)   || bodyDmg * 1.5;
  const rpm     = parseNum(w.rpm)            || 60;
  const isMelee = w.type === 'Melee';
  const isBurst = w.shots_per_burst != null;
  const bSize   = isBurst ? parseInt(w.shots_per_burst) : 1;
  const bDelay  = isBurst ? parseFloat(w.delay_in_bursts) : 0;
  const dropMin = parseNum(w.damage_dropoff_min_range);
  const dropMax = parseNum(w.damage_dropoff_max_range);
  const dropR   = w.damage_reduction_at_max
    ? parseFloat(w.damage_reduction_at_max.replace(/[~%]/g, '')) / 100
    : 0;
  const interval = 60 / rpm;
  const classSpd = CLASS_SPEED[w.class];
  return { bodyDmg, headDmg, rpm, interval, isMelee, isBurst, bSize, bDelay, dropMin, dropMax, dropR, classSpd };
}

function dropMult(dist, s) {
  if (!s.dropMin || !s.dropMax) return 1;
  if (dist <= s.dropMin) return 1;
  if (dist >= s.dropMax) return 1 - s.dropR;
  return 1 - ((dist - s.dropMin) / (s.dropMax - s.dropMin)) * s.dropR;
}

function simulate(p1w, p2w, p1acc, p1hs, p2acc, p2hs, startDist, speedOverride, meleeAdv, fsa) {
  const s1 = getStats(p1w), s2 = getStats(p2w);
  const maxHP1 = CLASS_HP[p1w.class], maxHP2 = CLASS_HP[p2w.class];
  let hp1 = maxHP1, hp2 = maxHP2;

  const spd1 = Math.min(s1.classSpd, speedOverride || 99);
  const spd2 = Math.min(s2.classSpd, speedOverride || 99);

  let dist = startDist;
  let p1pos = 0, p2pos = startDist;
  let time = 0;
  let t1 = fsa === 'p2' ? s1.interval : 0;
  let t2 = fsa === 'p1' ? s2.interval : 0;
  let b1shots = 0, b2shots = 0;

  while (time < MAX_TIME && hp1 > 0 && hp2 > 0) {
    const advancing1 = s1.isMelee || meleeAdv;
    const advancing2 = s2.isMelee || meleeAdv;
    if (advancing1) p1pos = Math.min(p1pos + spd1 * DT, p2pos - MELEE_RANGE);
    if (advancing2) p2pos = Math.max(p2pos - spd2 * DT, p1pos + MELEE_RANGE);
    dist = Math.max(0, p2pos - p1pos);

    let pendingDmgToP1 = 0;
    let pendingDmgToP2 = 0;

    if (time >= t1) {
      if (Math.random() < p1acc) {
        const isHS = (s1.headDmg > s1.bodyDmg) && Math.random() < p1hs;
        pendingDmgToP2 += (isHS ? s1.headDmg : s1.bodyDmg) * dropMult(dist, s1);
      }
      if (s1.isBurst) {
        b1shots++;
        t1 += b1shots < s1.bSize ? s1.interval : (b1shots = 0, s1.bDelay + s1.interval);
      } else {
        t1 += s1.interval;
      }
    }

    if (time >= t2) {
      if (Math.random() < p2acc) {
        const isHS = (s2.headDmg > s2.bodyDmg) && Math.random() < p2hs;
        pendingDmgToP1 += (isHS ? s2.headDmg : s2.bodyDmg) * dropMult(dist, s2);
      }
      if (s2.isBurst) {
        b2shots++;
        t2 += b2shots < s2.bSize ? s2.interval : (b2shots = 0, s2.bDelay + s2.interval);
      } else {
        t2 += s2.interval;
      }
    }

    hp2 = Math.max(0, hp2 - pendingDmgToP2);
    hp1 = Math.max(0, hp1 - pendingDmgToP1);

    if (hp1 <= 0 || hp2 <= 0) break;
    time += DT;
  }

  const winner = hp1 <= 0 && hp2 <= 0 ? 'tie'
    : hp2 <= 0 ? 'p1'
    : hp1 <= 0 ? 'p2'
    : hp1 > hp2 ? 'p1' : hp2 > hp1 ? 'p2' : 'tie';

  return { winner, time };
}

// ── Per-job execution ──
// A job = one (attacker vs defender, distance, profile) combo.
// The worker runs RUNS iterations and returns aggregated stats.
function runJob(job) {
  const { attacker, defender, distance, profile, runs, speedOverride, meleeAdv } = job;

  let wins = 0, losses = 0, ties = 0;
  let attackerTTKSum = 0, defenderTTKSum = 0;

  for (let i = 0; i < runs; i++) {
    const r = simulate(
      attacker,
      defender,
      profile.acc,   // attacker accuracy (from P1 sidebar)
      profile.hs,    // attacker headshot chance
      profile.acc,   // defender accuracy (symmetric per profile)
      profile.hs,
      distance,
      speedOverride,
      meleeAdv,
      'both'
    );

    if (r.winner === 'p1')       { wins++;   attackerTTKSum += r.time; }
    else if (r.winner === 'p2')  { losses++; defenderTTKSum += r.time; }
    else                         { ties++; }
  }

  const total       = wins + losses + ties;
  const winRate     = total > 0 ? wins / total : 0;
  const avgAttackerTTK = wins   > 0 ? attackerTTKSum / wins   : null;
  const avgDefenderTTK = losses > 0 ? defenderTTKSum / losses : null;

  return {
  jobId: job.jobId,
  defender: defender.name,
  class: defender.class,
  distance: job.distance,
  profile: profile.name,
  acc: profile.acc,
  hs: profile.hs,
  wins,
  losses,
  ties,
  total,
  winRate,
  avgAttackerTTK,
  avgDefenderTTK,
  result: winRate >= 0.6 ? 'favorable' : winRate >= 0.4 ? 'even' : 'unfavorable'
};

  // result: {
  //   jobId:    job.jobId,
  //   defender: defender.name,
  //   class:    defender.class,
  //   distance,
  //   profile:  profile.name,
  //   winRate,
  //   avgAttackerTTK,
  //   avgDefenderTTK,
  //   wins,
  //   losses,
  //   ties,
  //   total,
  //   result: winRate >= 0.6 ? 'favorable' : winRate >= 0.4 ? 'even' : 'unfavorable'
  // }
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

    for (let i = 0; i < jobs.length; i++) {
      const result = runJob(jobs[i]);
      // Post each result immediately so the main thread can update progress
      self.postMessage({ type: 'result', result });
    }

    // Queue is empty — request more work (work stealing)
    self.postMessage({ type: 'steal_request' });
  }

  if (msg.type === 'no_work') {
    // Nothing left anywhere, signal done
    self.postMessage({ type: 'done' });
  }
};
