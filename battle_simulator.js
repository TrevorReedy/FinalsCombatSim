// ═══════════════════════════════════════
// WEAPON DATA
// ═══════════════════════════════════════
let WEAPONS = [];

async function loadWeapons() {
  try {
    const response = await fetch('./weapons_s10_cleaned2.json');
    if (!response.ok) {
      throw new Error(`Failed to load weapons JSON: ${response.status}`);
    }

    WEAPONS = await response.json();

    // Init after weapons are loaded
    filterWeapons(1);
    filterWeapons(2);

    ['p1-acc','p1-hs','p2-acc','p2-hs'].forEach(id => {
      const el = document.getElementById(id);
      syncRange(el, id + '-v', '%');
    });

    syncRange(document.getElementById('start-dist'), 'sd-v', 'm');
    syncRange(document.getElementById('speed'), 'sp-v', '');

    ['p1-weapon','p2-weapon','p1-class','p2-class','start-dist'].forEach(id => {
      document.getElementById(id).addEventListener('change', drawIdle);
      document.getElementById(id).addEventListener('input', drawIdle);
    });

    drawIdle();
  } catch (err) {
    console.error(err);
    alert('Could not load weapons_s10_cleaned.json');
  }
}

loadWeapons();
// Class movement speeds (m/s in-game feel)
const CLASS_SPEED = { light: 7.0, medium: 5.0, heavy: 3.5 };
const CLASS_HP    = { light: 150, medium: 250, heavy: 350 };
const MELEE_RANGE = 2.0;
const DT = 0.01; // simulation tick 10ms

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
let firstShot = 'p1';
let simMode   = 'single';
let playSpeed = 1.0;
let animId    = null;
let simFrames = []; // pre-computed frames for playback
let frameIdx  = 0;

// ═══════════════════════════════════════
// CANVAS
// ═══════════════════════════════════════
const canvas = document.getElementById('arena');
const ctx    = canvas.getContext('2d');
let particles = [];

function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth;
}
window.addEventListener('resize', () => { resizeCanvas(); if(simFrames.length) drawFrame(simFrames[Math.min(frameIdx,simFrames.length-1)]); });
resizeCanvas();

function drawFrame(frame) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.strokeStyle = '#1a1f2a';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // Ground line
  const groundY = H * 0.72;
  ctx.strokeStyle = '#2a3040';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke();

  // Distance scale markers
  const maxDist = frame.initDist;
  const margin = 60;
  const trackW = W - margin * 2;
  ctx.fillStyle = '#2a3040';
  for (let d = 0; d <= maxDist; d += 10) {
    const x = margin + (d / maxDist) * trackW;
    ctx.fillRect(x - 0.5, groundY - 6, 1, 6);
    if (d % 20 === 0) {
      ctx.fillStyle = '#3a4455';
      ctx.font = '9px Share Tech Mono';
      ctx.textAlign = 'center';
      ctx.fillText(d + 'm', x, groundY + 14);
      ctx.fillStyle = '#2a3040';
    }
  }

  // Map game distance [0, initDist] to canvas X positions
  function toX(pos) { return margin + (pos / maxDist) * trackW; }

  // P1 is at position 0, P2 at position frame.dist
  const p1x = toX(frame.p1pos);
  const p2x = toX(frame.p2pos);

  // Draw bullets/projectiles
  frame.projectiles.forEach(p => {
    const px = toX(p.x);
    const isP1 = p.owner === 1;
    const grad = ctx.createRadialGradient(px, groundY - 22, 0, px, groundY - 22, p.isHS ? 8 : 4);
    grad.addColorStop(0, p.isHS ? '#ffd700' : (isP1 ? '#80c4ff' : '#ff8080'));
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, groundY - 22, p.isHS ? 8 : 4, 0, Math.PI * 2);
    ctx.fill();
  });

  // Particles
  particles.forEach(p => {
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1, p.y - 1, p.size, p.size);
  });
  ctx.globalAlpha = 1;

  // Draw P1 character
  drawCharacter(ctx, p1x, groundY, frame.p1class, '#4a9eff', false, frame.hp1 <= 0, frame.p1flash);

  // Draw P2 character (flipped)
  drawCharacter(ctx, p2x, groundY, frame.p2class, '#e84040', true, frame.hp2 <= 0, frame.p2flash);

  // Muzzle flashes
  if (frame.p1flash) spawnMuzzleFlash(p1x + 18, groundY - 28, '#4a9eff');
  if (frame.p2flash) spawnMuzzleFlash(p2x - 18, groundY - 28, '#e84040');

  // Hit sparks
  if (frame.p1hit) spawnHitSparks(p1x, groundY - 25, frame.p1hs, '#4a9eff');
  if (frame.p2hit) spawnHitSparks(p2x, groundY - 25, frame.p2hs, '#e84040');

  // Update HUD
  document.getElementById('hud-dist').textContent = frame.dist.toFixed(1) + 'm';
  document.getElementById('hud-time').textContent = frame.time.toFixed(2) + 's';
  document.getElementById('hud-p1-hp').style.width = Math.max(0, frame.hp1 / frame.maxHP1 * 100) + '%';
  document.getElementById('hud-p2-hp').style.width = Math.max(0, frame.hp2 / frame.maxHP2 * 100) + '%';
  document.getElementById('hud-p1-hpval').textContent = Math.max(0, frame.hp1).toFixed(0) + ' HP';
  document.getElementById('hud-p2-hpval').textContent = Math.max(0, frame.hp2).toFixed(0) + ' HP';
}


function drawCharacter(ctx, x, groundY, cls, color, flip, dead, firing) {
  ctx.save();
  
  // ✅ FIX: Handle flip without breaking position
  if (flip) {
    if (flip) {
  ctx.translate(x, 0);
  ctx.scale(-1, 1);
  x = 0;
}
  }
  
  const scale = cls === 'heavy' ? 1.35 : cls === 'light' ? 0.9 : 1.1;
  const bh = 32 * scale;
  const hw = 8 * scale;
  const hy = groundY - bh;
  
  // Use absolute x position (don't modify it)
  const finalX = flip ? -x : x;

  ctx.globalAlpha = dead ? 0.35 : 1.0;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(finalX, groundY, hw * 1.4, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  if (dead) {
    // Dead body on ground
    ctx.fillStyle = color + '99';
    ctx.fillRect(finalX - hw * 2, groundY - 12, hw * 4, 8);
    ctx.fillStyle = '#000';
    ctx.font = `${12 * scale}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('💀', finalX, groundY - 18);
    ctx.globalAlpha = 1;
    ctx.restore();
    return;
  }

  // Body gradient - FIX: use finalX for gradient coordinates
  const bodyGrad = ctx.createLinearGradient(finalX - hw, hy, finalX + hw, hy + bh);
  bodyGrad.addColorStop(0, color + 'dd');
  bodyGrad.addColorStop(1, color + '66');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(finalX - hw, hy, hw * 2, bh);

  // Firing flash
  if (firing) {
    ctx.fillStyle = color + 'aa';
    ctx.fillRect(finalX - hw - 4, hy + bh * 0.3, hw * 2 + 8, bh * 0.4);
  }

  // Head
  const headR = 7 * scale;
  ctx.beginPath();
  ctx.arc(finalX, hy - headR, headR, 0, Math.PI * 2);
  ctx.fillStyle = color + 'cc';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Class icon
  ctx.fillStyle = '#fff';
  ctx.font = `${8 * scale}px Share Tech Mono`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cls[0].toUpperCase(), finalX, hy - headR);

  // Weapon barrel
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5 * scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(finalX + hw, hy + bh * 0.35);
  ctx.lineTo(finalX + hw + 22 * scale, hy + bh * 0.35);
  ctx.stroke();

  // Legs
  ctx.strokeStyle = color + 'cc';
  ctx.lineWidth = 3 * scale;
  ctx.beginPath();
  ctx.moveTo(finalX - hw * 0.4, groundY - 3);
  ctx.lineTo(finalX - hw * 0.4, groundY);
  ctx.moveTo(finalX + hw * 0.4, groundY - 3);
  ctx.lineTo(finalX + hw * 0.4, groundY);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.restore();
}
function spawnMuzzleFlash(x, y, color) {
  for (let i = 0; i < 6; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.3) * 4,
      vy: (Math.random() - 0.5) * 3,
      life: 1.0,
      decay: 0.15 + Math.random() * 0.2,
      color,
      size: 2 + Math.random() * 3
    });
  }
}

function spawnHitSparks(x, y, isHS, color) {
  const n = isHS ? 14 : 6;
  for (let i = 0; i < n; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.5) * (isHS ? 7 : 4),
      vy: (Math.random() - 0.5) * (isHS ? 7 : 4) - 2,
      life: 1.0,
      decay: 0.12 + Math.random() * 0.15,
      color: isHS ? '#ffd700' : color,
      size: isHS ? 3 : 2
    });
  }
}

function updateParticles() {
  particles = particles.filter(p => p.life > 0);
  particles.forEach(p => {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.15;
    p.life -= p.decay;
  });
}

{/* // ═══════════════════════════════════════
// SIM ENGINE
// ═══════════════════════════════════════ */}
function parseNum(s) {
  if (!s) return null;
  const m = String(s).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}
function getStats(w) {
  const bodyDmg = parseNum(w.body_dmg) || 0;
  const headDmg = parseNum(w.head_damage) || bodyDmg * 1.5;
  const rpm = parseNum(w.rpm) || 60;
  const isMelee = w.type === 'Melee';
  const isBurst = w.shots_per_burst != null;
  const bSize = isBurst ? parseInt(w.shots_per_burst) : 1;
  const bDelay = isBurst ? parseFloat(w.delay_in_bursts) : 0;
  const dropMin = parseNum(w.damage_dropoff_min_range);
  const dropMax = parseNum(w.damage_dropoff_max_range);
  const dropR = w.damage_reduction_at_max
    ? parseFloat(String(w.damage_reduction_at_max).replace(/[~%]/g, '')) / 100
    : 0;

  const magSize = parseInt(w.magazine_size) || Infinity;
  const tacticalReload = parseNum(w.tactical_reload_time) || 0;
  const emptyReload = parseNum(w.empty_reload_time) || tacticalReload || 0;

  const interval = 60 / rpm;
  const classSpd = CLASS_SPEED[w.class];

  return {
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
    dropR,
    classSpd,
    magSize,
    tacticalReload,
    emptyReload
  };
}

function dropMult(dist, s) {
  if (!s.dropMin || !s.dropMax) return 1;
  if (dist <= s.dropMin) return 1;
  if (dist >= s.dropMax) return 1 - s.dropR;
  return 1 - ((dist - s.dropMin) / (s.dropMax - s.dropMin)) * s.dropR;
}

function simulate(p1w, p2w, p1acc, p1hs, p2acc, p2hs, startDist, speedOverride, meleeAdv, fsa, captureFrames) {
  const s1 = getStats(p1w), s2 = getStats(p2w);
  const maxHP1 = CLASS_HP[p1w.class], maxHP2 = CLASS_HP[p2w.class];
  let hp1 = maxHP1, hp2 = maxHP2;

  // Movement speeds (class-based, capped by user override if lower)
  const spd1 = Math.min(s1.classSpd, speedOverride || 99);
  const spd2 = Math.min(s2.classSpd, speedOverride || 99);

  let dist = startDist;
  // P1 is at 0, P2 at startDist
  let p1pos = 0, p2pos = startDist;

  let time = 0;
  let t1 = fsa === 'p2' ? s1.interval : 0;
  let t2 = fsa === 'p1' ? s2.interval : 0;
  let b1shots = 0, b2shots = 0;

  let dmg1 = 0, dmg2 = 0, shots1 = 0, hits1 = 0, hs1count = 0;
  let shots2 = 0, hits2 = 0, hs2count = 0;

  const frames = captureFrames ? [] : null;
  const log = captureFrames ? [] : null;

  // Projectiles for visualization
  let projectiles = [];

  const MAX_TIME = 60;
while (time < MAX_TIME && hp1 > 0 && hp2 > 0) {
  let p1fired = false, p1hit = false, p1isHS = false;
  let p2fired = false, p2hit = false, p2isHS = false;

  // Movement
  const advancing1 = s1.isMelee || meleeAdv;
  const advancing2 = s2.isMelee || meleeAdv;
  if (advancing1) p1pos = Math.min(p1pos + spd1 * DT, p2pos - MELEE_RANGE);
  if (advancing2) p2pos = Math.max(p2pos - spd2 * DT, p1pos + MELEE_RANGE);
  dist = Math.max(0, p2pos - p1pos);

  // Simultaneous firing
  let pendingDmgToP1 = 0;
  let pendingDmgToP2 = 0;

  if (time >= t1) {
    if (log) {
      log.push({
        type: 'reload',
        text: `[${time.toFixed(2)}s] P1 🔄 RELOAD (${(s1.emptyReload || s1.tacticalReload || 0).toFixed(2)}s)`
      })
    }
    shots1++;
    p1fired = true;
    const hit = Math.random() < p1acc;

    if (hit) {
      const isHS = (s1.headDmg > s1.bodyDmg) && Math.random() < p1hs;
      const dmg = (isHS ? s1.headDmg : s1.bodyDmg) * dropMult(dist, s1);

      pendingDmgToP2 += dmg;
      dmg1 += dmg;
      hits1++;
      if (isHS) hs1count++;
      p1hit = true;
      p1isHS = isHS;

      if (log) log.push({ type: isHS ? 'hs' : 'hp1', text: `[${time.toFixed(2)}s] P1 ${isHS ? '🎯 HEADSHOT' : '→ HIT'} for ${dmg.toFixed(1)}` });
      if (frames) projectiles.push({ x: (p1pos + p2pos) / 2, owner: 1, isHS, age: 0 });
    } else {
      if (log) log.push({ type: 'info', text: `[${time.toFixed(2)}s] P1 → MISS` });
    }

    if (s1.isBurst) {
      b1shots++;
      t1 += b1shots < s1.bSize ? s1.interval : (b1shots = 0, s1.bDelay + s1.interval);
    } else {
      t1 += s1.interval;
    }
  }

  if (time >= t2) {
    shots2++;
        if (log) {
      log.push({
        type: 'reload',
        text: `[${time.toFixed(2)}s] P2 🔄 RELOAD (${(s2.emptyReload || s2.tacticalReload || 0).toFixed(2)}s)`
      })
    }
    p2fired = true;
    const hit = Math.random() < p2acc;

    if (hit) {
      const isHS = (s2.headDmg > s2.bodyDmg) && Math.random() < p2hs;
      const dmg = (isHS ? s2.headDmg : s2.bodyDmg) * dropMult(dist, s2);

      pendingDmgToP1 += dmg;
      dmg2 += dmg;
      hits2++;
      if (isHS) hs2count++;
      p2hit = true;
      p2isHS = isHS;

      if (log) log.push({ type: isHS ? 'hs' : 'hp2', text: `[${time.toFixed(2)}s] P2 ${isHS ? '🎯 HEADSHOT' : '→ HIT'} for ${dmg.toFixed(1)}` });
      if (frames) projectiles.push({ x: (p1pos + p2pos) / 2, owner: 2, isHS, age: 0 });
    } else {
      if (log) log.push({ type: 'info', text: `[${time.toFixed(2)}s] P2 → MISS` });
    }

    if (s2.isBurst) {
      b2shots++;
      t2 += b2shots < s2.bSize ? s2.interval : (b2shots = 0, s2.bDelay + s2.interval);
    } else {
      t2 += s2.interval;
    }
  }

  // Apply both at once
  hp2 = Math.max(0, hp2 - pendingDmgToP2);
  hp1 = Math.max(0, hp1 - pendingDmgToP1);

  // Age/expire projectiles
  projectiles = projectiles.filter(p => p.age < 3);
  projectiles.forEach(p => p.age++);

  if (frames) {
    frames.push({
      time,
      dist,
      p1pos: p1pos,
      p2pos: p2pos,
      hp1,
      hp2,
      maxHP1,
      maxHP2,
      p1class: p1w.class,
      p2class: p2w.class,
      p1flash: p1fired,
      p2flash: p2fired,
      p1hit,
      p2hit,
      p1hs: p1isHS,
      p2hs: p2isHS,
      initDist: startDist,
      projectiles: JSON.parse(JSON.stringify(projectiles))
    });
  }

  if (hp1 <= 0 || hp2 <= 0) break;

  time += DT;
}
  

  // Final frame
  if (frames) {
    const winner = hp1 <= 0 && hp2 <= 0 ? 'tie' : hp2 <= 0 ? 'p1' : hp1 <= 0 ? 'p2' : (hp1 > hp2 ? 'p1' : hp2 > hp1 ? 'p2' : 'tie');
    frames.push({ time, dist, p1pos: p1pos/startDist*100, p2pos: p2pos/startDist*100, hp1: Math.max(0,hp1), hp2: Math.max(0,hp2), maxHP1, maxHP2, p1class: p1w.class, p2class: p2w.class, p1flash:false, p2flash:false, p1hit:false, p2hit:false, p1hs:false, p2hs:false, initDist: startDist, projectiles: [], winner });
    log.push({ type: 'kill', text: winner==='tie' ? '⚡ TIE — BOTH ELIMINATED' : winner==='p1' ? '🏆 PLAYER 1 WINS' : '🏆 PLAYER 2 WINS' });
  }

  const winner = hp1 <= 0 && hp2 <= 0 ? 'tie' : hp2 <= 0 ? 'p1' : hp1 <= 0 ? 'p2' : (hp1 > hp2 ? 'p1' : hp2 > hp1 ? 'p2' : 'tie');
  return { winner, time, dist, hp1: Math.max(0,hp1), hp2: Math.max(0,hp2), maxHP1, maxHP2,
    dmg1, dmg2, shots1, hits1, hs1: hs1count, shots2, hits2, hs2: hs2count, frames, log };
}

{/* // ═══════════════════════════════════════
// PLAYBACK LOOP
// ═══════════════════════════════════════
let lastRafTime = 0;
let simTimeAccum = 0; */}

function playback(rafTime) {
  if (!simFrames.length) return;
  const elapsed = (rafTime - lastRafTime) / 1000;
  lastRafTime = rafTime;

  // Advance simulation time by wall time × playback speed
  simTimeAccum += elapsed * playSpeed;

  // Find which frame matches simTimeAccum
  while (frameIdx < simFrames.length - 1 && simFrames[frameIdx].time <= simTimeAccum) {
    frameIdx++;
  }

  updateParticles();
  drawFrame(simFrames[frameIdx]);

  if (frameIdx < simFrames.length - 1) {
    animId = requestAnimationFrame(playback);
  } else {
    // Finished — show final results
    showResults(lastResult);
    document.getElementById('run-btn').disabled = false;
  }
}

// ═══════════════════════════════════════
// UI
// ═══════════════════════════════════════
let lastResult = null;

function runSim() {
  if (animId) cancelAnimationFrame(animId);
  particles = [];
  frameIdx = 0;
  simTimeAccum = 0;

  const p1w   = WEAPONS[parseInt(document.getElementById('p1-weapon').value)];
  const p2w   = WEAPONS[parseInt(document.getElementById('p2-weapon').value)];
  const p1acc = parseInt(document.getElementById('p1-acc').value) / 100;
  const p1hs  = parseInt(document.getElementById('p1-hs').value)  / 100;
  const p2acc = parseInt(document.getElementById('p2-acc').value) / 100;
  const p2hs  = parseInt(document.getElementById('p2-hs').value)  / 100;
  const startDist = parseInt(document.getElementById('start-dist').value);
  const speedOv = parseFloat(document.getElementById('speed').value);
  const meleeAdv = document.getElementById('melee-advance').checked;
  const simN = simMode === 'multi' ? Math.min(10000, Math.max(1, parseInt(document.getElementById('sim-count').value) || 200)) : 1;

  document.getElementById('run-btn').disabled = true;
  document.getElementById('pre-run-msg').style.display = 'none';
  document.getElementById('winner-banner').style.display = 'none';
  document.getElementById('stats-grid').style.display = 'none';

  // Run visual sim (single, always)
  const result = simulate(p1w, p2w, p1acc, p1hs, p2acc, p2hs, startDist, speedOv, meleeAdv, firstShot, true);
  lastResult = result;
  simFrames = result.frames;

  // Populate combat log immediately
  const logEl = document.getElementById('combat-log');
  logEl.innerHTML = (result.log || []).slice(0, 400).map(l => `<div class="ll ${l.type}">${l.text}</div>`).join('');

  // Set HUD names
  document.getElementById('hud-p1-name').textContent = p1w.name;
  document.getElementById('hud-p2-name').textContent = p2w.name;

  // Multi sim
  if (simMode === 'multi' && simN > 1) {
    let w1=0, w2=0, ties=0, ttkArr=[], hp1Arr=[], hp2Arr=[];
    for (let i = 0; i < simN; i++) {
      const r = simulate(p1w, p2w, p1acc, p1hs, p2acc, p2hs, startDist, speedOv, meleeAdv, firstShot, false);
      if (r.winner==='p1') { w1++; ttkArr.push(r.time); }
      else if (r.winner==='p2') { w2++; }
      else ties++;
      hp1Arr.push(r.hp1); hp2Arr.push(r.hp2);
    }
    const pct = v => (v/simN*100).toFixed(1);
    const avg = arr => arr.length ? (arr.reduce((a,b)=>a+b)/arr.length).toFixed(2) : '—';
    document.getElementById('wr-p1-bar').style.width = pct(w1)+'%';
    document.getElementById('wr-tie-bar').style.width = pct(ties)+'%';
    document.getElementById('wr-p2-bar').style.width = pct(w2)+'%';
    document.getElementById('wr-p1-lbl').textContent = `P1: ${pct(w1)}%`;
    document.getElementById('wr-tie-lbl').textContent = `TIE: ${pct(ties)}%`;
    document.getElementById('wr-p2-lbl').textContent = `P2: ${pct(w2)}%`;
    document.getElementById('ms-w1').textContent = w1;
    document.getElementById('ms-w2').textContent = w2;
    document.getElementById('ms-tie').textContent = ties;
    document.getElementById('ms-ttk1').textContent = ttkArr.length ? avg(ttkArr)+'s' : '—';
    document.getElementById('ms-hp1').textContent = avg(hp1Arr);
    document.getElementById('ms-hp2').textContent = avg(hp2Arr);
    document.getElementById('multi-tab').style.display = '';
  } else {
    document.getElementById('multi-tab').style.display = 'none';
  }

  // Start playback
  lastRafTime = performance.now();
  animId = requestAnimationFrame(playback);
}

function showResults(r) {
  document.getElementById('winner-banner').style.display = 'flex';
  document.getElementById('stats-grid').style.display = 'grid';
  const w = r.winner;
  const wEl = document.getElementById('winner-name');
  wEl.className = 'winner-name ' + (w==='tie' ? 'tie' : w);
  const p1w = WEAPONS[parseInt(document.getElementById('p1-weapon').value)];
  const p2w = WEAPONS[parseInt(document.getElementById('p2-weapon').value)];
  document.getElementById('winner-icon').textContent = w==='tie' ? '⚡' : '🏆';
  wEl.textContent = w==='p1' ? p1w.name : w==='p2' ? p2w.name : 'TIE';
  document.getElementById('winner-sub').textContent = w==='tie' ? 'Simultaneous elimination' : `${w==='p1'?'Player 1':'Player 2'} wins in ${r.time.toFixed(2)}s`;
  document.getElementById('s-p1-dmg').textContent = r.dmg1.toFixed(0);
  document.getElementById('s-p2-dmg').textContent = r.dmg2.toFixed(0);
  document.getElementById('s-p1-shs').textContent = `${r.shots1}/${r.hits1}/${r.hs1}`;
  document.getElementById('s-p2-shs').textContent = `${r.shots2}/${r.hits2}/${r.hs2}`;
  document.getElementById('s-ttk').textContent = r.time.toFixed(2)+'s';
  document.getElementById('s-range').textContent = r.dist.toFixed(1)+'m';
  document.getElementById('s-p1-hp').textContent = r.hp1.toFixed(0);
  document.getElementById('s-p2-hp').textContent = r.hp2.toFixed(0);
}

// ═══════════════════════════════════════
// INIT & HELPERS
// ═══════════════════════════════════════
function switchFighterTab(n, el) {
  document.querySelectorAll('.ftab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.fighter-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('fp' + n).classList.add('active');
}

function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

function setFSA(v, btn) {
  firstShot = v;
  btn.parentElement.querySelectorAll('.tbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function setSimMode(v, btn) {
  simMode = v;
  btn.parentElement.querySelectorAll('.tbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('multi-opts').style.display = v === 'multi' ? 'block' : 'none';
}

function setPlaySpeed(v, btn) {
  playSpeed = v;
  btn.parentElement.querySelectorAll('.tbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function syncRange(el, valId, suffix) {
  const v = parseFloat(el.value);
  const pct = ((v - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--pct', pct + '%');
  const d = document.getElementById(valId);
  if (suffix === '') d.textContent = v.toFixed(1);
  else d.textContent = v + suffix;
}

function filterWeapons(p) {
  const cls = document.getElementById(`p${p}-class`).value;
  const sel = document.getElementById(`p${p}-weapon`);
  sel.innerHTML = '';
  WEAPONS.forEach((w, i) => {
    if (cls && w.class !== cls) return;
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `[${w.class.toUpperCase()[0]}] ${w.name} — ${w.type}`;
    sel.appendChild(opt);
  });
  updateWeaponInfo(p);
}

function updateWeaponInfo(p) {
  const w = WEAPONS[parseInt(document.getElementById(`p${p}-weapon`).value)];
  if (!w) return;
  const badges = document.getElementById(`p${p}-badges`);
  const note   = document.getElementById(`p${p}-note`);
  const hp     = CLASS_HP[w.class];
  const spd    = CLASS_SPEED[w.class];
  const spdLabel = w.class === 'light' ? 'FAST' : w.class === 'medium' ? 'MED' : 'SLOW';
  badges.innerHTML = `
    <span class="badge ${w.class}">${w.class} — ${hp}HP</span>
    <span class="badge">${w.type}</span>
    ${w.firing_mode ? `<span class="badge">${w.firing_mode}</span>` : ''}
    ${w.body_dmg ? `<span class="badge">DMG ${w.body_dmg}</span>` : ''}
    ${w.head_damage ? `<span class="badge">HEAD ${w.head_damage}</span>` : ''}
    ${w.rpm ? `<span class="badge">${w.rpm} RPM</span>` : ''}
    <span class="badge ${w.class}">${spdLabel} ${spd}m/s</span>
  `;
  const ddInfo = w.damage_dropoff_min_range ? `DROP: ${w.damage_dropoff_min_range}–${w.damage_dropoff_max_range} (${w.damage_reduction_at_max})` : 'No dropoff data';
  note.innerHTML = ddInfo + (w.notes ? ` &nbsp;|&nbsp; ${w.notes}` : '');
}

// Draw idle state on canvas
function drawIdle() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#1a1f2a'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  const groundY = H * 0.72;
  ctx.strokeStyle = '#2a3040'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke();
  ctx.fillStyle = '#2a3040'; ctx.font = '11px Share Tech Mono'; ctx.textAlign = 'center';
  ctx.fillText('SELECT FIGHTERS AND PRESS SIMULATE', W/2, H/2 - 10);

  const p1w = WEAPONS[parseInt(document.getElementById('p1-weapon').value)];
  const p2w = WEAPONS[parseInt(document.getElementById('p2-weapon').value)];
  if (p1w && p2w) {
    const startDist = parseInt(document.getElementById('start-dist').value);
    const margin = 60, trackW = W - margin * 2;
    const p1x = margin;
    const p2x = margin + trackW;
    drawCharacter(ctx, p1x, groundY, p1w.class, '#4a9eff', false, false, false);
    drawCharacter(ctx, p2x, groundY, p2w.class, '#e84040', true, false, false);
    document.getElementById('hud-p1-name').textContent = p1w.name;
    document.getElementById('hud-p2-name').textContent = p2w.name;
    document.getElementById('hud-dist').textContent = startDist + 'm';
    document.getElementById('hud-p1-hp').style.width = '100%';
    document.getElementById('hud-p2-hp').style.width = '100%';
    document.getElementById('hud-p1-hpval').textContent = CLASS_HP[p1w.class] + ' HP';
    document.getElementById('hud-p2-hpval').textContent = CLASS_HP[p2w.class] + ' HP';
  }
}

// Init
filterWeapons(1);
filterWeapons(2);
['p1-acc','p1-hs','p2-acc','p2-hs'].forEach(id => {
  const el = document.getElementById(id);
  syncRange(el, id+'-v', '%');
});
syncRange(document.getElementById('start-dist'), 'sd-v', 'm');
syncRange(document.getElementById('speed'), 'sp-v', '');

// Draw idle whenever weapon changes
['p1-weapon','p2-weapon','p1-class','p2-class','start-dist'].forEach(id => {
  document.getElementById(id).addEventListener('change', drawIdle);
  document.getElementById(id).addEventListener('input', drawIdle);
});
drawIdle();
// v1.2.0 - added cross analysis engine (commented out for now to focus on core sim and UI)
// ═══════════════════════════════════════
// CROSS ANALYSIS ENGINE
// ═══════════════════════════════════════

// function getAimProfiles() {
//   return [
//     { name: 'Poor', acc: 0.5, hs: 0.2 },
//     { name: 'Average', acc: 0.75, hs: 0.35 },
//     { name: 'Strong', acc: 0.9, hs: 0.55 },
//     { name: 'Elite', acc: 0.99, hs: 0.8 }
//   ];
// }

// function getDistances() {
//   return [0, 15, 25, 30, 50, 75, 100];
// }

// function classifyMatchup(winRate) {
//   if (winRate >= 0.6) return 'favorable';
//   if (winRate >= 0.4) return 'even';
//   return 'unfavorable';
// }
// function runCrossAnalysis() {
//     start = performance.now();
//   const attacker = WEAPONS[parseInt(document.getElementById('p1-weapon').value)];
//   const distances = getDistances();
//   const profiles = getAimProfiles();

//   const speedOv = parseFloat(document.getElementById('speed').value);
//   const meleeAdv = document.getElementById('melee-advance').checked;

//   console.log("=== CROSS ANALYSIS START ===");
//   console.log("Attacker:", attacker?.name);
//   console.log("Distances:", distances);
//   console.log("Profiles:", profiles);
//   console.log("Speed Override:", speedOv);
//   console.log("Melee Advance:", meleeAdv);

//   const results = [];

//   WEAPONS.forEach(defender => {
//     if (defender.name === attacker.name) return;

//     console.log(`\n--- Defender: ${defender.name} (${defender.class}) ---`);

//     distances.forEach(dist => {
//       profiles.forEach(profile => {

//         console.log(`\n[SCENARIO] Dist=${dist} | Profile=${profile.name}`);

//         let wins = 0;
//         let losses = 0;
//         let ttkSum = 0;

//         const RUNS = 10000;

//         for (let i = 0; i < RUNS; i++) {
//           const r = simulate(
//             attacker,
//             defender,
//             profile.acc,
//             profile.hs,
//             profile.acc,
//             profile.hs,
//             dist,
//             speedOv,
//             meleeAdv,
//             'both',
//             false
//           );

//           console.log(`Run ${i + 1}: Winner=${r.winner}, Time=${r.time}`);

//           if (r.winner === 'p1') {
//             wins++;
//             ttkSum += r.time;
//           } else if (r.winner === 'p2') {
//             losses++;
//           }
//         }

//         const total = wins + losses;
//         const winRate = total > 0 ? wins / total : 0;
//         const avgTTK = wins > 0 ? (ttkSum / wins) : null;

//         console.log("RESULT SUMMARY:", {
//           wins,
//           losses,
//           total,
//           winRate,
//           avgTTK
//         });

//         const row = {
//           attacker: attacker.name,
//           defender: defender.name,
//           class: defender.class,
//           distance: dist,
//           profile: profile.name,
//           ttk: avgTTK,
//           winRate,
//           result: classifyMatchup(winRate)
//         };

//         console.log("PUSH ROW:", row);

//         results.push(row);

//       });
//     });
//   });

//   console.log("\n=== FINAL RESULTS COUNT ===", results.length);
//   console.log("Sample Results:", results.slice(0, 5));
//   end = performance.now();
//   console.log(`Cross analysis (${RUNS} Battles) completed in ${(end - start) / 1000} seconds`);
//   renderCrossAnalysis(results);
//   rendered = performance.now();
//   console.log(`Rendering (${RUNS} battles) completed in ${(rendered - end) / 1000} seconds`);
// }

// function renderCrossAnalysis(results) {
//   console.log("\n=== RENDER START ===");
//   console.log("Incoming results length:", results.length);

//   const container = document.getElementById('cross-table');

//   if (!container) {
//     console.error("❌ cross-table NOT FOUND");
//     return;
//   }

//   console.log("✅ cross-table found");

//   let html = `
//     <table style="width:100%; font-size:11px;">
//       <tr>
//         <th>Defender</th>
//         <th>Class</th>
//         <th>Dist</th>
//         <th>Profile</th>
//         <th>TTK</th>
//         <th>Win%</th>
//         <th>Result</th>
//       </tr>
//   `;

//   results.forEach((r, i) => {
//     if (i < 5) console.log("Rendering row:", r); // only first 5 to avoid spam

//     const color =
//       r.result === 'favorable' ? '#39d974' :
//       r.result === 'unfavorable' ? '#e84040' :
//       '#f0b429';

//     html += `
//       <tr>
//         <td>${r.defender}</td>
//         <td>${r.class}</td>
//         <td>${r.distance}</td>
//         <td>${r.profile}</td>
//         <td>${r.ttk ? r.ttk.toFixed(2) : '-'}</td>
//         <td>${(r.winRate * 100).toFixed(1)}%</td>
//         <td style="color:${color}">${r.result}</td>
//       </tr>
//     `;
//   });

//   html += `</table>`;

//   container.innerHTML = html;

//   console.log("✅ HTML injected into DOM");

//   const tabBtn = document.querySelector('[onclick*="cross"]');

//   if (!tabBtn) {
//     console.error("❌ Cross tab button NOT FOUND");
//   } else {
//     console.log("✅ Cross tab button found, switching tab");
//   }

//   switchTab('cross', tabBtn);
// }


