// ═══════════════════════════════════════
// HEAT GRAPH RENDERER
// Cross-analysis heatmap view
// Hovering a cell shows the profile breakdown that makes up the average.
// ═══════════════════════════════════════

(function () {
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function esc(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function average(nums) {
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

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

  function textColorForBg(winRate) {
    return winRate >= 0.42 && winRate <= 0.68 ? '#111' : '#fff';
  }

  function buildFilterOptions(results) {
    const classes = [...new Set(results.map(r => r.class).filter(Boolean))].sort();
    const profiles = [...new Set(results.map(r => r.profile).filter(Boolean))].sort();
    return { classes, profiles };
  }

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

  function getFirstNumber(obj, keys) {
    for (const key of keys) {
      const val = obj?.[key];
      if (typeof val === 'number' && Number.isFinite(val)) return val;
      if (typeof val === 'string' && val.trim() !== '' && !Number.isNaN(Number(val))) {
        return Number(val);
      }
    }
    return null;
  }

  function normalizePercent(val) {
    if (val == null || !Number.isFinite(val)) return null;
    return val <= 1 ? val * 100 : val;
  }

  function formatPercent(val, digits = 0) {
    const pct = normalizePercent(val);
    return pct == null ? '—' : `${pct.toFixed(digits)}%`;
  }

  function formatSeconds(val) {
    return val == null || !Number.isFinite(val) ? '—' : `${val.toFixed(2)}s`;
  }

  function getProfileDefaults(profileName) {
    if (typeof getAimProfiles !== 'function') return { accuracy: null, headshot: null };

    const profiles = getAimProfiles();
    const match = profiles.find(p =>
      String(p.name).toLowerCase() === String(profileName || '').toLowerCase()
    );

    if (!match) return { accuracy: null, headshot: null };

    return {
      accuracy: match.acc,
      headshot: match.hs
    };
  }

  function getProfileAccuracy(matchGroup) {
    const sample = matchGroup?.[0];
    if (!sample) return null;

    const direct = getFirstNumber(sample, [
      'accuracy',
      'acc',
      'attackerAccuracy',
      'profileAccuracy',
      'p1acc',
      'aimAccuracy'
    ]);

    if (direct != null) return direct;

    return getProfileDefaults(sample.profile).accuracy;
  }

  function getProfileHeadshot(matchGroup) {
    const sample = matchGroup?.[0];
    if (!sample) return null;

    const direct = getFirstNumber(sample, [
      'headshot',
      'headshotChance',
      'headshotRate',
      'hs',
      'attackerHeadshot',
      'profileHeadshot',
      'p1hs',
      'hsRate'
    ]);

    if (direct != null) return direct;

    return getProfileDefaults(sample.profile).headshot;
  }

  function buildProfileBreakdown(matches) {
    const grouped = {};

    matches.forEach(r => {
      const key = r.profile || 'Unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(r);
    });

    return Object.keys(grouped)
      .sort((a, b) => a.localeCompare(b))
      .map(profile => {
        const group = grouped[profile];
        return {
          profile,
          accuracy: getProfileAccuracy(group),
          headshot: getProfileHeadshot(group),
          winRate: average(group.map(r => r.winRate).filter(v => v != null)),
          avgAttackerTTK: average(group.map(r => r.avgAttackerTTK).filter(v => v != null)),
          avgDefenderTTK: average(group.map(r => r.avgDefenderTTK).filter(v => v != null)),
          count: group.length
        };
      });
  }

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

  function getRowFavorabilityScore(cells) {
    const winRates = cells
      .map(cell => cell.winRate)
      .filter(v => v != null && Number.isFinite(v));

    if (!winRates.length) return -1;
    return average(winRates);
  }

  function sortGroupedRows(grouped, distances, profileFilter, sortMode) {
    const rowsWithMeta = grouped.map(group => {
      const cells = buildHeatCells(group.items, distances, profileFilter);
      return {
        ...group,
        cells,
        favorability: getRowFavorabilityScore(cells)
      };
    });

    if (sortMode === 'fav-desc') {
      rowsWithMeta.sort((a, b) => {
        if (b.favorability !== a.favorability) return b.favorability - a.favorability;
        return a.defender.localeCompare(b.defender);
      });
    } else if (sortMode === 'fav-asc') {
      rowsWithMeta.sort((a, b) => {
        if (a.favorability !== b.favorability) return a.favorability - b.favorability;
        return a.defender.localeCompare(b.defender);
      });
    } else {
      rowsWithMeta.sort((a, b) => a.defender.localeCompare(b.defender));
    }

    return rowsWithMeta;
  }

  function buildLegend() {
    return `
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0 18px 0;">
        <span style="font-size:12px;letter-spacing:1px;color:var(--muted);">LOW WR</span>
        <div style="
          flex:1;
          height:12px;
          border:1px solid var(--border);
          background:linear-gradient(to right,
            rgb(220,70,70) 0%,
            rgb(220,180,70) 50%,
            rgb(70,210,70) 100%);
        "></div>
        <span style="font-size:12px;letter-spacing:1px;color:var(--muted);">HIGH WR</span>
      </div>
    `;
  }

  function buildTooltipHtml(cell) {
    if (!cell.profiles?.length) return '';

    const rows = cell.profiles.map(p => {
      return `
        <div style="
          border:1px solid rgba(255,255,255,0.08);
          background:rgba(255,255,255,0.03);
          border-radius:8px;
          padding:8px 9px;
          min-width:0;
        ">
          <div style="
            font-size:12px;
            font-weight:700;
            color:#fff;
            margin-bottom:6px;
            letter-spacing:0.4px;
          ">
            ${esc(p.profile)}
          </div>

          <div style="
            display:grid;
            grid-template-columns:1fr auto;
            gap:4px 10px;
            font-size:11px;
            line-height:1.25;
            color:rgba(255,255,255,0.92);
          ">
            <div>Win Rate</div>
            <div style="font-weight:700;">${formatPercent(p.winRate, 1)}</div>

            <div>Your Avg TTK</div>
            <div style="font-weight:700;">${formatSeconds(p.avgAttackerTTK)}</div>

            <div>Enemy Avg TTK</div>
            <div style="font-weight:700;">${formatSeconds(p.avgDefenderTTK)}</div>

            <div>Accuracy %</div>
            <div style="font-weight:700;">${formatPercent(p.accuracy, 0)}</div>

            <div>Headshot %</div>
            <div style="font-weight:700;">${formatPercent(p.headshot, 0)}</div>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="heatgraph-tooltip" style="
        position:absolute;
        left:50%;
        top:calc(100% + 8px);
        transform:translateX(-50%);
        width:620px;
        max-width:min(620px, 92vw);
        background:rgba(10,12,18,0.98);
        border:1px solid rgba(255,255,255,0.14);
        border-radius:10px;
        box-shadow:0 14px 36px rgba(0,0,0,0.45);
        padding:12px;
        z-index:9999;
        opacity:0;
        visibility:hidden;
        pointer-events:none;
        transition:opacity 0.14s ease, visibility 0.14s ease;
      ">
        <div style="
          font-size:13px;
          font-weight:800;
          color:#fff;
          margin-bottom:8px;
          letter-spacing:0.4px;
        ">
          Why this cell averages to ${formatPercent(cell.winRate, 1)}
        </div>

        <div style="
          font-size:11px;
          line-height:1.35;
          color:rgba(255,255,255,0.78);
          margin-bottom:10px;
        ">
          Each box is one aim profile used in the simulation.
          <strong style="color:#fff;">Accuracy %</strong> means how often shots land.
          <strong style="color:#fff;">Headshot %</strong> means how often landed shots become headshots.
        </div>

        <div style="
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:8px;
        ">
          ${rows}
        </div>
      </div>
    `;
  }

  function renderHeatGraph(results, mountId = 'cross-table') {
    console.log("🔥 HeatGraph INIT");
    console.log("📦 Incoming results:", results?.length);
    console.log("📍 Mount ID:", mountId);

    const mount = document.getElementById(mountId);
    console.log("📌 Mount element:", mount);

    if (!mount) return;
    if (!results || !results.length) {
      mount.innerHTML = `<div style="padding:16px;color:var(--muted);">No cross-analysis results to graph.</div>`;
      return;
    }

    const distances = [...new Set(results.map(r => r.distance))].sort((a, b) => a - b);
    const { classes, profiles } = buildFilterOptions(results);

    console.log("📏 Distances:", distances);
    console.log("🎯 Classes:", classes);
    console.log("🎯 Profiles:", profiles);

    const bodyId = 'heatgraph-body';

    function draw() {
      console.log("🎨 DRAW CALLED");

      const sortFilter = document.getElementById('heat-sort-filter')?.value || 'fav-desc';
      const classFilter = document.getElementById('heat-class-filter')?.value || '';
      const profileFilter = document.getElementById('heat-profile-filter')?.value || '';

      console.log("🔎 Filters:", {
        classFilter,
        profileFilter,
        sortFilter
      });

      const filtered = results.filter(r => {
        if (classFilter && r.class !== classFilter) return false;
        return true;
      });

      console.log("📉 Filtered results:", filtered.length);

      const grouped = groupRows(filtered);
      const sortedGrouped = sortGroupedRows(grouped, distances, profileFilter, sortFilter);

      console.log("📊 Grouped defenders:", sortedGrouped.length);

      let rowsHtml = sortedGrouped.map(group => {
        console.log("🧱 Rendering row:", group.defender, "| items:", group.items.length);

        const cells = group.cells;

        const cellHtml = cells.map(cell => {
          console.log("🟦 Cell:", {
            distance: cell.distance,
            winRate: cell.winRate,
            count: cell.count,
            profiles: cell.profiles?.length || 0
          });

          if (cell.winRate == null) {
            return `
              <td style="
                border:1px solid var(--border);
                background:rgba(255,255,255,0.03);
                color:var(--muted);
                text-align:center;
                padding:10px 8px;
                min-width:88px;
                height:64px;
                font-size:12px;
              ">—</td>
            `;
          }

          const bg = winRateColor(cell.winRate);
          const fg = textColorForBg(cell.winRate);
          const wr = (cell.winRate * 100).toFixed(1);
          const ttk = cell.avgAttackerTTK != null ? `${cell.avgAttackerTTK.toFixed(2)}s` : '—';
          const defTtk = cell.avgDefenderTTK != null ? `${cell.avgDefenderTTK.toFixed(2)}s` : '—';

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
        }).join('');

        return `
          <tr>
            <td style="
              position:sticky;
              left:0;
              z-index:1;
              background:var(--card);
              border:1px solid var(--border);
              padding:10px 12px;
              min-width:220px;
            ">
              <div style="font-size:14px;font-weight:700;color:var(--white);">${esc(group.defender)}</div>
              <div style="font-size:11px;letter-spacing:1px;color:var(--muted);text-transform:uppercase;">
                ${esc(group.class)}
              </div>
            </td>
            ${cellHtml}
          </tr>
        `;
      }).join('');

      if (!rowsHtml) {
        rowsHtml = `
          <tr>
            <td colspan="${distances.length + 1}" style="padding:18px;color:var(--muted);text-align:center;">
              No rows match current filters.
            </td>
          </tr>
        `;
      }

      document.getElementById(bodyId).innerHTML = `
        <style>
          #${bodyId} td:hover > .heatgraph-tooltip,
          #${bodyId} td:focus-within > .heatgraph-tooltip {
            opacity: 1 !important;
            visibility: visible !important;
          }

          @media (max-width: 900px) {
            #${bodyId} .heatgraph-tooltip {
              width: min(92vw, 520px) !important;
            }
          }

          @media (max-width: 640px) {
            #${bodyId} .heatgraph-tooltip {
              width: min(94vw, 420px) !important;
            }

            #${bodyId} .heatgraph-tooltip > div:last-child {
              grid-template-columns: 1fr !important;
            }
          }
        </style>

        ${buildLegend()}

        <div style="overflow:auto;border:1px solid var(--border);background:var(--bg);">
          <table style="border-collapse:collapse;width:max-content;min-width:100%;">
            <thead>
              <tr>
                <th style="
                  position:sticky;
                  left:0;
                  z-index:2;
                  background:var(--card);
                  border:1px solid var(--border);
                  padding:10px 12px;
                  min-width:220px;
                  text-align:left;
                  color:var(--muted);
                  letter-spacing:1px;
                ">DEFENDER</th>
                ${distances.map(dist => `
                  <th style="
                    background:var(--card);
                    border:1px solid var(--border);
                    padding:10px 8px;
                    min-width:88px;
                    text-align:center;
                    color:var(--muted);
                    letter-spacing:1px;
                  ">${dist}m</th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      `;
    }

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

    document.getElementById('heat-class-filter')?.addEventListener('change', draw);
    document.getElementById('heat-profile-filter')?.addEventListener('change', draw);
    document.getElementById('heat-sort-filter')?.addEventListener('change', draw);

    draw();
  }

  window.renderHeatGraph = renderHeatGraph;
})();