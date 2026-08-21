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
    meta:   { view: 'view-meta',   title: 'Meta Simulation — cross analysis', nav: 'meta' },
    sustain:{ view: 'view-sustain', title: 'Sustain Analysis — holding the objective', nav: 'sustain' }
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
    if (route === 'stats') { renderStatsTable(); renderHealStats(); renderGadgetStats(); loadTimeline().then(t => { if (t && currentRoute === 'stats') renderStatsTable(); }); }
    if (route === 'meta') updateMetaEstimate();
    if (route === 'sustain') updateSustainEstimate();
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
//outdated
  // function idealTTK(w, hp) {
  //   const s = statsFor(w);
  //   if (!s || !s.bodyDmg) return null;
  //   const shots = Math.ceil(hp / s.bodyDmg);
  //   return timeToNthShot(s, shots);
  // }

  function idealTTKFromStats(s, hp) {
  if (!s || !s.bodyDmg) return null;

  const shots = Math.ceil(hp / s.bodyDmg);
  return timeToNthShot(s, shots);
}


function idealTTK(w, hp) {
  return idealTTKFromStats(statsFor(w), hp);
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
    { key: 'ttkL',   label: `TTK ${CLASS_HP.light}`,  align: 'right', get: w => idealTTK(w, CLASS_HP.light),  fmt: v => v == null ? '—' : v.toFixed(2) + 's', derived: true },
    { key: 'ttkM',   label: `TTK ${CLASS_HP.medium}`, align: 'right', get: w => idealTTK(w, CLASS_HP.medium), fmt: v => v == null ? '—' : v.toFixed(2) + 's', derived: true },
    { key: 'ttkH',   label: `TTK ${CLASS_HP.heavy}`,  align: 'right', get: w => idealTTK(w, CLASS_HP.heavy),  fmt: v => v == null ? '—' : v.toFixed(2) + 's', derived: true }
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

  // Class health comes from heals.js, which loads first. Kept under the
  // short name this file already uses everywhere rather than renaming ten
  // call sites, but it is no longer a second copy of the numbers.
  const HP = CLASS_HP;

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

  // A version can be listed twice — 11.3.0 is both a measured sheet and a patch
  // with stat changes. That is one moment in time with two kinds of evidence,
  // not two moments, so it gets one slot on every axis and in every list.
  function orderedVersions() {
    return [...new Set((timeline?.versions || []).map(v => v.version))].sort(compareVersions);
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
  // The versions a data sheet actually measured. Everything else on the
  // timeline is a patch record, which states changes but never a full roster.
  function sheetVersions() {
    return new Set((timeline?.versions || []).filter(v => v.kind === 'sheet').map(v => v.version));
  }

  function resolveWeaponAt(weapon, version) {
    // A patch version has no roster of its own, so "is this weapon on the
    // sheet" is the wrong question — there is no sheet. Fall back to the same
    // carry-forward-plus-patches resolution the chart plots, which is the whole
    // reason the patch records were ingested: the game at 11.0.0 is a state you
    // should be able to simulate, not just one you can read about.
    if (!sheetVersions().has(version)) {
      const state = statsByVersion(weapon).get(version);
      if (!state) return null;
      const fields = {};
      for (const key of RUNTIME_FIELDS) fields[key] = state.fields[key] ?? null;
      return { fields, inheritedFrom: state.carried ? state.source.version : null };
    }

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

  // ── The full timeline, version by version ────────────────────────
  //
  // A sheet measures every stat at once; a patch states only what it moved. To
  // draw one continuous line across both, walk the versions in order carrying
  // the last known state forward: a sheet replaces it wholesale, a patch
  // overwrites only the fields it names, and a version that is neither inherits
  // unchanged. This is the resolution rule from csv/patches/README.md, and it is
  // what turns 22 sparse patch records into 22 plottable points.
  //
  // A sheet at the same version as a patch wins, because it measured the game
  // after that patch shipped.
  // Memoised: the ledger asks for this once per entry, and the walk is over
  // every version on record each time.
  const statsCache = new WeakMap();

  function statsByVersion(weapon) {
    const hit = statsCache.get(weapon);
    if (hit) return hit;

    const out = new Map();
    let carried = null, source = null;

    for (const version of orderedVersions()) {
      const snap = weapon.snapshots[version];
      const patch = weapon.patches?.[version];

      if (hasAnyStat(snap)) {
        carried = {};
        for (const key of RUNTIME_FIELDS) carried[key] = snap[key] ?? null;
        source = { version, kind: 'sheet' };
      } else if (carried && patch && Object.keys(patch.fields || {}).length) {
        carried = { ...carried };
        for (const [key, value] of Object.entries(patch.fields)) {
          if (RUNTIME_FIELDS.includes(key)) carried[key] = value;
        }
        source = { version, kind: 'patch' };
      }

      if (carried) out.set(version, { fields: carried, source, carried: source.version !== version });
    }
    statsCache.set(weapon, out);
    return out;
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
    // Which sheet this version's numbers ultimately rest on — the newest one at
    // or before it. Worth surfacing, because on a patch version it is the only
    // measurement anywhere underneath the stated changes.
    const basedOn = [...sheetVersions()]
      .filter(v => compareVersions(v, version) <= 0)
      .sort(compareVersions)
      .pop() || null;

    return { list, inheritedCount, basedOn };
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

    // Heals move with the roster or they silently stay on Season 11 numbers
    // while the weapons rewind. Warned-about picks are forgotten too: the
    // same item at a different version is a different claim.
    warnedTheoretical.clear();
    renderHealStacks();
    renderHealStats();
    // The shields rewind with everything else — a Dome at 2.0.0 lasted 12s
    // and a Mesh was worth 750, and a page still showing today's numbers
    // would be quietly wrong about both.
    renderGadgetStats();
    updateSustainEstimate();

    if (currentRoute === 'weapon') renderWeaponPage(currentParams[0], currentParams[1]);
  }

  function syncVersionPickers() {
    const versions = orderedVersions();
    const measured = sheetVersions();
    const newest = newestVersion();

    // 137 flat entries is a scroll, not a choice. Grouping by season keeps the
    // list navigable, and marking which versions a sheet actually measured says
    // what you are getting: the rest are carried forward with patch notes laid
    // over the top, which is real data but not a fresh capture.
    const bySeason = new Map();
    for (const v of versions.slice().reverse()) {
      const season = parseInt(String(v).split('.')[0], 10) || 0;
      if (!bySeason.has(season)) bySeason.set(season, []);
      bySeason.get(season).push(v);
    }

    const markup = [...bySeason.entries()].map(([season, list]) => `
      <optgroup label="Season ${season}">
        ${list.map(v => `<option value="${esc(v)}">${esc(v)}${
          v === newest ? ' — newest' : measured.has(v) ? ' — measured' : ''}</option>`).join('')}
      </optgroup>`).join('');

    document.querySelectorAll('.data-version-picker').forEach(sel => {
      if (sel.options.length !== versions.length) sel.innerHTML = markup;
      sel.value = activeDataVersion;
    });

    const built = timeline ? materializeWeapons(activeDataVersion) : null;
    document.querySelectorAll('.data-version-note').forEach(el => {
      const meta = timeline?.versions.find(v => v.version === activeDataVersion);
      // On a patch version every weapon is carried forward by definition, so
      // the per-weapon count adds nothing there — it only means something on a
      // sheet, where it says how much of the roster that sheet missed.
      const isSheet = sheetVersions().has(activeDataVersion);
      el.innerHTML = built
        ? `${built.list.length} weapons · ${isSheet
            ? esc(meta?.author || 'measured')
              + (built.inheritedCount ? ` · ${built.inheritedCount} carried forward from earlier sheets` : '')
            : `no sheet measured this version — carried forward from ${esc(built.basedOn || 'the last sheet')} with the patch notes since applied`}`
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
    // Retained, not lost. The sheets print "~70%" for a weapon that still does
    // 70% of its damage at max range, and the patch notes write the same figure
    // as a 0.7 multiplier — so a bigger number is a better weapon.
    { key: 'dropoff_reduction', label: 'Damage kept at max range', unit: '%', get: (s) => s.dropoff_reduction }
  ];

  // Which direction is an improvement, per metric. Damage up is a buff; time to
  // kill up is a nerf. Without this the chart would paint a slower reload green.
  const METRIC_POLARITY = {
    ttk_light: -1, ttk_medium: -1, ttk_heavy: -1,
    stk_light: -1, stk_medium: -1, stk_heavy: -1,
    empty_reload: -1, tactical_reload: -1
  };
  const metricPolarity = key => METRIC_POLARITY[key] ?? 1;

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
        document.getElementById('wp-chart-detail').innerHTML = '';
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
        <span class="badge">measured in ${availableVersions.length} of ${orderedVersions().length} versions</span>
        <span class="badge" title="The version the simulator is currently running on">sim: ${esc(activeDataVersion)}</span>
        <span class="badge">${(n => `${n} recorded change${n === 1 ? '' : 's'}`)(weapon.changes.filter(c => c.type === 'change').length)}</span>
      `;
      document.getElementById('wp-lead').textContent = weapon.alias_note
        || `Tracked across the community data sheets from ${availableVersions[0]} to ${availableVersions[availableVersions.length - 1]}.`;

      document.getElementById('wp-metric').value = activeMetric;
      expandedVersion = null;
      drawWeaponChart();
      renderVersionChips(weapon);
      renderLedgerFilters(weapon);
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
    const versions = orderedVersions();
    const resolved = statsByVersion(weapon);
    const polarity = metricPolarity(metric.key);

    // Every version gets a value, not just the ones a sheet measured — that is
    // the whole point of folding the patch records in.
    const points = versions.map((v, i) => {
      const state = resolved.get(v);
      const value = state ? metric.get(state.fields, weapon.class) : null;
      const landed = weapon.changes.filter(c => c.to_version === v && c.type !== 'coverage');
      return {
        version: v, i,
        value: Number.isFinite(value) ? value : null,
        carried: !!state?.carried,
        // Stated HERE, not merely inherited from a patch further back — every
        // version after a patch keeps pointing at it as the source.
        stated: state?.source?.kind === 'patch' && !state.carried,
        disputed: !!weapon.snapshots[v]?.rpm_disputed,
        landed
      };
    });

    // What happened to THIS metric at each version, judged by the resolved line
    // rather than by which fields the patch happened to name — a stated damage
    // change moves DPS and TTK too, and the reader is looking at one of those.
    let prevValue = null;
    for (const p of points) {
      if (p.value == null) continue;
      if (prevValue != null && Math.abs(p.value - prevValue) > 1e-9) {
        p.moved = true;
        p.kind = Math.sign(p.value - prevValue) * polarity > 0 ? 'buff' : 'nerf';
      } else if (p.landed.length) {
        // Touched here, but nothing this metric can show.
        p.kind = 'elsewhere';
      }
      prevValue = p.value;
    }

    const present = points.filter(p => p.value != null);
    if (present.length === 0) {
      mount.innerHTML = `<div class="empty-state"><div class="empty-icon">◌</div>
        <div class="empty-title">No data for this metric</div>
        <div class="empty-sub">None of the sheets covering ${esc(weapon.name)} record ${esc(metric.label.toLowerCase())}.</div></div>`;
      noteEl.textContent = '';
      return;
    }

    // Deeper bottom padding than a plain chart needs: the version ticks sit on
    // three alternating rows so adjacent updates do not collide, and the season
    // band labels get a row of their own beneath them.
    const W = 1100, H = 430, pad = { l: 64, r: 26, t: 28, b: 104 };
    const TICK_ROWS = 3;
    const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;

    let min = Math.min(...present.map(p => p.value));
    let max = Math.max(...present.map(p => p.value));
    if (min === max) { min = min - Math.abs(min || 1) * 0.2; max = max + Math.abs(max || 1) * 0.2; }
    else { const padding = (max - min) * 0.15; min -= padding; max += padding; }
    if (min > 0 && min < (max - min)) min = 0;   // keep bar-like metrics honest about zero

    // ── Season bands ──
    // Spacing versions by their position in a flat list makes the axis a
    // popularity contest: season 9 shipped 15 patches and season 1 shipped 9,
    // so a flat axis silently gives season 9 nearly twice the width and squeezes
    // the early history into a corner. Each season instead gets an equal band
    // with its versions spread evenly inside it. The axis is then ordinal, not a
    // time scale — it reads as "when in the game's life", which is the question
    // this chart is actually asked.
    const seasonOf = v => parseInt(String(v).split('.')[0], 10) || 0;
    const seasons = [...new Set(versions.map(seasonOf))].sort((a, b) => a - b);
    const bandW = plotW / seasons.length;

    const slotX = new Map();
    const bandOf = new Map();
    seasons.forEach((season, si) => {
      const inSeason = versions.filter(v => seasonOf(v) === season);
      bandOf.set(season, { start: pad.l + si * bandW, index: si });
      inSeason.forEach((v, j) => {
        slotX.set(v, pad.l + si * bandW + ((j + 0.5) / inSeason.length) * bandW);
      });
    });

    const x = i => slotX.get(versions[i]) ?? pad.l + plotW / 2;
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

    const GLYPH = { buff: '↑', nerf: '↓', soft: '—', elsewhere: '·' };

    // An update is a version where something happened to this weapon. Those get
    // a full marker, a label and a click target; every other version stays a
    // plain dot so the eye goes to the events rather than to the grid.
    const dots = present.map(p => {
      const isUpdate = p.landed.length > 0;
      const tone = p.kind || 'soft';
      const summary = p.landed.length
        ? `${p.landed.length} change${p.landed.length === 1 ? '' : 's'}`
        : 'no recorded change';

      if (!isUpdate) {
        return `<circle class="chart-dot${p.carried ? ' carried' : ''}" cx="${x(p.i)}" cy="${y(p.value)}" r="2.5">
          <title>${esc(p.version)} — ${esc(fmtMetric(metric, p.value))} (carried forward, ${esc(summary)})</title></circle>`;
      }

      return `<g class="chart-mark ${tone}${p.version === activeVersion ? ' selected' : ''}"
          role="button" tabindex="0" data-version="${esc(p.version)}"
          aria-label="${esc(p.version)}: ${esc(fmtMetric(metric, p.value))}, ${esc(summary)}">
        <circle class="hit" cx="${x(p.i)}" cy="${y(p.value)}" r="14" />
        <circle class="ring" cx="${x(p.i)}" cy="${y(p.value)}" r="6.5" />
        <circle class="core" cx="${x(p.i)}" cy="${y(p.value)}" r="4.5" />
        <title>${esc(p.version)} — ${esc(fmtMetric(metric, p.value))}${p.moved ? '' : ' (unchanged on this metric)'}, ${esc(summary)}${p.disputed ? ' · disputed source value' : ''}</title>
      </g>`;
    }).join('');

    // Direct-label only the updates that actually moved this metric, plus the
    // endpoints. A number over all 29 versions is unreadable.
    const labelled = new Set([present[0], present[present.length - 1], ...present.filter(p => p.moved)]);
    const valueLabels = [...labelled].map(p => `
      <text class="chart-value ${p.kind || ''}" x="${x(p.i)}" y="${y(p.value) - 13}"
        text-anchor="middle">${esc(fmtMetric(metric, p.value))}</text>`).join('');

    // Version ticks, only where something landed — a label per version would be
    // mush. The trailing ".0" is dropped because it is the same on almost every
    // version and buys nothing but width; the full number stays in the tooltip.
    const updates = points.filter(p => p.landed.length && p.value != null);
    const shortVersion = v => v.replace(/\.0$/, '');
    const xLabels = updates.map((p, n) => `
      <g class="chart-xlabel ${p.kind || 'soft'}${p.version === activeVersion ? ' selected' : ''}"
         role="button" tabindex="0" data-version="${esc(p.version)}">
        <text x="${x(p.i)}" y="${H - 6 - (TICK_ROWS - 1 - (n % TICK_ROWS)) * 14}" text-anchor="middle">
          <tspan class="glyph">${GLYPH[p.kind] || GLYPH.soft}</tspan> ${esc(shortVersion(p.version))}
          <title>${esc(p.version)}</title></text>
      </g>`).join('');

    // Alternating fills rather than divider rules: a band you can see the width
    // of tells you which season a point sits in without tracing a line down to
    // the axis, and it stays readable behind the plot.
    const seasonBands = seasons.map(season => {
      const { start, index } = bandOf.get(season);
      const hasUpdate = updates.some(p => seasonOf(p.version) === season);
      return `
        <g class="season-band${index % 2 ? ' alt' : ''}${hasUpdate ? ' live' : ''}">
          <rect x="${start}" y="${pad.t}" width="${bandW}" height="${plotH}" />
          <text x="${start + bandW / 2}" y="${H - 6}" text-anchor="middle">S${season}</text>
        </g>`;
    }).join('');

    mount.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img"
        aria-label="${esc(metric.label)} for ${esc(weapon.name)} across ${versions.length} versions in ${seasons.length} seasons, ${updates.length} of them updates">
        ${seasonBands}
        ${grid}
        <line class="chart-axis-line" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + plotH}" />
        <line class="chart-axis-line" x1="${pad.l}" y1="${pad.t + plotH}" x2="${W - pad.r}" y2="${pad.t + plotH}" />
        ${lines}${dots}${valueLabels}${xLabels}
      </svg>`;

    // Marker and axis tick are two handles on the same thing, so both open it.
    mount.querySelectorAll('[data-version]').forEach(el => {
      const open = () => selectChartVersion(el.dataset.version);
      el.addEventListener('click', open);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });

    renderChartDetail(weapon);

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

    // The line is two kinds of evidence spliced together, and saying which is
    // which matters more than the shape does: a measured point is somebody
    // capturing the game, a stated one is the developers describing it.
    const measured = present.filter(p => !p.carried && !p.stated).length;
    const stated = present.filter(p => p.stated).length;

    noteEl.innerHTML = [
      headline + excursionNote,
      `Plotted across ${present.length} versions — ${measured} measured from a data sheet, ${stated} stated in a patch note, the rest carried forward unchanged.`,
      updates.length ? `${updates.length} update${updates.length === 1 ? '' : 's'} touched this weapon; click one to read what landed.` : '',
      missing.length ? `Nothing recorded before ${first.version} (${missing.length} earlier version${missing.length === 1 ? '' : 's'}); dashed segments span a coverage gap, not a straight-line change.` : ''
    ].filter(Boolean).join(' ');
  }

  // ── Update detail, expanded from the chart ───────────────────────
  let expandedVersion = null;

  function selectChartVersion(version, opts = {}) {
    // Clicking the open one closes it, so the chart can be read unobstructed.
    // Clicking the open one closes it — except when the click came from a
    // version chip, where "snap to this" should never mean "close it".
    expandedVersion = (expandedVersion === version && opts.scrollTo !== 'chart') ? null : version;
    const weapon = timeline?.weapons[activeWeaponId];
    if (!weapon) return;
    drawWeaponChart();
    // The chart, the chips and the ledger are three views of one selection, so
    // opening an update in any of them opens it in all.
    renderVersionChips(weapon);
    renderChangeLog(weapon);
    if (!expandedVersion) return;

    const target = opts.scrollTo === 'chart'
      ? document.getElementById('wp-chart')
      : document.getElementById('wp-chart-detail');
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Where a version is both, the two entries carry different halves of the
  // story — the sheet knows who measured it, the patch entry knows the date and
  // the link — so they are merged rather than picked between.
  function versionMeta(version) {
    const entries = (timeline?.versions || []).filter(v => v.version === version);
    if (!entries.length) return null;
    const merged = Object.assign({}, ...entries);
    merged.kind = entries.some(e => e.kind === 'sheet') ? 'sheet' : 'patch';
    merged.alsoPatched = entries.length > 1;
    return merged;
  }

  function renderChartDetail(weapon) {
    const mount = document.getElementById('wp-chart-detail');
    if (!mount) return;
    if (!expandedVersion) { mount.innerHTML = ''; return; }

    const meta = versionMeta(expandedVersion);
    const landed = weapon.changes.filter(c => c.to_version === expandedVersion && c.type !== 'coverage');

    mount.innerHTML = `
      <div class="update-card">
        <div class="update-head">
          <div>
            <span class="update-version">${esc(expandedVersion)}</span>
            ${meta?.title ? `<span class="update-title">${esc(meta.title)}</span>` : ''}
          </div>
          <div class="update-meta">
            ${meta?.date ? `<span>${esc(meta.date)}</span>` : ''}
            ${meta?.kind === 'sheet' ? `<span>measured by ${esc(meta.author)}${meta.alsoPatched ? ', and stated in the patch notes' : ''}</span>` : ''}
            ${meta?.url ? `<a href="${esc(meta.url)}" target="_blank" rel="noopener">patch notes ↗</a>` : ''}
            <button class="update-close" type="button" aria-label="Close">✕</button>
          </div>
        </div>
        ${tallyRow(landed)}
        <div class="update-body">
          ${landed.length
            ? landed.map(changeLine).join('')
            : `<div class="change-line coverage">Nothing recorded for ${esc(weapon.name)} in this version.</div>`}
        </div>
      </div>`;

    mount.querySelector('.update-close')?.addEventListener('click', () => selectChartVersion(expandedVersion));
  }

  // Counts by kind. Dev notes are excluded — they explain changes, they are not
  // changes, so counting them would inflate every tally.
  function tallyRow(list) {
    const counts = { buff: 0, nerf: 0, soft: 0 };
    for (const c of list) if (c.type !== 'dev_note' && counts[c.kind] != null) counts[c.kind]++;
    const chips = ['buff', 'nerf', 'soft']
      .filter(k => counts[k])
      .map(k => `<span class="tally ${k}"><span class="glyph">${KIND_MARK[k].glyph}</span>${counts[k]} ${
        k === 'soft' ? 'soft' : k}${counts[k] === 1 || k === 'soft' ? '' : 's'}</span>`);
    const devs = list.filter(c => c.type === 'dev_note').length;
    if (devs) chips.push(`<span class="tally dev">${devs} dev note${devs === 1 ? '' : 's'}</span>`);
    return chips.length ? `<div class="tally-row">${chips.join('')}</div>` : '';
  }

  // ── Version chips + snapshot ─────────────────────────────────────
  // Only the versions where something happened to THIS weapon get a chip. With
  // 137 versions on record a full list is a wall, and a chip for a version that
  // changed nothing snaps the chart to a point with nothing to read.
  function renderVersionChips(weapon) {
    const mount = document.getElementById('wp-versions');
    const touched = orderedVersions().filter(v =>
      weapon.snapshots[v] || weapon.changes.some(c => c.to_version === v && c.type !== 'coverage')
    );

    mount.innerHTML = touched.map(version => {
      const measured = !!weapon.snapshots[version];
      return `<button class="vchip${version === expandedVersion ? ' active' : ''}${measured ? ' measured' : ''}"
        type="button" data-version="${esc(version)}"
        title="${measured ? 'Measured by a data sheet' : 'Stated in the patch notes'}">${esc(version)}</button>`;
    }).join('');

    // Snapping to a version is the same act as clicking its marker, so it runs
    // through the same path — the chart, the detail card and the ledger all
    // follow one selection rather than three.
    mount.querySelectorAll('.vchip').forEach(chip => {
      chip.addEventListener('click', () => {
        activeVersion = chip.dataset.version;
        selectChartVersion(chip.dataset.version, { scrollTo: 'chart' });
      });
    });
  }

  function statRow(label, value, extra) {
    return `<div class="srow"><span class="skey">${esc(label)}</span><span class="sval">${value}</span>${
      extra ? `<span class="snote">${esc(extra)}</span>` : ''}</div>`;
  }

  /**
   * The weapon's full stat block as of a version, for embedding in a ledger
   * entry. It reads the RESOLVED state rather than the raw sheet row, so a
   * patch-note version — which no sheet measured — still shows where the
   * weapon actually stood once that patch landed.
   */
  function statBlock(weapon, version) {
    const state = statsByVersion(weapon).get(version);
    if (!state) return '';

    const snap = state.fields;
    const meta = versionMeta(version);
    const raw = weapon.snapshots[version] || {};
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

    const qualifiers = weapon.changes.filter(c => c.to_version === version && c.type === 'definition');
    const caveats = [...(raw.notes || []), ...(meta?.caveats || [])];

    // Say where the numbers came from. Carried-forward values are the common
    // case once patch records are in, and reading them as a fresh measurement
    // would badly overstate how much anyone actually checked.
    const provenance = state.carried
      ? `Carried forward from ${esc(state.source.version)} — nothing changed these since.`
      : state.source.kind === 'sheet'
        ? `Measured in the ${esc(version)} sheet${meta?.author ? ` by ${esc(meta.author)}` : ''}.`
        : `Stated in the ${esc(version)} patch notes; no sheet measured this version.`;

    return `
      <div class="stat-block">
        <div class="stat-block-head">
          <span class="section-label">Stats at ${esc(version)}</span>
          <span class="stat-block-src">${provenance}${
            version === activeDataVersion ? ' · the version the simulator runs on' : ''}</span>
        </div>

        <div class="ttk-grid">${ttkRows}</div>

        <div class="stat-rows">
          ${statRow('Body damage', snap.body_dmg ?? '—')}
          ${statRow('Head damage', snap.head_dmg ?? '—')}
          ${statRow('Rate of fire', snap.rpm != null ? snap.rpm + ' RPM'
            : raw.rpm_source_value != null ? `<span class="withheld">${raw.rpm_source_value} RPM — withheld</span>` : '—')}
          ${statRow('Magazine', snap.magazine_size ?? '—')}
          ${statRow('Damage per magazine', dpm ?? '—')}
          ${statRow('Sustained DPS', dps == null ? '—' : dps.toFixed(0))}
          ${statRow('Empty reload', snap.empty_reload != null ? snap.empty_reload.toFixed(2) + 's' : '—',
            snap.empty_reload != null && !raw.reload_kind_known ? 'kind unknown' : '')}
          ${statRow('Tactical reload', snap.tactical_reload != null ? snap.tactical_reload.toFixed(2) + 's' : '—')}
          ${snap.shots_per_burst ? statRow('Burst', `${snap.shots_per_burst} shots, ${snap.burst_delay ?? '—'}s between bursts`) : ''}
          ${statRow('Dropoff', snap.dropoff_min != null
            ? `${snap.dropoff_min}m → ${snap.dropoff_max ?? '?'}m${snap.dropoff_reduction != null ? ` (keeps ${snap.dropoff_reduction}% past that)` : ''}`
            : '—')}
        </div>

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
      </div>`;
  }

  // Buff, nerf or soft change. The ingest decides this — it knows each field's
  // polarity and it has the numbers — so the UI only picks a glyph. Working it
  // out again here is how the two drift apart: this used to hold its own
  // polarity list, and that list had dropoff_reduction backwards, painting
  // every falloff buff red.
  const KIND_MARK = {
    buff: { glyph: '↑', title: 'Buff — better for the wielder' },
    nerf: { glyph: '↓', title: 'Nerf — worse for the wielder' },
    soft: { glyph: '—', title: 'Soft change — an interaction or an untracked stat' }
  };

  function kindMark(kind) {
    return KIND_MARK[kind] || KIND_MARK.soft;
  }

  function changeText(c) {
    const { glyph, title } = kindMark(c.kind);
    const flag = c.shadow_change_candidate
      ? `<span class="conf shadow" title="${esc(c.note || '')}">unannounced</span>` : '';

    // A stat recorded for the first time has a value but no direction, so it
    // gets the arrow-free treatment rather than a made-up baseline.
    const values = c.from == null
      ? `<span class="chg-values ${c.kind}" title="${title}">set to ${c.to}</span>`
      : `<span class="chg-values ${c.kind}" title="${title}">${c.from} ${glyph} ${c.to}</span>
         <span class="chg-delta ${c.kind}">${c.delta > 0 ? '+' : ''}${c.delta}${c.delta_pct != null ? ` (${c.delta_pct > 0 ? '+' : ''}${c.delta_pct}%)` : ''}</span>`;

    return `<span class="chg-field">${esc(c.label)}</span>
      ${values}
      <span class="conf ${c.confidence}">${c.confidence}</span>${flag}`;
  }

  // ── Change ledger ────────────────────────────────────────────────
  //
  // Every recorded change for this weapon as one running list, newest first,
  // grouped by the version it landed in. Grouping by version rather than by the
  // old "8.3.0 → 10.0.0" transition is what lets a patch record and a sheet diff
  // sit in the same entry: they describe the same moment, they just came from
  // different evidence.
  const LEDGER_FILTERS = [
    { key: 'all', label: 'Everything' },
    { key: 'buff', label: 'Buffs' },
    { key: 'nerf', label: 'Nerfs' },
    { key: 'soft', label: 'Soft' }
  ];
  let activeLedgerFilter = 'all';

  function renderLedgerFilters(weapon) {
    const mount = document.getElementById('wp-ledger-filters');
    if (!mount) return;

    const counts = { all: 0, buff: 0, nerf: 0, soft: 0 };
    for (const c of weapon.changes) {
      if (c.type === 'dev_note' || c.type === 'coverage') continue;
      counts.all++;
      if (counts[c.kind] != null) counts[c.kind]++;
    }

    mount.innerHTML = LEDGER_FILTERS.map(f => `
      <button class="lfilter ${f.key}${activeLedgerFilter === f.key ? ' active' : ''}"
        type="button" data-filter="${f.key}" ${counts[f.key] ? '' : 'disabled'}>
        ${f.key === 'all' ? '' : `<span class="glyph">${KIND_MARK[f.key].glyph}</span>`}${esc(f.label)}
        <span class="lcount">${counts[f.key]}</span>
      </button>`).join('');

    mount.querySelectorAll('.lfilter').forEach(btn => {
      btn.addEventListener('click', () => {
        activeLedgerFilter = btn.dataset.filter;
        renderLedgerFilters(weapon);
        renderChangeLog(weapon);
      });
    });
  }

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
      if (!groups.has(c.to_version)) groups.set(c.to_version, []);
      groups.get(c.to_version).push(c);
    }

    const ordered = [...groups.keys()].sort(compareVersions).reverse();

    // A dev note explains the changes beside it, so it rides along with them
    // rather than being filtered out on its own.
    const keep = list => activeLedgerFilter === 'all'
      ? list
      : list.filter(c => c.kind === activeLedgerFilter || c.type === 'dev_note');

    const rows = ordered.map(version => {
      const list = keep(groups.get(version));
      if (!list.length || list.every(c => c.type === 'dev_note')) return '';

      const meta = versionMeta(version);
      const isSheet = meta?.kind === 'sheet';
      // 11.3.0 is both measured and patched. Saying only "measured" would hide
      // that its numbers were also stated outright.
      const sourceLabel = meta?.alsoPatched ? 'measured + patch note' : isSheet ? 'measured' : 'patch note';

      return `
        <details class="ledger-entry${version === expandedVersion ? ' lit' : ''}" ${version === expandedVersion ? 'open' : ''}>
          <summary>
            <span class="ledger-version">${esc(version)}</span>
            <span class="ledger-source ${isSheet ? 'sheet' : 'patch'}">${sourceLabel}</span>
            ${meta?.date ? `<span class="ledger-date">${esc(meta.date)}</span>` : ''}
            ${tallyRow(list)}
          </summary>
          <div class="ledger-body">
            ${meta?.url ? `<a class="ledger-link" href="${esc(meta.url)}" target="_blank" rel="noopener">${esc(meta.title || 'Patch notes')} ↗</a>` : ''}
            ${list.map(changeLine).join('')}
            ${statBlock(weapon, version)}
          </div>
        </details>`;
    }).filter(Boolean).join('');

    mount.innerHTML = rows || `<div class="empty-state"><div class="empty-icon">◌</div>
      <div class="empty-title">Nothing matches that filter</div>
      <div class="empty-sub">No ${esc(activeLedgerFilter)} changes are recorded for ${esc(weapon.name)}.</div></div>`;
  }

  function changeLine(c) {
    if (c.type === 'change') return `<div class="change-line">${changeText(c)}</div>`;

    // Developer commentary explaining a patch. It is the "why" beside the
    // "what", so it is never given an arrow — nothing about it is a change.
    if (c.type === 'dev_note') {
      return `<div class="change-line dev-note">
        <span class="dev-label">Dev note</span><span>${esc(c.note)}</span></div>`;
    }

    // A stated change with no tracked stat behind it: the patch note's own
    // wording is all there is, so it carries the whole line.
    if (c.type === 'note') {
      const { glyph, title } = kindMark(c.kind);
      return `<div class="change-line">
        <span class="chg-mark ${c.kind}" title="${title}">${glyph}</span>
        <span class="chg-prose">${esc(c.note)}</span></div>`;
    }

    return `<div class="change-line coverage">${esc(c.note)}</div>`;
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
  // HEALING
  //
  // A heal "attached" to a fighter is an off-screen support healing them —
  // a pocket healer. Two of the four sources cannot heal the person holding
  // them, so modelling it any other way would leave the beam and the
  // infuser unusable in a duel.
  //
  // Items can be picked at versions before they existed. That is deliberate:
  // Season 1's beam against the ball's launch build is a fair question, and
  // refusing it would be worse than answering it with a label. Everything
  // renders off `provenance`, so a theoretical number cannot reach the
  // screen without being marked as one.
  // ═════════════════════════════════════════════════════════════════

  const HEAL_ORDER = ['beam', 'ball', 'infuser', 'canister'];

  let healTimeline = null;
  let healTimelinePromise = null;

  // Which player's chip row is currently showing its add menu, if any.
  let healMenuOpenFor = null;

  // Items already warned about this session. Cleared on a version change.
  const warnedTheoretical = new Set();

  const healStacks = { 1: [], 2: [] };

  function loadHealTimeline() {
    if (healTimelinePromise) return healTimelinePromise;
    healTimelinePromise = fetch('./csv/cleaned/heal_timeline.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => (healTimeline = data))
      .catch(err => {
        console.warn('Heal data unavailable — run: node tools/ingest_heals.mjs', err);
        return null;
      });
    return healTimelinePromise;
  }

  function healAt(id) {
    if (!healTimeline) return null;
    return resolveHealAt(healTimeline, id, activeDataVersion);
  }

  // ── The kit roster ──
  // csv/gadgets/ carries every specialization, gadget and carriable. Most
  // of it is roster only, and that is what the loadout rules run on: the
  // four heal sources appear there too, so a Heal Beam can be recognised
  // as a Medium specialization competing for the same slot as a Guardian
  // Turret. Only the two shields carry numbers this screen simulates.
  const SHIELD_ORDER = ['mesh', 'dome'];

  let gadgetTimeline = null;
  let gadgetTimelinePromise = null;

  function loadGadgetTimeline() {
    if (gadgetTimelinePromise) return gadgetTimelinePromise;
    gadgetTimelinePromise = fetch('./csv/cleaned/gadget_timeline.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => (gadgetTimeline = data))
      .catch(err => {
        console.warn('Gadget data unavailable — run: node tools/ingest_gadgets.mjs', err);
        return null;
      });
    return gadgetTimelinePromise;
  }

  function gadgetAt(id) {
    if (!gadgetTimeline) return null;
    return resolveGadgetAt(gadgetTimeline, id, activeDataVersion);
  }

  /** Display name for anything in a kit, heal source or shield. */
  function itemName(id) {
    return healTimeline?.items[id]?.name || gadgetTimeline?.items[id]?.name || id;
  }

  /** Resolved items for one player's stack, in a stable order. */
  function resolvedStack(player) {
    return HEAL_ORDER
      .filter(id => healStacks[player].includes(id))
      .map(healAt)
      .filter(Boolean);
  }

  /** Average HP/s a stack delivers over a window — for labelling only. */
  function stackRate(items, seconds = 7) {
    if (!items.length) return 0;
    return combineSchedules(items).deliveredBy(seconds) / seconds;
  }

  // battle_simulator.js runs the 1v1 and reads these when it starts a duel.
  window.resolveHealStack = player => {
    const items = resolvedStack(player);
    return items.length ? combineSchedules(items) : null;
  };
  window.healStackSummary = player => {
    const items = resolvedStack(player);
    if (!items.length) return null;
    return {
      ids: items.map(i => i.id),
      names: items.map(i => i.name),
      theoretical: items.some(i => i.provenance === 'theoretical'),
      ratePer7s: stackRate(items)
    };
  };

  // ── Stats page reference table ──
  function renderHealStats() {
    const mount = document.getElementById('heal-stats');
    if (!mount) return;
    if (!healTimeline) { mount.innerHTML = ''; return; }

    const rows = HEAL_ORDER.map(id => {
      const item = healAt(id);
      if (!item) return '';
      const meta = healTimeline.items[id];
      const theoretical = item.provenance === 'theoretical';
      const f = item.fields;

      // Each kind is described by different numbers, so the detail column
      // says what that kind actually does rather than forcing all four into
      // one set of weapon-shaped fields.
      const detail =
        item.kind === 'targeted'
          ? `${f.heal_rate} HP/s · overheats after ${f.overheat_time}s (${(f.heal_rate * f.overheat_time).toFixed(0)} HP) · ${f.overheat_cooldown}s cooldown · ${f.range}m`
          : item.kind === 'projectile'
          ? `${f.heal_per_shot} HP/shot · ${f.capacity} charges (${f.heal_per_shot * f.capacity} HP) · ${f.rpm} RPM · ${f.recharge_delay}s before refill`
          : id === 'ball'
          ? `${f.ramp_from}→${f.ramp_to} HP/s over ${f.ramp_time}s · ${f.radius}m radius · ${f.device_hp} HP device · ${f.cooldown}s cooldown`
          : `${f.burst_heal} HP on contact · then ${f.heal_rate} HP/s for ${f.active_duration}s · ${f.radius}m radius`;

      return `<tr>
        <td><strong>${esc(item.name)}</strong><br><span class="doc-note">${esc(meta.source_slot)}</span></td>
        <td>${stackRate([item]).toFixed(0)} HP/s</td>
        <td>${esc(detail)}</td>
        <td>${item.self_heal ? 'yes' : 'no'}</td>
        <td>${theoretical
              ? `<span style="color:var(--soft)">⚠ ${esc(item.sourceVersion)} values — did not exist until ${esc(item.introducedAt)}</span>`
              : `${esc(item.sourceVersion)}${item.provenance === 'carried' ? ' (carried)' : ''}`}</td>
      </tr>`;
    }).join('');

    mount.innerHTML = `<table class="sustain-rank">
      <thead><tr>
        <th>Source</th><th>Avg over 7s</th><th>How it heals</th><th>Self-heals</th><th>Data from</th>
      </tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  // ── Stats page: the shields, and the roster behind them ──
  function renderGadgetStats() {
    renderShieldStats();
    renderGadgetRoster();
  }

  function renderShieldStats() {
    const mount = document.getElementById('shield-stats');
    if (!mount) return;
    if (!gadgetTimeline) { mount.innerHTML = ''; return; }

    const rows = SHIELD_ORDER.map(id => {
      const item = gadgetAt(id);
      if (!item || !item.fields) return '';
      const f = item.fields;
      const theoretical = item.provenance === 'theoretical';
      const meta = gadgetTimeline.items[id];

      const detail = [
        `${f.device_hp} HP`,
        f.duration != null ? `${f.duration}s once deployed` : 'stands until it is broken',
        f.radius != null ? `${f.radius}m radius — nothing inside it is covered` : 'covers the arc it faces',
        f.cooldown != null ? `${f.cooldown}s cooldown` : 'paid for out of an energy pool'
      ].join(' · ');

      return `<tr>
        <td><strong>${esc(item.name)}</strong><br><span class="doc-note">${esc(item.classes.join('/'))} ${esc(item.slot)}</span></td>
        <td>${f.device_hp} HP</td>
        <td>${esc(detail)}</td>
        <td>${esc(meta.notes || '')}</td>
        <td>${theoretical
              ? `<span style="color:var(--soft)">⚠ ${esc(item.sourceVersion)} values — did not exist until ${esc(item.introducedAt)}</span>`
              : `${esc(item.sourceVersion)}${item.provenance === 'carried' ? ' (carried)' : ''}`}</td>
      </tr>`;
    }).join('');

    mount.innerHTML = `<table class="sustain-rank">
      <thead><tr>
        <th>Shield</th><th>Absorbs</th><th>How it behaves</th><th>What it is</th><th>Data from</th>
      </tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  function renderGadgetRoster() {
    const mount = document.getElementById('gadget-roster');
    if (!mount) return;
    if (!gadgetTimeline) { mount.innerHTML = ''; return; }

    const items = Object.values(gadgetTimeline.items);
    // Grouped the way the loadout screen is: specializations first, then
    // gadgets, each in light-medium-heavy order with the shared ones last.
    const slotOrder = { specialization: 0, gadget: 1, carriable: 2 };
    const classOrder = { light: 0, medium: 1, heavy: 2 };
    const sorted = items.slice().sort((a, b) =>
      (slotOrder[a.slot] - slotOrder[b.slot]) ||
      (a.classes.length - b.classes.length) ||
      (classOrder[a.classes[0]] - classOrder[b.classes[0]]) ||
      a.name.localeCompare(b.name));

    const modelled = { heals: 'healing', shield: 'shield', none: '—' };

    const rows = sorted.map(item => `<tr>
      <td><strong>${esc(item.name)}</strong></td>
      <td>${esc(item.classes.length === 3 ? 'all' : item.classes.join('/'))}</td>
      <td>${esc(item.slot)}</td>
      <td>${esc(item.category)}</td>
      <td>${esc(modelled[item.model] || item.model)}</td>
      <td class="doc-note">${esc(item.notes || '')}</td>
    </tr>`).join('');

    const counts = ['specialization', 'gadget', 'carriable']
      .map(slot => `${items.filter(i => i.slot === slot).length} ${slot}s`).join(', ');
    const unknown = items.filter(i => !i.introduced).length;

    mount.innerHTML = `<table class="sustain-rank">
      <thead><tr>
        <th>Item</th><th>Class</th><th>Slot</th><th>Does</th><th>Simulated</th><th>Notes</th>
      </tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="doc-note">${counts}. ${unknown} of them have no recorded introduction version yet —
      marked <code>?</code> in <code>csv/gadgets/items.csv</code> rather than guessed.</p>`;
  }

  // ── Chip row ──
  function renderHealStacks() { [1, 2].forEach(renderHealStack); }

  function renderHealStack(player) {
    const mount = document.getElementById(`p${player}-heals`);
    if (!mount) return;

    if (!healTimeline) {
      mount.innerHTML = '<span class="sidebar-hint">Heal data unavailable.</span>';
      return;
    }

    const items = resolvedStack(player);
    const chips = items.map(item => {
      const theoretical = item.provenance === 'theoretical';
      const rate = stackRate([item]).toFixed(0);
      return `<span class="heal-chip ${theoretical ? 'theoretical' : ''}">
        ${esc(item.name)}
        <span class="heal-rate">${rate}/s</span>
        ${theoretical ? `<span class="heal-warn" title="Did not exist at ${esc(activeDataVersion)} — using ${esc(item.sourceVersion)} values">⚠</span>` : ''}
        <button class="heal-remove" type="button" data-heal-remove="${esc(item.id)}" data-player="${player}" aria-label="Remove ${esc(item.name)}">✕</button>
      </span>`;
    }).join('');

    const remaining = HEAL_ORDER.filter(id => !healStacks[player].includes(id));
    const menu = healMenuOpenFor === player && remaining.length
      ? `<div class="heal-menu">${remaining.map(id => {
            const item = healAt(id);
            if (!item) return '';
            const theoretical = item.provenance === 'theoretical';
            return `<button class="heal-add" type="button" data-heal-add="${esc(id)}" data-player="${player}">
              ${esc(item.name)} ${theoretical ? '⚠' : ''}
            </button>`;
          }).join('')}</div>`
      : '';

    mount.innerHTML = chips +
      `<button class="heal-add" type="button" data-heal-menu="${player}" ${remaining.length ? '' : 'disabled'}>
        ${healMenuOpenFor === player ? '− close' : '+ heal item'}
      </button>` + menu;

    const note = document.getElementById(`p${player}-heal-rate`);
    if (note) {
      if (!items.length) note.textContent = 'No support. Health only ever goes down.';
      else {
        const anyTheoretical = items.some(i => i.provenance === 'theoretical');
        // Two overlapping fields pay the higher rate, not both — worth saying
        // out loud, or the second one looks like it did nothing.
        const zones = items.filter(i => i.kind === 'zone');
        note.innerHTML = `${stackRate(items).toFixed(0)} HP/s averaged over a 7s hold` +
          (zones.length > 1
            ? ` · <span style="color:var(--soft)">${esc(zones.map(z => z.name).join(' and '))} overlap — only the higher rate counts</span>`
            : '') +
          (anyTheoretical ? ' · <span style="color:var(--soft)">contains theoretical items</span>' : '');
      }
    }
  }

  function addHeal(player, id) {
    const item = healAt(id);
    if (!item) return;

    const commit = () => {
      if (!healStacks[player].includes(id)) healStacks[player].push(id);
      healMenuOpenFor = null;
      renderHealStack(player);
      redrawArena();
    };

    if (item.provenance === 'theoretical' && !warnedTheoretical.has(id)) {
      warnedTheoretical.add(id);
      showTheoreticalWarning(item, commit);
      return;
    }
    commit();
  }

  function initHealPickers() {
    document.addEventListener('click', e => {
      const menuBtn = e.target.closest('[data-heal-menu]');
      if (menuBtn) {
        const player = +menuBtn.dataset.healMenu;
        healMenuOpenFor = healMenuOpenFor === player ? null : player;
        renderHealStack(player);
        return;
      }

      const addBtn = e.target.closest('[data-heal-add]');
      if (addBtn) { addHeal(+addBtn.dataset.player, addBtn.dataset.healAdd); return; }

      const removeBtn = e.target.closest('[data-heal-remove]');
      if (removeBtn) {
        const player = +removeBtn.dataset.player;
        const id = removeBtn.dataset.healRemove;
        healStacks[player] = healStacks[player].filter(x => x !== id);
        renderHealStack(player);
        redrawArena();
      }
    });
  }

  // ── Theoretical warning ──
  function showTheoreticalWarning(item, onConfirm) {
    const modal = document.getElementById('heal-modal');
    const body = document.getElementById('heal-modal-body');
    if (!modal || !body) { onConfirm(); return; }

    const rate = stackRate([item]).toFixed(0);
    body.innerHTML = `
      <p><strong>${esc(item.name)}</strong> did not exist in
      <code>${esc(activeDataVersion)}</code>. It was introduced in
      <code>${esc(item.introducedAt)}</code>.</p>
      <p>Using its <code>${esc(item.sourceVersion)}</code> values —
      about <strong>${rate} HP/s</strong> across a 7 second hold.</p>
      <p class="modal-sub">Results using this loadout are theoretical and cannot be
      compared to real ${esc(activeDataVersion)} play. The item stays marked
      wherever it appears.</p>`;

    const confirm = document.getElementById('heal-modal-confirm');
    const cancel = document.getElementById('heal-modal-cancel');

    const close = () => {
      modal.hidden = true;
      confirm.removeEventListener('click', accept);
      cancel.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
    const accept = () => { close(); onConfirm(); };
    const onKey = e => { if (e.key === 'Escape') close(); };

    confirm.addEventListener('click', accept);
    cancel.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    modal.hidden = false;
    confirm.focus();
  }

  // ═════════════════════════════════════════════════════════════════
  // SUSTAIN ANALYSIS
  //
  // Not "who wins" but "did you last long enough". Holding an objective is
  // a time question, and a win rate cannot answer it.
  // ═════════════════════════════════════════════════════════════════

  const SUSTAIN_SAMPLE_STEP = 0.25;
  const SUSTAIN_SAMPLE_MAX = 20;

  // Squad sizes solved every run. All three are solved together so the
  // 1-vs-2-vs-3 comparison is a click rather than another few minutes.
  const SUSTAIN_ATTACKER_COUNTS = [1, 2, 3];

  let sustainWindow = 7;
  let sustainAttackers = 1;
  let sustainResults = null;

  // Whether the shields are in the kit space at all. They multiply the grid
  // by about three, so skipping them is a real option on a slow machine —
  // and the run it skips is the one nobody is asking for when the question
  // is purely about healing.
  let sustainUseShields = true;

  // How often the Mesh is assumed to be facing the right way. This is an
  // assumption rather than a measurement (see gadgets.js), so it is a
  // control rather than a constant — and because it is applied by blending
  // two solved kits rather than by re-solving anything, moving it is
  // instant. The Dome needs no such knob: whether it covers you is decided
  // by its radius against the range, which is geometry.
  let meshCoverage = MESH_COVERAGE;

  const sustainClass = () => document.getElementById('sustain-class')?.value || 'medium';
  const sustainDistance = () => +(document.getElementById('sustain-distance')?.value || 15);
  const sustainProfile = () => document.getElementById('sustain-profile')?.value || 'Average';
  const sustainStagger = () => document.getElementById('sustain-stagger')?.value || 'spread';

  const sampleIndexFor = seconds => Math.round(seconds / SUSTAIN_SAMPLE_STEP);

  /**
   * Every kit a squad of three can legally bring, for a defender of this class.
   *
   * Not every subset: a Heal Beam is a Medium specialization, an H+ Infuser
   * is a Light gadget and a Mesh Shield is a Heavy specialization, so
   * wanting all three means wanting three specific teammates and you have
   * two. gadgets.js does the seating; what comes back is what a real squad
   * can field. See its header for why that filter is worth having.
   */
  function sustainKits() {
    if (!healTimeline || !gadgetTimeline) return [];

    const ids = sustainUseShields ? [...HEAL_ORDER, ...SHIELD_ORDER] : [...HEAL_ORDER];
    const roster = ids.map(gadgetAt).filter(Boolean);
    if (roster.length !== ids.length) return [];

    return allLegalKits(roster, sustainClass()).map(kit => {
      const healIds = kit.ids.filter(id => HEAL_ORDER.includes(id));
      const shieldIds = kit.ids.filter(id => SHIELD_ORDER.includes(id));
      return {
        ids: kit.ids,
        healIds,
        shieldIds,
        // The heal numbers come from csv/heals/; the gadget row only knows
        // which slot the thing occupies.
        healItems: healIds.map(healAt).filter(Boolean),
        shieldItems: shieldIds.map(gadgetAt).filter(Boolean)
      };
    });
  }

  const kitKeyOf = ids => ids.join('+') || 'none';

  function stackLabel(ids) {
    if (!ids.length) return 'none';
    return ids.map(itemName).join(' + ');
  }

  function stackIsTheoretical(ids) {
    return ids.some(id => (HEAL_ORDER.includes(id) ? healAt(id) : gadgetAt(id))?.provenance === 'theoretical');
  }

  /** Total absorbing HP a kit's shields are worth, before any coverage. */
  function kitShieldPool(shieldIds) {
    return shieldIds.reduce((sum, id) => sum + (gadgetAt(id)?.fields?.device_hp || 0), 0);
  }

  function closeMatchupPanels() {
    document.querySelectorAll('.rank-bar-cell.is-open').forEach(cell => {
      cell.classList.remove('is-open');
      cell.querySelector('.sustain-bar-btn')?.setAttribute('aria-expanded', 'false');
    });
  }

  function initSustainPanel() {
    const dist = document.getElementById('sustain-distance');
    if (dist && typeof getDistances === 'function') {
      dist.innerHTML = getDistances()
        .map(d => `<option value="${d}" ${d === 15 ? 'selected' : ''}>${d}m</option>`).join('');
    }

    const prof = document.getElementById('sustain-profile');
    if (prof && typeof getAimProfiles === 'function') {
      prof.innerHTML = getAimProfiles()
        .map(p => `<option value="${esc(p.name)}" ${p.name === 'Average' ? 'selected' : ''}>${esc(p.name)} — ${Math.round(p.acc * 100)}% acc</option>`).join('');
    }

    document.querySelectorAll('#sustain-window-group .tbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sustain-window-group .tbtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sustainWindow = +btn.dataset.window;
        updateSustainEstimate();
        if (sustainResults) renderSustain(sustainResults, 'sustain-grid');
      });
    });

    document.querySelectorAll('#sustain-attackers-group .tbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sustain-attackers-group .tbtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sustainAttackers = +btn.dataset.attackers;
        if (sustainResults) renderSustain(sustainResults, 'sustain-grid');
      });
    });

    const invalidate = (title, why) => {
      sustainResults = null;
      updateSustainEstimate();
      const mount = document.getElementById('sustain-grid');
      if (mount) mount.innerHTML = `<div class="empty-state">
        <div class="empty-icon">✚</div><div class="empty-title">${esc(title)}</div>
        <div class="empty-sub">${esc(why)}</div></div>`;
    };
    // The shields change which kits exist, so like the class they cannot be
    // re-read off a finished grid.
    document.querySelectorAll('#sustain-shields-group .tbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.shields === '1';
        if (next === sustainUseShields) return;
        document.querySelectorAll('#sustain-shields-group .tbtn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sustainUseShields = next;
        invalidate(next ? 'Shields added to the kit space' : 'Shields removed from the kit space',
          'This changes which kits get solved, so it needs another run.');
      });
    });

    // Coverage is a weight on results that already exist, so unlike every
    // other shield setting this one is instant.
    document.getElementById('sustain-mesh-coverage')?.addEventListener('change', e => {
      meshCoverage = +e.target.value;
      if (sustainResults) renderSustain(sustainResults, 'sustain-grid');
    });

    // Re-reading finished results is free; only the class needs a re-run,
    // because base health changes what was solved. Squad size does not —
    // every count is solved up front and the toggle above slices.
    ['sustain-distance', 'sustain-profile'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => {
        if (sustainResults) renderSustain(sustainResults, 'sustain-grid');
      });
    });

    document.getElementById('sustain-class')?.addEventListener('change', () =>
      // Class decides base health and, through the loadout rules, which
      // kits a squad built around you can even carry.
      invalidate('Class changed',
        'Base health and the legal kits both change, so this needs another run.'));
    // Stagger moves the shot times themselves, so unlike the window or the
    // squad-size toggle it cannot be re-read off finished results.
    document.getElementById('sustain-stagger')?.addEventListener('change', () =>
      invalidate('Squad timing changed',
        'This moves when each attacker opens fire, so it needs another run.'));

    // The matchup panels open on hover, but a pinned one survives the pointer
    // leaving, so the list can be read (and scrolled) at leisure. Only one at
    // a time — two open panels overlap each other.
    const mount = document.getElementById('sustain-grid');
    mount?.addEventListener('click', e => {
      const btn = e.target.closest('.sustain-bar-btn');
      if (!btn || !mount.contains(btn)) return;
      const cell = btn.parentElement;
      const open = !cell.classList.contains('is-open');
      closeMatchupPanels();
      cell.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.rank-bar-cell')) closeMatchupPanels();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeMatchupPanels();
    });

    document.getElementById('sustain-run-btn')?.addEventListener('click', startSustainAnalysis);
    document.getElementById('sustain-cancel-btn')?.addEventListener('click', () => {
      if (typeof cancelCrossAnalysis === 'function') cancelCrossAnalysis('sustain-grid');
    });

    updateSustainEstimate();
  }

  function updateSustainEstimate() {
    const el = document.getElementById('sustain-estimate');
    if (!el) return;
    const kits = sustainKits().length || (sustainUseShields ? 50 : 16);
    const squads = SUSTAIN_ATTACKER_COUNTS.length;
    const cells = weapons().length * 7 * 4 * kits * squads;
    const illegal = (1 << (sustainUseShields ? 6 : 4)) - kits;
    el.innerHTML = `<strong>${cells.toLocaleString()}</strong> scenarios —
      ${weapons().length} weapons × 7 ranges × 4 aim profiles × ${kits} legal kits
      × ${squads} squad sizes, solved exactly.` +
      (illegal > 0
        ? `<br><span class="doc-note">${illegal} combination${illegal === 1 ? '' : 's'} left out —
           no squad of three ${sustainClass()}-plus-two can carry ${illegal === 1 ? 'it' : 'them'}.</span>`
        : '');
  }

  function setSustainRunning(running) {
    const run = document.getElementById('sustain-run-btn');
    const cancel = document.getElementById('sustain-cancel-btn');
    if (run) run.disabled = running;
    if (cancel) cancel.disabled = !running;
  }

  function startSustainAnalysis() {
    if (!healTimeline || !gadgetTimeline) return;
    if (typeof runSustainAnalysis !== 'function') return;

    setSustainRunning(true);
    runSustainAnalysis({
      defenderClass: sustainClass(),
      kits: sustainKits(),
      mountId: 'sustain-grid',
      sampleStep: SUSTAIN_SAMPLE_STEP,
      sampleMax: SUSTAIN_SAMPLE_MAX,
      attackerCounts: SUSTAIN_ATTACKER_COUNTS,
      attackerStagger: sustainStagger(),
      render: (results, mountId) => { sustainResults = results; renderSustain(results, mountId); },
      onComplete: () => setSustainRunning(false)
    });
  }

  // ── Rendering ──
  function renderSustain(results, mountId) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    if (!results || !results.length) { mount.innerHTML = ''; return; }

    const distance = sustainDistance();
    const profile = sustainProfile();
    const idx = sampleIndexFor(sustainWindow);

    // Everything below reads this one slice: the chosen range, aim profile
    // and squad size, at the chosen hold window. Older results predate the
    // squad-size axis, so a missing count reads as 1.
    const countOf = r => r.attackerCount || 1;
    const keyOf = r => r.kitKey || r.healKey;
    const shieldsOf = r => r.shieldIds || [];
    const atRange = results.filter(r => r.distance === distance && r.profile === profile);
    const squadSizes = [...new Set(atRange.map(countOf))].sort((a, b) => a - b);

    // ── Every solved kit, indexed so one can be read off against another ──
    // Coverage below is answered by comparing a kit to the same kit without
    // the shield, which is only possible because every legal subset was
    // solved. Rows are kept per attacker so the blend happens per matchup
    // rather than on an average that has already thrown the matchups away.
    const solved = new Map();          // key|count -> Map(attacker -> row)
    const kitIds = new Map();          // key -> ids
    for (const r of atRange) {
      const key = keyOf(r) + '|' + countOf(r);
      if (!solved.has(key)) solved.set(key, new Map());
      solved.get(key).set(r.attacker, r);
      kitIds.set(keyOf(r), [...(r.healIds || []), ...shieldsOf(r)]);
    }

    // ── Coverage ──
    // A shield only helps when it is between you and the people shooting.
    // The Dome is geometry: inside its radius the attacker is in there with
    // you, and the whole kit collapses onto the one without it — so those
    // rows are dropped rather than shown twice under different names. The
    // Mesh is a panel facing one way, and how often that is the right way is
    // an assumption; it is applied by blending the kit with the same kit
    // without it, which needs no re-solving and moves with the control.
    const dropped = [];
    const coverageOf = id => {
      const item = gadgetAt(id);
      return item ? shieldCoverageAt(item, distance, meshCoverage) : 0;
    };

    const usableKeys = [...new Set(atRange.map(keyOf))].filter(key => {
      const dead = (kitIds.get(key) || []).filter(id => SHIELD_ORDER.includes(id) && coverageOf(id) === 0);
      if (dead.length) { dropped.push(...dead.map(itemName)); return false; }
      return true;
    });

    /**
     * The rows for one kit at one squad size, with partial coverage folded
     * in. A kit whose Mesh covers 60% of engagements is 60% of itself and
     * 40% of the kit without it — both were solved, so this is a weighted
     * read of two exact answers rather than a third approximate one.
     */
    const rowsFor = (key, count) => {
      const ids = kitIds.get(key) || [];
      const partial = ids.filter(id => SHIELD_ORDER.includes(id) && coverageOf(id) < 1);
      const base = solved.get(key + '|' + count);
      if (!base) return [];
      if (!partial.length) return [...base.values()];

      // One partial shield today, so one fold. Written as a loop so a
      // second one does not need this rewritten.
      let blended = [...base.values()].map(r => ({ ...r, survival: r.survival.slice() }));
      for (const id of partial) {
        const weight = coverageOf(id);
        const without = solved.get(kitKeyOf(ids.filter(x => x !== id)) + '|' + count);
        if (!without) continue;
        blended = blended.map(r => {
          const other = without.get(r.attacker);
          if (!other) return r;
          return {
            ...r,
            survival: r.survival.map((v, i) => v * weight + (other.survival[i] ?? 0) * (1 - weight))
          };
        });
      }
      return blended;
    };

    const meanHold = rows =>
      rows.reduce((sum, r) => sum + (r.survival[idx] ?? 0), 0) / (rows.length || 1);

    const ranked = usableKeys.map(key => {
      const ids = kitIds.get(key) || [];
      const rows = rowsFor(key, sustainAttackers);
      const healIds = ids.filter(id => HEAL_ORDER.includes(id));
      const shieldIds = ids.filter(id => SHIELD_ORDER.includes(id));
      return {
        ids,
        label: stackLabel(ids),
        theoretical: stackIsTheoretical(ids),
        hold: meanHold(rows),
        // The 1/2/3 comparison is the point of the axis, so it is carried on
        // every ranking row rather than living behind the toggle.
        holdByCount: squadSizes.map(n => {
          const r = rowsFor(key, n);
          return r.length ? meanHold(r) : null;
        }),
        rate: healIds.length ? stackRate(healIds.map(healAt).filter(Boolean), sustainWindow) : 0,
        shieldPool: kitShieldPool(shieldIds),
        rows
      };
    }).sort((a, b) => b.hold - a.hold);

    const slice = atRange.filter(r => countOf(r) === sustainAttackers);
    const squadWord = sustainAttackers === 1 ? 'one attacker' : `${sustainAttackers} attackers`;
    const droppedNames = [...new Set(dropped)];
    const meshInPlay = ranked.some(r => r.ids.includes('mesh'));

    mount.innerHTML = `
      <div class="sustain-head">
        <div>
          <div class="sustain-title">Holding ${sustainWindow}s as ${esc(sustainClass())} under ${squadWord}</div>
          <div class="sustain-sub">${distance}m · ${esc(profile)} aim · ${slice.length.toLocaleString()} scenarios · data ${esc(activeDataVersion)}</div>
        </div>
      </div>

      <div class="sustain-section-title">Which kit gets you there — chance of holding ${sustainWindow}s</div>
      ${rankingHtml(ranked, squadSizes)}

      ${droppedNames.length ? `<p class="sustain-note">
        ⌀ ${esc(droppedNames.join(' and '))} ${droppedNames.length === 1 ? 'is' : 'are'} left out at ${distance}m —
        an attacker this close is inside the bubble with you, where it blocks nothing.
        Those kits are identical to the same kit without it, which is already listed.</p>` : ''}

      ${meshInPlay ? `<p class="sustain-note">
        The Mesh Shield is counted at <strong>${Math.round(meshCoverage * 100)}%</strong> coverage — it is a
        panel facing one way, and that is the share of engagements it is assumed to be facing the
        right way for. Change it in the panel; it re-reads the same solved grid rather than re-running it.</p>` : ''}

      <div class="sustain-section-title">Survival over time</div>
      <div class="sustain-curves">${curvesHtml(ranked)}</div>

      <p class="sustain-note">
        One-sided: you are interacting with the objective and not returning fire, and
        none of the attackers can be dropped mid-hold. Averaged across every weapon in
        the roster at this range and aim profile — read it as "against a random
        opponent", not against a specific one. Everyone shooting you carries the same
        weapon and the same aim; a mixed squad is not solvable on this grid.
        Shields and healing are both assumed to be up from the first shot: a Dome
        dropped late to cover the end of a steal is a real play this grid cannot see,
        and a Mesh that is destroyed does not come back inside the window.
      </p>`;
  }

  function rankingHtml(ranked, squadSizes) {
    // The squad columns are the comparison the axis exists for, so they sit
    // next to each other rather than behind the toggle. The selected size
    // is the one the bar and the rest of the page are drawn from.
    const compare = squadSizes.length > 1;
    const idx = sampleIndexFor(sustainWindow);

    const pct = h => h == null ? '—' : (h * 100).toFixed(1) + '%';
    const squadCells = r => compare
      ? r.holdByCount.map((h, i) => `
        <td class="rank-hold ${squadSizes[i] === sustainAttackers ? 'is-selected' : ''}"
            >${pct(h)}</td>`).join('')
      : `<td class="rank-hold is-selected">${pct(r.hold)}</td>`;

    const rows = ranked.map((r, i) => `
      <tr class="${r.theoretical ? 'is-theoretical' : ''}">
        <td class="rank-num">${i + 1}</td>
        <td class="rank-stack">${esc(r.label)}</td>
        ${squadCells(r)}
        ${barCellHtml(r, i, idx, ranked.length)}
        <td class="rank-rate">${r.rate.toFixed(0)} HP/s</td>
        <td class="rank-rate">${r.shieldPool ? r.shieldPool.toFixed(0) + ' HP' : '—'}</td>
      </tr>`).join('');

    const squadHeads = compare
      ? squadSizes.map(n => `<th style="text-align:right" class="${n === sustainAttackers ? 'is-selected' : ''}"
          >${n}v1</th>`).join('')
      : `<th style="text-align:right">Hold ${sustainWindow}s</th>`;

    const anyTheoretical = ranked.some(r => r.theoretical);
    return `<table class="sustain-rank">
      <thead><tr>
        <th></th><th>Kit</th>${squadHeads}
        <th>Matchups</th><th style="text-align:right">Heal rate</th>
        <th style="text-align:right">Shield</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="sustain-note">Hover a bar for the matchups behind it, or click to pin it open —
      <span class="matchup-won">green</span> is a weapon you held off,
      <span class="matchup-lost">red</span> is one that broke you.</p>` + (anyTheoretical ? `<p class="sustain-note">
      ⚠ Marked rows contain an item that did not exist at ${esc(activeDataVersion)} and use its
      launch values. Those rows are theoretical and cannot be compared to real play at this version.</p>` : '');
  }

  /**
   * The bar doubles as the handle for the per-weapon breakdown: hovering or
   * focusing it opens the panel, clicking pins it open so the list can be
   * read without holding the pointer still.
   */
  function barCellHtml(r, i, idx, total) {
    // Rows in the lower half open upward, so a panel on the last row is not
    // stranded past the bottom of the scrolling results pane.
    const up = total > 4 && i >= total / 2;
    const held = r.rows.filter(row => (row.survival[idx] ?? 0) >= 0.5)
      .sort((a, b) => (b.survival[idx] ?? 0) - (a.survival[idx] ?? 0));
    const broke = r.rows.filter(row => (row.survival[idx] ?? 0) < 0.5)
      .sort((a, b) => (a.survival[idx] ?? 0) - (b.survival[idx] ?? 0));

    const chips = (rows, cls) => rows.map(row => `<span class="matchup-chip ${cls}">
      ${esc(row.attacker)} <b>${((row.survival[idx] ?? 0) * 100).toFixed(0)}%</b></span>`).join('');

    const label = `${r.label}: held against ${held.length} of ${r.rows.length} weapons ` +
      `over ${sustainWindow}s. Activate for the matchup list.`;

    const shieldNote = r.shieldPool ? ` · ${r.shieldPool.toFixed(0)} HP of shield` : '';

    return `<td class="rank-bar-cell">
      <button type="button" class="sustain-bar-btn" aria-expanded="false"
              aria-label="${esc(label)}">
        <span class="sustain-bar" style="width:${(r.hold * 100).toFixed(1)}%"></span>
      </button>
      <div class="sustain-matchups ${up ? 'opens-up' : ''}" role="tooltip">
        <div class="matchup-head">
          ${esc(r.label)} — holding ${sustainWindow}s against
          <span class="matchup-won">${held.length} won</span> ·
          <span class="matchup-lost">${broke.length} lost</span>
          <span class="matchup-of">of ${r.rows.length}${esc(shieldNote)}</span>
        </div>
        <div class="matchup-body">
          ${held.length ? `<div class="matchup-group">
            <div class="matchup-label matchup-won">Held the objective against</div>
            <div class="matchup-chips">${chips(held, 'is-won')}</div>
          </div>` : ''}
          ${broke.length ? `<div class="matchup-group">
            <div class="matchup-label matchup-lost">Broke the hold</div>
            <div class="matchup-chips">${chips(broke, 'is-lost')}</div>
          </div>` : ''}
          ${!r.rows.length ? '<div class="matchup-label">No scenarios at this slice.</div>' : ''}
        </div>
      </div>
    </td>`;
  }

  function curvesHtml(ranked) {
    const W = 820, H = 300, PAD_L = 46, PAD_B = 34, PAD_T = 12, PAD_R = 12;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const n = Math.round(SUSTAIN_SAMPLE_MAX / SUSTAIN_SAMPLE_STEP);

    const x = t => PAD_L + (t / SUSTAIN_SAMPLE_MAX) * plotW;
    const y = p => PAD_T + (1 - p) * plotH;

    // Six lines is the most that stays readable; the rest are in the table.
    const shown = ranked.slice(0, 6);
    const colours = ['#39d974', '#4a9eff', '#9d7fff', '#e08a1e', '#e84040', '#8b93a7'];

    const paths = shown.map((r, i) => {
      const mean = [];
      for (let k = 0; k <= n; k++) {
        let sum = 0;
        for (const row of r.rows) sum += row.survival[k] ?? 0;
        mean.push(sum / (r.rows.length || 1));
      }
      const d = mean.map((p, k) => `${k ? 'L' : 'M'}${x(k * SUSTAIN_SAMPLE_STEP).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${colours[i]}" stroke-width="2"
        ${r.theoretical ? 'stroke-dasharray="5 3"' : ''} />`;
    }).join('');

    const legend = shown.map((r, i) =>
      `<g transform="translate(${PAD_L + 8},${PAD_T + 8 + i * 15})">
         <rect width="10" height="3" y="4" fill="${colours[i]}"/>
         <text x="16" y="9" fill="#8b93a7" font-size="11" font-family="Share Tech Mono, monospace">${esc(r.label)}${r.theoretical ? ' ⚠' : ''}</text>
       </g>`).join('');

    const gridY = [0, 0.25, 0.5, 0.75, 1].map(p =>
      `<line x1="${PAD_L}" y1="${y(p)}" x2="${W - PAD_R}" y2="${y(p)}" stroke="#1e232e"/>
       <text x="${PAD_L - 6}" y="${y(p) + 4}" text-anchor="end" fill="#8b93a7" font-size="11">${p * 100}%</text>`).join('');

    const gridX = [0, 5, 10, 15, 20].map(t =>
      `<line x1="${x(t)}" y1="${PAD_T}" x2="${x(t)}" y2="${PAD_T + plotH}" stroke="#1e232e"/>
       <text x="${x(t)}" y="${H - 12}" text-anchor="middle" fill="#8b93a7" font-size="11">${t}s</text>`).join('');

    const marker = `
      <line x1="${x(sustainWindow)}" y1="${PAD_T}" x2="${x(sustainWindow)}" y2="${PAD_T + plotH}"
            stroke="#e84040" stroke-width="1.5" stroke-dasharray="4 3"/>
      <text x="${x(sustainWindow) + 5}" y="${PAD_T + 12}" fill="#e84040" font-size="11"
            font-family="Share Tech Mono, monospace">${sustainWindow}s</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="Probability of surviving over time, one line per heal stack">
      ${gridY}${gridX}${marker}${paths}${legend}</svg>`;
  }

  // ═════════════════════════════════════════════════════════════════
  // COLLAPSIBLE SIDEBAR
  // Every .app view (sim / meta / sustain) gets the same toggle, and the
  // state is shared, so switching views never reopens a panel the user
  // just closed. Collapsed leaves a rail behind — see the CSS.
  // ═════════════════════════════════════════════════════════════════
  const SIDEBAR_KEY = 'finals.sidebarCollapsed';
  let sidebarCollapsed = false;
  try { sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { /* private mode */ }

  function applySidebarState() {
    document.querySelectorAll('.app').forEach(app => {
      app.classList.toggle('sidebar-collapsed', sidebarCollapsed);
      const btn = app.querySelector('.sidebar-toggle');
      if (!btn) return;
      const label = sidebarCollapsed ? 'Show panel' : 'Hide panel';
      btn.setAttribute('aria-expanded', String(!sidebarCollapsed));
      // The label is hidden in the collapsed rail, so name the button directly.
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.querySelector('.sidebar-toggle-icon').textContent = sidebarCollapsed ? '»' : '«';
      btn.querySelector('.sidebar-toggle-label').textContent = label;
    });
  }

  function setSidebarCollapsed(next) {
    sidebarCollapsed = next;
    try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* private mode */ }
    applySidebarState();
    // The arena canvas takes its width from the parent, which just changed.
    if (currentRoute === 'sim') redrawArena();
  }

  function initSidebarToggles() {
    document.querySelectorAll('.app > .sidebar').forEach(sidebar => {
      if (sidebar.querySelector('.sidebar-toggle')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sidebar-toggle';
      btn.innerHTML = '<span class="sidebar-toggle-icon" aria-hidden="true">«</span>' +
                      '<span class="sidebar-toggle-label">Hide panel</span>';
      btn.addEventListener('click', () => setSidebarCollapsed(!sidebarCollapsed));
      sidebar.prepend(btn);
    });
    applySidebarState();
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
  initSidebarToggles();
  initMetaPanel();
  initSustainPanel();
  initHealPickers();
  initWeaponPage();
  loadHealTimeline().then(() => { renderHealStacks(); renderHealStats(); });
  loadGadgetTimeline().then(() => { updateSustainEstimate(); renderGadgetStats(); });
  {
    const { name, params } = routeFromHash();
    navigate(name, { push: false, params });
  }
})();
