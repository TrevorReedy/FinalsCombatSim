## **Building a High-Performance Combat Simulator for *The Finals*: From Weapon Data to Web Workers to Heatmaps**

When I first set out to build a combat simulator for *The Finals*, I knew it would be a technically ambitious project. *The Finals* is an online multiplayer first-person shooter, and the goal of my simulator was to compare weapons across realistic combat scenarios while accounting for variables like weapon damage, fire rate, magazine size, reload timing, distance, movement, accuracy, headshot chance, and player class.

At a high level, the application answers one question:

> Given two weapons, two player classes, a starting distance, and a set of aim assumptions, who wins more often?

The final result is more than a simple calculator. It is a browser-based simulation stack with a visual one-on-one battle simulator, a shared combat engine, a JSON weapon database, a multi-worker cross-analysis system, and an interactive heatmap that summarizes thousands or millions of simulated fights.

This write-up explains the stack from top to bottom so someone who has never seen the code can understand how the project works.

---

## **Project Stack Overview**

The project is organized around a few major JavaScript files, each with a specific responsibility:

```txt
weapons_s10_cleaned.json
  └── Raw weapon data: damage, RPM, reload time, magazine size, dropoff, notes

battle_simulator.js
  └── Main browser UI: loads weapons, controls sliders, draws canvas animation,
      runs single and multi simulations, displays combat logs and stats

simulate.js
  └── Shared simulation engine: handles combat math, movement, firing,
      reloads, damage dropoff, hit chance, headshot chance, and winner detection

cross_analysis_pool.js
  └── Main-thread coordinator for large analysis jobs: builds job list,
      creates Web Workers, distributes work, tracks progress, collects results

cross_analysis_worker.js
  └── Worker-side runner: receives jobs, runs simulate() many times,
      aggregates results, requests more work when its queue is empty

heatgraph.js
  └── Visualization layer: turns cross-analysis results into a filtered,
      sortable heatmap with hover breakdowns
```

The important architectural decision is that the simulation engine is separated from the UI. The same `simulate()` function can be used for a single visual fight on the main thread or for thousands of headless runs inside Web Workers.

That separation is what allows the project to support both:

1. **Visual playback** for understanding an individual fight.
2. **Cross-analysis** for comparing one weapon against many opponents across distances and skill profiles.

---

## **The Data Layer: Weapon Stats as JSON**

The foundation of the simulator is the weapon data file. Each weapon is represented as a JSON object containing its class, weapon type, firing mode, damage values, RPM, magazine size, reload times, damage dropoff, and optional notes.

A simplified weapon entry looks like this:

```json
{
  "class": "light",
  "type": "Handgun",
  "firing_mode": "Burst",
  "name": "93R",
  "body_dmg": 24,
  "head_damage": 36,
  "rpm": 1000,
  "magazine_size": 24,
  "tactical_reload_time": 1.45,
  "empty_reload_time": 1.75,
  "shots_per_burst": 3,
  "delay_in_bursts": 0.275,
  "damage_dropoff_min_range": 30,
  "damage_dropoff_max_range": 37.5,
  "damage_reduction_at_max": 0.5,
  "weapon_type": "hitscan",
  "hitscan_range": null
}
```

This data model lets the simulator treat weapons generically. The engine does not need a custom function for every weapon. Instead, each weapon carries enough metadata for the simulator to determine how fast it fires, how much damage it deals, whether it bursts, whether it reloads, and how damage changes over distance.

Some weapons also include notes for edge cases that are not fully modeled yet. For example, certain projectile weapons include notes explaining that the current TTK calculation does not account for projectile travel time. This is useful because it documents where the simulation is accurate and where it is still an approximation.

---

## **The UI Layer: Loading Weapons into the Browser**

The browser UI starts by fetching the JSON weapon data and storing it in a global `WEAPONS` array.

```js
let WEAPONS = [];

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
```

This is the application bootstrap. Nothing meaningful can happen until the weapon data loads, because every dropdown, canvas preview, simulation, and cross-analysis job depends on the `WEAPONS` array.

The flow is:

```txt
Page loads
  ↓
loadWeapons() fetches weapons_s10_cleaned.json
  ↓
WEAPONS is populated
  ↓
Dropdowns are filled using filterWeapons()
  ↓
Sliders are synced using syncRange()
  ↓
Canvas preview is drawn using drawIdle()
```

---

## **Filtering Weapons by Class**

The UI lets the user choose a class such as light, medium, or heavy. After that, the weapon dropdown is rebuilt to show only weapons that belong to that class.

```js
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
```

The important detail here is that the dropdown option value is not the weapon name. It is the weapon's index inside the `WEAPONS` array.

```js
opt.value = i;
```

That makes later lookups simple:

```js
const p1w = WEAPONS[parseInt(document.getElementById('p1-weapon').value)];
```

Instead of searching by name, the UI stores the selected array index and uses it to retrieve the full weapon object immediately.

---

## **Displaying Weapon Information**

When the user changes a weapon, the UI displays key stats such as class HP, weapon type, firing mode, damage, headshot damage, RPM, speed, and dropoff notes.

```js
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

  const ddInfo = w.damage_dropoff_min_range
    ? `DROP: ${w.damage_dropoff_min_range}–${w.damage_dropoff_max_range} (${w.damage_reduction_at_max})`
    : 'No dropoff data';

  note.innerHTML = ddInfo + (w.notes ? ` &nbsp;|&nbsp; ${w.notes}` : '');
  drawIdle();
}
```

This function does two jobs:

1. It updates the visible UI so the user knows what weapon they selected.
2. It redraws the idle canvas so the preview stays synchronized with the selected fighters.

---

## **Core Game Constants**

The simulator defines movement speed and health by class.

```js
const CLASS_SPEED = { light: 7.0, medium: 5.0, heavy: 3.5 };
const CLASS_HP    = { light: 150, medium: 250, heavy: 350 };
const MELEE_RANGE = 2.0;
const DT = 0.01; // simulation tick 10ms
```

These constants are used by the combat engine to model movement and survivability.

The `DT` value is especially important. It means the simulation advances in 0.01 second increments, or 10 milliseconds per tick. That gives the simulator enough resolution to model fast fire rates, reload timing, movement, and simultaneous damage without relying on real-time animation timing.

---

## **The Shared Simulation Engine**

The heart of the project is `simulate()`.

```js
function simulate(
  p1w,
  p2w,
  p1acc,
  p1hs,
  p2acc,
  p2hs,
  startDist,
  speedOverride,
  meleeAdv,
  fsa,
  captureFrames
) {
  const s1 = getStats(p1w), s2 = getStats(p2w);
  // simulation state continues...
}
```

This function receives two weapon objects and a set of combat assumptions:

```txt
p1w, p2w
  The selected weapons for player 1 and player 2

p1acc, p2acc
  Accuracy probability for each player

p1hs, p2hs
  Headshot probability for each player

startDist
  Starting distance between the two players

speedOverride
  Optional speed cap for movement tuning

meleeAdv
  Whether melee-style advancement is enabled

fsa
  First-shot advantage setting

captureFrames
  Whether the engine should return animation frames and combat log entries
```

The most important design choice is the final parameter: `captureFrames`.

When `captureFrames` is `true`, the simulator records visual frame data and log text for playback. When it is `false`, it skips that extra work and only returns the final statistics. That makes the same function usable in two different contexts:

```txt
Single visual simulation
  simulate(..., captureFrames = true)
  → returns frames, logs, final stats

Worker cross-analysis
  simulate(..., captureFrames = false)
  → returns only final stats, much faster
```

---

## **Normalizing Weapon Data with getStats()**

Raw JSON can contain strings, numbers, missing values, and nulls. Before the simulation loop runs, each weapon is normalized into a simpler stats object.

```js
function getStats(w) {
  const rpm = parseNum(w.rpm) || 60;

  const bodyDmg = parseNum(w.body_dmg) || 0;
  const headDmg = parseNum(w.head_damage) || bodyDmg;
  const isMelee = w.type === 'Melee';
  const isBurst = w.shots_per_burst != null;
  const bSize = isBurst ? parseInt(w.shots_per_burst) : 1;
  const bDelay = isBurst ? parseFloat(w.delay_in_bursts) : 0;
  const dropMin = parseNum(w.damage_dropoff_min_range);
  const dropMax = parseNum(w.damage_dropoff_max_range);
  const dropR = w.damage_reduction_at_max
    ? parseFloat(String(w.damage_reduction_at_max).replace(/[~%]/g, ''))
    : 0;
  const interval = 60 / rpm;
  const classSpd = CLASS_SPEED[w.class];

  const magSize = Number.isFinite(parseInt(w.magazine_size))
    ? parseInt(w.magazine_size)
    : null;

  const tacticalReload = parseNum(w.tactical_reload_time) || 0;
  const emptyReload = parseNum(w.empty_reload_time) || tacticalReload || 0;

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
```

This function turns messy external data into a predictable internal format.

For example:

```js
const interval = 60 / rpm;
```

If a weapon fires at 600 RPM, then:

```txt
60 seconds / 600 rounds = 0.1 seconds between shots
```

That interval becomes the timer used inside the simulation loop to decide when the next shot can happen.

---

## **Damage Dropoff**

The simulator models damage reduction over distance using `dropMult()`.

```js
function dropMult(dist, s) {
  if (!s.dropMin || !s.dropMax) return 1;
  if (dist <= s.dropMin) return 1;
  if (dist >= s.dropMax) return 1 - s.dropR;
  return 1 - ((dist - s.dropMin) / (s.dropMax - s.dropMin)) * s.dropR;
}
```

This function returns a multiplier.

```txt
1.0 means full damage
0.5 means half damage
0.28 means 28% of original damage
```

The logic is:

```txt
If the weapon has no dropoff data:
  use full damage

If the target is closer than the dropoff start:
  use full damage

If the target is beyond the dropoff end:
  use the maximum reduced damage

If the target is between min and max dropoff:
  linearly interpolate the damage reduction
```

This is what lets the same weapon behave differently at 5 meters, 25 meters, and 100 meters.

---

## **Simulation State: Health, Position, Ammo, Reloads, and Timers**

Inside `simulate()`, each fight starts by creating local state for both players.

```js
const maxHP1 = CLASS_HP[p1w.class], maxHP2 = CLASS_HP[p2w.class];
let hp1 = maxHP1, hp2 = maxHP2;

const spd1 = Math.min(s1.classSpd, speedOverride || 99);
const spd2 = Math.min(s2.classSpd, speedOverride || 99);

let dist = startDist;
let p1pos = 0, p2pos = startDist;
let time = 0;
```

Health comes from class. Position starts with player 1 at zero and player 2 at the starting distance.

The simulator also tracks shot timing:

```js
let t1 = fsa === 'p2' ? s1.interval : 0;
let t2 = fsa === 'p1' ? s2.interval : 0;
```

This supports first-shot advantage. If player 1 has first-shot advantage, player 2 waits one firing interval before shooting. If both shoot at the same time, both timers can start at zero.

The engine also tracks burst fire:

```js
let b1shots = 0, b2shots = 0;
```

And magazine/reload state:

```js
let mag1 = s1.magSize !== null ? s1.magSize : Infinity;
let mag2 = s2.magSize !== null ? s2.magSize : Infinity;
let reloading1 = false, reloading2 = false;
let reloadEnd1 = 0, reloadEnd2 = 0;
```

Using `Infinity` for weapons without magazines is a clean shortcut. It lets the simulation treat bows, melee weapons, or special weapons as never needing reloads without adding a separate branch everywhere.

---

## **The Main Simulation Loop**

The fight runs inside a loop until one player dies or the maximum simulation time is reached.

```js
const MAX_TIME = 60;

while (time < MAX_TIME && hp1 > 0 && hp2 > 0) {
  let p1fired = false, p1hit = false, p1isHS = false;
  let p2fired = false, p2hit = false, p2isHS = false;

  // movement, reloads, firing, damage, frame capture...

  if (hp1 <= 0 || hp2 <= 0) break;
  time += DT;
}
```

This is a discrete-time simulation. Every tick represents 0.01 seconds of simulated combat. During each tick, the engine:

```txt
1. Updates movement
2. Checks whether reloads are complete
3. Determines whether P1 can fire
4. Determines whether P2 can fire
5. Applies pending damage simultaneously
6. Records animation frames if needed
7. Advances time by DT
```

This tick-based model makes the simulation deterministic in structure while still allowing randomness through hit chance and headshot chance.

---

## **Movement and Distance**

Distance matters because melee weapons need range and ranged weapons can lose damage through dropoff.

```js
if (s1.isMelee || meleeAdv) {
  p1pos = Math.min(p1pos + spd1 * DT, p2pos - MELEE_RANGE);
}

if (s2.isMelee || meleeAdv) {
  p2pos = Math.max(p2pos - spd2 * DT, p1pos + MELEE_RANGE);
}

p1pos += spd1 * DT;
p2pos -= spd2 * DT;
dist = Math.max(0, p2pos - p1pos);
```

The simulator uses each player's class speed to move positions over time. Light characters move faster than medium characters, and medium characters move faster than heavy characters.

This matters for weapons like melee options or close-range shotguns because the starting distance is not the only distance that matters. The fighters can close the gap over time, changing hit availability and damage output.

---

## **Reload Handling**

Reloads are modeled as time windows. When a player empties a magazine, that player enters a reloading state until the reload timer finishes.

```js
if (reloading1 && time >= reloadEnd1) {
  reloading1 = false;
  mag1 = s1.magSize;
  if (log) {
    log.push({
      type: 'reload',
      text: `[${time.toFixed(2)}s] P1 ✅ RELOAD COMPLETE (${mag1} in mag)`
    });
  }
}
```

When the magazine reaches zero, the reload starts:

```js
if (mag1 <= 0) {
  reloading1 = true;
  const reloadTime1 = s1.emptyReload || s1.tacticalReload || 0;
  reloadEnd1 = time + reloadTime1;
  t1 = reloadEnd1;
  b1shots = 0;

  if (log) {
    log.push({
      type: 'reload',
      text: `[${time.toFixed(2)}s] P1 🔄 RELOAD (${reloadTime1.toFixed(2)}s)`
    });
  }
}
```

The key variable is `reloadEnd1`. The player cannot fire again until the current simulation time passes that value.

This is important because some weapons have strong damage but small magazines. A weapon may win if it kills before reloading but lose if it fails to secure the kill in one magazine.

---

## **Firing Logic, Accuracy, and Headshots**

Each player fires when they are not reloading and the current simulation time is greater than their next allowed fire time.

```js
if (!reloading1 && time >= t1) {
  shots1++;
  p1fired = true;
  if (mag1 !== Infinity) mag1--;

  const p1InRange = !s1.isMelee || dist <= meleeRange1;

  if (p1InRange && Math.random() < p1acc) {
    const isHS = (s1.headDmg > s1.bodyDmg) && Math.random() < p1hs;
    const dmg  = (isHS ? s1.headDmg : s1.bodyDmg) * dropMult(dist, s1);

    pendingDmgToP2 += dmg;
    dmg1 += dmg;
    hits1++;
    if (isHS) hs1count++;

    p1hit = true;
    p1isHS = isHS;
  }
}
```

This block models several pieces of combat at once:

```txt
shots1++
  A shot was attempted.

Math.random() < p1acc
  The shot hits based on the player's accuracy percentage.

Math.random() < p1hs
  If the shot hits, it may become a headshot.

body/head damage * dropMult(distance)
  Damage is adjusted by range.

pendingDmgToP2 += dmg
  Damage is stored temporarily so both players can damage each other in the same tick.
```

That last point is important. Damage is not applied immediately. It is stored in `pendingDmgToP1` or `pendingDmgToP2`.

---

## **Simultaneous Damage Application**

After both players have had a chance to fire, damage is applied to both health pools.

```js
hp2 = Math.max(0, hp2 - pendingDmgToP2);
hp1 = Math.max(0, hp1 - pendingDmgToP1);
```

This prevents the simulation from unfairly giving one player priority just because their code block ran first.

Without this, player 1 could kill player 2 before player 2's shot was processed, even if both were supposed to fire during the same tick. By storing pending damage and applying it after both firing checks, the engine supports simultaneous eliminations and fairer timing.

---

## **Burst Fire Timing**

Burst weapons use two timing rules:

1. Shots inside the burst use the normal firing interval.
2. After the burst is complete, the weapon waits for the burst delay.

```js
if (s1.isBurst) {
  b1shots++;
  t1 += b1shots < s1.bSize
    ? s1.interval
    : (b1shots = 0, s1.bDelay + s1.interval);
} else {
  t1 += s1.interval;
}
```

This means a weapon like the 93R can fire three quick shots and then pause before the next burst. Modeling that matters because burst weapons often have very different practical TTK than automatic weapons with the same average RPM.

---

## **Frame Capture for Visual Playback**

When `captureFrames` is enabled, the simulation saves frame objects during the fight.

```js
if (frames) {
  frames.push({
    time,
    dist,
    p1_position: p1pos,
    p2_position: p2pos,
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
```

Each frame stores enough information for the canvas renderer to draw that moment later.

The frame includes:

```txt
Current time
Current distance
Player positions
Player health
Player classes
Whether either player fired
Whether either player was hit
Whether the hit was a headshot
Projectile effects for visualization
```

This is a clean design because the simulation does not draw directly to the canvas. It only creates data. The renderer later consumes that data.

---

## **The Return Object**

At the end of a fight, the simulator decides a winner and returns all final statistics.

```js
const winner =
  hp1 <= 0 && hp2 <= 0 ? 'tie' :
  hp2 <= 0 ? 'p1' :
  hp1 <= 0 ? 'p2' :
  hp1 > hp2 ? 'p1' : hp2 > hp1 ? 'p2' : 'tie';

return {
  winner,
  time,
  dist,
  hp1: Math.max(0, hp1),
  hp2: Math.max(0, hp2),
  maxHP1,
  maxHP2,
  dmg1,
  dmg2,
  shots1,
  hits1,
  hs1: hs1count,
  shots2,
  hits2,
  hs2: hs2count,
  frames,
  log
};
```

This return object is used differently depending on where the simulation was called.

```txt
Visual simulator
  Uses frames, log, winner, damage, shots, hits, health, and time

Cross-analysis worker
  Uses winner and time, then aggregates win rate and average TTK
```

---

## **Single Fight Mode: Running One Visual Simulation**

The main UI runs a single visual simulation when the user clicks simulate.

```js
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

  const result = simulate(
    p1w,
    p2w,
    p1acc,
    p1hs,
    p2acc,
    p2hs,
    startDist,
    speedOv,
    meleeAdv,
    firstShot,
    true
  );

  lastResult = result;
  simFrames = result.frames;
}
```

This function converts UI inputs into simulation arguments. Notice that the final argument is `true`, which means this run captures animation frames.

The combat log is then rendered from the returned log entries:

```js
const logEl = document.getElementById('combat-log');
logEl.innerHTML = (result.log || [])
  .slice(0, 400)
  .map(l => `<div class="ll ${l.type}">${l.text}</div>`)
  .join('');
```

The `slice(0, 400)` is a practical UI guard. Some fights may generate many log entries, so the display is capped to prevent the page from being overwhelmed.

---

## **Multi-Simulation Mode**

For a single matchup, the UI can also run many simulations and summarize the results.

```js
if (simMode === 'multi' && simN > 1) {
  let w1 = 0, w2 = 0, ties = 0;
  let ttkArr1 = [], ttkArr2 = [], hp1Arr = [], hp2Arr = [];
  let bulletsToKill1 = [], bulletsToKill2 = [];

  for (let i = 0; i < simN; i++) {
    const r = simulate(
      p1w,
      p2w,
      p1acc,
      p1hs,
      p2acc,
      p2hs,
      startDist,
      speedOv,
      meleeAdv,
      firstShot,
      false
    );

    if (r.winner === 'p1') {
      w1++;
      ttkArr1.push(r.time);
      bulletsToKill1.push(r.hits1);
    } else if (r.winner === 'p2') {
      w2++;
      ttkArr2.push(r.time);
      bulletsToKill2.push(r.hits2);
    } else {
      ties++;
    }

    hp1Arr.push(r.hp1);
    hp2Arr.push(r.hp2);
  }
}
```

This is similar to cross-analysis, but it still runs on the main thread and is limited to a smaller number of simulations.

The key difference is that `captureFrames` is `false` for repeated runs. The UI only needs aggregate statistics, not thousands of animation frames.

---

## **Canvas Rendering: Drawing a Fight**

The simulator uses an HTML canvas to draw the two fighters, projectiles, hit sparks, muzzle flashes, the distance scale, and the HUD.

The main drawing function is `drawFrame(frame)`.

```js
function drawFrame(frame) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.strokeStyle = '#1a1f2a';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  const groundY = H * 0.72;

  function toX(pos) {
    return margin + (pos / maxDist) * trackW;
  }

  const p1x = toX(frame.p1_position);
  const p2x = toX(frame.p2_position);

  drawCharacter(ctx, p1x, groundY, frame.p1class, '#4a9eff', false, frame.hp1 <= 0, frame.p1flash, CLASS_SCALE[frame.p1class]);
  drawCharacter(ctx, p2x, groundY, frame.p2class, '#e84040', true, frame.hp2 <= 0, frame.p2flash, CLASS_SCALE[frame.p2class]);
}
```

This function takes the simulation frame and transforms abstract combat state into pixels.

```txt
p1_position and p2_position
  become canvas X coordinates

hp1 and hp2
  update health bars

p1flash and p2flash
  trigger muzzle flash particles

p1hit and p2hit
  trigger hit sparks

p1class and p2class
  control character scale and class label
```

This separation keeps rendering logic out of the combat math. The simulation engine does not care about colors, particles, fonts, or canvas coordinates.

---

## **The Performance Problem**

Single simulations are manageable on the main thread. Cross-analysis is not.

The cross-analysis feature compares one attacker against many defenders across several distances and skill profiles. The code defines fixed distance and aim-profile sets:

```js
function getDistances() {
  return [1, 5, 15, 25, 50, 75, 100];
}

function getAimProfiles() {
  return [
    { name: 'Poor',    acc: 0.50, hs: 0.20 },
    { name: 'Average', acc: 0.75, hs: 0.35 },
    { name: 'Strong',  acc: 0.90, hs: 0.55 },
    { name: 'Elite',   acc: 0.99, hs: 0.80 }
  ];
}
```

If there are around 47 possible defender weapons, that becomes:

```txt
47 defenders × 7 distances × 4 aim profiles = 1,316 scenarios
```

Each scenario runs many times:

```js
const RUNS = 50000;
```

That means a full analysis can represent tens of millions of simulated fights.

```txt
1,316 scenarios × 50,000 runs = 65,800,000 simulations
```

Running that on the browser's main thread would freeze the page. The solution is to move the heavy computation into Web Workers.

---

## **Cross-Analysis Architecture**

The cross-analysis system is split into two parts:

```txt
cross_analysis_pool.js
  Main-thread coordinator

cross_analysis_worker.js
  Background worker runner
```

The main thread is responsible for:

```txt
Reading UI inputs
Building jobs
Creating workers
Distributing jobs
Tracking progress
Collecting results
Rendering the heatmap
```

The workers are responsible for:

```txt
Receiving jobs
Running simulate() repeatedly
Aggregating wins/losses/ties
Posting results back
Requesting more work
```

This allows expensive simulation work to happen off the main UI thread.

---

## **Choosing Worker Count**

The worker pool size is based on the browser's available CPU cores.

```js
const POOL_SIZE = Math.max(
  2,
  Math.min(8, (navigator.hardwareConcurrency || 4) - 1)
);
```

This does three things:

```txt
navigator.hardwareConcurrency
  asks the browser how many logical CPU cores are available

- 1
  leaves one core available for the main browser thread and UI work

Math.min(8, ...)
  caps workers at 8 to avoid spawning too many threads

Math.max(2, ...)
  ensures at least 2 workers are used
```

This is a practical browser performance compromise. More workers are not always better. Too many workers can increase context switching and message overhead.

---

## **Building Cross-Analysis Jobs**

A job is one specific scenario:

```txt
Attacker weapon
Defender weapon
Distance
Opponent aim profile
Number of simulation runs
Movement settings
User accuracy/headshot settings
```

The job builder creates the Cartesian product of defender weapons, distances, and aim profiles.

```js
function buildJobs(
  attacker,
  weapons,
  distances,
  profiles,
  speedOverride,
  meleeAdv,
  attackerAcc,
  attackerHs
) {
  const jobs = [];
  let jobId = 0;

  weapons.forEach(defender => {
    if (defender.name === attacker.name) return;

    distances.forEach(distance => {
      profiles.forEach(profile => {
        jobs.push({
          jobId: jobId++,
          attacker,
          defender,
          distance,
          profile,
          runs: RUNS,
          speedOverride,
          meleeAdv,

          // USER / ATTACKER SETTINGS
          attackerAcc,
          attackerHs,

          // OPPONENT / DEFENDER SETTINGS
          defenderAcc: profile.acc,
          defenderHs: profile.hs
        });
      });
    });
  });

  return jobs;
}
```

Each job is self-contained. That is important because workers do not need to query the DOM, ask the main thread for missing data, or share mutable weapon state. A worker receives a job and has everything it needs to run that scenario.

---

## **Initial Distribution**

Before work stealing starts, jobs are distributed across workers.

```js
function distributeJobs(jobs, poolSize) {
  const chunks = Array.from({ length: poolSize }, () => []);
  jobs.forEach((job, i) => chunks[i % poolSize].push(job));
  return chunks;
}
```

This distributes jobs in a round-robin pattern.

```txt
Job 0 → Worker 0
Job 1 → Worker 1
Job 2 → Worker 2
...
Job N → Worker N % poolSize
```

That gives each worker an initial batch of work. However, not all jobs take the same amount of time. Some weapon matchups finish quickly, while others can run longer because of reloads, movement, misses, or long TTK scenarios. That is why the system also uses work stealing.

---

## **The Central Queue and Work Stealing**

After the jobs are built, the main thread creates a central queue.

```js
const globalQueue = [...allJobs].reverse();
const results = new Array(totalJobs);
let completedJobs = 0;
```

The queue is reversed so jobs can be removed efficiently using `pop()`.

When a worker finishes its current batch, it sends a `steal_request` message. The coordinator responds by handing it more jobs from the global queue.

```js
function handleStealRequest(worker) {
  console.log(`🔀 Steal request — remaining jobs: ${globalQueue.length}`);

  if (globalQueue.length === 0) {
    worker.postMessage({ type: 'no_work' });
    return;
  }

  const stolen = [];
  for (let i = 0; i < STEAL_CHUNK && globalQueue.length > 0; i++) {
    stolen.push(globalQueue.pop());
  }

  worker.postMessage({ type: 'stolen', jobs: stolen });
}
```

The chunk size is configurable:

```js
const STEAL_CHUNK = 16;
```

This balances two competing concerns:

```txt
Small chunks
  Better load balancing, but more messages between workers and main thread

Large chunks
  Less message overhead, but higher chance that some workers finish early and sit idle
```

A chunk size of 16 gives each worker enough work to avoid constantly messaging the main thread, while still letting the pool rebalance as jobs finish.

---

## **Worker Message Protocol**

The worker system uses a simple message protocol.

```txt
Main thread → Worker
  { type: 'jobs', jobs: [...] }
  { type: 'stolen', jobs: [...] }
  { type: 'no_work' }

Worker → Main thread
  { type: 'result', result }
  { type: 'steal_request' }
  { type: 'done' }
```

The main thread handles these messages in `onWorkerMessage()`.

```js
function onWorkerMessage(e) {
  const msg = e.data;

  if (msg.type === 'result') {
    results[msg.result.jobId] = msg.result;
    completedJobs++;
    updateProgress();
    return;
  }

  if (msg.type === 'steal_request') {
    handleStealRequest(this);
    return;
  }

  if (msg.type === 'done') {
    activeWorkers--;
    this.terminate();
    updateProgress();

    if (activeWorkers === 0) {
      const finalResults = results.filter(Boolean);
      window.LAST_RESULTS = finalResults;

      if (typeof renderHeatGraph === 'function') {
        renderHeatGraph(finalResults, 'cross-table');
      }
    }
  }
}
```

The `jobId` matters because results can return in any order. Workers run in parallel, so job 50 might finish before job 10. By storing each result at `results[msg.result.jobId]`, the coordinator keeps results organized regardless of completion order.

---

## **Spawning Workers**

Workers are created from `cross_analysis_worker.js`.

```js
const chunks = distributeJobs(allJobs, POOL_SIZE);

for (let i = 0; i < POOL_SIZE; i++) {
  console.log(`👷 Spawning worker ${i}`);
  const w = new Worker('./cross_analysis_worker.js');
  w.onmessage = onWorkerMessage.bind(w);
  w.onerror = (err) => console.error(`Worker ${i} error:`, err);
  workers.push(w);

  const jobsToSend = chunks[i];
  for (let j = 0; j < jobsToSend.length; j++) globalQueue.pop();

  w.postMessage({ type: 'jobs', jobs: jobsToSend });
}
```

Each worker receives an initial set of jobs. When it finishes those jobs, it asks for more.

The coordinator terminates each worker after the run is complete:

```js
this.terminate();
```

That keeps memory clean between analysis runs.

---

## **Inside the Worker**

The worker imports the shared simulation engine:

```js
importScripts('./simulate.js');
```

This is what allows `cross_analysis_worker.js` to call the same `simulate()` function used by the visual simulator.

The worker's main job is to run one scenario many times and aggregate the result.

```js
function runJob(job) {
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

    if (r.winner === 'p1') {
      wins++;
      attackerTTKSum += r.time;
    } else if (r.winner === 'p2') {
      losses++;
      defenderTTKSum += r.time;
    } else {
      ties++;
    }
  }
}
```

For each run, the worker records whether the attacker won, lost, or tied. It also tracks TTK separately for attacker wins and defender wins.

At the end, it calculates aggregate statistics:

```js
const total = wins + losses + ties;
const winRate = total > 0 ? wins / total : 0;
const avgAttackerTTK = wins > 0 ? attackerTTKSum / wins : null;
const avgDefenderTTK = losses > 0 ? defenderTTKSum / losses : null;
```

Then the worker returns a compact result object:

```js
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
```

This is much smaller than sending every individual fight result back to the main thread. Instead of posting 50,000 raw simulation results, the worker posts one aggregate summary for the scenario.

That is one of the biggest performance wins in the project.

---

## **Worker Batch Processing**

The worker receives either initial jobs or stolen jobs.

```js
self.onmessage = function(e) {
  const msg = e.data;

  if (msg.type === 'jobs' || msg.type === 'stolen') {
    const jobs = msg.jobs;

    for (let i = 0; i < jobs.length; i++) {
      const result = runJob(jobs[i]);
      self.postMessage({ type: 'result', result });
    }

    self.postMessage({ type: 'steal_request' });
  }

  if (msg.type === 'no_work') {
    self.postMessage({ type: 'done' });
  }
};
```

The worker does not decide whether more work exists. It simply asks. The main thread owns the global queue and decides whether to send more jobs or tell the worker to shut down.

This keeps the concurrency model simple:

```txt
Workers do computation.
Main thread owns scheduling.
```

---

## **Progress Updates**

Because each worker posts a result after completing a job, the main thread can update progress incrementally.

```js
function updateProgress() {
  const pct = (completedJobs / totalJobs * 100).toFixed(1);

  if (progressBar) {
    progressBar.style.width = pct + '%';
  }

  if (progressLabel) {
    progressLabel.innerHTML = `
      ${completedJobs.toLocaleString()} / ${totalJobs.toLocaleString()} scenarios complete
      · <span class="ca-worker-label">${activeWorkers} workers active</span>
    `;
  }
}
```

This makes the tool feel responsive even during a heavy computation. The user can see scenarios completing rather than staring at a frozen page.

---

## **Profiling and Performance Logging**

The cross-analysis files include profiling hooks for performance analysis.

```js
function startProfiling() {
  if (typeof console.profile === 'function') {
    isProfiling = true;
    console.profile('CrossAnalysis');
    console.log('🔴 Profiling started - run your analysis');
  } else {
    console.warn('console.profile not available. Run with --enable-devtools-experiments');
  }
}
```

The worker also records job timing:

```js
const __jobStart = performance.now();
let __simTime = 0;

// run simulations...

const __jobEnd = performance.now();
const __jobMs = __jobEnd - __jobStart;

console.log(
  `✅ Worker ${workerId} DONE job ${job.jobId} | ` +
  `time=${__jobMs.toFixed(2)}ms | ` +
  `avgSim=${(__simTime / runs).toFixed(4)}ms | ` +
  `runs=${runs}`
);
```

This helped identify where time was going:

```txt
Total analysis time
Per-job time
Average simulation time
Worker batch time
Worker activity and shutdown
```

For a project like this, performance measurement is not optional. Without instrumentation, it would be hard to know whether the bottleneck was simulation math, worker messaging, DOM rendering, heatmap generation, or something else.

---

## **Heatmap Rendering**

After all workers finish, the main thread calls:

```js
renderHeatGraph(finalResults, 'cross-table');
```

The heatmap receives the final list of scenario results.

```js
function renderHeatGraph(results, mountId = 'cross-table') {
  const mount = document.getElementById(mountId);

  if (!mount) return;
  if (!results || !results.length) {
    mount.innerHTML = `<div style="padding:16px;color:var(--muted);">No cross-analysis results to graph.</div>`;
    return;
  }

  const distances = [...new Set(results.map(r => r.distance))].sort((a, b) => a - b);
  const { classes, profiles } = buildFilterOptions(results);

  // draw heatmap...
}
```

The heatmap dynamically discovers which distances, classes, and aim profiles exist in the result set. That means the renderer does not need to hardcode the number of columns or filters.

---

## **Grouping Results by Defender**

The heatmap groups rows by defender weapon.

```js
function groupRows(results) {
  const rows = {};

  results.forEach(r => {
    if (!rows[r.defender]) {
      rows[r.defender] = {
        defender: r.defender,
        class: r.class,
        items: []
      };
    }

    rows[r.defender].items.push(r);
  });

  return Object.values(rows);
}
```

This converts a flat list of scenario results into table rows. Each row represents a defender weapon, and each cell represents that defender at a specific distance.

---

## **Building Heatmap Cells**

Each heatmap cell summarizes all matching results for one defender at one distance.

```js
function buildHeatCells(items, distances, activeProfile) {
  return distances.map(dist => {
    const matches = items.filter(r =>
      r.distance === dist &&
      (!activeProfile || r.profile === activeProfile)
    );

    if (!matches.length) {
      return {
        distance: dist,
        winRate: null,
        avgAttackerTTK: null,
        avgDefenderTTK: null,
        count: 0,
        profiles: []
      };
    }

    return {
      distance: dist,
      winRate: average(matches.map(r => r.winRate).filter(v => v != null)),
      avgAttackerTTK: average(matches.map(r => r.avgAttackerTTK).filter(v => v != null)),
      avgDefenderTTK: average(matches.map(r => r.avgDefenderTTK).filter(v => v != null)),
      count: matches.length,
      profiles: buildProfileBreakdown(matches)
    };
  });
}
```

If the heatmap is averaging all profiles, a cell may represent multiple underlying results. If the user filters to a specific profile, the cell only uses that profile.

This makes the visualization flexible:

```txt
Average all opponent profiles
  Shows broad weapon favorability

Filter to Elite
  Shows how the matchup changes against highly accurate opponents

Filter to Poor
  Shows how forgiving the weapon is against lower accuracy
```

---

## **Coloring Win Rate**

The heatmap uses win rate to generate cell color.

```js
function winRateColor(winRate) {
  const t = clamp(winRate, 0, 1);

  let r, g, b;
  if (t < 0.5) {
    const p = t / 0.5;
    r = 220;
    g = Math.round(70 + (180 - 70) * p);
    b = 70;
  } else {
    const p = (t - 0.5) / 0.5;
    r = Math.round(220 + (70 - 220) * p);
    g = Math.round(180 + (210 - 180) * p);
    b = 70;
  }

  return `rgb(${r}, ${g}, ${b})`;
}
```

Conceptually:

```txt
Low win rate
  redder cell

Middle win rate
  yellow/orange cell

High win rate
  greener cell
```

This lets the user scan the grid quickly instead of reading every number.

---

## **Rendering the Heatmap Table**

Each heatmap cell includes win rate, attacker TTK, and a hover tooltip.

```js
return `
  <td
    style="
      position:relative;
      overflow:visible;
      border:1px solid var(--border);
      background:${bg};
      color:${fg};
      text-align:center;
      padding:8px 6px;
      min-width:88px;
      height:64px;
      font-weight:700;
      cursor:help;
    "
    aria-label="Win Rate ${wr} percent, Attacker TTK ${ttk}, Defender TTK ${defTtk}, Samples ${cell.count}"
  >
    <div style="font-size:15px;line-height:1;">${wr}%</div>
    <div style="font-size:11px;line-height:1.2;margin-top:6px;opacity:0.95;">${ttk}</div>
    ${buildTooltipHtml(cell)}
  </td>
`;
```

The result is a grid where each cell provides both a quick visual signal and detailed data on hover.

---

## **Filters and Sorting**

The heatmap includes controls for class filtering, opponent profile filtering, and row sorting.

```js
mount.innerHTML = `
  <div style="padding:14px;">
    <div style="
      display:flex;
      flex-wrap:wrap;
      gap:12px;
      align-items:end;
      margin-bottom:14px;
    ">
      <div>
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:6px;">Class Filter</label>
        <select id="heat-class-filter" style="min-width:160px;">
          <option value="">All Classes</option>
          ${classes.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </select>
      </div>

      <div>
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:6px;">Opponent Profile</label>
        <select id="heat-profile-filter" style="min-width:180px;">
          <option value="">Average All Profiles</option>
          ${profiles.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
        </select>
      </div>

      <div>
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:6px;">Sort Rows</label>
        <select id="heat-sort-filter" style="min-width:220px;">
          <option value="fav-desc">Most to Least Favorable</option>
          <option value="fav-asc">Least to Most Favorable</option>
          <option value="alpha">Alphabetical</option>
        </select>
      </div>
    </div>

    <div id="${bodyId}"></div>
  </div>
`;
```

The filters are wired directly to redraw the heatmap.

```js
document.getElementById('heat-class-filter')?.addEventListener('change', draw);
document.getElementById('heat-profile-filter')?.addEventListener('change', draw);
document.getElementById('heat-sort-filter')?.addEventListener('change', draw);

draw();
```

This means the heatmap does not need to rerun the simulations when filters change. It simply reuses the already computed result set.

That is another important performance decision:

```txt
Simulation work happens once.
Visualization can be redrawn many times.
```

---

## **Escaping HTML for Safety**

Because the heatmap injects strings into `innerHTML`, it includes an escape helper.

```js
function esc(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
```

This matters because weapon names, classes, or notes can eventually come from external data. Escaping helps prevent accidental HTML injection when rendering dynamic strings.

---

## **Why the Browser Froze at First**

The original challenge was that the browser's main thread was doing too much work.

The main thread is responsible for:

```txt
Rendering the page
Handling clicks and input
Animating the canvas
Updating DOM elements
Running JavaScript
```

If millions of simulations run on that same thread, the browser cannot update the UI. Buttons stop responding, animations freeze, and the tab appears locked.

The Web Worker design solves this by moving CPU-heavy loops off the main thread.

```txt
Main thread
  UI, progress bar, final rendering

Worker threads
  Monte Carlo simulation loops
```

That is the core performance breakthrough of the project.

---

## **Why Aggregation Matters**

A naive worker implementation could send every simulation result back to the main thread.

That would be a mistake.

For one scenario with 50,000 runs, that would mean 50,000 messages. For 1,316 scenarios, that would mean tens of millions of messages. The message overhead alone could destroy performance.

Instead, each worker aggregates locally:

```js
let wins = 0, losses = 0, ties = 0;
let attackerTTKSum = 0, defenderTTKSum = 0;
```

Then it sends one result per job:

```js
self.postMessage({ type: 'result', result });
```

This reduces communication from:

```txt
one message per simulation
```

to:

```txt
one message per scenario
```

That is a massive reduction in main-thread overhead.

---

## **Why Work Stealing Matters**

Static job distribution is not enough because not all jobs cost the same.

For example:

```txt
A close-range fight with high damage weapons may end quickly.
A long-range fight with misses, reloads, and damage dropoff may take much longer.
```

If every worker gets a fixed list of jobs and one worker gets unlucky with expensive jobs, the other workers may finish early and sit idle.

Work stealing solves this by letting workers request more jobs when they finish.

```js
self.postMessage({ type: 'steal_request' });
```

The result is better CPU utilization. Workers stay busy until the global queue is empty.

---

## **The Full Runtime Flow**

From the user's perspective, the cross-analysis feature looks simple: choose a weapon and run the analysis.

Internally, the flow is much larger:

```txt
User clicks Cross Analysis
  ↓
runCrossAnalysis() reads selected attacker, accuracy, headshot %, speed, melee settings
  ↓
getDistances() returns test distances
  ↓
getAimProfiles() returns opponent skill profiles
  ↓
buildJobs() creates one job for every defender × distance × profile
  ↓
distributeJobs() creates initial worker batches
  ↓
Main thread spawns Web Workers
  ↓
Workers import simulate.js
  ↓
Workers run simulate() 50,000 times per job
  ↓
Workers aggregate wins, losses, ties, win rate, and TTK
  ↓
Workers post one result per job
  ↓
Main thread stores results by jobId and updates progress
  ↓
Idle workers request more jobs
  ↓
Main thread sends stolen jobs or no_work
  ↓
When all workers are done, finalResults is created
  ↓
renderHeatGraph() visualizes the result set
```

This is the full stack working together.

---

## **What This Project Demonstrates**

This project demonstrates several important software engineering skills:

```txt
Data modeling
  Weapon behavior is represented through JSON fields instead of hardcoded cases.

Simulation design
  Combat is modeled through time steps, probability, position, reloads, damage, and state.

Separation of concerns
  The simulation engine, UI rendering, worker orchestration, and heatmap visualization are separate layers.

Performance engineering
  Heavy computation is moved into Web Workers, message volume is reduced through aggregation, and progress is updated incrementally.

Concurrency
  A worker pool and work-stealing queue keep CPU cores busy without freezing the browser.

Visualization
  Raw simulation output is transformed into a readable heatmap with filtering, sorting, and hover details.

Debugging and profiling
  The code includes performance timers and console profiling hooks to measure bottlenecks.
```

---

## **Roadblocks and Lessons Learned**

The biggest early roadblock was performance. Running large simulation loops directly on the main thread made the browser freeze. That forced a redesign from a simple single-threaded app into a worker-based architecture.

The second major challenge was coordination. Using Web Workers is not difficult by itself, but coordinating many workers efficiently requires careful thought. The project needed:

```txt
Job IDs to preserve result order
A central queue to own remaining work
A message protocol for worker communication
A chunk size to balance overhead and load balancing
A termination path when all work is complete
Progress updates that do not require blocking the UI
```

The third challenge was visualization. A table of raw numbers was not enough. The heatmap made the analysis usable by turning thousands of results into a pattern the user can understand quickly.

---

## **Takeaway for Recruiters**

This project is not just a game-related tool. It is a browser-based performance engineering project.

It shows that I can build an application that:

```txt
Processes large datasets
Runs CPU-heavy simulations
Uses parallelism in the browser
Coordinates asynchronous worker messages
Separates computation from rendering
Builds interactive visualizations
Turns raw data into user-facing insight
```

The most important part of the project is not that it simulates weapons. The important part is that it takes a computationally expensive problem, breaks it into independent jobs, distributes those jobs across browser workers, aggregates the results efficiently, and renders them in a way that users can actually understand.

That is the same kind of thinking used in analytics tools, testing systems, performance dashboards, simulation engines, and any application where raw computation has to become meaningful output.
