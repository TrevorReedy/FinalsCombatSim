// ═══════════════════════════════════════
// WEAPON DATA
// ═══════════════════════════════════════
const CLASS_SCALE = {
  light: 1.0,
  medium: 1.5,
  heavy: 2
};
let WEAPONS = [];

const p1Sliders = [
  document.getElementById('p1-acc'),
  document.getElementById('p1-hs')
];

const p2Sliders = [
  document.getElementById('p2-acc'),
  document.getElementById('p2-hs')
];

function setSliderGroupColor(sliders, color) {
  sliders.forEach(slider => {
    if (!slider) return;
    slider.style.setProperty('--slider-color', color);
  });
}

function applyActiveSliderColors(player) {
  if (player === 1) {
    setSliderGroupColor(p1Sliders, '#4a9eff');
    setSliderGroupColor(p2Sliders, '#444');
  } else {
    setSliderGroupColor(p1Sliders, '#444');
    setSliderGroupColor(p2Sliders, '#e84040');
  }
}


async function loadWeapons() {
  try {
    const response = await fetch('./weapons_s10_cleaned.json');
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
  const p1x = toX(frame.p1_position);
  const p2x = toX(frame.p2_position);

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
  drawCharacter(ctx, p1x, groundY, frame.p1class, '#4a9eff', false, frame.hp1 <= 0, frame.p1flash, CLASS_SCALE[frame.p1class]);

  // Draw P2 character (flipped)
  drawCharacter(ctx, p2x, groundY, frame.p2class, '#e84040', true, frame.hp2 <= 0, frame.p2flash, CLASS_SCALE[frame.p2class]);

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


function drawCharacter(ctx, x, groundY, cls, color, flip, dead, firing, scale = 1) {
  ctx.save();

  // Anchor character at x, then optionally mirror around that anchor
  ctx.translate(x, 0);
  if (flip) ctx.scale(-1, 1);

  const bodyHeight = 32 * scale;
  const halfWidth = 8 * scale;
  const headRadius = 7 * scale;
  const weaponLength = 22 * scale;
  const bodyTopY = groundY - bodyHeight;

  ctx.globalAlpha = dead ? 0.35 : 1.0;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(0, groundY, halfWidth * 1.4, 4 * scale, 0, 0, Math.PI * 2);
  ctx.fill();

  if (dead) {
    ctx.fillStyle = color + '99';
    ctx.fillRect(-halfWidth * 2, groundY - 12 * scale, halfWidth * 4, 8 * scale);

    ctx.fillStyle = '#000';
    ctx.font = `${12 * scale}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💀', 0, groundY - 18 * scale);

    ctx.globalAlpha = 1;
    ctx.restore();
    return;
  }

  // Body
  const bodyGrad = ctx.createLinearGradient(-halfWidth, bodyTopY, halfWidth, bodyTopY + bodyHeight);
  bodyGrad.addColorStop(0, color + 'dd');
  bodyGrad.addColorStop(1, color + '66');
  ctx.fillStyle = bodyGrad;
  ctx.fillRect(-halfWidth, bodyTopY, halfWidth * 2, bodyHeight);

  // Firing flash
  if (firing) {
    ctx.fillStyle = color + 'aa';
    ctx.fillRect(
      -halfWidth - 4 * scale,
      bodyTopY + bodyHeight * 0.3,
      halfWidth * 2 + 8 * scale,
      bodyHeight * 0.4
    );
  }

  // Head
  ctx.beginPath();
  ctx.arc(0, bodyTopY - headRadius, headRadius, 0, Math.PI * 2);
  ctx.fillStyle = color + 'cc';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * scale;
  ctx.stroke();

  // Class icon
  ctx.fillStyle = '#fff';
  ctx.font = `${8 * scale}px "Share Tech Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cls[0].toUpperCase(), 0, bodyTopY - headRadius);

  // Weapon barrel
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5 * scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(halfWidth, bodyTopY + bodyHeight * 0.35);
  ctx.lineTo(halfWidth + weaponLength, bodyTopY + bodyHeight * 0.35);
  ctx.stroke();

  // Legs
  ctx.strokeStyle = color + 'cc';
  ctx.lineWidth = 3 * scale;
  ctx.beginPath();
  ctx.moveTo(-halfWidth * 0.4, groundY - 3 * scale);
  ctx.lineTo(-halfWidth * 0.4, groundY);
  ctx.moveTo(halfWidth * 0.4, groundY - 3 * scale);
  ctx.lineTo(halfWidth * 0.4, groundY);
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

/*stats edge cases
  MINIGUN rpm = minigunRPM(spinTime)
                interval = 60 / rpm
                effectiveAcc = baseAcc * spreadPenalty(distance)
                damage = baseDamage * dropMult(distance)

*/
// function getStats(w) {
//   const bodyDmg = parseNum(w.body_dmg) || 0;
//   const headDmg = parseNum(w.head_damage) || parseNum(w.body_damage);
//   const rpm = parseNum(w.rpm) || 60;
//   const isMelee = w.type === 'Melee';
//   const isBurst = w.shots_per_burst != null;
//   const bSize = isBurst ? parseInt(w.shots_per_burst) : 1;
//   const bDelay = isBurst ? parseFloat(w.delay_in_bursts) : 0;
//   const dropMin = parseNum(w.damage_dropoff_min_range);
//   const dropMax = parseNum(w.damage_dropoff_max_range);
//   const dropR = w.damage_reduction_at_max
//     ? parseFloat(String(w.damage_reduction_at_max).replace(/[~%]/g, ''))
//     : 0;

//  const magSize = Number.isFinite(parseInt(w.magazine_size))
//   ? parseInt(w.magazine_size)
//   : Infinity;
//   const tacticalReload = parseNum(w.tactical_reload_time) || 0;
//   const emptyReload = parseNum(w.empty_reload_time) || tacticalReload || 0;

//   const interval = w.name === 'Crossbow' ? 1 : 60 / rpm;
//   const classSpd = CLASS_SPEED[w.class];

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

// 

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
    let w1=0, w2=0, ties=0, ttkArr1=[], ttkArr2=[], hp1Arr=[], hp2Arr=[]; bulletsToKill1=[], bulletsToKill2=[];
    for (let i = 0; i < simN; i++) {
      const r = simulate(p1w, p2w, p1acc, p1hs, p2acc, p2hs, startDist, speedOv, meleeAdv, firstShot, false);
      if (r.winner==='p1') { 
      w1++; ttkArr1.push(r.time);
        bulletsToKill1.push(r.hits1);
      }
      else if (r.winner==='p2') { 
        w2++; ttkArr2.push(r.time);
       bulletsToKill2.push(r.hits2);
       }
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

    document.getElementById('ms-l1').textContent = w2;
    document.getElementById('ms-l2').textContent = w1;


    document.getElementById('ms-tie').textContent = ties;
    document.getElementById('ms-ttk1').textContent = ttkArr1.length ? avg(ttkArr1)+'s' : '—';
    document.getElementById('ms-ttk2').textContent = ttkArr2.length ? avg(ttkArr2)+'s' : '—';

    document.getElementById('ms-hp1').textContent = avg(hp1Arr);
    document.getElementById('ms-hp2').textContent = avg(hp2Arr);

    console.log('Bullets to kill P1:', bulletsToKill1);
    console.log('Bullets to kill P2:', bulletsToKill2);
    document.getElementById('ms-bulletsToKill1').textContent = Math.ceil(avg(bulletsToKill1));
    document.getElementById('ms-bulletsToKill2').textContent = Math.ceil(avg(bulletsToKill2));

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
function switchFighterTab(player, el) {
  document.querySelectorAll('.ftab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.fighter-panel').forEach(p => p.classList.remove('active'));

  el.classList.add('active');
  document.getElementById('fp' + player).classList.add('active');

  applyActiveSliderColors(player);
}

function switchTab(name, el) {
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(t => t.classList.remove('active'));
  contents.forEach(c => c.classList.remove('active'));

  if (el) el.classList.add('active');

  const target = document.getElementById('tab-' + name);

  if (!target) {
    console.error('❌ Tab not found:', 'tab-' + name);
    return; // prevent crash
  }

  target.classList.add('active');
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
  drawIdle();
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
  drawCharacter(ctx, p1x, groundY, p1w.class, '#4a9eff', false, false, false, CLASS_SCALE[p1w.class]);
  drawCharacter(ctx, p2x, groundY, p2w.class, '#e84040', true, false, false, CLASS_SCALE[p2w.class]);
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





applyActiveSliderColors(1);