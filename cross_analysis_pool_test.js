// ═══════════════════════════════════════════════════════════════════
// CROSS ANALYSIS ENGINE — Worker Pool + Work Stealing
//
// Drop-in replacement for runCrossAnalysis() and renderCrossAnalysis()
// in battle_simulator.js.
//
// Architecture:
//   - POOL_SIZE workers created once, reused across analyses
//   - All jobs pushed into a shared central queue (the "global deque")
//   - Each worker processes its batch then issues a steal_request
//   - Coordinator responds with remaining jobs, or no_work if empty
//   - Progress bar updates on every completed result
//   - Workers are terminated after each analysis run and recreated
//     next time (keeps memory clean; pool creation cost is negligible
//     vs the simulation work)
// ═══════════════════════════════════════════════════════════════════

const POOL_SIZE  = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const RUNS       = 100_000;
// Jobs are handed out in chunks so a steal request doesn't give a
// single-job trickle. Tune upward if inter-thread messaging becomes
// a bottleneck, downward for finer progress granularity.
const STEAL_CHUNK = 4;

// ── Distances and aim profiles ──
function getDistances() {
  return [0, 15, 25, 30, 50, 75, 100];
}

function getAimProfiles() {
  return [
    { name: 'Poor',    acc: 0.50, hs: 0.20 },
    { name: 'Average', acc: 0.75, hs: 0.35 },
    { name: 'Strong',  acc: 0.90, hs: 0.55 },
    { name: 'Elite',   acc: 0.99, hs: 0.80 }
  ];
}

// ── Job builder ──
// Produces the full cartesian product: every defender × distance × profile.
// Each job is a self-contained description; workers need no shared state.
// function buildJobs(attacker, weapons, distances, profiles, speedOverride, meleeAdv) {
//   const jobs = [];
//   let jobId  = 0;

//   weapons.forEach(defender => {
//     if (defender.name === attacker.name) return;
//     distances.forEach(distance => {
//       profiles.forEach(profile => {
//         jobs.push({
//           jobId: jobId++,
//           attacker,
//           defender,
//           distance,
//           profile,
//           runs: RUNS,
//           speedOverride,
//           meleeAdv,
//           acc: profile.acc,
//           hs: profile.hs
//         });
//       });
//     });
//   });

//   return jobs;
// }
function buildJobs(attacker, weapons, distances, profiles, speedOverride, meleeAdv, attackerAcc, attackerHs) {
  const jobs = [];
  let jobId  = 0;

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
// ── Initial job distribution ──
// Slice the full queue into POOL_SIZE roughly-equal chunks.
// Any remainder drips into the first worker's chunk.
function distributeJobs(jobs, poolSize) {
  const chunks = Array.from({ length: poolSize }, () => []);
  jobs.forEach((job, i) => chunks[i % poolSize].push(job));
  return chunks;
}

// ── Main entry point ──
function runCrossAnalysis() {
  const attackerIdx = parseInt(document.getElementById('p1-weapon').value);
  const attacker    = WEAPONS[attackerIdx];
  if (!attacker) return;

  const distances     = getDistances();
  const profiles      = getAimProfiles();
  const speedOverride = parseFloat(document.getElementById('speed').value);
  const meleeAdv      = document.getElementById('melee-advance').checked;

  const attackerAcc   = parseFloat(document.getElementById('p1-acc').value) / 100;
const attackerHs    = parseFloat(document.getElementById('p1-hs').value) / 100;

const allJobs = buildJobs(
  attacker,
  WEAPONS,
  distances,
  profiles,
  speedOverride,
  meleeAdv,
  attackerAcc,
  attackerHs
);
const totalJobs = allJobs.length;

  if (totalJobs === 0) return;

  // Central queue — shared reference, mutated as workers steal from it
  // Stored as a plain array; we pop() from the tail (O(1)).
  // The queue is reversed so the first jobs are at the tail for pop().
  const globalQueue = [...allJobs].reverse();

  // Results accumulator
  const results     = new Array(totalJobs);
  let   completedJobs = 0;

  // ── UI setup ──
  const btn       = document.getElementById('cross-btn');
  const container = document.getElementById('cross-table');
  if (btn) btn.disabled = true;

  container.innerHTML = `
    <div style="padding:20px;">
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;letter-spacing:2px;
                  text-transform:uppercase;color:var(--muted);margin-bottom:10px;">
        RUNNING CROSS ANALYSIS — ${POOL_SIZE} WORKERS · ${totalJobs.toLocaleString()} SCENARIOS · ${RUNS.toLocaleString()} RUNS EACH
      </div>
      <div style="height:6px;background:var(--border);overflow:hidden;margin-bottom:8px;">
        <div id="ca-progress-bar"
             style="height:100%;width:0%;background:var(--accent);transition:width .1s linear;"></div>
      </div>
      <div id="ca-progress-label"
           style="font-size:10px;color:var(--muted);letter-spacing:1px;">
        0 / ${totalJobs.toLocaleString()} scenarios complete
        · <span id="ca-worker-label">${POOL_SIZE} workers active</span>
      </div>
    </div>
  `;

  // Switch to the cross tab immediately so the user sees progress
  const crossTabBtn = document.querySelector('[onclick*="cross"]');
  if (crossTabBtn) switchTab('cross', crossTabBtn);

  const progressBar   = document.getElementById('ca-progress-bar');
  const progressLabel = document.getElementById('ca-progress-label');
  const workerLabel   = document.getElementById('ca-worker-label');

  function updateProgress() {
    const pct = (completedJobs / totalJobs * 100).toFixed(1);
    if (progressBar)   progressBar.style.width = pct + '%';
    if (progressLabel) progressLabel.textContent =
      `${completedJobs.toLocaleString()} / ${totalJobs.toLocaleString()} scenarios complete`;
  }

  // ── Worker pool ──
  let activeWorkers = POOL_SIZE;
  const workers     = [];

  // Called when a worker posts steal_request.
  // Hands off up to STEAL_CHUNK jobs, or signals no_work.
  function handleStealRequest(worker) {
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
      if (workerLabel) workerLabel.textContent = `${activeWorkers} workers active`;
      this.terminate();

      if (activeWorkers === 0) {
        // All workers finished — render
        if (btn) btn.disabled = false;
        renderCrossAnalysis(results.filter(Boolean));
      }
    }
  }

  // Create workers, assign initial chunks
  const chunks = distributeJobs(allJobs, POOL_SIZE);

  for (let i = 0; i < POOL_SIZE; i++) {
    // Worker script must be served from same origin.
    // Adjust path to match your deployment layout.
    const w = new Worker('./cross_analysis_worker.js');
    w.onmessage = onWorkerMessage.bind(w);
    w.onerror   = (err) => console.error(`Worker ${i} error:`, err);
    workers.push(w);

    // Remove the initial chunk from the global queue so it isn't
    // double-assigned if a worker steals before finishing its own batch.
    // (chunks are sliced from allJobs, not from globalQueue, so there's
    // no overlap — but we still drain globalQueue by the same count to
    // keep accounting consistent.)
    const jobsToSend = chunks[i];
    // Drain equivalent entries from the tail of globalQueue
    for (let j = 0; j < jobsToSend.length; j++) globalQueue.pop();

    w.postMessage({ type: 'jobs', jobs: jobsToSend });
  }
}

// ═══════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════

function classifyMatchup(winRate) {
  if (winRate >= 0.6) return 'favorable';
  if (winRate >= 0.4) return 'even';
  return 'unfavorable';
}

function renderCrossAnalysis(results) {
  const container = document.getElementById('cross-table');
  if (!container) return;

  // ── Group by defender for summary rows ──
  const byDefender = {};
  results.forEach(r => {
    if (!byDefender[r.defender]) {
      byDefender[r.defender] = { class: r.class, rows: [] };
    }
    byDefender[r.defender].rows.push(r);
  });

  // ── Compute per-defender summary (overall win rate across all combos) ──
  function summarise(rows) {
    const totalWins  = rows.reduce((s, r) => s + r.wins,  0);
    const totalGames = rows.reduce((s, r) => s + r.total, 0);
    const winRate    = totalGames > 0 ? totalWins / totalGames : 0;

    const ttkEntries = rows.filter(r => r.avgAttackerTTK != null);
    const avgTTK     = ttkEntries.length
      ? ttkEntries.reduce((s, r) => s + r.avgAttackerTTK, 0) / ttkEntries.length
      : null;

    // Best and worst distance by win rate
    const byDist = {};
    rows.forEach(r => {
      if (!byDist[r.distance]) byDist[r.distance] = [];
      byDist[r.distance].push(r.winRate);
    });
    let bestDist = null, bestWR = -1, worstDist = null, worstWR = 2;
    Object.entries(byDist).forEach(([d, wrs]) => {
      const avg = wrs.reduce((a, b) => a + b) / wrs.length;
      if (avg > bestWR)  { bestWR  = avg; bestDist  = d; }
      if (avg < worstWR) { worstWR = avg; worstDist = d; }
    });

    return { winRate, avgTTK, bestDist, worstDist, result: classifyMatchup(winRate) };
  }

  // ── Sort defenders: favorable first, then even, then unfavorable ──
  const ORDER = { favorable: 0, even: 1, unfavorable: 2 };
  const sorted = Object.entries(byDefender).sort(([, a], [, b]) => {
    const sa = summarise(a.rows), sb = summarise(b.rows);
    return ORDER[sa.result] - ORDER[sb.result] || sb.winRate - sa.winRate;
  });

  // ── Build HTML ──
  const clsColor = { light: 'var(--light-cl)', medium: 'var(--med-cl)', heavy: 'var(--heavy-cl)' };

  let html = `
    <div style="padding:12px 14px;border-bottom:1px solid var(--border);
                font-family:'Barlow Condensed',sans-serif;font-size:11px;
                letter-spacing:2px;text-transform:uppercase;color:var(--muted);">
      CROSS ANALYSIS COMPLETE ·
      <span style="color:var(--green)">${results.filter(r=>r.result==='favorable').length} FAVORABLE</span> ·
      <span style="color:var(--accent)">${results.filter(r=>r.result==='even').length} EVEN</span> ·
      <span style="color:var(--red)">${results.filter(r=>r.result==='unfavorable').length} UNFAVORABLE</span>
      · ${RUNS.toLocaleString()} RUNS / SCENARIO
    </div>
    <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead>
        <tr style="background:var(--card);border-bottom:2px solid var(--border);">
          <th style="padding:8px 12px;text-align:left;font-size:9px;letter-spacing:2px;color:var(--muted);">DEFENDER</th>
          <th style="padding:8px 12px;text-align:left;font-size:9px;letter-spacing:2px;color:var(--muted);">CLASS</th>
          <th style="padding:8px 12px;text-align:left;font-size:9px;letter-spacing:2px;color:var(--muted);">DIST</th>
          <th style="padding:8px 12px;text-align:left;font-size:9px;letter-spacing:2px;color:var(--muted);">PROFILE</th>
          <th style="padding:8px 12px;text-align:right;font-size:9px;letter-spacing:2px;color:var(--muted);">WIN%</th>
          <th style="padding:8px 12px;text-align:right;font-size:9px;letter-spacing:2px;color:var(--blue);">ATK TTK</th>
          <th style="padding:8px 12px;text-align:right;font-size:9px;letter-spacing:2px;color:var(--red);">DEF TTK</th>
          <th style="padding:8px 12px;text-align:left;font-size:9px;letter-spacing:2px;color:var(--muted);">RESULT</th>
        </tr>
      </thead>
      <tbody>
  `;

  sorted.forEach(([defName, defData]) => {
    const summary = summarise(defData.rows);
    const sumColor =
      summary.result === 'favorable'   ? 'var(--green)' :
      summary.result === 'unfavorable' ? 'var(--red)'   : 'var(--accent)';

    // ── Summary row ──
    html += `
      <tr style="background:var(--card);border-top:2px solid var(--border);cursor:pointer;"
          onclick="this.nextElementSibling && (this.nextElementSibling.style.display =
            this.nextElementSibling.style.display === 'none' ? '' : 'none')">
        <td colspan="2" style="padding:10px 12px;font-family:'Barlow Condensed',sans-serif;
                                font-size:15px;font-weight:700;letter-spacing:1px;color:${sumColor};">
          ▶ ${defName}
        </td>
        <td style="padding:10px 12px;font-size:9px;letter-spacing:1px;color:var(--muted);">
          <span style="padding:1px 6px;border:1px solid ${clsColor[defData.class]};
                       color:${clsColor[defData.class]};font-size:9px;">
            ${defData.class.toUpperCase()}
          </span>
        </td>
        <td style="padding:10px 12px;font-size:9px;color:var(--muted);">
          BEST ${summary.bestDist}m · WORST ${summary.worstDist}m
        </td>
        <td style="padding:10px 12px;text-align:right;font-family:'Barlow Condensed',sans-serif;
                   font-size:18px;font-weight:700;color:${sumColor};">
          ${(summary.winRate * 100).toFixed(1)}%
        </td>
        <td style="padding:10px 12px;text-align:right;color:var(--blue);">
          ${summary.avgTTK != null ? summary.avgTTK.toFixed(2) + 's' : '—'}
        </td>
        <td colspan="2" style="padding:10px 12px;text-align:right;font-family:'Barlow Condensed',sans-serif;
                                font-size:13px;font-weight:700;letter-spacing:2px;color:${sumColor};">
          ${summary.result.toUpperCase()} ▼
        </td>
      </tr>
    `;

    // ── Detail rows (collapsible, starts hidden) ──
    html += `
      <tr style="display:none;">
        <td colspan="8" style="padding:0;">
          <table style="width:100%;border-collapse:collapse;">
            <tr style="background:var(--card);border-bottom:1px solid var(--border);">
              <td style="padding:5px 12px 5px 32px;font-size:9px;letter-spacing:2px;color:var(--muted);width:90px;">DIST</td>
              <td colspan="2"></td>
              <td style="padding:5px 12px;font-size:9px;letter-spacing:2px;color:var(--muted);">PROFILE</td>
              <td style="padding:5px 12px;text-align:right;font-size:9px;letter-spacing:2px;color:var(--muted);">WIN%</td>
              <td style="padding:5px 12px;text-align:right;font-size:9px;letter-spacing:2px;color:var(--blue);">ATK TTK</td>
              <td style="padding:5px 12px;text-align:right;font-size:9px;letter-spacing:2px;color:var(--red);">DEF TTK</td>
              <td style="padding:5px 12px;font-size:9px;letter-spacing:2px;color:var(--muted);">RESULT</td>
            </tr>
    `;

    const distances = [...new Set(defData.rows.map(r => r.distance))].sort((a, b) => a - b);

    distances.forEach(dist => {
      const distRows = defData.rows.filter(r => r.distance === dist);
      const distWR   = distRows.reduce((s, r) => s + r.winRate, 0) / distRows.length;
      const distColor =
        distWR >= 0.6 ? 'var(--green)' : distWR >= 0.4 ? 'var(--accent)' : 'var(--red)';

      html += `
        <tr style="background:var(--bg);border-top:1px solid var(--border);">
          <td style="padding:6px 12px 6px 24px;font-size:9px;letter-spacing:2px;
                     color:${distColor};width:90px;">@ ${dist}m</td>
          <td colspan="7"></td>
        </tr>
      `;

      distRows.forEach(r => {
        console.log('R OBJECT:', r);
        const rowColor =
          r.result === 'favorable'   ? 'var(--green)' :
          r.result === 'unfavorable' ? 'var(--red)'   : 'var(--accent)';

        html += `
          <tr style="border-top:1px solid var(--border);opacity:0.85;">
            <td style="padding:5px 12px 5px 32px;color:var(--muted);font-size:10px;"></td>
            <td style="padding:5px 12px;"></td>
            <td style="padding:5px 12px;color:var(--muted);font-size:10px;"></td>
            <td style="padding:5px 12px;font-size:10px;letter-spacing:1px;color:var(--white);">You ${(r.attackerAcc * 100).toFixed(0)}% / ${(r.attackerHs * 100).toFixed(0)}% HS
              vs ${r.profile}
              | Opp ${(r.defenderAcc * 100).toFixed(0)}% / ${(r.defenderHs * 100).toFixed(0)}% HS</td>
            <td style="padding:5px 12px;text-align:right;font-family:'Barlow Condensed',sans-serif;
                       font-size:15px;font-weight:700;color:${rowColor};">
              ${(r.winRate * 100).toFixed(1)}%
            </td>
            <td style="padding:5px 12px;text-align:right;color:var(--blue);font-size:10px;">
              ${r.avgAttackerTTK != null ? r.avgAttackerTTK.toFixed(2) + 's' : '—'}
            </td>
            <td style="padding:5px 12px;text-align:right;color:var(--red);font-size:10px;">
              ${r.avgDefenderTTK != null ? r.avgDefenderTTK.toFixed(2) + 's' : '—'}
            </td>
            <td style="padding:5px 12px;font-size:9px;letter-spacing:1px;color:${rowColor};">
              ${r.result.toUpperCase()}
            </td>
          </tr>
        `;
      });   

    });

    html += `</table></td></tr>`;
  });

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}   
