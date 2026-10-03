// ═══════════════════════════════════════════════════════════════════
// WEAPON HISTORY CHART
//
// Small multiples over one shared version axis: a panel per metric, a line
// per weapon inside each panel. Units never share a y-axis — damage per shot
// and DPS sit in separate panels lined up on the same x, so a change can be
// followed straight down from the cause to its consequences.
//
// ui_shell.js builds the model (it owns the timeline and the metric
// definitions); this file only lays it out and handles pointer and keyboard
// interaction. The layout helpers are pure and exported for the Node tests.
//
// Drawn at the mount's real pixel width, never scaled through a viewBox, so a
// 13px label is 13px on screen whatever the panel width.
// ═══════════════════════════════════════════════════════════════════
(function (root) {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const LAYOUT = {
    left: 66,          // y-axis labels
    right: 132,        // direct labels at each line's end
    strip: 34,         // season names above the plot
    axis: 36,          // version ticks below the plot
    singleHeight: 300,
    stackedHeight: 170,
    plotTop: 10,
    plotBottom: 8,
    tickGap: 10        // minimum px between two version labels
  };

  // ── Pure helpers ─────────────────────────────────────────────────

  /** Round numbers for an axis: steps of 1, 2 or 5 times a power of ten. */
  function niceTicks(min, max, target = 4) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1;
      min -= pad; max += pad;
    }
    const raw = (max - min) / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(+v.toPrecision(12));
    return { min: lo, max: hi, step, ticks };
  }

  /**
   * Version positions with every season the same width and its versions
   * spread evenly inside it. `seasons` is the visible range in order.
   */
  function xLayout(versions, seasons, x0, width) {
    const bandW = width / Math.max(1, seasons.length);
    const pos = new Map();
    const bands = [];
    seasons.forEach((season, si) => {
      const inSeason = versions.filter(v => v.season === season);
      const start = x0 + si * bandW;
      bands.push({ season, start, end: start + bandW, index: si });
      inSeason.forEach((v, j) => pos.set(v.version, start + ((j + 0.5) / inSeason.length) * bandW));
    });
    return { pos, bands, bandW };
  }

  /**
   * Which version labels fit on one row. Candidates come in priority order;
   * each is kept only if it clears every label already kept by `gap` px.
   * Returns the kept candidates sorted by x.
   */
  function placeTickLabels(candidates, gap = LAYOUT.tickGap) {
    const kept = [];
    for (const c of candidates) {
      const left = c.x - c.width / 2, right = c.x + c.width / 2;
      const clashes = kept.some(k => left < k.x + k.width / 2 + gap && right > k.x - k.width / 2 - gap);
      if (!clashes) kept.push(c);
    }
    return kept.sort((a, b) => a.x - b.x);
  }

  /**
   * A series as % change from its value at the baseline version — or, if it
   * has no value there, from its first value after it. Null where there is
   * nothing to index against.
   */
  function toPercent(values, baselineIndex) {
    let base = null;
    for (let i = Math.max(0, baselineIndex); i < values.length; i++) {
      if (values[i] != null) { base = values[i]; break; }
    }
    if (base == null || base === 0) return values.map(() => null);
    return values.map(v => (v == null ? null : ((v - base) / Math.abs(base)) * 100));
  }

  /**
   * Where % change is measured from. An explicit baseline wins; otherwise
   * the first version in view — zoomed into a season, "% change" means
   * change within that season, not since the game launched.
   */
  function baselineIndexFor(model) {
    if (model.baseline) {
      const i = model.versions.findIndex(v => v.version === model.baseline);
      if (i >= 0) return i;
    }
    if (model.zoom) {
      const i = model.versions.findIndex(v => v.season >= model.zoom[0] && v.season <= model.zoom[1]);
      if (i >= 0) return i;
    }
    return 0;
  }

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /**
   * The middle 50% of a field of weapons at each version: lower quartile,
   * median, upper quartile, and how many weapons there were. Each series is
   * indexed to its own baseline first in % mode, so the band answers "how
   * did the pack move", not "how big is the pack". Versions where fewer than
   * `minCount` weapons have a value get no band — a quartile of two numbers
   * is not a pack.
   */
  function fieldBand(seriesList, { mode = 'abs', baselineIndex = 0, minCount = 3 } = {}) {
    const values = mode === 'pct' ? seriesList.map(v => toPercent(v, baselineIndex)) : seriesList;
    const n = values[0]?.length || 0;
    const lo = new Array(n).fill(null), mid = new Array(n).fill(null), hi = new Array(n).fill(null), count = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const at = values.map(v => v[i]).filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
      count[i] = at.length;
      if (at.length < minCount) continue;
      lo[i] = quantile(at, 0.25);
      mid[i] = quantile(at, 0.5);
      hi[i] = quantile(at, 0.75);
    }
    return { lo, mid, hi, count };
  }

  /** Spread end labels so none overlaps: sorted by y, pushed apart by `minGap`. */
  function spreadLabels(items, minGap, top, bottom) {
    const sorted = [...items].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < minGap) sorted[i].y = sorted[i - 1].y + minGap;
    }
    const overflow = sorted.length ? sorted[sorted.length - 1].y - bottom : 0;
    if (overflow > 0) for (const s of sorted) s.y = Math.max(top, s.y - overflow);
    return sorted;
  }

  // Text width without a layout pass. A canvas measures in the real face;
  // Node (tests) falls back to an average character width.
  let measureCtx = null;
  function textWidth(text, font = '600 12.5px Inter, system-ui, sans-serif') {
    if (typeof document !== 'undefined') {
      measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
      if (measureCtx) { measureCtx.font = font; return measureCtx.measureText(text).width; }
    }
    return String(text).length * 7.2;
  }

  // ── Rendering ────────────────────────────────────────────────────

  function el(name, attrs = {}, text) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  }

  function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const GLYPH = { buff: '↑', nerf: '↓', soft: '—', elsewhere: '·' };

  /**
   * Draws the chart into `mount`, replacing whatever was there.
   *
   * model: {
   *   versions: [{ version, season, date }],     every version, in order
   *   zoom: [fromSeason, toSeason] | null,
   *   mode: 'abs' | 'pct', baseline: version | null, selected: version | null,
   *   touchedSeasons: Set<season>,               seasons the primary weapon changed in
   *   panels: [{ key, label, format(v), formatPct(v), polarity, series: [{
   *     id, name, slot, primary, hidden, values: (number|null)[],
   *     kinds: ('buff'|'nerf'|'soft'|'elsewhere'|null)[], landed: bool[] }] }]
   * }
   * handlers: { onSelect(version), onZoom(season, extend), onRemovePanel(key) }
   *
   * Returns { destroy(), composeSvg() }.
   */
  function renderWeaponChart(mount, model, handlers = {}) {
    mount.innerHTML = '';
    const width = Math.max(320, Math.floor(mount.clientWidth || 900));
    const compact = width < 560;
    const L = { ...LAYOUT, right: compact ? 70 : LAYOUT.right, left: compact ? 52 : LAYOUT.left };
    const plotX0 = L.left, plotW = width - L.left - L.right;

    const seasonsAll = [...new Set(model.versions.map(v => v.season))].sort((a, b) => a - b);
    const seasons = model.zoom
      ? seasonsAll.filter(s => s >= model.zoom[0] && s <= model.zoom[1])
      : seasonsAll;
    const visibleIdx = model.versions
      .map((v, i) => (seasons.includes(v.season) ? i : -1))
      .filter(i => i >= 0);
    const visible = visibleIdx.map(i => model.versions[i]);
    const { pos, bands } = xLayout(visible, seasons, plotX0, plotW);
    const xOf = i => pos.get(model.versions[i].version);

    const baselineIndex = baselineIndexFor(model);

    const wrap = h('div', 'wc');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Stat history chart. Use the left and right arrow keys to step through versions, Enter to open one.');

    // ── Season strip ──
    const strip = el('svg', { class: 'wc-strip', width, height: L.strip });
    for (const b of bands) {
      const g = el('g', {
        class: `wc-season${b.index % 2 ? ' alt' : ''}${model.touchedSeasons.has(b.season) ? ' live' : ''}`,
        role: 'button', tabindex: '-1', 'data-season': b.season
      });
      g.appendChild(el('rect', { x: b.start, y: 0, width: b.end - b.start, height: L.strip }));
      // Full name where it fits; on a narrow screen just the number, with
      // one "Season" label in the gutter saying what the numbers are.
      const bw = b.end - b.start;
      const label = bw > 78 ? `Season ${b.season}` : bw > 36 ? `S${b.season}` : String(b.season);
      g.appendChild(el('text', { x: (b.start + b.end) / 2, y: L.strip / 2 + 5, 'text-anchor': 'middle' }, label));
      g.appendChild(el('title', {}, model.zoom && seasons.length === 1
        ? `Season ${b.season}`
        : `Season ${b.season} — click to zoom in, shift-click to extend`));
      strip.appendChild(g);
    }
    if (bands.length && bands[0].end - bands[0].start <= 36) {
      strip.appendChild(el('text', { class: 'wc-strip-caption', x: plotX0 - 8, y: L.strip / 2 + 5, 'text-anchor': 'end' }, 'Season'));
    }
    wrap.appendChild(strip);

    const crosshairs = [];
    const panelGeoms = [];
    const visiblePanels = model.panels;
    const plotH = visiblePanels.length > 1 ? L.stackedHeight : L.singleHeight;

    for (const panel of visiblePanels) {
      const shown = panel.series.filter(s => !s.hidden);
      const lines = shown.map(s => ({
        s,
        values: model.mode === 'pct' ? toPercent(s.values, baselineIndex) : s.values
      }));

      const band = panel.field && panel.field.series.length
        ? fieldBand(panel.field.series, { mode: model.mode, baselineIndex })
        : null;
      const inView = [
        ...lines.flatMap(l => visibleIdx.map(i => l.values[i])),
        ...(band ? visibleIdx.flatMap(i => [band.lo[i], band.hi[i]]) : [])
      ].filter(v => v != null);
      let lo = inView.length ? Math.min(...inView) : 0;
      let hi = inView.length ? Math.max(...inView) : 1;
      if (model.mode === 'pct') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      else if (lo > 0 && lo < (hi - lo) * 1.5) lo = 0;   // keep magnitudes honest about zero
      const scale = niceTicks(lo, hi, 4);
      const y = v => L.plotTop + (plotH - L.plotTop - L.plotBottom) * (1 - (v - scale.min) / (scale.max - scale.min || 1));

      const box = h('div', 'wc-panel');
      const head = h('div', 'wc-panel-head');
      head.appendChild(h('span', 'wc-panel-title', panel.label + (model.mode === 'pct' ? ' — % change' : '')));
      if (visiblePanels.length > 1 && handlers.onRemovePanel) {
        const x = h('button', 'wc-panel-remove', '×');
        x.type = 'button';
        x.title = `Remove ${panel.label}`;
        x.setAttribute('aria-label', `Remove ${panel.label}`);
        x.addEventListener('click', () => handlers.onRemovePanel(panel.key));
        head.appendChild(x);
      }
      box.appendChild(head);

      const svg = el('svg', { class: 'wc-plot', width, height: plotH, role: 'img', 'aria-label': panel.label });

      for (const b of bands) {
        svg.appendChild(el('rect', { class: `wc-band${b.index % 2 ? ' alt' : ''}`, x: b.start, y: 0, width: b.end - b.start, height: plotH }));
      }
      for (const b of bands.slice(1)) {
        svg.appendChild(el('line', { class: 'wc-divider', x1: b.start, x2: b.start, y1: 0, y2: plotH }));
      }

      for (const t of scale.ticks) {
        const yy = y(t);
        const zero = model.mode === 'pct' && Math.abs(t) < 1e-9;
        svg.appendChild(el('line', { class: `wc-grid${zero ? ' zero' : ''}`, x1: plotX0, x2: plotX0 + plotW, y1: yy, y2: yy }));
        svg.appendChild(el('text', { class: 'wc-ylabel', x: plotX0 - 8, y: yy + 4, 'text-anchor': 'end' },
          model.mode === 'pct' ? panel.formatPct(t) : panel.format(t)));
      }

      // The field band sits behind every line: the middle half of the pack,
      // stepped like the lines, with its median dashed through it.
      if (band) {
        const runs = [];
        let run = [];
        for (const i of visibleIdx) {
          if (band.lo[i] == null) { if (run.length) runs.push(run); run = []; continue; }
          run.push(i);
        }
        if (run.length) runs.push(run);
        const stepPts = (idx, arr) => {
          const pts = [[xOf(idx[0]), y(arr[idx[0]])]];
          for (let k = 1; k < idx.length; k++) {
            pts.push([xOf(idx[k]), y(arr[idx[k - 1]])], [xOf(idx[k]), y(arr[idx[k]])]);
          }
          return pts;
        };
        for (const r of runs) {
          const top = stepPts(r, band.hi), bottom = stepPts(r, band.lo).reverse();
          if (r.length === 1) { top.push([top[0][0] + 1, top[0][1]]); bottom.unshift([bottom[0][0] + 1, bottom[0][1]]); }
          const poly = [...top, ...bottom].map(([px, py]) => `${px},${py}`).join(' ');
          svg.appendChild(el('polygon', { class: 'wc-field', points: poly }));
          const midPts = stepPts(r, band.mid);
          svg.appendChild(el('path', { class: 'wc-field-mid', d: 'M' + midPts.map(([px, py]) => `${px},${py}`).join(' L') }));
        }
      }

      // Lines: a stat holds until a patch moves it, so each line is drawn as
      // steps — flat between versions, a vertical jump where it changed. A
      // run of missing versions is bridged with a dashed connector so a gap
      // in coverage never reads as a smooth change.
      const endLabels = [];
      for (const { s, values } of lines) {
        const pts = visibleIdx.filter(i => values[i] != null).map(i => ({ i, x: xOf(i), y: y(values[i]) }));
        if (!pts.length) continue;
        let d = `M${pts[0].x},${pts[0].y}`;
        let gaps = '';
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1], b = pts[k];
          const adjacent = visibleIdx.indexOf(b.i) - visibleIdx.indexOf(a.i) === 1;
          if (adjacent) d += ` H${b.x} V${b.y}`;
          else { gaps += `M${a.x},${a.y} H${b.x} V${b.y} `; d += ` M${b.x},${b.y}`; }
        }
        if (gaps) svg.appendChild(el('path', { class: `wc-line gap s${s.slot}`, d: gaps }));
        svg.appendChild(el('path', { class: `wc-line s${s.slot}${s.primary ? ' primary' : ''}`, d }));

        // Change markers. The primary weapon's carry the buff/nerf colour and
        // are clickable; a compared weapon's are plain dots in its own colour.
        for (const p of pts) {
          if (!s.landed[p.i]) continue;
          if (s.primary) {
            const kind = s.kinds[p.i] || 'soft';
            const g = el('g', {
              class: `chart-mark ${kind}${model.selected === model.versions[p.i].version ? ' selected' : ''}`,
              'data-version': model.versions[p.i].version
            });
            g.appendChild(el('circle', { class: 'hit', cx: p.x, cy: p.y, r: 12 }));
            g.appendChild(el('circle', { class: 'ring', cx: p.x, cy: p.y, r: 6.5 }));
            g.appendChild(el('circle', { class: 'core', cx: p.x, cy: p.y, r: 4.5 }));
            svg.appendChild(g);
          } else if (s.kinds[p.i] === 'buff' || s.kinds[p.i] === 'nerf') {
            svg.appendChild(el('circle', { class: `wc-dot s${s.slot}`, cx: p.x, cy: p.y, r: 4 }));
          }
        }

        // With one line in the panel there is room to print the value at
        // every step, so a change reads without hovering. Never on every
        // point — only where the line moved, plus where it starts.
        if (lines.length === 1) {
          let lastX = -Infinity;
          const fmt = v => (model.mode === 'pct' ? panel.formatPct(v) : panel.format(v));
          for (const p of pts) {
            const moved = s.kinds[p.i] === 'buff' || s.kinds[p.i] === 'nerf';
            if (p !== pts[0] && !moved) continue;
            if (p.x - lastX < 46 || p.x > plotX0 + plotW - 30) continue;
            const above = p.y > 24;
            svg.appendChild(el('text', {
              class: `wc-steplabel ${s.kinds[p.i] || ''}`, x: p.x + 8, y: above ? p.y - 9 : p.y + 18
            }, fmt(values[p.i])));
            lastX = p.x;
          }
        }

        const last = pts[pts.length - 1];
        const lastVal = values[last.i];
        endLabels.push({
          y: last.y, slot: s.slot,
          text: (model.mode === 'pct' ? panel.formatPct(lastVal) : panel.format(lastVal)),
          name: s.name
        });
      }

      // Direct labels at the right edge: the value, then the weapon when
      // there is more than one line to tell apart.
      for (const lab of spreadLabels(endLabels, 30, 10, plotH - 6)) {
        const g = el('g', { class: 'wc-endlabel' });
        g.appendChild(el('line', { class: `wc-endkey s${lab.slot}`, x1: plotX0 + plotW + 6, x2: plotX0 + plotW + 18, y1: lab.y, y2: lab.y }));
        g.appendChild(el('text', { class: 'wc-endvalue', x: plotX0 + plotW + 22, y: lab.y + (lines.length > 1 && !compact ? 0 : 4) }, lab.text));
        if (lines.length > 1 && !compact) {
          g.appendChild(el('text', { class: 'wc-endname', x: plotX0 + plotW + 22, y: lab.y + 13 }, truncate(lab.name, 16)));
        }
        svg.appendChild(g);
      }

      if (!lines.length || !inView.length) {
        svg.appendChild(el('text', { class: 'wc-empty', x: plotX0 + plotW / 2, y: plotH / 2, 'text-anchor': 'middle' },
          model.mode === 'pct' ? 'Nothing to index — no value at or after the baseline' : 'No data recorded for this stat'));
      }

      const cross = el('line', { class: 'wc-crosshair', x1: 0, x2: 0, y1: 0, y2: plotH, visibility: 'hidden' });
      svg.appendChild(cross);
      crosshairs.push(cross);

      box.appendChild(svg);
      wrap.appendChild(box);
      panelGeoms.push({ panel, lines, band });
    }

    // ── Version axis ──
    const axis = el('svg', { class: 'wc-axis', width, height: L.axis });
    const primaryPanel = model.panels[0];
    const primary = primaryPanel?.series.find(s => s.primary);
    const tickCandidates = [];
    for (const i of visibleIdx) {
      const v = model.versions[i];
      const anyLanded = model.panels.some(p => p.series.some(s => !s.hidden && s.landed[i]));
      if (!anyLanded && model.selected !== v.version) continue;
      // The glyph follows the page's own weapon where there is one; with
      // several equal weapons no single buff/nerf speaks for the version.
      const kind = primary?.landed[i] ? (primary.kinds[i] || 'soft') : 'other';
      const moved = model.panels.some(p => p.series.some(s => !s.hidden && (s.kinds[i] === 'buff' || s.kinds[i] === 'nerf')));
      const text = `${GLYPH[kind] || '·'} ${v.version.replace(/\.0$/, '')}`;
      tickCandidates.push({
        i, x: xOf(i), text, kind,
        width: textWidth(text),
        priority: model.selected === v.version ? 0 : moved ? 1 : anyLanded ? 2 : 3
      });
    }
    tickCandidates.sort((a, b) => a.priority - b.priority || a.x - b.x);
    for (const t of placeTickLabels(tickCandidates)) {
      const v = model.versions[t.i];
      const g = el('g', {
        class: `wc-tick ${t.kind}${model.selected === v.version ? ' selected' : ''}`,
        'data-version': v.version
      });
      g.appendChild(el('line', { x1: t.x, x2: t.x, y1: 0, y2: 6 }));
      g.appendChild(el('text', { x: t.x, y: 22, 'text-anchor': 'middle' }, t.text));
      g.appendChild(el('title', {}, `${v.version}${v.date ? ' · ' + v.date : ''}`));
      axis.appendChild(g);
    }
    wrap.appendChild(axis);

    // ── Tooltip + crosshair ──
    const tip = h('div', 'wc-tip');
    tip.hidden = true;
    wrap.appendChild(tip);

    let cursor = null;   // position in visibleIdx

    function showAt(k) {
      if (k == null || !visibleIdx.length) return;
      cursor = Math.max(0, Math.min(visibleIdx.length - 1, k));
      const i = visibleIdx[cursor];
      const v = model.versions[i];
      const x = xOf(i);
      for (const c of crosshairs) { c.setAttribute('x1', x); c.setAttribute('x2', x); c.setAttribute('visibility', 'visible'); }

      tip.replaceChildren();
      const headRow = h('div', 'wc-tip-head');
      headRow.appendChild(h('strong', null, v.version));
      headRow.appendChild(h('span', null, `Season ${v.season}${v.date ? ' · ' + v.date : ''}`));
      tip.appendChild(headRow);

      for (const { panel, lines, band } of panelGeoms) {
        if (!lines.length && !band) continue;
        tip.appendChild(h('div', 'wc-tip-panel', panel.label));
        if (band && band.mid[i] != null) {
          const f = v => (model.mode === 'pct' ? panel.formatPct(v) : panel.format(v));
          const row = h('div', 'wc-tip-row field');
          row.appendChild(h('span', 'wc-tip-key field'));
          row.appendChild(h('strong', null, f(band.mid[i])));
          row.appendChild(h('span', 'wc-tip-name', `${panel.field.label} median · middle half ${f(band.lo[i])}–${f(band.hi[i])} · ${band.count[i]} weapons`));
          tip.appendChild(row);
        }
        for (const { s, values } of lines) {
          const row = h('div', 'wc-tip-row');
          row.appendChild(h('span', `wc-tip-key s${s.slot}`));
          const val = values[i];
          row.appendChild(h('strong', null, val == null ? '—'
            : model.mode === 'pct' ? panel.formatPct(val) : panel.format(val)));
          row.appendChild(h('span', 'wc-tip-name', s.name));
          // Change from the previous version on record, so the reader sees
          // what moved without hunting for the step.
          const prev = i > 0 ? s.values[i - 1] : null;
          if (val != null && prev != null && s.values[i] != null && Math.abs(s.values[i] - prev) > 1e-9) {
            const better = Math.sign(s.values[i] - prev) * panel.polarity > 0;
            const delta = s.values[i] - prev;
            row.appendChild(h('span', `wc-tip-delta ${better ? 'buff' : 'nerf'}`,
              `${delta > 0 ? '+' : '−'}${panel.format(Math.abs(delta))}`));
          }
          tip.appendChild(row);
        }
      }
      tip.appendChild(h('div', 'wc-tip-hint', 'Click to open this version'));

      tip.hidden = false;
      const wrapW = wrap.clientWidth || width;
      const tipW = tip.offsetWidth || 220;
      const left = x + 16 + tipW > wrapW ? x - 16 - tipW : x + 16;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${L.strip + 8}px`;
    }

    function hide() {
      for (const c of crosshairs) c.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    }

    function nearest(clientX) {
      const r = wrap.getBoundingClientRect();
      const px = clientX - r.left;
      let best = 0, bestD = Infinity;
      visibleIdx.forEach((i, k) => {
        const d = Math.abs(xOf(i) - px);
        if (d < bestD) { bestD = d; best = k; }
      });
      return { k: best, inPlot: px >= plotX0 - 12 && px <= plotX0 + plotW + 12 };
    }

    const onMove = e => {
      if (e.target.closest?.('.wc-strip, .wc-panel-head')) { hide(); return; }
      const { k, inPlot } = nearest(e.clientX);
      if (inPlot) showAt(k); else hide();
    };
    wrap.addEventListener('pointermove', onMove);
    wrap.addEventListener('pointerleave', hide);

    wrap.addEventListener('click', e => {
      const season = e.target.closest?.('[data-season]');
      if (season) { handlers.onZoom?.(Number(season.dataset.season), e.shiftKey); return; }
      if (e.target.closest?.('.wc-panel-head')) return;
      const direct = e.target.closest?.('[data-version]');
      if (direct) { handlers.onSelect?.(direct.dataset.version); return; }
      const { k, inPlot } = nearest(e.clientX);
      if (inPlot) handlers.onSelect?.(model.versions[visibleIdx[k]].version);
    });

    wrap.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const start = cursor ?? (model.selected
          ? Math.max(0, visibleIdx.indexOf(model.versions.findIndex(v => v.version === model.selected)))
          : visibleIdx.length - 1);
        showAt(cursor == null ? start : start + (e.key === 'ArrowRight' ? 1 : -1));
      } else if ((e.key === 'Enter' || e.key === ' ') && cursor != null) {
        e.preventDefault();
        handlers.onSelect?.(model.versions[visibleIdx[cursor]].version);
      } else if (e.key === 'Escape') {
        hide();
      }
    });
    wrap.addEventListener('blur', hide);

    mount.appendChild(wrap);

    /**
     * The whole chart as one standalone SVG — strip, panels with their
     * titles, axis — for export. Styles are left as classes; export.js
     * inlines the computed values.
     */
    function composeSvg() {
      const parts = [...wrap.children].filter(n => n.matches('svg, .wc-panel'));
      const heads = 24;
      let total = 0;
      for (const p of parts) total += p.matches('svg') ? Number(p.getAttribute('height')) : heads + Number(p.querySelector('svg').getAttribute('height'));
      const out = el('svg', { xmlns: SVG_NS, width, height: total, viewBox: `0 0 ${width} ${total}`, class: 'wc-export' });
      let yOff = 0;
      for (const p of parts) {
        if (p.matches('svg')) {
          const g = el('g', { transform: `translate(0,${yOff})` });
          for (const c of p.children) g.appendChild(c.cloneNode(true));
          out.appendChild(g);
          yOff += Number(p.getAttribute('height'));
        } else {
          out.appendChild(el('text', { class: 'wc-export-title', x: plotX0, y: yOff + 17 }, p.querySelector('.wc-panel-title').textContent));
          yOff += heads;
          const inner = p.querySelector('svg');
          const g = el('g', { transform: `translate(0,${yOff})` });
          for (const c of inner.children) if (!c.classList.contains('wc-crosshair')) g.appendChild(c.cloneNode(true));
          out.appendChild(g);
          yOff += Number(inner.getAttribute('height'));
        }
      }
      return out;
    }

    return { composeSvg, wrap, element: wrap };
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /** The same model as an HTML table: one row per version, a column per line. */
  function renderWeaponTable(mount, model) {
    mount.innerHTML = '';
    const seasonsAll = [...new Set(model.versions.map(v => v.season))];
    const seasons = model.zoom ? seasonsAll.filter(s => s >= model.zoom[0] && s <= model.zoom[1]) : seasonsAll;
    const baselineIndex = baselineIndexFor(model);

    const cols = [];
    for (const panel of model.panels) {
      for (const s of panel.series) {
        if (s.hidden) continue;
        cols.push({ panel, s, values: model.mode === 'pct' ? toPercent(s.values, baselineIndex) : s.values });
      }
      if (panel.field && panel.field.series.length) {
        const band = fieldBand(panel.field.series, { mode: model.mode, baselineIndex });
        cols.push({ panel, s: { name: `${panel.field.label} median`, landed: [] }, values: band.mid });
      }
    }

    const scroller = h('div', 'wc-table-wrap');
    const table = h('table', 'data-table wc-table');
    const thead = h('thead');
    const hr = h('tr');
    hr.appendChild(h('th', null, 'Version'));
    hr.appendChild(h('th', null, 'Season'));
    for (const c of cols) hr.appendChild(h('th', 'right', `${c.s.name} · ${c.panel.label}`));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = h('tbody');
    model.versions.forEach((v, i) => {
      if (!seasons.includes(v.season)) return;
      const changed = cols.some(c => c.s.landed[i]);
      const tr = h('tr', changed ? 'changed' : null);
      tr.appendChild(h('td', null, v.version));
      tr.appendChild(h('td', null, String(v.season)));
      for (const c of cols) {
        const val = c.values[i];
        tr.appendChild(h('td', 'right', val == null ? '—' : model.mode === 'pct' ? c.panel.formatPct(val) : c.panel.format(val)));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroller.appendChild(table);
    mount.appendChild(scroller);
  }

  const api = { renderWeaponChart, renderWeaponTable, niceTicks, xLayout, placeTickLabels, toPercent, baselineIndexFor, fieldBand, spreadLabels, LAYOUT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, { WeaponChart: api });
})(typeof window !== 'undefined' ? window : globalThis);
