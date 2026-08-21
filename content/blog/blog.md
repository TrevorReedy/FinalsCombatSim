# The Finals Combat Simulator

> A browser tool for comparing weapons in **THE FINALS** — and the story of taking it from **95 million sampled duels that crashed the tab** to an **exact probabilistic solver that answers the same question in milliseconds**.

**THE FINALS** is a free-to-play, team-based first-person shooter built around fast objective play and highly destructible arenas. Its fights can change dramatically based on weapon choice, range, accuracy, movement, and the chaos happening around you, which made it an interesting game to model probabilistically.

## At a Glance

| | |
|---|---:|
| **Weapons** | 46 |
| **Meta scenarios** | 952 |
| **Parallel workers** | Up to 8 |
| **Original workload** | 95.2M simulated fights |
| **Exact solver benchmark** | 1.4 ms |
| **Sampling benchmark** | 1,514 ms |
| **Measured solver speedup** | **1,110×** |

The project started as a Monte Carlo simulator. When that approach became too expensive in the browser, I first attacked the performance problem with Web Workers, dynamic job scheduling, and reproducible seeded randomness. Eventually I realized the bigger problem was not how fast I could run the simulation — it was that I was running millions of simulations when many matchups could be solved exactly.

The current architecture uses a **dual-engine simulation system**:

- **Exact probabilistic solver** for matchups that satisfy the model's assumptions.
- **Seeded Monte Carlo simulation** as a fallback for cases that do not, and as an oracle for validating the exact solver.

---

## Basics of the App

- **1v1 Simulator** — visual duel
- **Meta Simulator** — heat map
- **Sustain Simulator** — cashout holds
- **Stats** — data + history
- **Help** — model + limits

<!-- Add a screenshot or GIF of the app here. -->

---

# The Engineering Story

## Version 1 — "Single Threaded" + Monte Carlo Logic

This first pass allowed me to run a Monte Carlo simulation where one user picked a weapon and would fight every other weapon in non-deterministic simulated fights.

These simulated fights were chosen to be random because FPS games are themselves non-deterministic. Nobody hits 100% of shots due to lag, user aim, or a myriad of other factors — especially in a game like **THE FINALS**, where everything can be destroyed and chaos is a main aspect of the game.

I hoped my simulator would allow players to see past the noise and focus on the signal: numbers that show, at minimum, real correlation in the game.

### Building the First Model

To represent this randomness while preserving correlations between weapons, I decided to run **100,000 simulated fights for each scenario**.

A scenario consists of a single combination of:

| Variable | Scenario space |
|---|---|
| **34 simulated weapons** | 46 total weapons − 12 melee weapons. The melee entries were removed because the data was insufficient and I was having issues modeling a close-range encounter correctly. |
| **7 distances** | 1 m, 5 m, 15 m, 25 m, 50 m, 75 m, 100 m |
| **4 accuracy profiles** | 50%, 75%, 90%, 99% |

```text
34 defenders × 7 distances × 4 profiles = 952 scenarios
952 scenarios × 100,000 fights = 95.2 million simulated fights
```

I ran the 952 scenarios with 100,000 runs each through the Chrome browser. I waited, and then waited some more, and finally — *drumroll please...* — the main thread crashed and failed to complete the **95.2 million calculations**.

### Roadblock: Out of Memory / Compute Cost

My first benchmarks made the scale of the problem clear:

| Configuration | Time |
|---|---:|
| 95.2M fights, single thread | **215 s** / 3.6 min |
| 8 workers | **27 s** |
| 8 workers @ 50k runs | **13 s** |
| 8 workers @ 10k runs | **3 s** |

At first, one of the main culprits behind the intensive workload looked like `Math.random()`.

`Math.random()` was called for every shot fired. With roughly 35 shots per fight × 1.75 ≈ **~60 random calls per fight**, that became roughly **6 million random calls per scenario** at 100,000 runs.

### Was `Math.random()` the Problem?

I benchmarked a single fight — `{FCAR vs AKM @ 25m}` — at 100k runs:

| RNG method | Time | Result |
|---|---:|---|
| `Math.random()` | 183 ms | baseline |
| Cheap LCG substitute | 190 ms | 4% slower |
| Constant / no RNG | 147 ms | 19% faster |

I had overvalued `Math.random()` as the source of the problem. Repeated random-number generation looked like an obvious culprit, but the benchmark showed that even removing RNG entirely only saved about a fifth of the runtime.

That meant I had to search elsewhere for meaningful performance gains.

---

## New Problems, New Solutions

### The Three Ways Out

I saw three realistic paths forward.

### 1. Reduce the Number of Runs to 10,000–50,000 — **Picked**

| Pros | Cons |
|---|---|
| Minimal increase in implementation complexity | Decreased statistical accuracy due to smaller sample size |
| Immediate reduction in compute | Still relatively slow on lower-compute machines |

### 2. Implement Web Workers — **Picked**

| Pros | Cons |
|---|---|
| Fast | Increased system-resource demands |
| Can run 50k–100k samples without freezing the UI | Lower-compute devices may not receive the same benefit |
| Multiple calculations can make progress in parallel | Each worker has its own V8 isolate and introduces memory/runtime overhead |
| Simulation work stays separate from DOM/UI work | Requires coordination and messaging between workers and the main thread |

### 3. Time-Slice the Main Thread

| Pros | Cons |
|---|---|
| No worker communication or worker overhead | Does not improve total turnaround time, only responsiveness |
| Prevents one continuous blocking task | 100k runs would still take far too long |
| Can stop the page from appearing frozen | Simulation and rendering still share the main thread |

I picked **1 and 2**.

Originally I wanted to implement only Web Workers and try to force progress across multiple workers while keeping all 100k runs. In my head, 100k felt significant, but I had overestimated how statistically significant the difference actually was.

The need to reach 100k runs was chasing perfection and complexity instead of solving a real problem.

`ui_shell.js:1525` computes:

```js
100 * 0.5 / Math.sqrt(runs)
```

That gives the standard error of a win rate:

| Runs | Standard error |
|---:|---:|
| 10k | ±0.50 pts |
| 50k | ±0.22 pts |
| 100k | ±0.16 pts |

Doubling **50k → 100k** buys only **0.06 percentage points** of standard error improvement.

That was a marginal return for doubling the work.

By implementing Web Workers and decreasing the default workload to 50k runs, the large meta simulation could now finish in roughly **30–60 seconds** on my Framework 13 laptop, while still capping the pool at 8 workers.

---

## Version 2 — Parallel Monte Carlo Logic

The browser's main UI execution context is single-threaded. Heavy CPU simulation on that thread competes directly with DOM work and makes the page unresponsive.

Instead of rewriting the project in another language such as Java, Go, or Rust, I used **Web Workers** to move simulation work into separate execution contexts that can run in parallel while the main thread remains responsible for the UI.

Each worker does have its own V8 isolate, which introduces overhead, but with coarse work assignments the amount of useful computation per job is large enough to make that overhead worthwhile.

### Worker Pool Sizing

To support as many devices as possible, the worker pool ranges from **2 to 8 workers**, sized around:

```text
hardwareConcurrency − 1
```

The subtraction leaves compute capacity available for the main thread. The UI never shares a worker with simulation work, but without leaving room for UI execution, DOM work and simulation still compete for the same CPU resources and the page becomes less reactive under load.

The division of labor stays consistent:

- **Main thread:** UI + coordination
- **Workers:** simulation only

No worker performing simulation work touches the DOM.

### Dynamic Worker Scheduling — Inspired by Work Stealing

As I was creating this project, I was enrolled in a parallel algorithms course at my college. We used **ForkJoin**, a Java parallel-computing framework that uses work stealing to prevent threads from sitting idle while other threads still have work available.

What I built is a coarser cousin of that idea.

Jobs are dealt out round-robin at the start so every worker begins with an even share:

```text
distributeJobs
jobIndex % poolSize
```

Once a worker drains its share, it posts a `steal_request`. The coordinator can then hand back up to 16 additional jobs from one shared central queue on a first-come, first-served basis.

It is **not** ForkJoin's per-thread deque — there is one shared queue and one coordinator serving it — but it buys the same important property:

> No worker should sit idle while useful work is still available.

That matters because job cost varies by roughly **6× across the grid**. A fight at 5 m resolves in roughly 45 loop iterations, while one at 100 m takes closer to 287.

### Bigger Than the Threading: Worker Communication

The main method of inter-worker communication became **summary messages**.

Each finished job posts exactly one result back. A worker that runs dry posts a steal request.

Most importantly, I aggregate inside the worker so that:

> **Each job returns one summary — not 100,000 individual results.**

Without that decision, the system could attempt to move roughly 95 million structured-clone messages back through the browser. The messaging overhead would swamp the parallelism.

That became a bigger design decision than the threading itself.

### Reproducible Randomness

This is also where the `Math.random()` thread from Version 1 gets paid off.

The sampling engine now uses a seeded **xoshiro128\*\*** generator instead of `Math.random()`.

It was never a speed win — the earlier benchmark already showed that RNG was not the main bottleneck — but it made every run **reproducible**.

If a surprising cell appears in the heat map, I can replay the same simulation exactly.

---

## Version 3 — Exact Probabilistic Solver

Now this is the fun part of the project — where I tear apart my own assumptions and learn something new.

I assumed Monte Carlo simulation was my best strategy.

The simulation algorithm forced millions, and sometimes hundreds of millions, of individual fights just to preserve the pseudo-random nature of each simulation. At the same time, I was using such large sample counts specifically to eliminate statistical noise and outliers.

Those ideas started to conflict.

I was spending enormous amounts of compute to create randomness, then spending even more compute to average that randomness back out.

I needed to reconcile that.

---

## Dual-Engine Simulation

### Exact Probabilistic Solver

I implemented an **exact probability solver** that calculates combat outcomes directly instead of estimating them through repeated simulations.

It uses dynamic programming to propagate the probability mass of all relevant hit outcomes and derive exact kill-time and matchup probabilities **without sampling**.

It works because neither fighter reacts to being shot.

Nobody flinches, retreats, or stops firing at low health, so the two firing timelines never influence each other.

- *When* a fighter fires is fixed by the weapon.
- *Whether* each shot hits is an independent roll.

That means each side's kill-time distribution can be solved independently and then compared. Whoever's killing blow lands first wins.

> **Measured against the sampling engine on the same matchups: 1.4 ms of solver time replaces 1,514 ms of sampling — a 1,110× speedup.**
>
> The two engines agree within **0.4 percentage points** on every case in `tools/test_solver.mjs`.

### Why Keep Monte Carlo?

The sampler did not go away. It became the fallback.

`canSolveExactly()` checks whether a matchup breaks the exact solver's assumptions — for example:

- a fighter is moving, or
- out-of-combat regeneration depends on time since the last damage event.

Those cases are routed back to seeded Monte Carlo.

Having both engines is also what makes the speedup trustworthy: **the slow engine becomes the oracle that proves the fast engine did not change the answer.**

---

## Current Architecture

```text
                         Matchup / User Inputs
                                  │
                                  ▼
                         Can Solve Exactly?
                           /            \
                         Yes             No
                          │               │
                          ▼               ▼
                 Exact Probability   Seeded Monte Carlo
                      Solver             Workers
                          │               │
                          └───────┬───────┘
                                  ▼
                           Combat Results
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                  1v1           Meta         Sustain
               Simulator      Simulator      Simulator
```

---

## Engineering Decisions That Changed the Project

| Problem | First approach | Final direction | Why |
|---|---|---|---|
| Combat uncertainty | Monte Carlo sampling | Exact probability + Monte Carlo fallback | Avoid sampling when the model can be solved directly |
| Browser CPU load | Main-thread simulation | Web Workers | Keep CPU-heavy simulation away from UI execution |
| Uneven job cost | Static round-robin assignment | Dynamic shared job queue | Reduce worker idle time |
| Randomness | `Math.random()` | Seeded xoshiro128\*\* | Reproducible simulation runs |
| Worker output | Large potential result traffic | Per-job aggregation | Avoid messaging overhead overwhelming parallelism |
| Solver verification | Sampling only | Exact solver checked against seeded Monte Carlo | Preserve confidence that optimization did not change the model |

---

## Where This Leaves the Project

The exact solver has allowed me to expand the scope of the simulator beyond my original goals.

Raw compute is no longer the same obstacle it was in Version 1. That means I can start considering gadgets, healing items, and more complex combat interactions without every additional mechanic automatically multiplying into millions of extra simulated fights.

The project started as a weapon comparison tool.

It turned into a lesson in **profiling, parallelism, scheduling, statistical tradeoffs, reproducibility, probability modeling, and eventually questioning whether the original algorithm should exist at all.**
