// ═══════════════════════════════════════════════════════════════════
// CHART EXPORT
//
// One menu, three jobs:
//   Share    — copy the chart as an image, or download it as PNG
//   Publish  — SVG for print and editing, PDF through the browser
//   Analyze  — the numbers behind it as CSV, or JSON with the settings that
//              reproduce the view
//
// Every image format goes through one SVG, so the PNG, the SVG and the PDF
// are the same picture. A chart supplies getSvg() and getData(); this file
// frames the picture (title, footer, background), inlines the styles the
// page would otherwise supply, embeds the fonts, and does the conversions.
// ═══════════════════════════════════════════════════════════════════
(function (root) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const APP_NAME = 'THE FINALS Combat Simulator';

  // ── Pure helpers (exported for the Node tests) ───────────────────

  /** RFC 4180: quote a field that holds a comma, quote or newline. */
  function csvField(v) {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** Rows of plain objects to CSV, columns in first-seen order. */
  function toCsv(rows) {
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const lines = [cols.map(csvField).join(',')];
    for (const r of rows) lines.push(cols.map(c => csvField(r[c])).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  function slug(s) {
    return String(s || 'chart').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'chart';
  }

  function fileName(name, dataVersion, ext) {
    return `finals-${slug(name)}${dataVersion ? '-' + slug(dataVersion) : ''}.${ext}`;
  }

  function buildJson({ chart, dataVersion, settings, rows, dispersion, exportedAt }) {
    return {
      meta: {
        app: APP_NAME,
        chart,
        data_version: dataVersion || null,
        exported_at: exportedAt || new Date().toISOString(),
        row_count: rows.length,
        dispersion: dispersion || null
      },
      settings: settings || {},
      data: rows
    };
  }

  // ── Browser side ─────────────────────────────────────────────────

  function dataVersion() {
    return document.querySelector('.data-version-picker')?.value || null;
  }

  function dispersion() {
    return typeof currentDispersion === 'function' ? currentDispersion() : null;
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  let toastTimer = 0;
  function toast(text) {
    let el = document.getElementById('export-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'export-toast';
      el.className = 'export-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // The properties an SVG needs to look the same outside the page. Copied
  // from the live computed style, so CSS variables, the theme and every
  // class rule resolve to plain values.
  const SVG_PROPS = [
    'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity',
    'stroke-linecap', 'stroke-linejoin', 'opacity', 'paint-order'
  ];
  const TEXT_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-decoration-line', 'text-anchor'];
  // Values that are the SVG default anyway; writing them out is just bulk.
  const DEFAULTS = {
    'fill-opacity': '1', 'stroke-opacity': '1', opacity: '1', 'paint-order': 'normal',
    'stroke-dasharray': 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter',
    'letter-spacing': 'normal', 'text-decoration-line': 'none', 'font-style': 'normal', 'text-anchor': 'start'
  };
  const TEXT_TAGS = new Set(['text', 'tspan']);

  function inlineStyles(svg) {
    // Rules match by class, so the clone has to be in the document for a
    // moment to have a computed style at all.
    const holder = document.createElement('div');
    // Hidden with opacity, never visibility: visibility is inherited, and
    // every element would compute — and be exported — as hidden.
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;';
    holder.className = 'wc';            // chart rules are written under .wc
    holder.appendChild(svg);
    document.body.appendChild(holder);
    for (const node of [svg, ...svg.querySelectorAll('*')]) {
      if (node.tagName === 'title' || node.tagName === 'style' || node.tagName === 'defs') continue;
      const cs = getComputedStyle(node);
      const props = TEXT_TAGS.has(node.tagName) ? [...SVG_PROPS, ...TEXT_PROPS] : SVG_PROPS;
      const decl = props.map(p => {
        const v = cs.getPropertyValue(p);
        return v && DEFAULTS[p] !== v ? `${p}:${v}` : '';
      }).filter(Boolean).join(';');
      if (decl) node.setAttribute('style', decl + (node.getAttribute('style') ? ';' + node.getAttribute('style') : ''));
    }
    holder.remove();
    // The live page's `visibility` on hidden crosshairs and the like is now
    // inline; anything hidden is dropped outright so it cannot reappear.
    svg.querySelectorAll('[visibility="hidden"]').forEach(n => n.remove());
    return svg;
  }

  // ── Fonts ──
  // An SVG drawn into a canvas cannot reach the page's web fonts, so the
  // faces it uses are embedded as data URIs. Latin subsets only — that is
  // everything the charts print — and fetched once per session. If the
  // fetch fails the picture falls back to system fonts, which is fine.
  let fontCssPromise = null;
  function embeddedFontCss() {
    if (fontCssPromise) return fontCssPromise;
    const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => l.href.includes('fonts.googleapis.com'));
    if (!link) return (fontCssPromise = Promise.resolve(''));
    fontCssPromise = fetch(link.href)
      .then(r => (r.ok ? r.text() : ''))
      .then(async css => {
        const blocks = css.split(/(?=\/\*)/).filter(b => /^\/\*\s*latin\s*\*\//.test(b));
        const out = await Promise.all(blocks.map(async block => {
          const m = block.match(/url\((https:[^)]+)\)/);
          if (!m) return '';
          const buf = await (await fetch(m[1])).arrayBuffer();
          let bin = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return block.replace(m[0], `url(data:font/woff2;base64,${btoa(bin)})`).replace(/\/\*[^*]*\*\//, '');
        }));
        return out.join('\n');
      })
      .catch(() => '');
    return fontCssPromise;
  }

  /**
   * The chart, framed to stand on its own: background, title, subtitle and
   * a footer saying what data it was drawn from. Returns { svg, width, height }.
   */
  async function framedSvg(chartSvg, info) {
    const PAD = 28, TITLE_H = info.subtitle ? 62 : 42, FOOT_H = 40;
    const w = Number(chartSvg.getAttribute('width')) || 900;
    const h = Number(chartSvg.getAttribute('height')) || 400;
    const width = w + PAD * 2, height = h + TITLE_H + FOOT_H + PAD;

    const bg = cssVar('--card', '#14171f');
    const ink = cssVar('--text', '#f3f3f0');
    const muted = cssVar('--muted', '#8b93a7');
    const accent = cssVar('--accent', '#e84040');

    const out = document.createElementNS(SVG_NS, 'svg');
    out.setAttribute('xmlns', SVG_NS);
    out.setAttribute('width', width);
    out.setAttribute('height', height);
    out.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const fonts = await embeddedFontCss();
    if (fonts) {
      const style = document.createElementNS(SVG_NS, 'style');
      style.textContent = fonts;
      out.appendChild(style);
    }

    const rect = (attrs) => { const r = document.createElementNS(SVG_NS, 'rect'); for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, v); return r; };
    const text = (str, attrs) => { const t = document.createElementNS(SVG_NS, 'text'); for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v); t.textContent = str; return t; };
    const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

    out.appendChild(rect({ x: 0, y: 0, width, height, fill: bg }));
    out.appendChild(rect({ x: 0, y: 0, width, height: 3, fill: accent }));
    out.appendChild(text(info.title || '', { x: PAD, y: 34, fill: ink, 'font-family': FONT, 'font-size': 19, 'font-weight': 700 }));
    if (info.subtitle) out.appendChild(text(info.subtitle, { x: PAD, y: 56, fill: muted, 'font-family': FONT, 'font-size': 13 }));

    const body = inlineStyles(chartSvg.cloneNode(true));
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', `translate(${PAD},${TITLE_H})`);
    // A nested <svg> keeps the chart's own coordinate system and viewBox.
    body.setAttribute('x', 0);
    body.setAttribute('y', 0);
    g.appendChild(body);
    out.appendChild(g);

    const d = dispersion();
    const footer = [
      APP_NAME,
      dataVersion() ? `weapon data ${dataVersion()}` : null,
      d ? (d.enabled ? `pellet dispersion on (${Number(d.halfAngleDeg).toFixed(1)}° cone)` : 'pellet dispersion off') : null,
      `exported ${new Date().toISOString().slice(0, 10)}`
    ].filter(Boolean).join('  ·  ');
    out.appendChild(text(footer, { x: PAD, y: height - 16, fill: muted, 'font-family': FONT, 'font-size': 11.5 }));

    return { svg: out, width, height };
  }

  function serialize(svg) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
  }

  async function pngBlob(svgString, width, height, scale = 2) {
    const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = new Image();
      img.decoding = 'sync';
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('image decode failed')); img.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      return await new Promise(r => canvas.toBlob(r, 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * PDF without a library: the browser's own print pipeline, on a page the
   * exact size of the picture, keeps it vector. The user picks "Save as PDF"
   * in the dialog.
   */
  function printPdf(svgString, width, height, title) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    const body = svgString.replace(/^<\?xml[^>]*>\s*/, '');
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>
      <style>@page{size:${width}px ${height}px;margin:0}html,body{margin:0;padding:0}
      body{-webkit-print-color-adjust:exact;print-color-adjust:exact}svg{display:block;width:${width}px;height:${height}px}</style>
      </head><body>${body}</body></html>`;
    frame.onload = () => {
      const win = frame.contentWindow;
      const cleanup = () => setTimeout(() => frame.remove(), 500);
      win.addEventListener('afterprint', cleanup);
      setTimeout(() => { win.focus(); win.print(); }, 150);
      setTimeout(cleanup, 60000);
    };
    document.body.appendChild(frame);
    return frame;
  }

  // ── The menu ─────────────────────────────────────────────────────

  const ACTIONS = [
    { group: 'Share', items: [
      { id: 'copy', label: 'Copy image', hint: 'PNG to the clipboard' },
      { id: 'png', label: 'Download PNG', hint: '2× resolution' }
    ] },
    { group: 'Publish', items: [
      { id: 'svg', label: 'Download SVG', hint: 'vector, editable' },
      { id: 'pdf', label: 'PDF', hint: 'opens print — choose Save as PDF' }
    ] },
    { group: 'Analyze & reproduce', items: [
      { id: 'csv', label: 'Download CSV', hint: 'every value in view' },
      { id: 'json', label: 'Download JSON', hint: 'data + the settings behind it' }
    ] }
  ];

  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.menu.remove();
    openMenu.button.setAttribute('aria-expanded', 'false');
    openMenu = null;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => { if (openMenu && !openMenu.wrap.contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  }

  /**
   * Puts an "Export" button into `slot`.
   *
   * opts: {
   *   name: string | () => string            file-name stem
   *   title: () => { title, subtitle }        printed on the image
   *   getSvg: () => SVGElement | string | null
   *   getData: () => { rows: object[], settings: object }
   * }
   */
  function attachExportMenu(slot, opts) {
    slot.querySelector('.export-wrap')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'export-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wc-btn export-btn';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = 'Export ▾';
    wrap.appendChild(button);
    slot.appendChild(wrap);

    const val = v => (typeof v === 'function' ? v() : v);

    async function picture() {
      let svg = await opts.getSvg();
      if (!svg) throw new Error('This chart has nothing to draw yet.');
      if (typeof svg === 'string') {
        svg = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      }
      // Charts drawn to a viewBox carry no pixel size of their own.
      if (!svg.getAttribute('width') && svg.getAttribute('viewBox')) {
        const [, , w, h] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
        svg.setAttribute('width', w); svg.setAttribute('height', h);
      }
      return framedSvg(svg, val(opts.title) || {});
    }

    async function run(id) {
      const name = val(opts.name);
      const ver = dataVersion();
      try {
        if (id === 'csv' || id === 'json') {
          const { rows = [], settings = {}, jsonData = null } = opts.getData() || {};
          if (id === 'csv') {
            download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), fileName(name, ver, 'csv'));
            toast(`CSV saved — ${rows.length.toLocaleString()} rows`);
          } else {
            // A chart may hand JSON a grouped shape of the same data — one
            // array per series rather than a row per point — which is far
            // smaller and how a script would want to read it anyway.
            const json = buildJson({ chart: name, dataVersion: ver, settings, rows: jsonData || rows, dispersion: dispersion() });
            const text = JSON.stringify(json, null, (jsonData || rows).length > 5000 ? 0 : 2);
            download(new Blob([text], { type: 'application/json' }), fileName(name, ver, 'json'));
            toast('JSON saved — data and the settings that reproduce it');
          }
          return;
        }

        if (id === 'copy' && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          // The clipboard write has to start inside the click, so it is given
          // a promise for the image rather than the finished image.
          const blob = picture().then(p => pngBlob(serialize(p.svg), p.width, p.height));
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            toast('Image copied to the clipboard');
            return;
          } catch {
            download(await blob, fileName(name, ver, 'png'));
            toast('This browser would not copy an image — downloaded the PNG instead');
            return;
          }
        }

        const p = await picture();
        const svgString = serialize(p.svg);
        if (id === 'svg') {
          download(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }), fileName(name, ver, 'svg'));
          toast('SVG saved');
        } else if (id === 'png' || id === 'copy') {
          download(await pngBlob(svgString, p.width, p.height), fileName(name, ver, 'png'));
          toast(id === 'copy' ? 'This browser cannot copy images — downloaded the PNG instead' : 'PNG saved');
        } else if (id === 'pdf') {
          printPdf(svgString, p.width, p.height, val(opts.title)?.title || name);
          toast('Choose "Save as PDF" in the print dialog');
        }
      } catch (err) {
        console.error('export failed', err);
        toast(`Export failed: ${err.message || err}`);
      }
    }

    button.addEventListener('click', e => {
      e.stopPropagation();
      if (openMenu?.wrap === wrap) { closeMenu(); return; }
      closeMenu();
      const menu = document.createElement('div');
      menu.className = 'export-menu';
      menu.setAttribute('role', 'menu');
      for (const group of ACTIONS) {
        const head = document.createElement('div');
        head.className = 'export-group';
        head.textContent = group.group;
        menu.appendChild(head);
        for (const item of group.items) {
          const b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('role', 'menuitem');
          b.className = 'export-item';
          b.dataset.action = item.id;
          const l = document.createElement('span'); l.textContent = item.label;
          const h = document.createElement('span'); h.className = 'export-hint'; h.textContent = item.hint;
          b.append(l, h);
          b.addEventListener('click', ev => { ev.stopPropagation(); closeMenu(); run(item.id); });
          menu.appendChild(b);
        }
      }
      wrap.appendChild(menu);
      button.setAttribute('aria-expanded', 'true');
      openMenu = { wrap, menu, button };
      menu.querySelector('button')?.focus();
    });

    return { run };
  }

  const api = { attachExportMenu, toCsv, csvField, fileName, buildJson, slug };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api, { ChartExport: api });
})(typeof window !== 'undefined' ? window : globalThis);
