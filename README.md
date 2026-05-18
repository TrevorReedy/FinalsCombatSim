# THE FINALS Battle Simulator

A browser-based combat simulation tool for comparing weapons from **THE FINALS**.  
The simulator lets users select two contestants, choose weapons, adjust accuracy/headshot settings, change distance and movement rules, then run either a visual one-on-one simulation or a larger statistical analysis.

The project includes a canvas-based battle playback system, multi-run simulation stats, weapon data loaded from JSON, a cross-analysis engine powered by Web Workers, and a heatmap view for comparing matchups across multiple distances and aim profiles.

---

## Features

### Visual Battle Simulation

- Select Player 1 and Player 2 weapons.
- Filter weapons by class:
  - Light
  - Medium
  - Heavy
- Adjust:
  - Accuracy
  - Headshot chance
  - Starting distance
  - Melee advance speed
  - First-shot advantage
  - Playback speed
- Watch the battle play out on a canvas arena.
- View final combat stats such as:
  - Winner
  - Damage dealt
  - Shots fired
  - Hits
  - Headshots
  - Time to kill
  - Final range
  - Remaining HP

---

### Multi-Run Simulation

The simulator can run repeated simulations to estimate matchup consistency.

Multi-run output includes:

- Player 1 wins
- Player 2 wins
- Ties
- Average time to kill
- Average HP remaining
- Average bullets to kill
- Win-rate distribution

This helps reduce the randomness of single simulations and gives a better sense of how favorable a matchup is.

---

### Cross Analysis

The cross-analysis system compares one selected attacker against every other weapon across several distances and aim profiles.

The current cross-analysis setup uses:

- Multiple Web Workers
- A shared job queue
- Work stealing
- Progress tracking
- Profiling logs
- Final result rendering

Each job runs many simulations and returns:

- Defender weapon
- Defender class
- Distance
- Aim profile
- Wins
- Losses
- Ties
- Win rate
- Average attacker TTK
- Average defender TTK
- Favorability result

Favorability is grouped as:

- Favorable
- Even
- Unfavorable

---

### Heatmap View

The heatmap turns cross-analysis results into a visual matchup table.

Each cell shows:

- Win rate
- Average attacker TTK
- Average defender TTK
- Tooltip breakdown by aim profile
- Color-coded matchup favorability

The heatmap can help quickly identify which matchups are strong, weak, or highly distance-dependent.

---

### Weapon Data

Weapon stats are loaded from `weapons_s10_cleaned.json`.

Each weapon can include data such as:

- Class
- Weapon type
- Firing mode
- Body damage
- Headshot damage
- RPM
- Magazine size
- Tactical reload time
- Empty reload time
- Burst size
- Burst delay
- Damage dropoff range
- Damage reduction
- Notes
- Hitscan/projectile information

---

## Project Structure

```txt
.
├── index.html
├── battle_simulation.css
├── battle_simulator.js
├── simulate.js
├── cross_analysis_pool.js
├── cross_analysis_worker.js
├── heatgraph.js
└── weapons_s10_cleaned.json
