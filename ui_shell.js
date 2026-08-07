// ═══════════════════════════════════════════════════════════════════
// UI SHELL — view router, weapon stats browser, meta-analysis controls
//
// The simulation itself lives in simulate.js / battle_simulator.js.
// This file only owns the surrounding application: which screen is
// visible, the stats reference table, and the Meta Simulation panel
// that drives cross_analysis_pool.js.
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Routes ────────────────────────────────────────────────────────
  const ROUTES = {
    home:   { view: 'view-home',   title: 'Combat Simulator v2.0',           nav: null   },
    help:   { view: 'view-help',   title: 'Help — how the model works',       nav: 'help' },
    stats:  { view: 'view-stats',  title: 'Weapon / Gadget Stats',            nav: 'stats'},
    weapon: { view: 'view-weapon', title: 'Weapon history',                   nav: 'stats'},
    sim:    { view: 'view-sim',    title: '1v1 Simulation — visual mode',     nav: 'sim'  },
    meta:   { view: 'view-meta',   title: 'Meta Simulation — cross analysis', nav: 'meta' }
  };

  let currentRoute = 'home';
  let currentParams = [];

  // Hash routes are `#/name` plus optional segments, e.g. `#/weapon/93r/8.3.0`.
  function routeFromHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '').trim();
    const [name, ...params] = raw.split('/').filter(Boolean).map(decodeURIComponent);
    return ROUTES[name] ? { name, params } : { name: 'home', params: [] };
  }

  function hashFor(route, params) {
    return '#/' + [route, ...params].map(encodeURIComponent).join('/');
  }

  function navigate(route, { push = true, params = [] } = {}) {
    if (!ROUTES[route]) { route = 'home'; params = []; }

    Object.entries(ROUTES).forEach(([name, cfg]) => {
      const el = document.getElementById(cfg.view);
      if (!el) return;
      const active = name === route;
      el.classList.toggle('active', active);
      el.hidden = !active;
    });

    document.querySelectorAll('.navbtn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.route === ROUTES[route].nav);
    });

    document.body.classList.toggle('at-home', route === 'home');
    const subtitle = document.getElementById('view-subtitle');
    if (subtitle) subtitle.textContent = ROUTES[route].title;

    currentRoute = route;
    currentParams = params;
    const wanted = hashFor(route, params);
    if (push && location.hash !== wanted) location.hash = wanted;

    window.scrollTo(0, 0);
    onRouteEntered(route, params);
  }

  // The arena canvas sizes itself from its parent, which has no width while
  // the simulation view is hidden — so re-measure and repaint on entry.
  function redrawArena() {
    if (typeof resizeCanvas !== 'function') return;
    resizeCanvas();
    if (typeof simFrames !== 'undefined' && simFrames.length && typeof drawFrame === 'function') {
      drawFrame(simFrames[Math.min(frameIdx, simFrames.length - 1)]);
    } else if (typeof drawIdle === 'function') {
      drawIdle();
    }
  }

  function onRouteEntered(route, params = []) {
    if (route === 'home') renderKillTimeChart();
    if (route === 'sim') redrawArena();
    if (route === 'stats') { renderStatsTable(); loadTimeline().then(t => { if (t && currentRoute === 'stats') renderStatsTable(); }); }
    if (route === 'meta') updateMetaEstimate();
    if (route === 'weapon') renderWeaponPage(params[0], params[1]);
  }

  // Any element with data-route acts as a link.
  document.addEventListener('click', e => {
    const target = e.target.closest('[data-route]');
    if (!target) return;
    e.preventDefault();
    navigate(target.dataset.route);
  });

  document.getElementById('brand-home')?.addEventListener('click', () => navigate('home'));

  window.addEventListener('hashchange', () => {
    const { name, params } = routeFromHash();
    navigate(name, { push: false, params });
  });

  // Weapon name cells in the stats table open that weapon's history.
  document.addEventListener('click', e => {
    const link = e.target.closest('[data-weapon]');
    if (!link) return;
    e.preventDefault();
    navigate('weapon', { params: [link.dataset.weapon] });
  });

  // Escape backs out to the menu (unless the user is typing).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || currentRoute === 'home') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    navigate('home');
  });

  // ═════════════════════════════════════════════════════════════════
  // DERIVED WEAPON NUMBERS
  // Mirrors the firing loop in simulate.js so the table and the
  // simulation never disagree.
  // ═════════════════════════════════════════════════════════════════
  // WEAPONS is a top-level `let` in battle_simulator.js — reachable as a
  // global binding, but never as a window property.
  function weapons() {
    return typeof WEAPONS !== 'undefined' && Array.isArray(WEAPONS) ? WEAPONS : [];
  }

  function statsFor(w) {
    return typeof getStats === 'function' ? getStats(w) : null;
  }

  // Time from the first shot to the nth shot, honouring burst delays
  // and forced reloads. Returns seconds.
  function timeToNthShot(s, n) {
    if (n <= 1) return 0;
    let t = 0;
    let burst = 0;
    const mag = s.magSize != null ? s.magSize : Infinity;
    let left = mag;

    for (let i = 1; i < n; i++) {
      left--;
      if (left <= 0 && mag !== Infinity) {
        t += s.emptyReload || s.tacticalReload || 0;
        left = mag;
        burst = 0;
      } else if (s.isBurst) {
        burst++;
        if (burst < s.bSize) {
          t += s.interval;
        } else {
          burst = 0;
          t += s.bDelay + s.interval;
        }
      } else {
        t += s.interval;
      }
    }
    return t;
  }

  function idealTTK(w, hp) {
    const s = statsFor(w);
    if (!s || !s.bodyDmg) return null;
    const shots = Math.ceil(hp / s.bodyDmg);
    return timeToNthShot(s, shots);
  }

  // Sustained body-shot DPS: damage of a full magazine over the time
  // it takes to empty and reload it.
  function sustainedDPS(w) {
    const s = statsFor(w);
    if (!s || !s.bodyDmg) return null;
    const mag = s.magSize != null ? s.magSize : 30;
    const fireTime = timeToNthShot(s, mag) + s.interval;
    const cycle = fireTime + (s.magSize != null ? (s.emptyReload || s.tacticalReload || 0) : 0);
    return cycle > 0 ? (s.bodyDmg * mag) / cycle : null;
  }

  function dropoffText(w) {
    if (!w.damage_dropoff_min_range || !w.damage_dropoff_max_range) return '—';
    const red = w.damage_reduction_at_max;
    const pct = red == null ? null : Math.round(parseFloat(String(red).replace(/[~%]/g, '')) * (parseFloat(red) <= 1 ? 100 : 1));
    return `${w.damage_dropoff_min_range}–${w.damage_dropoff_max_range}m` + (pct != null ? ` (−${pct}%)` : '');
  }

  // ═════════════════════════════════════════════════════════════════
  // STATS TABLE
  // ═════════════════════════════════════════════════════════════════
  const COLUMNS = [
    { key: 'name',   label: 'Weapon',  align: 'left',  get: w => w.name,
      fmt: v => {
        const id = weaponIdFor(v);
        return id
          ? `<button class="weapon-link" type="button" data-weapon="${esc(id)}" title="Stat history for ${esc(v)}">${esc(v)}</button>`
          : esc(v);
      }, html: true },
    { key: 'class',  label: 'Class',   align: 'left',  get: w => w.class,                   fmt: v => `<span class="cls ${v}">${v.toUpperCase()}</span>`, html: true },
    { key: 'type',   label: 'Type',    align: 'left',  get: w => w.type || '—',             fmt: v => v },
    { key: 'mode',   label: 'Mode',    align: 'left',  get: w => w.firing_mode || '—',      fmt: v => v },
    { key: 'body',   label: 'Body',    align: 'right', get: w => num(w.body_dmg),           fmt: v => fmt(v, 0) },
    { key: 'head',   label: 'Head',    align: 'right', get: w => num(w.head_damage),        fmt: v => fmt(v, 0) },
    { key: 'rpm',    label: 'RPM',     align: 'right', get: w => num(w.rpm),                fmt: v => fmt(v, 0) },
    { key: 'mag',    label: 'Mag',     align: 'right', get: w => num(w.magazine_size),      fmt: v => fmt(v, 0) },
    { key: 'reload', label: 'Reload',  align: 'right', get: w => num(w.empty_reload_time) ?? num(w.tactical_reload_time), fmt: v => v == null ? '—' : v.toFixed(2) + 's' },
    { key: 'drop',   label: 'Dropoff', align: 'left',  get: w => dropoffText(w),            fmt: v => v },
    { key: 'dps',    label: 'DPS',     align: 'right', get: w => sustainedDPS(w),           fmt: v => v == null ? '—' : v.toFixed(0), derived: true },
    { key: 'ttkL',   label: 'TTK 150', align: 'right', get: w => idealTTK(w, 150),          fmt: v => v == null ? '—' : v.toFixed(2) + 's', derived: true },
    { key: 'ttkM',   label: 'TTK 250', align: 'right', get: w => idealTTK(w, 250),          fmt: v => v == null ? '—' : v.toFixed(2) + 's', derived: true },
    { key: 'ttkH',   label: 'TTK 350', align: 'right', get: w => idealTTK(w, 350),          fmt: v => v == null ? '—' : v.toFixed(2) + 's', derived: true }
  ];

  function num(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).match(/[\d.]+/)?.[0]);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(v, digits) {
    return v == null ? '—' : v.toFixed(digits);
  }

  function esc(str) {
    return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  let sortKey = 'name';
  let sortDir = 1;

  function renderStatsHead() {
    const head = document.getElementById('stats-head');
    if (!head) return;
    head.innerHTML = '<tr>' + COLUMNS.map(c => {
      const arrow = sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
      const cls = [
        'th',
        c.align === 'right' ? 'right' : '',
        c.derived ? 'derived' : '',
        sortKey === c.key ? 'sorted' : ''
      ].filter(Boolean).join(' ');
      return `<th class="${cls}" data-sort="${c.key}">${c.label}${arrow}</th>`;
    }).join('') + '</tr>';

    head.querySelectorAll('th').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = 1; }
        renderStatsTable();
      });
    });
  }

  function renderStatsTable() {
    const body = document.getElementById('stats-body');
    const countEl = document.getElementById('stats-count');
    if (!body) return;

    const all = weapons();
    if (all.length === 0) {
      body.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="table-empty">Loading weapon data…</td></tr>`;
      if (countEl) countEl.textContent = '—';
      return;
    }

    const search = (document.getElementById('stats-search')?.value || '').toLowerCase().trim();
    const clsFilter = document.getElementById('stats-class')?.value || '';
    const typeFilter = document.getElementById('stats-type')?.value || '';

    const rows = all.filter(w =>
      (!clsFilter || w.class === clsFilter) &&
      (!typeFilter || w.type === typeFilter) &&
      (!search || w.name.toLowerCase().includes(search))
    );

    const col = COLUMNS.find(c => c.key === sortKey) || COLUMNS[0];
    rows.sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;   // blanks always sink
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sortDir;
      return String(va).localeCompare(String(vb)) * sortDir;
    });

    body.innerHTML = rows.length
      ? rows.map(w => '<tr>' + COLUMNS.map(c => {
          const cls = [c.align === 'right' ? 'right' : '', c.derived ? 'derived' : ''].filter(Boolean).join(' ');
          const rendered = c.fmt(c.get(w));
          return `<td class="${cls}">${c.html ? rendered : esc(rendered)}</td>`;
        }).join('') + '</tr>').join('')
      : `<tr><td colspan="${COLUMNS.length}" class="table-empty">No weapons match those filters.</td></tr>`;

    if (countEl) countEl.textContent = `${rows.length} of ${all.length} weapons`;
    renderStatsHead();
  }

  function populateTypeFilter() {
    const sel = document.getElementById('stats-type');
    if (!sel) return;
    const types = [...new Set(weapons().map(w => w.type).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All types</option>' +
      types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  }

  ['stats-search', 'stats-class', 'stats-type'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('input', renderStatsTable);
    el?.addEventListener('change', renderStatsTable);
  });

  // ═════════════════════════════════════════════════════════════════
  // KILL TIME vs AVERAGE
  //
  // Every weapon's time to kill, laid out against the pool average: bars
  // reach left when a weapon kills faster than average and right when it
  // kills slower. Sorted fastest first, so the shape of the list is the
  // shape of the meta. Clicking a weapon opens its history.
  // ═════════════════════════════════════════════════════════════════

  function killTimeRows(targetClass) {
    return weapons()
      // Melee weapons have no fire rate in any data sheet, so their timing
      // would be an invented 60 RPM. Better to leave them out and say so.
      .filter(w => w.rpm != null && w.body_dmg != null)
      .map(w => ({ weapon: w, killTime: idealTTK(w, HP[targetClass]) }))
      .filter(row => Number.isFinite(row.killTime))
      .sort((a, b) => a.killTime - b.killTime);
  }

  function renderKillTimeChart() {
    const mount = document.getElementById('ttk-chart');
    if (!mount) return;

    const targetClass = document.getElementById('ttk-target')?.value || 'medium';
    const rows = killTimeRows(targetClass);
    const subtitle = document.getElementById('ttk-chart-sub');
    const footer = document.getElementById('ttk-chart-footer');

    if (!rows.length) {
      mount.innerHTML = `<div class="empty-state"><div class="empty-icon">◌</div>
        <div class="empty-title">Loading weapon data…</div></div>`;
      if (subtitle) subtitle.textContent = '';
      if (footer) footer.innerHTML = '';
      return;
    }

    const average = rows.reduce((sum, r) => sum + r.killTime, 0) / rows.length;
    const spread = Math.sqrt(
      rows.reduce((sum, r) => sum + (r.killTime - average) ** 2, 0) / rows.length
    );
    const widestGap = Math.max(...rows.map(r => Math.abs(r.killTime - average)));

    if (subtitle) {
      subtitle.innerHTML = `${rows.length} weapons on ${esc(activeDataVersion)} data · ` +
        `average <strong>${average.toFixed(2)}s</strong> · spread <strong>${spread.toFixed(2)}s</strong>`;
    }

    // Half the track is the widest gap, so the longest bar just fills its side.
    const barWidth = gap => (Math.abs(gap) / widestGap) * 50;

    mount.innerHTML = rows.map(row => {
      const gap = row.killTime - average;
      const faster = gap < 0;
      const width = barWidth(gap);
      const id = weaponIdFor(row.weapon.name);
      const cls = row.weapon.class;

      return `
        <div class="ttk-row">
          <span class="ttk-class ${cls}" title="${cls}">${cls[0].toUpperCase()}</span>
          ${id
            ? `<button class="ttk-name" type="button" data-weapon="${esc(id)}"
                 title="How ${esc(row.weapon.name)} has changed across patches">${esc(row.weapon.name)}</button>`
            : `<span class="ttk-name">${esc(row.weapon.name)}</span>`}
          <span class="ttk-track">
            <span class="ttk-bar ${faster ? 'faster' : 'slower'} ${cls}"
                  style="${faster ? `right:50%;` : `left:50%;`} width:${width.toFixed(2)}%"></span>
          </span>
          <span class="ttk-value">${row.killTime.toFixed(2)}s</span>
          <span class="ttk-delta ${faster ? 'faster' : 'slower'}">${faster ? '−' : '+'}${Math.abs(gap).toFixed(2)}s</span>
        </div>`;
    }).join('');

    const fastest = rows[0];
    const slowest = rows[rows.length - 1];
    if (footer) {
      footer.innerHTML = `
        <div class="ttk-card faster">
          <span class="ttk-card-label">Fastest</span>
          <strong>${esc(fastest.weapon.name)}</strong>
          ${fastest.killTime.toFixed(2)}s · ${Math.abs(fastest.killTime - average).toFixed(2)}s under average
        </div>
        <div class="ttk-card slower">
          <span class="ttk-card-label">Slowest</span>
          <strong>${esc(slowest.weapon.name)}</strong>
          ${slowest.killTime.toFixed(2)}s · ${Math.abs(slowest.killTime - average).toFixed(2)}s over average
        </div>`;
    }
  }

  document.getElementById('ttk-target')?.addEventListener('change', renderKillTimeChart);

  // ═════════════════════════════════════════════════════════════════
  // WEAPON HISTORY
  //
  // csv/cleaned/weapon_timeline.json carries raw stat values per version,
  // built by tools/ingest_weapon_history.mjs. Everything derived (DPS, TTK,
  // STK) is computed here with the same functions the stats table uses, so
  // the page and the simulator can never disagree about timing.
  // ═════════════════════════════════════════════════════════════════
  let timeline = null;
  let timelinePromise = null;

  function loadTimeline() {
    if (!timelinePromise) {
      timelinePromise = fetch('./csv/cleaned/weapon_timeline.json')
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(data => (timeline = data))
        .catch(err => {
          console.warn('Weapon history unavailable — run: node tools/ingest_weapon_history.mjs', err);
          return null;
        });
    }
    return timelinePromise;
  }

  // Must match normName() in tools/ingest_weapon_history.mjs.
  function normForAlias(s) {
    return String(s)
      .toUpperCase()
      .replace(/W\//g, 'WITH ')
      .replace(/[.\-_]/g, ' ')
      .replace(/[^A-Z0-9() ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function weaponIdFor(name) {
    return timeline?.aliases?.[normForAlias(name)] || null;
  }

  // Timeline records use the ingest tool's field names; getStats() expects the
  // shipped JSON's names. One adapter keeps a single timing implementation.
  function toWeaponShape(snap, cls) {
    return {
      name: '', class: cls,
      type: snap.rpm == null ? 'Melee' : 'Handgun',
      body_dmg: snap.body_dmg,
      head_damage: snap.head_dmg,
      rpm: snap.rpm,
      magazine_size: snap.magazine_size,
      empty_reload_time: snap.empty_reload,
      tactical_reload_time: snap.tactical_reload,
      shots_per_burst: snap.shots_per_burst,
      delay_in_bursts: snap.burst_delay,
      damage_dropoff_min_range: snap.dropoff_min,
      damage_dropoff_max_range: snap.dropoff_max,
      damage_reduction_at_max: snap.dropoff_reduction != null ? snap.dropoff_reduction / 100 : null
    };
  }

  const HP = { light: 150, medium: 250, heavy: 350 };

  // ═════════════════════════════════════════════════════════════════
  // DATA VERSION
  //
  // weapons_s10_cleaned.json is Krome's 10.0.0 sheet and is what loads before
  // the timeline arrives. Once it does, the whole app — stats table, 1v1
  // simulation and meta analysis — runs on whichever version is selected,
  // newest by default.
  // ═════════════════════════════════════════════════════════════════
  const BUNDLED_DATA_VERSION = '10.0.0';
  const DATA_VERSION_KEY = 'finalsDataVersion';
  let activeDataVersion = BUNDLED_DATA_VERSION;

  // Chronology comes from the version numbers, never from array order.
  function compareVersions(a, b) {
    const A = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const B = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const diff = (A[i] ?? 0) - (B[i] ?? 0);
      if (diff) return diff;
    }
    return 0;
  }

  function orderedVersions() {
    return (timeline?.versions || []).map(v => v.version).sort(compareVersions);
  }

  function newestVersion() {
    const all = orderedVersions();
    return all[all.length - 1] || BUNDLED_DATA_VERSION;
  }

  // Fields a sheet omits are inherited from the newest earlier version that
  // records them — the hierarchy that makes a sparse snapshot runnable. 11.3.0
  // lists melee weapons with no damage at all, so without this they would drop
  // out of the roster entirely.
  const RUNTIME_FIELDS = [
    'body_dmg', 'head_dmg', 'rpm', 'magazine_size', 'empty_reload',
    'tactical_reload', 'shots_per_burst', 'burst_delay',
    'dropoff_min', 'dropoff_max', 'dropoff_reduction'
  ];

  const hasAnyStat = snap => !!snap && RUNTIME_FIELDS.some(k => snap[k] != null);

  // Inheritance is per row, not per field. A blank cell inside a row a sheet
  // did populate is that author saying "not applicable" — Krome deliberately
  // leaves the Dagger's magazine empty — so it must not be back-filled from an
  // older sheet that recorded a 1 there. Only a wholly empty row is a coverage
  // gap, and that inherits the last version that did record the weapon.
  function resolveWeaponAt(weapon, version) {
    if (!weapon.snapshots[version]) return null;   // not on this sheet's roster

    if (hasAnyStat(weapon.snapshots[version])) {
      const snap = weapon.snapshots[version];
      const fields = {};
      for (const key of RUNTIME_FIELDS) fields[key] = snap[key] ?? null;
      return { fields, inheritedFrom: null };
    }

    const earlier = orderedVersions()
      .filter(v => compareVersions(v, version) < 0)
      .reverse()
      .find(v => hasAnyStat(weapon.snapshots[v]));
    if (!earlier) return null;

    const snap = weapon.snapshots[earlier];
    const fields = {};
    for (const key of RUNTIME_FIELDS) fields[key] = snap[key] ?? null;
    return { fields, inheritedFrom: earlier };
  }

  // Builds a WEAPONS-shaped roster for a version, in the field names getStats()
  // and the rest of the engine expect.
  function materializeWeapons(version) {
    if (!timeline) return null;
    const list = [];
    let inheritedCount = 0;

    for (const [id, weapon] of Object.entries(timeline.weapons)) {
      const resolved = resolveWeaponAt(weapon, version);
      if (!resolved || resolved.fields.body_dmg == null) continue;   // unsimulatable

      const f = resolved.fields;
      const defaults = timeline.runtime_defaults?.[id] || {};
      if (resolved.inheritedFrom) inheritedCount++;

      list.push({
        id,
        name: weapon.name,
        class: weapon.class,
        type: weapon.type || (f.rpm == null ? 'Melee' : 'Handgun'),
        firing_mode: weapon.firing_mode || null,
        body_dmg: f.body_dmg,
        head_damage: f.head_dmg,
        rpm: f.rpm,
        // A melee weapon has no magazine. The 5.8 sheet records a 1 in that
        // column, which the engine would read as "reload after every swing".
        magazine_size: (weapon.type === 'Melee')
          ? (defaults.magazine_size ?? null)
          : f.magazine_size,
        empty_reload_time: f.empty_reload,
        tactical_reload_time: f.tactical_reload,
        shots_per_burst: f.shots_per_burst,
        delay_in_bursts: f.burst_delay,
        // A hard reach limit (melee swing, flamethrower cone) is engine
        // knowledge no sheet records, so it fills in only where the sheet is
        // silent — never overriding a measured dropoff curve.
        damage_dropoff_min_range: f.dropoff_min ?? defaults.reach ?? null,
        damage_dropoff_max_range: f.dropoff_max ?? defaults.reach ?? null,
        damage_reduction_at_max: f.dropoff_reduction != null
          ? f.dropoff_reduction / 100
          : (defaults.reach != null ? 1 : null),
        notes: resolved.inheritedFrom
          ? `Not recorded in the ${version} sheet — stats carried forward from ${resolved.inheritedFrom}.`
          : null,
        _inheritedFrom: resolved.inheritedFrom
      });
    }

    list.sort((a, b) => a.name.localeCompare(b.name));
    return { list, inheritedCount };
  }

  // Swaps the roster the entire app runs on, in place so every module that
  // captured the WEAPONS binding keeps working.
  function applyDataVersion(version, { persist = true } = {}) {
    if (!timeline || !timeline.versions.some(v => v.version === version)) return;

    const built = materializeWeapons(version);
    if (!built || !built.list.length) return;

    activeDataVersion = version;
    if (persist) {
      try { localStorage.setItem(DATA_VERSION_KEY, version); } catch { /* private mode */ }
    }

    WEAPONS.splice(0, WEAPONS.length, ...built.list);

    // Rebuild everything downstream of the roster.
    if (typeof filterWeapons === 'function') { filterWeapons(1); filterWeapons(2); }
    if (typeof updateWeaponInfo === 'function') { updateWeaponInfo(1); updateWeaponInfo(2); }
    redrawArena();
    populateTypeFilter();
    populateMetaWeapons();
    updateMetaEstimate();
    renderStatsTable();
    renderKillTimeChart();
    syncVersionPickers();
    if (currentRoute === 'weapon') renderWeaponPage(currentParams[0], currentParams[1]);
  }

  function syncVersionPickers() {
    const versions = orderedVersions();
    document.querySelectorAll('.data-version-picker').forEach(sel => {
      if (sel.options.length !== versions.length) {
        sel.innerHTML = versions.slice().reverse().map(v =>
          `<option value="${esc(v)}">${esc(v)}${v === newestVersion() ? ' (newest)' : ''}</option>`).join('');
      }
      sel.value = activeDataVersion;
    });

    const built = timeline ? materializeWeapons(activeDataVersion) : null;
    document.querySelectorAll('.data-version-note').forEach(el => {
      const meta = timeline?.versions.find(v => v.version === activeDataVersion);
      el.innerHTML = built
        ? `${built.list.length} weapons · ${esc(meta?.author || '')}${
            built.inheritedCount ? ` · ${built.inheritedCount} weapon${built.inheritedCount === 1 ? '' : 's'} carried forward from earlier sheets` : ''}`
        : '';
    });
  }

  // Every plottable metric. `get` returns null when the sheet for that version
  // does not support the metric, which leaves a visible gap in the chart.
  const METRICS = [
    { key: 'body_dmg', label: 'Damage per shot (body)', get: (s) => s.body_dmg },
    { key: 'head_dmg', label: 'Damage per shot (head)', get: (s) => s.head_dmg },
    { key: 'dps', label: 'Sustained DPS (with reloads)', unit: '', digits: 0,
      get: (s, c) => (s.rpm == null || s.body_dmg == null ? null : sustainedDPS(toWeaponShape(s, c))) },
    { key: 'raw_dps', label: 'Raw DPS (no reloads)', digits: 0,
      get: (s) => (s.rpm == null || s.body_dmg == null ? null : (s.body_dmg * s.rpm) / 60) },
    { key: 'ttk_light', label: 'Ideal TTK vs Light', unit: 's', digits: 2,
      get: (s, c) => (s.rpm == null ? null : idealTTK(toWeaponShape(s, c), HP.light)) },
    { key: 'ttk_medium', label: 'Ideal TTK vs Medium', unit: 's', digits: 2,
      get: (s, c) => (s.rpm == null ? null : idealTTK(toWeaponShape(s, c), HP.medium)) },
    { key: 'ttk_heavy', label: 'Ideal TTK vs Heavy', unit: 's', digits: 2,
      get: (s, c) => (s.rpm == null ? null : idealTTK(toWeaponShape(s, c), HP.heavy)) },
    { key: 'stk_light', label: 'Shots to kill a Light', get: (s) => (s.body_dmg ? Math.ceil(HP.light / s.body_dmg) : null) },
    { key: 'stk_medium', label: 'Shots to kill a Medium', get: (s) => (s.body_dmg ? Math.ceil(HP.medium / s.body_dmg) : null) },
    { key: 'stk_heavy', label: 'Shots to kill a Heavy', get: (s) => (s.body_dmg ? Math.ceil(HP.heavy / s.body_dmg) : null) },
    { key: 'rpm', label: 'Rate of fire (RPM)', get: (s) => s.rpm },
    { key: 'magazine_size', label: 'Magazine size', get: (s) => s.magazine_size },
    { key: 'damage_per_mag', label: 'Damage per magazine',
      get: (s) => (s.body_dmg != null && s.magazine_size ? s.body_dmg * s.magazine_size : null) },
    { key: 'empty_reload', label: 'Empty reload', unit: 's', digits: 2, get: (s) => s.empty_reload },
    { key: 'tactical_reload', label: 'Tactical reload', unit: 's', digits: 2, get: (s) => s.tactical_reload },
    { key: 'dropoff_min', label: 'Dropoff starts at', unit: 'm', digits: 1, get: (s) => s.dropoff_min },
    { key: 'dropoff_max', label: 'Dropoff ends at', unit: 'm', digits: 1, get: (s) => s.dropoff_max },
    { key: 'dropoff_reduction', label: 'Damage lost at max range', unit: '%', get: (s) => s.dropoff_reduction }
  ];

  let activeWeaponId = null;
  let activeVersion = null;
  let activeMetric = 'body_dmg';

  function fmtMetric(metric, v) {
    if (v == null) return '—';
    const digits = metric.digits ?? (Number.isInteger(v) ? 0 : 1);
    return v.toFixed(digits) + (metric.unit || '');
  }

  function initWeaponPage() {
    const sel = document.getElementById('wp-metric');
    if (!sel) return;
    sel.innerHTML = METRICS.map(m => `<option value="${m.key}">${esc(m.label)}</option>`).join('');
    sel.addEventListener('change', () => {
      activeMetric = sel.value;
      drawWeaponChart();
    });
  }

  function renderWeaponPage(id, version) {
    loadTimeline().then(() => {
      const nameEl = document.getElementById('wp-name');
      const chartEl = document.getElementById('wp-chart');

      if (!timeline) {
        nameEl.textContent = 'Weapon history unavailable';
        document.getElementById('wp-lead').textContent =
          'csv/cleaned/weapon_timeline.json could not be loaded. Generate it with: node tools/ingest_weapon_history.mjs';
        chartEl.innerHTML = '';
        document.getElementById('wp-snapshot').innerHTML = '';
        document.getElementById('wp-changes').innerHTML = '';
        document.getElementById('wp-versions').innerHTML = '';
        return;
      }

      const weapon = timeline.weapons[id];
      if (!weapon) {
        nameEl.textContent = 'Unknown weapon';
        document.getElementById('wp-lead').textContent = `No history recorded for "${id}".`;
        return;
      }

      activeWeaponId = id;
      const availableVersions = Object.keys(weapon.snapshots);
      // Some sheets list a weapon with no numbers at all (11.3.0 records melee
      // shots-to-kill only). Landing on a blank snapshot would look broken, so
      // default to the newest version that actually carries data.
      const withData = availableVersions.filter(v => {
        const s = weapon.snapshots[v];
        return s.body_dmg != null || s.rpm != null;
      });
      activeVersion = version && weapon.snapshots[version]
        ? version
        : (withData[withData.length - 1] || availableVersions[availableVersions.length - 1]);

      nameEl.textContent = weapon.name;
      document.getElementById('wp-badges').innerHTML = `
        <span class="badge ${weapon.class}">${weapon.class} — ${HP[weapon.class]}HP</span>
        <span class="badge">${availableVersions.length} of ${timeline.versions.length} versions</span>
        <span class="badge" title="The version the simulator is currently running on">sim: ${esc(activeDataVersion)}</span>
        <span class="badge">${(n => `${n} recorded change${n === 1 ? '' : 's'}`)(weapon.changes.filter(c => c.type === 'change').length)}</span>
      `;
      document.getElementById('wp-lead').textContent = weapon.alias_note
        || `Tracked across the community data sheets from ${availableVersions[0]} to ${availableVersions[availableVersions.length - 1]}.`;

      document.getElementById('wp-metric').value = activeMetric;
      drawWeaponChart();
      renderVersionChips(weapon);
      renderSnapshot(weapon);
      renderChangeLog(weapon);
    });
  }

  // ── Chart ────────────────────────────────────────────────────────
  function drawWeaponChart() {
    const mount = document.getElementById('wp-chart');
    const noteEl = document.getElementById('wp-chart-note');
    const weapon = timeline?.weapons[activeWeaponId];
    if (!mount || !weapon) return;

    const metric = METRICS.find(m => m.key === activeMetric) || METRICS[0];
    const versions = timeline.versions.map(v => v.version);
    const points = versions.map((v, i) => {
      const snap = weapon.snapshots[v];
      const value = snap ? metric.get(snap, weapon.class) : null;
      return { version: v, i, value: Number.isFinite(value) ? value : null, disputed: !!snap?.rpm_disputed };
    });

    const present = points.filter(p => p.value != null);
    if (present.length === 0) {
      mount.innerHTML = `<div class="empty-state"><div class="empty-icon">◌</div>
        <div class="empty-title">No data for this metric</div>
        <div class="empty-sub">None of the sheets covering ${esc(weapon.name)} record ${esc(metric.label.toLowerCase())}.</div></div>`;
      noteEl.textContent = '';
      return;
    }

    const W = 760, H = 300, pad = { l: 62, r: 24, t: 22, b: 44 };
    const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;

    let min = Math.min(...present.map(p => p.value));
    let max = Math.max(...present.map(p => p.value));
    if (min === max) { min = min - Math.abs(min || 1) * 0.2; max = max + Math.abs(max || 1) * 0.2; }
    else { const padding = (max - min) * 0.15; min -= padding; max += padding; }
    if (min > 0 && min < (max - min)) min = 0;   // keep bar-like metrics honest about zero

    const x = i => pad.l + (versions.length === 1 ? plotW / 2 : (i / (versions.length - 1)) * plotW);
    const y = v => pad.t + plotH - ((v - min) / (max - min)) * plotH;

    const ticks = 4;
    let grid = '';
    for (let t = 0; t <= ticks; t++) {
      const value = min + ((max - min) * t) / ticks;
      const yy = y(value);
      grid += `<line class="chart-grid" x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}" />`;
      grid += `<text class="chart-axis" x="${pad.l - 10}" y="${yy + 4}" text-anchor="end">${fmtMetric(metric, value)}</text>`;
    }

    // Segments are drawn one at a time so a gap in coverage shows as a dashed
    // connector instead of pretending the value moved smoothly.
    let lines = '';
    for (let a = 0; a < present.length - 1; a++) {
      const p1 = present[a], p2 = present[a + 1];
      const gap = p2.i - p1.i > 1;
      lines += `<line class="chart-line${gap ? ' gap' : ''}" x1="${x(p1.i)}" y1="${y(p1.value)}" x2="${x(p2.i)}" y2="${y(p2.value)}" />`;
    }

    const dots = present.map(p => `
      <g class="chart-point${p.disputed ? ' disputed' : ''}">
        <circle cx="${x(p.i)}" cy="${y(p.value)}" r="5">
          <title>${esc(p.version)} — ${esc(fmtMetric(metric, p.value))}${p.disputed ? ' (disputed source value)' : ''}</title>
        </circle>
        <text class="chart-value" x="${x(p.i)}" y="${y(p.value) - 12}" text-anchor="middle">${esc(fmtMetric(metric, p.value))}</text>
      </g>`).join('');

    const xLabels = points.map(p => `
      <text class="chart-axis${p.value == null ? ' muted' : ''}" x="${x(p.i)}" y="${H - 16}" text-anchor="middle">${esc(p.version)}</text>`).join('');

    mount.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric.label)} across versions">
        ${grid}
        <line class="chart-axis-line" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + plotH}" />
        <line class="chart-axis-line" x1="${pad.l}" y1="${pad.t + plotH}" x2="${W - pad.r}" y2="${pad.t + plotH}" />
        ${lines}${dots}${xLabels}
      </svg>`;

    const missing = points.filter(p => p.value == null).map(p => p.version);
    const first = present[0], last = present[present.length - 1];
    const change = last.value - first.value;
    const pctChange = first.value ? ((change / first.value) * 100).toFixed(1) : null;

    // Endpoints matching does not mean the value never moved, so check the
    // whole series before claiming anything was unchanged.
    const flat = present.every(p => p.value === first.value);
    const peak = present.reduce((a, b) => (b.value > a.value ? b : a));
    const low = present.reduce((a, b) => (b.value < a.value ? b : a));
    const excursion = peak.value > Math.max(first.value, last.value)
      || low.value < Math.min(first.value, last.value);

    const headline = flat
      ? `Unchanged at ${fmtMetric(metric, first.value)} across every version on record.`
      : `${esc(metric.label)}: ${fmtMetric(metric, first.value)} at ${first.version} → ${fmtMetric(metric, last.value)} at ${last.version}`
        + (change === 0
          ? ' — back where it started.'
          : ` (${change > 0 ? '+' : ''}${fmtMetric(metric, change)}${pctChange ? `, ${change > 0 ? '+' : ''}${pctChange}%` : ''}).`);

    const excursionNote = !flat && excursion
      ? ` Peaked at ${fmtMetric(metric, peak.value)} in ${peak.version}, lowest ${fmtMetric(metric, low.value)} in ${low.version}.`
      : '';

    noteEl.innerHTML = [
      headline + excursionNote,
      missing.length ? `No data in ${missing.join(', ')} — dashed segments span a gap in sheet coverage, not a straight-line change.` : ''
    ].filter(Boolean).join(' ');
  }

  // ── Version chips + snapshot ─────────────────────────────────────
  function renderVersionChips(weapon) {
    const mount = document.getElementById('wp-versions');
    mount.innerHTML = timeline.versions.map(v => {
      const has = !!weapon.snapshots[v.version];
      return `<button class="vchip${v.version === activeVersion ? ' active' : ''}${has ? '' : ' empty'}"
        type="button" data-version="${esc(v.version)}" ${has ? '' : 'disabled'}
        title="${has ? esc(v.author) : 'Not in this sheet'}">${esc(v.version)}</button>`;
    }).join('');

    mount.querySelectorAll('.vchip').forEach(chip => {
      chip.addEventListener('click', () => {
        activeVersion = chip.dataset.version;
        navigate('weapon', { params: [activeWeaponId, activeVersion] });
      });
    });
  }

  function statRow(label, value, extra) {
    return `<div class="srow"><span class="skey">${esc(label)}</span><span class="sval">${value}</span>${
      extra ? `<span class="snote">${esc(extra)}</span>` : ''}</div>`;
  }

  function renderSnapshot(weapon) {
    const mount = document.getElementById('wp-snapshot');
    const snap = weapon.snapshots[activeVersion];
    const meta = timeline.versions.find(v => v.version === activeVersion);
    if (!snap) { mount.innerHTML = ''; return; }

    const w = toWeaponShape(snap, weapon.class);
    const dpm = snap.body_dmg != null && snap.magazine_size ? snap.body_dmg * snap.magazine_size : null;
    const dps = snap.rpm != null && snap.body_dmg != null ? sustainedDPS(w) : null;

    const ttkRows = ['light', 'medium', 'heavy'].map(cls => {
      const stk = snap.body_dmg ? Math.ceil(HP[cls] / snap.body_dmg) : null;
      const ttk = snap.rpm != null ? idealTTK(w, HP[cls]) : null;
      return `<div class="ttk-cell">
        <div class="stat-label">vs ${cls}</div>
        <div class="stat-val ${cls === 'light' ? 'p1' : cls === 'heavy' ? 'p2' : 'neutral'}">${ttk == null ? '—' : ttk.toFixed(2) + 's'}</div>
        <div class="ttk-sub">${stk == null ? '—' : stk + ' shots'}</div>
      </div>`;
    }).join('');

    const landed = weapon.changes.filter(c => c.to_version === activeVersion && c.type === 'change');
    const qualifiers = weapon.changes.filter(c => c.to_version === activeVersion && c.type === 'definition');
    const blank = snap.body_dmg == null && snap.rpm == null;
    const caveats = [...(snap.notes || []), ...(meta?.caveats || [])];

    mount.innerHTML = `
      <div class="snapshot-head">
        <div class="snapshot-title">${esc(weapon.name)} <span class="at">at</span> ${esc(activeVersion)}</div>
        <div class="snapshot-source">${esc(meta?.author || '')} · ${esc(meta?.method || '')}${
          activeVersion === activeDataVersion ? ' · the version the simulator runs on' : ''}</div>
      </div>

      ${blank ? `<p class="doc-note">The ${esc(activeVersion)} sheet lists this weapon but records no damage or rate of fire for it — only shots to kill. Pick another version for a full stat block.</p>` : ''}

      <div class="ttk-grid">${ttkRows}</div>

      <div class="stat-rows">
        ${statRow('Body damage', snap.body_dmg ?? '—')}
        ${statRow('Head damage', snap.head_dmg ?? '—')}
        ${statRow('Rate of fire', snap.rpm != null ? snap.rpm + ' RPM'
          : snap.rpm_source_value != null ? `<span class="withheld">${snap.rpm_source_value} RPM — withheld</span>` : '—')}
        ${statRow('Magazine', snap.magazine_size ?? '—')}
        ${statRow('Damage per magazine', dpm ?? '—')}
        ${statRow('Sustained DPS', dps == null ? '—' : dps.toFixed(0))}
        ${statRow('Empty reload', snap.empty_reload != null ? snap.empty_reload.toFixed(2) + 's' : '—',
          snap.empty_reload != null && !snap.reload_kind_known ? 'kind unknown' : '')}
        ${statRow('Tactical reload', snap.tactical_reload != null ? snap.tactical_reload.toFixed(2) + 's' : '—')}
        ${snap.shots_per_burst ? statRow('Burst', `${snap.shots_per_burst} shots, ${snap.burst_delay ?? '—'}s between bursts`) : ''}
        ${statRow('Dropoff', snap.dropoff_min != null
          ? `${snap.dropoff_min}m → ${snap.dropoff_max ?? '?'}m${snap.dropoff_reduction != null ? ` (−${snap.dropoff_reduction}%)` : ''}`
          : '—')}
      </div>

      ${landed.length ? `
        <div class="snapshot-section">
          <div class="section-label">Changed in this version</div>
          ${landed.map(c => `<div class="change-line">${changeText(c)}</div>`).join('')}
        </div>` : ''}

      ${qualifiers.length ? `
        <div class="snapshot-section">
          <div class="section-label">Read this before trusting the change</div>
          ${qualifiers.map(q => `<div class="change-line coverage">${esc(q.note)}</div>`).join('')}
        </div>` : ''}

      ${caveats.length ? `
        <div class="snapshot-section">
          <div class="section-label">Source caveats</div>
          <ul class="doc-ul">${caveats.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
        </div>` : ''}
    `;
  }

  // Fields where a bigger number is worse for the wielder. Colouring purely by
  // numeric direction would paint a longer reload or a harsher dropoff green.
  const LOWER_IS_BETTER = new Set(['empty_reload', 'tactical_reload', 'burst_delay', 'dropoff_reduction']);

  function changeText(c) {
    const rose = c.to > c.from;
    const buff = LOWER_IS_BETTER.has(c.field) ? !rose : rose;
    const tone = buff ? 'buff' : 'nerf';
    const title = buff ? 'Better for the wielder' : 'Worse for the wielder';
    return `<span class="chg-field">${esc(c.label)}</span>
      <span class="chg-values ${tone}" title="${title}">${c.from} ${rose ? '↑' : '↓'} ${c.to}</span>
      <span class="chg-delta ${tone}">${c.delta > 0 ? '+' : ''}${c.delta}${c.delta_pct != null ? ` (${c.delta_pct > 0 ? '+' : ''}${c.delta_pct}%)` : ''}</span>
      <span class="conf ${c.confidence}">${c.confidence}</span>`;
  }

  // ── Change log ───────────────────────────────────────────────────
  function renderChangeLog(weapon) {
    const mount = document.getElementById('wp-changes');
    if (!weapon.changes.length) {
      mount.innerHTML = `<div class="empty-state"><div class="empty-icon">◌</div>
        <div class="empty-title">No recorded changes</div>
        <div class="empty-sub">This weapon appears in only one sheet, so there is nothing to compare against.</div></div>`;
      return;
    }

    const groups = new Map();
    for (const c of weapon.changes) {
      const key = `${c.from_version} → ${c.to_version}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }

    mount.innerHTML = [...groups.entries()].reverse().map(([key, list]) => `
      <div class="chg-group">
        <div class="chg-head">${esc(key)}</div>
        ${list.map(c => c.type !== 'change'
          ? `<div class="change-line coverage">${esc(c.note)}</div>`
          : `<div class="change-line">${changeText(c)}</div>`).join('')}
      </div>`).join('');
  }

  // ═════════════════════════════════════════════════════════════════
  // META SIMULATION PANEL
  // ═════════════════════════════════════════════════════════════════
  const DISTANCE_COUNT = 7;   // getDistances()
  const PROFILE_COUNT  = 4;   // getAimProfiles()

  // The grid is solved exactly by default. Sampling is kept as a
  // deliberate choice: it is the only way to cross-check the solver from
  // inside the app, and it is what a moving-fighter model would need.
  function metaMethod() {
    return document.querySelector('#meta-method-group .tbtn.active')?.dataset.method || 'exact';
  }

  function metaRuns() {
    const active = document.querySelector('#meta-runs-group .tbtn.active');
    return parseInt(active?.dataset.runs || '10000', 10);
  }

  function metaWeapon() {
    const idx = parseInt(document.getElementById('meta-weapon')?.value, 10);
    return weapons()[idx] || null;
  }

  function populateMetaWeapons() {
    const sel = document.getElementById('meta-weapon');
    if (!sel) return;
    const cls = document.getElementById('meta-class')?.value || '';
    const previous = sel.value;
    sel.innerHTML = '';
    weapons().forEach((w, i) => {
      if (cls && w.class !== cls) return;
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `[${w.class.toUpperCase()[0]}] ${w.name} — ${w.type}`;
      sel.appendChild(opt);
    });
    if (previous && sel.querySelector(`option[value="${previous}"]`)) sel.value = previous;
    updateMetaBadges();
  }

  function updateMetaBadges() {
    const el = document.getElementById('meta-badges');
    const w = metaWeapon();
    if (!el || !w) return;
    const hp = typeof CLASS_HP !== 'undefined' ? CLASS_HP[w.class] : '';
    el.innerHTML = `
      <span class="badge ${w.class}">${w.class} — ${hp}HP</span>
      <span class="badge">${esc(w.type || '—')}</span>
      ${w.body_dmg ? `<span class="badge">DMG ${esc(w.body_dmg)}</span>` : ''}
      ${w.rpm ? `<span class="badge">${esc(w.rpm)} RPM</span>` : ''}
    `;
  }

  function updateMetaEstimate() {
    const el = document.getElementById('meta-estimate');
    if (!el) return;
    const total = weapons().length;
    if (!total) { el.textContent = '—'; return; }
    const scenarios = (total - 1) * DISTANCE_COUNT * PROFILE_COUNT;
    const sampling = metaMethod() === 'sampled';
    const workers = (typeof POOL_SIZE !== 'undefined' ? POOL_SIZE : '?');

    el.innerHTML = sampling
      ? `<strong>${scenarios.toLocaleString()}</strong> scenarios ·
         <strong>${(scenarios * metaRuns()).toLocaleString()}</strong> duels · ${workers} workers`
      : `<strong>${scenarios.toLocaleString()}</strong> scenarios ·
         solved exactly · ${workers} workers`;

    const note = document.getElementById('meta-method-note');
    if (note) {
      note.innerHTML = sampling
        ? `<strong>Sampled.</strong> Duels are played out and the winners counted, so these win
           rates carry sampling error — roughly ${(100 * 0.5 / Math.sqrt(metaRuns())).toFixed(2)}
           percentage points at this run count. They also inherit the engine's 10&nbsp;ms tick,
           which counts two kills in the same tick as a tie and can shift a win rate by several
           points where two weapons fire in near lockstep. Runs are seeded, so the same table comes
           back every time.`
        : `<strong>Solved, not sampled.</strong> Because nobody moves, every matchup is worked out
           exactly rather than by running duels and counting winners. The win rates carry no
           sampling error and are identical every run.`;
    }
  }

  function bindMetaRange(inputId, outId, suffix) {
    const input = document.getElementById(inputId);
    const out = document.getElementById(outId);
    if (!input || !out) return;
    const sync = () => {
      const v = parseFloat(input.value);
      const pct = ((v - input.min) / (input.max - input.min)) * 100;
      input.style.setProperty('--pct', pct + '%');
      out.textContent = suffix === '' ? v.toFixed(1) : v + suffix;
    };
    input.addEventListener('input', sync);
    sync();
  }

  function initMetaPanel() {
    bindMetaRange('meta-acc', 'meta-acc-v', '%');
    bindMetaRange('meta-hs', 'meta-hs-v', '%');

    document.getElementById('meta-class')?.addEventListener('change', populateMetaWeapons);
    document.getElementById('meta-weapon')?.addEventListener('change', updateMetaBadges);

    document.querySelectorAll('#meta-method-group .tbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#meta-method-group .tbtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const runsWrap = document.getElementById('meta-runs-wrap');
        if (runsWrap) runsWrap.style.display = metaMethod() === 'sampled' ? 'block' : 'none';
        updateMetaEstimate();
      });
    });

    document.querySelectorAll('#meta-runs-group .tbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#meta-runs-group .tbtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateMetaEstimate();
      });
    });

    document.getElementById('meta-run-btn')?.addEventListener('click', startMetaAnalysis);
    document.getElementById('meta-cancel-btn')?.addEventListener('click', () => {
      if (typeof cancelCrossAnalysis === 'function') cancelCrossAnalysis();
      setMetaRunning(false);
    });
  }

  function setMetaRunning(running) {
    const run = document.getElementById('meta-run-btn');
    const cancel = document.getElementById('meta-cancel-btn');
    if (run) {
      run.disabled = running;
      run.textContent = running ? '⏳ RUNNING…' : '▶ RUN META ANALYSIS';
    }
    if (cancel) cancel.disabled = !running;
  }

  function startMetaAnalysis() {
    const attacker = metaWeapon();
    if (!attacker) {
      // Pressing Run before the weapon data has loaded used to do nothing
      // at all, which just looks broken.
      const mount = document.getElementById('cross-table');
      if (mount) {
        mount.innerHTML = `<div class="empty-state"><div class="empty-icon">◌</div>
          <div class="empty-title">Weapon data still loading</div>
          <div class="empty-sub">Give it a moment and press run again.</div></div>`;
      }
      return;
    }

    setMetaRunning(true);
    if (typeof setCrossRuns === 'function') setCrossRuns(metaRuns());

    runCrossAnalysis({
      method: metaMethod(),
      attacker,
      attackerAcc: parseFloat(document.getElementById('meta-acc').value) / 100,
      attackerHs: parseFloat(document.getElementById('meta-hs').value) / 100,
      // Movement is fixed: the meta grid is stand-and-fight by design.
      mountId: 'cross-table',
      onComplete: () => setMetaRunning(false)
    });
  }

  // ═════════════════════════════════════════════════════════════════
  // BOOT
  // ═════════════════════════════════════════════════════════════════
  document.addEventListener('weapons:loaded', () => {
    populateTypeFilter();
    populateMetaWeapons();
    updateMetaEstimate();
    if (currentRoute === 'stats') renderStatsTable();

    // Bundled data gets the app running; the timeline then upgrades it to the
    // newest sheet (or whichever version was last chosen).
    renderKillTimeChart();
    loadTimeline().then(t => {
      if (!t) { updateWeaponCount(); renderKillTimeChart(); return; }
      let wanted = null;
      try { wanted = localStorage.getItem(DATA_VERSION_KEY); } catch { /* private mode */ }
      const valid = wanted && t.versions.some(v => v.version === wanted);
      applyDataVersion(valid ? wanted : newestVersion(), { persist: false });
      updateWeaponCount();
    });
  });

  function updateWeaponCount() {
    const count = document.getElementById('home-weapon-count');
    if (count) count.textContent = `${weapons().length} weapons · ${activeDataVersion} data`;
  }

  document.addEventListener('weapons:error', () => {
    const count = document.getElementById('home-weapon-count');
    if (count) count.textContent = 'Weapon data failed to load — serve this page over HTTP, not file://';
    const body = document.getElementById('stats-body');
    if (body) body.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="table-empty">Weapon data unavailable.</td></tr>`;
  });

  document.addEventListener('change', e => {
    const picker = e.target.closest('.data-version-picker');
    if (picker) applyDataVersion(picker.value);
  });

  renderStatsHead();
  initMetaPanel();
  initWeaponPage();
  {
    const { name, params } = routeFromHash();
    navigate(name, { push: false, params });
  }
})();
