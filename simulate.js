// ═══════════════════════════════════════════════════════════════════
// SHARED SIMULATION ENGINE
// Used by both battle_simulator.js (visual playback) and
// cross_analysis_worker.js (headless 100k runs).
// captureFrames = true only in the main thread visual sim.
// ═══════════════════════════════════════════════════════════════════
function simulate(p1w, p2w, p1acc, p1hs, p2acc, p2hs, startDist, speedOverride, meleeAdv, fsa, captureFrames) {
  const s1 = getStats(p1w), s2 = getStats(p2w);
  const maxHP1 = CLASS_HP[p1w.class], maxHP2 = CLASS_HP[p2w.class];
  let hp1 = maxHP1, hp2 = maxHP2;

  const spd1 = Math.min(s1.classSpd, speedOverride || 99);
  const spd2 = Math.min(s2.classSpd, speedOverride || 99);

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

  const frames      = captureFrames ? [] : null;
  const log         = captureFrames ? [] : null;
  let   projectiles = [];

  const MAX_TIME = 60;

  while (time < MAX_TIME && hp1 > 0 && hp2 > 0) {
    let p1fired = false, p1hit = false, p1isHS = false;
    let p2fired = false, p2hit = false, p2isHS = false;

    // ── Movement ──
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

      if (Math.random() < p1acc) {
        const isHS = (s1.headDmg > s1.bodyDmg) && Math.random() < p1hs;
        const dmg  = (isHS ? s1.headDmg : s1.bodyDmg) * dropMult(dist, s1);
        pendingDmgToP2 += dmg;
        dmg1 += dmg; hits1++;
        if (isHS) hs1count++;
        p1hit = true; p1isHS = isHS;
        if (log) log.push({ type: isHS ? 'hs' : 'hp1', text: `[${time.toFixed(2)}s] P1 ${isHS ? '🎯 HEADSHOT' : '→ HIT'} for ${dmg.toFixed(1)}` });
        if (frames) projectiles.push({ x: (p1pos + p2pos) / 2, owner: 1, isHS, age: 0 });
      } else {
        if (log) log.push({ type: 'info', text: `[${time.toFixed(2)}s] P1 → MISS (${mag1 === Infinity ? '∞' : mag1} left)` });
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

      if (Math.random() < p2acc) {
        const isHS = (s2.headDmg > s2.bodyDmg) && Math.random() < p2hs;
        const dmg  = (isHS ? s2.headDmg : s2.bodyDmg) * dropMult(dist, s2);
        pendingDmgToP1 += dmg;
        dmg2 += dmg; hits2++;
        if (isHS) hs2count++;
        p2hit = true; p2isHS = isHS;
        if (log) log.push({ type: isHS ? 'hs' : 'hp2', text: `[${time.toFixed(2)}s] P2 ${isHS ? '🎯 HEADSHOT' : '→ HIT'} for ${dmg.toFixed(1)}` });
        if (frames) projectiles.push({ x: (p1pos + p2pos) / 2, owner: 2, isHS, age: 0 });
      } else {
        if (log) log.push({ type: 'info', text: `[${time.toFixed(2)}s] P2 → MISS` });
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
    shots1, hits1, hs1: hs1count,
    shots2, hits2, hs2: hs2count,
    frames, log
  };
}