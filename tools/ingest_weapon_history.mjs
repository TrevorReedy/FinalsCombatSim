#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// WEAPON HISTORY INGEST SPINE
//
// Reads the raw community data sheets in csv/ (never writes to them),
// normalises every one of them into the 8.3.0 column layout, and diffs
// consecutive versions into an event log.
//
//   node tools/ingest_weapon_history.mjs
//
// Outputs (all in csv/cleaned/):
//   <version>_finals_weapon_data.csv   normalised snapshot, 8.3.0 layout
//   weapon_history.json                the event log + provenance metadata
//
// Design notes:
//   - Sheets disagree in layout, units and even in what a column means, so
//     each source gets its own adapter plus a per-field trust level. A field
//     is only diffed when BOTH endpoints record it in a way worth trusting.
//   - Derived columns (damage per magazine, TTK, STK) are recomputed rather
//     than copied, so every version is internally consistent and comparable.
//   - Tolerances absorb frame-counting error: two authors measuring the same
//     unchanged weapon should not produce a phantom balance change.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV_DIR = join(ROOT, 'csv');
const OUT_DIR = join(CSV_DIR, 'cleaned');

const CLASS_HP = { light: 150, medium: 250, heavy: 350 };

// ═══════════════════════════════════════════════════════════════════
// CSV
// ═══════════════════════════════════════════════════════════════════
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════
// XLSX
// Later sheets arrive as Excel workbooks. An .xlsx is a zip of XML parts and
// Node ships an inflater, so it can be read without adding a dependency —
// which also means csv/ keeps exactly the file the author published.
// ═══════════════════════════════════════════════════════════════════
function unzip(buf) {
  // Locate the end-of-central-directory record (it sits within the last 64KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeXml(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Returns the named worksheet as rows of strings, matching parseCSV's shape.
function readXlsxSheet(path, sheetName) {
  const files = unzip(readFileSync(path));
  const text = name => files.get(name)?.toString('utf8') || '';

  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1])).join(''));

  const rels = new Map(
    [...text('xl/_rels/workbook.xml.rels').matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)]
      .map(m => [m[1], m[2].replace(/^\/?xl\//, '')])
  );
  const sheets = [...text('xl/workbook.xml').matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)]
    .map(m => ({ name: decodeXml(m[1]), target: rels.get(m[2]) }));

  const sheet = sheets.find(s => s.name === sheetName) || sheets[0];
  if (!sheet) throw new Error(`no worksheets in ${path}`);
  const xml = text('xl/' + sheet.target);

  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map();
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 's') {
        const idx = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = idx != null ? shared[+idx] ?? '' : '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1])).join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        value = v != null ? decodeXml(v) : '';
      }
      cells.set(colIndex(ref), value);
    }
    const width = cells.size ? Math.max(...cells.keys()) + 1 : 0;
    rows.push(Array.from({ length: width }, (_, i) => cells.get(i) ?? ''));
  }
  return rows;
}

// One entry point for every source, whatever container it arrived in.
function loadSheet(src) {
  const path = join(CSV_DIR, src.file);
  return src.file.toLowerCase().endsWith('.xlsx')
    ? readXlsxSheet(path, src.sheet)
    : parseCSV(readFileSync(path, 'utf8'));
}

function toCSV(rows) {
  return rows.map(r => r.map(cell => {
    const s = cell == null ? '' : String(cell);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════════════════
// VALUE NORMALISATION
// ═══════════════════════════════════════════════════════════════════
const BLANK = new Set(['', '-', '—', 'n/a', 'na', '?', '(varies)', 'varies']);

// Pulls the primary number out of a cell. Handles "1.45s", "32m", "~40%",
// "320*", "60\n(30)" (magazine + quick-mag) and returns null for blanks.
function num(cell) {
  if (cell == null) return null;
  const raw = String(cell).trim();
  if (BLANK.has(raw.toLowerCase())) return null;
  const primary = raw.split('\n')[0].split('(')[0];
  const m = primary.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) ? v : null;
}

// The parenthetical half of cells like "60\n(30)" or "2.80s (0.80s)".
function secondary(cell) {
  if (cell == null) return null;
  const m = String(cell).match(/\(([^)]*)\)/);
  if (!m) return null;
  const v = m[1].replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return v ? parseFloat(v[0]) : null;
}

// Dropoff reduction is written "~40%" in some sheets and "0.4" in others.
function pct(cell) {
  const v = num(cell);
  if (v == null) return null;
  return v <= 1 ? Math.round(v * 100) : Math.round(v);
}

function normName(s) {
  return String(s)
    .toUpperCase()
    .replace(/W\//g, 'WITH ')
    .replace(/[.\-_]/g, ' ')
    .replace(/[^A-Z0-9() ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ═══════════════════════════════════════════════════════════════════
// ALIASES
// ═══════════════════════════════════════════════════════════════════
const ALIASES = JSON.parse(readFileSync(join(ROOT, 'tools', 'weapon_aliases.json'), 'utf8'));
const IGNORE = new Set(ALIASES.ignore.map(normName));
const unmatched = new Set();

function resolveId(rawName) {
  const key = normName(rawName);
  if (!key || IGNORE.has(key)) return null;
  const id = ALIASES.aliases[key];
  if (!id) { unmatched.add(`${rawName} (normalised: ${key})`); return null; }
  return id;
}

const MELEE_IDS = new Set([
  'dagger', 'dagger_alt', 'dagger_alt_backstab', 'sword', 'sword_alt',
  'dual_blades', 'riot_shield', 'sledgehammer', 'sledgehammer_alt',
  'spear', 'spear_alt'
]);

// ═══════════════════════════════════════════════════════════════════
// SOURCE ADAPTERS
// Each returns { id, class, fields, notes[] } records. `fields` uses the
// canonical field names; anything the sheet does not record stays absent.
// ═══════════════════════════════════════════════════════════════════
function record(id, cls, fields, notes = []) {
  return { id, class: cls, fields, notes: notes.filter(Boolean) };
}

function classFromMarker(cell) {
  const k = normName(cell);
  if (k.startsWith('LIGHT')) return 'light';
  if (k.startsWith('MEDIUM')) return 'medium';
  if (k.startsWith('HEAVY')) return 'heavy';
  return null;
}

// ── 1.5: derived-stat sheet. Name in col 1, one unlabelled reload column,
//    headshot expressed as a multiplier, single falloff distance. ──
function parse_1_5(rows) {
  const out = [];
  let cls = null;
  for (const r of rows) {
    const name = (r[1] || '').trim();
    if (!name) continue;
    if (normName(name).includes('TTK CHARTS')) break;   // trailing chart section
    const marker = classFromMarker(name);
    if (marker) { cls = marker; continue; }

    const id = resolveId(name);
    if (!id || !cls) continue;

    const body = num(r[6]);
    const mult = num(r[12]);
    const head = mult && mult > 1 && body != null ? +(body * mult).toFixed(1) : null;
    const falloff = String(r[15] || '').trim();
    const dropMin = falloff.startsWith('>') ? null : num(falloff);

    out.push(record(id, cls, {
      body_dmg: body,
      head_dmg: head,
      rpm: MELEE_IDS.has(id) ? null : num(r[4]),
      magazine_size: num(r[2]),
      unspecified_reload: num(r[3]),
      dropoff_min: dropMin
    }, [
      head != null ? `Head damage derived from the sheet's ${mult}x headshot multiplier.` : null,
      falloff.startsWith('>') ? `Sheet records falloff as "${falloff}" — treated as no measurable dropoff.` : null,
      num(r[3]) != null ? 'Source has a single unlabelled reload column; kind (tactical vs empty) unknown.' : null
    ]));
  }
  return out;
}

// ── 2.4.0 / 7.3.0 / 8.3.0: the Zafferman-style layout. ──
function parseZafferman(rows, { dropMinCol, dropMaxCol, dropModCol, notesCol }) {
  const out = [];
  let cls = null;
  for (const r of rows) {
    const name = (r[0] || '').trim();
    if (!name) continue;
    const marker = classFromMarker(name);
    if (marker && !r.slice(1, 6).some(c => (c || '').trim())) { cls = marker; continue; }
    if (normName(name) === 'WEAPON') continue;

    const id = resolveId(name);
    if (!id || !cls) continue;

    out.push(record(id, cls, {
      body_dmg: num(r[1]),
      head_dmg: num(r[2]),
      rpm: num(r[3]),
      magazine_size: num(r[4]),
      empty_reload: num(r[6]),
      tactical_reload: num(r[7]),
      shots_per_burst: num(r[8]),
      burst_delay: num(r[9]),
      dropoff_min: num(r[dropMinCol]),
      dropoff_max: num(r[dropMaxCol]),
      dropoff_reduction: pct(r[dropModCol])
    }, [
      (r[notesCol] || '').trim() || null,
      secondary(r[4]) != null ? `Quick-magazine variant in source: ${String(r[4]).replace(/\n/g, ' ')}.` : null,
      secondary(r[6]) != null ? `Quick-reload variant in source: ${String(r[6]).replace(/\n/g, ' ')}s.` : null
    ]));
  }
  return out;
}

// ── 5.8: headerless. name, mag, body, head-or-multiplier, rpm, reload, class.
//    The fourth column is absolute head damage on some rows, a multiplier on
//    others, and alt-attack damage on melee rows. ──
function parse_5_8(rows) {
  const out = [];
  for (const r of rows) {
    const name = (r[0] || '').trim();
    if (!name) continue;
    const id = resolveId(name);
    if (!id) continue;
    const cls = (r[6] || '').trim().toLowerCase();
    if (!CLASS_HP[cls]) continue;

    const body = num(r[2]);
    const raw = num(r[3]);
    const melee = MELEE_IDS.has(id);

    let head = null, headNote = null;
    if (raw != null && !melee) {
      if (raw <= 3) {
        head = body != null ? +(body * raw).toFixed(1) : null;
        headNote = `Head damage derived from the sheet's ${raw}x multiplier.`;
      } else {
        head = raw;
      }
    } else if (raw != null && melee) {
      headNote = `Source column 4 holds ${raw} for this melee weapon — alt-attack damage, not head damage. Dropped.`;
    }

    const reload = num(r[5]);

    out.push(record(id, cls, {
      body_dmg: body,
      head_dmg: head,
      rpm: melee ? null : num(r[4]),
      magazine_size: num(r[1]),
      unspecified_reload: reload === 0 ? null : reload
    }, [
      headNote,
      melee && num(r[4]) != null ? `Source RPM column holds ${num(r[4])} for this melee weapon — swing rate, not RPM. Dropped.` : null,
      reload === 0 ? 'Source reload column is 0 — treated as missing.' : null,
      reload ? 'Source has a single unlabelled reload column; kind (tactical vs empty) unknown.' : null
    ]));
  }
  return out;
}

// ── 10.0.0 (Krome): header at row 3, class markers repeat per section. ──
function parse_krome(rows) {
  const out = [];
  let cls = null;
  for (const r of rows) {
    const marker = classFromMarker(r[0] || '');
    if (marker && normName(r[2] || '') === 'NAME') { cls = marker; continue; }

    const name = (r[2] || '').trim();
    if (!name || !cls) continue;
    const id = resolveId(name);
    if (!id) continue;

    out.push(record(id, cls, {
      body_dmg: num(r[5]),
      head_dmg: num(r[6]),
      rpm: num(r[7]),
      magazine_size: num(r[8]),
      empty_reload: num(r[12]),
      tactical_reload: num(r[11]),
      shots_per_burst: num(r[13]),
      burst_delay: num(r[14]),
      dropoff_min: num(r[27]),
      dropoff_max: num(r[28]),
      dropoff_reduction: pct(r[29])
    }, [
      (r[30] || '').trim() || null,
      secondary(r[8]) != null ? `Quick-magazine variant in source: ${String(r[8]).replace(/\n/g, ' ')}.` : null,
      secondary(r[12]) != null ? `Quick-reload variant in source: ${String(r[12]).replace(/\n/g, ' ')}.` : null
    ]));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// SOURCES + TRUST
//
// measured  — the sheet has an explicit, labelled column for this field
// derived   — reconstructed from a multiplier or similar; diffable, low confidence
// untrusted — recorded but not comparable across sheets (e.g. reload of unknown kind)
// ═══════════════════════════════════════════════════════════════════
const M = 'measured', D = 'derived', U = 'untrusted';

// ── Version ordering ──
// Chronology is derived from the version numbers, never from the order these
// entries happen to be declared in. Drop a new sheet in anywhere and it sorts
// into the right place, which is what the diff chain and the carry-forward
// hierarchy both depend on.
function versionKey(v) {
  return String(v).split('.').map(n => parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const A = versionKey(a), B = versionKey(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const diff = (A[i] ?? 0) - (B[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

const SOURCE_DEFINITIONS = [
  {
    version: '1.5',
    file: 'WeaponData1.5.csv',
    author: 'community sheet (author unattributed)',
    method: 'derived stat sheet; falloff as single distance',
    parse: parse_1_5,
    trust: { body_dmg: M, head_dmg: D, rpm: D, magazine_size: M, unspecified_reload: U, dropoff_min: D },
    caveats: [
      'Headshot damage is reconstructed from a multiplier column, so it inherits rounding (25 x 1.5 = 37.5 where later sheets print 38).',
      'Rate of fire is treated as low-confidence: this sheet reports derived stats rather than raw captures.',
      'Falloff is a single distance with no maximum range or reduction.'
    ]
  },
  {
    version: '2.4.0',
    file: 'WeaponData2.4.0.csv',
    author: 'Zafferman-style sheet',
    method: 'frame-by-frame capture',
    parse: rows => parseZafferman(rows, { dropMinCol: 16, dropMaxCol: 17, dropModCol: 18, notesCol: 19 }),
    trust: {
      body_dmg: M, head_dmg: M, rpm: M, magazine_size: M, empty_reload: M, tactical_reload: M,
      shots_per_burst: M, burst_delay: M, dropoff_min: M, dropoff_max: M, dropoff_reduction: M
    }
  },
  {
    version: '5.8',
    file: 'WeaponData5.8.csv',
    author: 'unattributed extract',
    method: 'headerless dump; column semantics inferred',
    parse: parse_5_8,
    trust: { body_dmg: M, head_dmg: D, rpm: D, magazine_size: M, unspecified_reload: U },
    caveats: [
      'Headerless dump; column meanings are inferred. Column 4 is absolute head damage on some rows, a headshot multiplier on others, and alt-attack damage on melee rows.',
      'The rate column matches independently-known RPM for 14 of 21 comparable weapons and is far off for the rest, so it is treated as low-confidence and individual outliers are flagged.',
      'The single reload column has no stated kind (tactical vs empty) and is 0 on several rows; it is never diffed.'
    ]
  },
  {
    version: '7.3.0',
    file: 'WeaponData7.3.0 .csv',
    author: "Zafferman's Weapon Master Sheet",
    method: 'frame-by-frame capture',
    parse: rows => parseZafferman(rows, { dropMinCol: 22, dropMaxCol: 23, dropModCol: 24, notesCol: 25 }),
    trust: {
      body_dmg: M, head_dmg: M, rpm: M, magazine_size: M, empty_reload: M, tactical_reload: M,
      shots_per_burst: M, burst_delay: M, dropoff_min: M, dropoff_max: M, dropoff_reduction: M
    }
  },
  {
    version: '8.3.0',
    file: "[THE FINALS] Zafferman's Weapon Master Sheet (8.3.0) - SUMMARY.csv",
    author: "Zafferman's Weapon Master Sheet",
    method: 'frame-by-frame capture',
    canonicalLayout: true,
    parse: rows => parseZafferman(rows, { dropMinCol: 22, dropMaxCol: 23, dropModCol: 24, notesCol: 25 }),
    trust: {
      body_dmg: M, head_dmg: M, rpm: M, magazine_size: M, empty_reload: M, tactical_reload: M,
      shots_per_burst: M, burst_delay: M, dropoff_min: M, dropoff_max: M, dropoff_reduction: M
    }
  },
  {
    version: '10.0.0',
    file: "THE FINALS - Krome's Weapon Data Sheet (10.0.0) - KWDS.csv",
    author: "Krome's Weapon Data Sheet (ikrome)",
    method: 'frame-by-frame capture',
    parse: parse_krome,
    trust: {
      body_dmg: M, head_dmg: M, rpm: M, magazine_size: M, empty_reload: M, tactical_reload: M,
      shots_per_burst: M, burst_delay: M, dropoff_min: M, dropoff_max: M, dropoff_reduction: M
    }
  },
  {
    version: '11.3.0',
    file: "[THE FINALS] Zafferman's Weapon Master Sheet (11.3.0).xlsx",
    sheet: 'SUMMARY',
    author: "Zafferman's Weapon Master Sheet",
    method: 'frame-by-frame capture',
    parse: rows => parseZafferman(rows, { dropMinCol: 22, dropMaxCol: 23, dropModCol: 24, notesCol: 25 }),
    trust: {
      body_dmg: M, head_dmg: M, rpm: M, magazine_size: M, empty_reload: M, tactical_reload: M,
      shots_per_burst: M, burst_delay: M, dropoff_min: M, dropoff_max: M, dropoff_reduction: M
    },
    caveats: [
      'Melee weapons are listed with shots-to-kill only — this sheet no longer records their damage, so their rows are mostly blank.',
      'The CL-40 split was renamed from Direct/Splash to Inner Radius/Outer Radius.'
    ]
  }
];

const SOURCES = [...SOURCE_DEFINITIONS].sort((a, b) => compareVersions(a.version, b.version));

{
  const seen = new Set();
  for (const s of SOURCES) {
    if (seen.has(s.version)) throw new Error(`two sources declare version ${s.version}`);
    seen.add(s.version);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CROSS-VERSION SANITY CHECK
//
// Some sheets put something other than rate of fire in the rate column for a
// handful of rows (5.8 lists 220 for the 93R, which measures ~1000 either side
// of it). A value that disagrees with BOTH neighbouring versions by more than
// this threshold is almost certainly a different quantity, not a balance
// change, so it is kept for the record but withheld from derived timings and
// from the event log.
// ═══════════════════════════════════════════════════════════════════
const RATE_OUTLIER = 0.30;      // how far off both neighbours counts as odd
const NEIGHBOUR_AGREE = 0.25;   // how close the neighbours must be to convict

function flagSuspectRates(versions) {
  // Read every rate up front. Flagging mutates records, and a flagged
  // neighbour must not blind the check for the version next to it.
  const original = versions.map(v => new Map(v.records.map(r => [r.id, r.fields.rpm])));
  let withheld = 0, disputed = 0;

  for (let i = 0; i < versions.length; i++) {
    for (const rec of versions[i].records) {
      const v = original[i].get(rec.id);
      if (v == null) continue;

      const neighbours = [];
      for (const j of [i - 1, i + 1]) {
        const n = original[j]?.get(rec.id);
        if (n != null) neighbours.push(n);
      }
      if (neighbours.length < 2) continue;

      const offBoth = neighbours.every(n => Math.abs(v - n) / Math.max(v, n) > RATE_OUTLIER);
      if (!offBoth) continue;

      // Neighbours that agree with each other but not with this value is a
      // unit/column error. Neighbours that disagree with each other too could
      // just be a weapon that was reworked twice — keep the value, flag it.
      const [a, b] = neighbours;
      const neighboursAgree = Math.abs(a - b) / Math.max(a, b) <= NEIGHBOUR_AGREE;

      if (neighboursAgree) {
        rec.fields.rpm_source_value = v;
        rec.fields.rpm = null;
        rec.notes.push(
          `Sheet's rate column reads ${v}, while both neighbouring versions agree on ${a} and ${b}. Treated as a column/unit error: kept for reference, excluded from derived timings and from the change history.`
        );
        withheld++;
      } else {
        rec.fields.rpm_disputed = true;
        rec.notes.push(
          `Sheet's rate column reads ${v}, more than ${RATE_OUTLIER * 100}% away from both neighbouring versions (${a}, ${b}) — which do not agree with each other either. Kept and used, but any change derived from it is low confidence.`
        );
        disputed++;
      }
    }
  }
  return { withheld, disputed };
}

// ═══════════════════════════════════════════════════════════════════
// DERIVED COLUMNS
//
// Timing matches simulate.js: "delay until next burst" is an extra pause on
// top of the normal shot interval. Krome's 10.0.0 sheet — the source of
// weapons_s10_cleaned.json — publishes TTKs that match this exactly. The
// Zafferman sheets use the opposite convention, so their published burst TTKs
// differ from what is recomputed here; see the convention check in validate().
// ═══════════════════════════════════════════════════════════════════
function timeToNthShot(n, f) {
  // No rate of fire (melee, or a rate we could not trust) means no timeline:
  // the sheets print STK and leave TTK blank, and so do we.
  if (!f.rpm) return null;
  if (n <= 1) return 0;
  const interval = 60 / f.rpm;
  const mag = f.magazine_size || Infinity;
  const reload = f.empty_reload ?? f.tactical_reload ?? f.unspecified_reload ?? 0;
  let t = 0, burst = 0, left = mag;

  for (let i = 1; i < n; i++) {
    left--;
    if (left <= 0 && Number.isFinite(mag)) { t += reload; left = mag; burst = 0; }
    else if (f.shots_per_burst) {
      burst++;
      if (burst < f.shots_per_burst) t += interval;
      else { burst = 0; t += f._replace ? (f.burst_delay ?? interval) : (f.burst_delay ?? 0) + interval; }
    } else t += interval;
  }
  return t;
}

function ttkStk(f, hp, head) {
  const dmg = head ? f.head_dmg : f.body_dmg;
  if (!dmg) return { stk: null, ttk: null };
  const stk = Math.ceil(hp / dmg);
  const ttk = timeToNthShot(stk, f);
  return { stk, ttk };
}

// ═══════════════════════════════════════════════════════════════════
// OUTPUT — 8.3.0 COLUMN LAYOUT
// ═══════════════════════════════════════════════════════════════════
const HEADER = [
  '', 'Body Damage', 'Head Damage', 'Rate of Fire (RPM)', 'Magazine Size',
  'Damage Per Magazine', 'Empty Reload Time (seconds)', 'Tactical Reload Time (seconds)',
  'Shots Per Burst', 'Delay Until Next Burst (seconds)',
  'TTK vs. Light @ Body (seconds)', 'STK (L)',
  'TTK vs. Medium @ Body (seconds)', 'STK (M)',
  'TTK vs. Heavy @ Body (seconds)', 'STK (H)',
  'TTK vs. Light @ Head (seconds)', 'STK (L)',
  'TTK vs. Medium @ Head (seconds)', 'STK (M)',
  'TTK vs. Heavy @ Head (seconds)', 'STK (H)',
  'Damage Dropoff Minimum Range', 'Damage Dropoff Maximum Range',
  'Damage Dropoff Modifier @ Max Range', 'Notes'
];

const dash = v => (v == null ? '-' : v);
const secs = v => (v == null ? '-' : v.toFixed(2));
const metres = v => (v == null ? '-' : `${v}m`);
const percent = v => (v == null ? '-' : `~${v}%`);

function snapshotRows(records) {
  const byId = new Map(records.map(r => [r.id, r]));
  const rows = [HEADER];

  for (const cls of ['light', 'medium', 'heavy']) {
    const ids = Object.keys(ALIASES.weapons).filter(
      id => ALIASES.weapons[id].class === cls && byId.has(id)
    );
    if (!ids.length) continue;
    rows.push([cls.toUpperCase(), ...Array(HEADER.length - 1).fill('')]);

    for (const id of ids) {
      const rec = byId.get(id);
      const f = rec.fields;
      const hp = CLASS_HP[cls];
      void hp;

      const body = ['light', 'medium', 'heavy'].map(c => ttkStk(f, CLASS_HP[c], false));
      const head = ['light', 'medium', 'heavy'].map(c => ttkStk(f, CLASS_HP[c], true));
      const dpm = f.body_dmg != null && f.magazine_size ? f.body_dmg * f.magazine_size : null;

      rows.push([
        ALIASES.weapons[id].name,
        dash(f.body_dmg),
        dash(f.head_dmg),
        dash(f.rpm ?? f.rpm_source_value ?? null),
        dash(f.magazine_size),
        dash(dpm),
        dash(f.empty_reload ?? f.unspecified_reload ?? null),
        dash(f.tactical_reload),
        dash(f.shots_per_burst),
        dash(f.burst_delay),
        secs(body[0].ttk), dash(body[0].stk),
        secs(body[1].ttk), dash(body[1].stk),
        secs(body[2].ttk), dash(body[2].stk),
        secs(head[0].ttk), dash(head[0].stk),
        secs(head[1].ttk), dash(head[1].stk),
        secs(head[2].ttk), dash(head[2].stk),
        metres(f.dropoff_min),
        metres(f.dropoff_max),
        percent(f.dropoff_reduction),
        rec.notes.join('  ')
      ]);
    }
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════
// DIFF
// Tolerances absorb measurement noise; anything larger is a real change.
// ═══════════════════════════════════════════════════════════════════
const FIELDS = [
  { key: 'body_dmg', label: 'Body damage', tol: 0 },
  { key: 'head_dmg', label: 'Head damage', tol: 0 },
  { key: 'rpm', label: 'RPM', relTol: 0.02 },
  { key: 'magazine_size', label: 'Magazine size', tol: 0 },
  { key: 'empty_reload', label: 'Empty reload', tol: 0.05 },
  { key: 'tactical_reload', label: 'Tactical reload', tol: 0.05 },
  { key: 'shots_per_burst', label: 'Shots per burst', tol: 0 },
  { key: 'burst_delay', label: 'Burst delay', tol: 0.05 },
  { key: 'dropoff_min', label: 'Dropoff min range', tol: 0.5 },
  { key: 'dropoff_max', label: 'Dropoff max range', tol: 0.5 },
  { key: 'dropoff_reduction', label: 'Dropoff reduction', tol: 3 }
];

// Values reconstructed from a multiplier carry rounding error (25 x 1.5 = 37.5
// against a sheet that prints 38), so a derived endpoint gets a relative floor
// on top of the field's own tolerance.
const DERIVED_REL_TOL = 0.02;

function changed(field, a, b, derived) {
  if (derived && Math.abs(b - a) <= Math.max(Math.abs(a), Math.abs(b)) * DERIVED_REL_TOL) return false;
  if (field.relTol != null) return Math.abs(b - a) > Math.max(a, b) * field.relTol;
  return Math.abs(b - a) > (field.tol ?? 0);
}

function diffVersions(prev, next) {
  const events = [];
  const prevById = new Map(prev.records.map(r => [r.id, r]));
  const nextById = new Map(next.records.map(r => [r.id, r]));

  for (const [id, nextRec] of nextById) {
    const prevRec = prevById.get(id);
    const name = ALIASES.weapons[id].name;

    if (!prevRec) {
      events.push({
        weapon: id, name, from_version: prev.version, to_version: next.version,
        type: 'coverage', field: null, from: null, to: null,
        confidence: 'n/a',
        note: `First appears in the ${next.version} sheet. Absence from the ${prev.version} sheet is sheet coverage, not proof the weapon was absent from the game.`,
        verified_against_patch_notes: false
      });
      continue;
    }

    for (const field of FIELDS) {
      const a = prevRec.fields[field.key];
      const b = nextRec.fields[field.key];
      if (a == null || b == null) continue;

      const trustA = prev.trust[field.key];
      const trustB = next.trust[field.key];
      if (!trustA || !trustB || trustA === U || trustB === U) continue;

      const disputed = field.key === 'rpm' && (prevRec.fields.rpm_disputed || nextRec.fields.rpm_disputed);
      const derived = trustA === D || trustB === D || disputed;
      if (!changed(field, a, b, derived)) continue;

      events.push({
        weapon: id, name, from_version: prev.version, to_version: next.version,
        type: 'change', field: field.key, label: field.label,
        from: a, to: b,
        delta: +(b - a).toFixed(3),
        delta_pct: a ? +(((b - a) / a) * 100).toFixed(1) : null,
        confidence: derived ? 'low' : 'high',
        note: derived
          ? `At least one endpoint is a derived or low-confidence value (${prev.version}: ${trustA}, ${next.version}: ${trustB}).`
          : null,
        verified_against_patch_notes: false
      });
    }
  }

  for (const [id] of prevById) {
    if (nextById.has(id)) continue;
    events.push({
      weapon: id, name: ALIASES.weapons[id].name,
      from_version: prev.version, to_version: next.version,
      type: 'coverage', field: null, from: null, to: null,
      confidence: 'n/a',
      note: `Present in the ${prev.version} sheet, absent from ${next.version}. Sheet coverage — not evidence of removal from the game.`,
      verified_against_patch_notes: false
    });
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// Recompute 8.3.0's own published TTK/STK columns and check the 10.0.0 parse
// against the JSON the simulator already ships. If the pipeline is sound,
// both should agree.
// ═══════════════════════════════════════════════════════════════════
function validate(snapshots) {
  const report = {};

  const src = SOURCES.find(s => s.version === '8.3.0');
  const rows = loadSheet(src);
  const published = new Map();
  for (const r of rows) {
    const id = resolveId((r[0] || '').trim());
    if (id) published.set(id, r);
  }

  let checked = 0, ttkMatch = 0, stkMatch = 0;
  const ttkMisses = [], stkMisses = [];
  for (const rec of snapshots.get('8.3.0')) {
    const r = published.get(rec.id);
    if (!r) continue;
    const cols = [[10, 11, 'light', false], [12, 13, 'medium', false], [14, 15, 'heavy', false],
                  [16, 17, 'light', true], [18, 19, 'medium', true], [20, 21, 'heavy', true]];
    for (const [ttkCol, stkCol, cls, head] of cols) {
      const pubTtk = num(r[ttkCol]), pubStk = num(r[stkCol]);
      const mine = ttkStk(rec.fields, CLASS_HP[cls], head);
      if (pubStk != null && mine.stk != null) {
        checked++;
        if (pubStk === mine.stk) stkMatch++;
        else stkMisses.push(`${rec.id} ${cls}${head ? ' head' : ''}: sheet ${pubStk} vs recomputed ${mine.stk}`);
        if (pubTtk != null && mine.ttk != null) {
          if (Math.abs(pubTtk - mine.ttk) <= 0.02) ttkMatch++;
          else ttkMisses.push(`${rec.id} ${cls}${head ? ' head' : ''}: sheet ${pubTtk}s vs recomputed ${mine.ttk.toFixed(2)}s`);
        } else if (pubTtk == null && mine.ttk == null) ttkMatch++;
      }
    }
  }
  report.recomputed_vs_published_8_3_0 = {
    cells_checked: checked,
    stk_agreement: `${stkMatch}/${checked}`,
    stk_disagreements: stkMisses,
    ttk_agreement: `${ttkMatch}/${checked}`,
    note: "Where these disagree, the sheet's own TTK column cannot be reproduced from the sheet's own stat columns. The recomputed value is used, so every version is internally consistent.",
    disagreements: ttkMisses
  };

  // Which burst convention does each sheet's own TTK column follow? The two
  // authors disagree, and knowing which is which is the only way to read their
  // published burst numbers correctly.
  report.burst_convention_by_sheet = {};
  for (const s of SOURCES) {
    const sheet = loadSheet(s);
    const nameCol = s.version === '10.0.0' ? 2 : (s.version === '1.5' ? 1 : 0);
    const ttkCols = s.version === '10.0.0' ? [[15, 'light'], [19, 'medium'], [23, 'heavy']]
      : s.version === '2.4.0' ? [[10, 'light'], [11, 'medium'], [12, 'heavy']]
      : [[10, 'light'], [12, 'medium'], [14, 'heavy']];

    let add = 0, replace = 0, cells = 0;
    for (const rec of snapshots.get(s.version)) {
      if (!rec.fields.shots_per_burst || !rec.fields.rpm) continue;
      const row = sheet.find(r => resolveId((r[nameCol] || '').trim()) === rec.id);
      if (!row) continue;
      for (const [col, cls] of ttkCols) {
        const pub = num(row[col]);
        if (pub == null || !rec.fields.body_dmg) continue;
        const stk = Math.ceil(CLASS_HP[cls] / rec.fields.body_dmg);
        const withAdd = timeToNthShot(stk, rec.fields);
        const withReplace = timeToNthShot(stk, { ...rec.fields, _replace: true });
        cells++;
        if (withAdd != null && Math.abs(withAdd - pub) <= 0.02) add++;
        else if (withReplace != null && Math.abs(withReplace - pub) <= 0.02) replace++;
      }
    }
    if (cells) {
      report.burst_convention_by_sheet[s.version] =
        `${cells} burst TTK cells — ${add} match "delay + interval" (this pipeline and simulate.js), ${replace} match "delay replaces interval"`;
    }
  }

  const jsonPath = join(ROOT, 'weapons_s10_cleaned.json');
  if (existsSync(jsonPath)) {
    const shipped = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const byId = new Map();
    for (const w of shipped) {
      const id = resolveId(w.name);
      if (id) byId.set(id, w);
    }
    const mismatches = [];
    let compared = 0;
    for (const rec of snapshots.get('10.0.0')) {
      const w = byId.get(rec.id);
      if (!w) continue;
      const pairs = [
        ['body_dmg', num(w.body_dmg)], ['head_dmg', num(w.head_damage)],
        ['rpm', num(w.rpm)], ['magazine_size', num(w.magazine_size)],
        ['dropoff_min', num(w.damage_dropoff_min_range)], ['dropoff_max', num(w.damage_dropoff_max_range)]
      ];
      for (const [key, shippedVal] of pairs) {
        const mine = rec.fields[key];
        if (shippedVal == null || mine == null) continue;
        compared++;
        if (Math.abs(shippedVal - mine) > 0.01) {
          mismatches.push(`${rec.id}.${key}: sheet ${mine} vs weapons_s10_cleaned.json ${shippedVal}`);
        }
      }
    }
    report.krome_10_0_0_vs_shipped_json = {
      weapons_matched: byId.size,
      fields_compared: compared,
      mismatches: mismatches
    };
  }

  return report;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const snapshots = new Map();
  const versions = [];

  for (const src of SOURCES) {
    const records = src.parse(loadSheet(src));
    snapshots.set(src.version, records);
    versions.push({ ...src, records });
  }

  const rateFlags = flagSuspectRates(versions);
  console.log(`  rate-of-fire check: ${rateFlags.withheld} withheld as column errors, ${rateFlags.disputed} kept but disputed\n`);

  for (const v of versions) {
    const file = join(OUT_DIR, `${v.version}_finals_weapon_data.csv`);
    writeFileSync(file, toCSV(snapshotRows(v.records)));
    console.log(`  ${v.version.padEnd(7)} ${String(v.records.length).padStart(3)} weapons  →  csv/cleaned/${v.version}_finals_weapon_data.csv`);
  }

  const events = [];
  for (let i = 1; i < versions.length; i++) {
    const evs = diffVersions(versions[i - 1], versions[i]);

    // A sheet that renames or re-scopes a row can produce a "change" that is
    // really a change of definition. Those are declared by hand in the alias
    // file and travel with the numbers they qualify.
    for (const r of ALIASES.rescoped || []) {
      if (r.version !== versions[i].version) continue;
      if (!versions[i].records.some(rec => rec.id === r.id)) continue;
      evs.push({
        weapon: r.id, name: ALIASES.weapons[r.id]?.name || r.id,
        from_version: versions[i - 1].version, to_version: versions[i].version,
        type: 'definition', field: null, from: null, to: null,
        confidence: 'n/a', note: r.note,
        verified_against_patch_notes: false
      });
    }

    events.push(...evs);
    const changes = evs.filter(e => e.type === 'change').length;
    const notes = evs.filter(e => e.type === 'definition').length;
    const coverage = evs.filter(e => e.type === 'coverage').length;
    console.log(`  ${versions[i - 1].version} → ${versions[i].version}: ${changes} stat changes, ${coverage} coverage events${notes ? `, ${notes} definition notes` : ''}`);
  }

  const validation = validate(snapshots);

  const history = {
    generated: new Date().toISOString().slice(0, 10),
    generator: 'tools/ingest_weapon_history.mjs',
    note: 'Derived from community data sheets only. Every event is a measured difference between two sheets, not a quoted patch note. verified_against_patch_notes is false everywhere until the patch-note source is ingested; a change with no matching patch note is a shadow-change candidate.',
    versions: SOURCES.map(s => ({
      version: s.version, source_file: s.file, author: s.author, method: s.method,
      weapons: snapshots.get(s.version).length,
      caveats: s.caveats || []
    })),
    tolerances: FIELDS.map(f => ({
      field: f.key,
      tolerance: f.relTol != null ? `${f.relTol * 100}% relative` : `${f.tol ?? 0} absolute`
    })),
    alias_notes: ALIASES.notes,
    validation,
    events
  };

  writeFileSync(join(OUT_DIR, 'weapon_history.json'), JSON.stringify(history, null, 2) + '\n');
  console.log(`\n  ${events.length} events  →  csv/cleaned/weapon_history.json`);

  // ── Browser-facing timeline ──
  // One file the weapon page can fetch: raw fields per version, per weapon,
  // plus that weapon's changes. Derived metrics (DPS, TTK) are deliberately
  // NOT baked in — the page computes them with the same functions the stats
  // table uses, so there is one implementation of the timing model in the UI.
  const timeline = {
    generated: history.generated,
    note: 'Generated by tools/ingest_weapon_history.mjs. Raw stat values only; the UI derives DPS/TTK and carries stats forward for versions whose sheet omits them.',
    versions: SOURCES.map(s => ({ version: s.version, author: s.author, method: s.method, caveats: s.caveats || [] })),
    aliases: ALIASES.aliases,
    runtime_defaults: ALIASES.runtime_defaults || {},
    weapons: {}
  };

  for (const [id, meta] of Object.entries(ALIASES.weapons)) {
    const snaps = {};
    for (const v of versions) {
      const rec = v.records.find(r => r.id === id);
      if (!rec) continue;
      const f = rec.fields;
      snaps[v.version] = {
        body_dmg: f.body_dmg ?? null,
        head_dmg: f.head_dmg ?? null,
        rpm: f.rpm ?? null,
        rpm_source_value: f.rpm_source_value ?? null,
        rpm_disputed: !!f.rpm_disputed,
        magazine_size: f.magazine_size ?? null,
        empty_reload: f.empty_reload ?? f.unspecified_reload ?? null,
        tactical_reload: f.tactical_reload ?? null,
        reload_kind_known: f.empty_reload != null || f.tactical_reload != null,
        shots_per_burst: f.shots_per_burst ?? null,
        burst_delay: f.burst_delay ?? null,
        dropoff_min: f.dropoff_min ?? null,
        dropoff_max: f.dropoff_max ?? null,
        dropoff_reduction: f.dropoff_reduction ?? null,
        notes: rec.notes
      };
    }
    if (!Object.keys(snaps).length) continue;

    timeline.weapons[id] = {
      name: meta.name,
      class: meta.class,
      // Identity is stable across versions; the sheets only carry stats. The
      // engine needs type to know what is melee, so it travels with the weapon.
      type: meta.type || null,
      firing_mode: meta.firing_mode || null,
      alias_note: ALIASES.notes[id] || null,
      snapshots: snaps,
      changes: events.filter(e => e.weapon === id)
    };
  }

  writeFileSync(join(OUT_DIR, 'weapon_timeline.json'), JSON.stringify(timeline) + '\n');
  console.log(`  ${Object.keys(timeline.weapons).length} weapons  →  csv/cleaned/weapon_timeline.json`);

  if (unmatched.size) {
    console.log('\n  UNMATCHED NAMES (add to tools/weapon_aliases.json):');
    for (const n of unmatched) console.log('    ' + n);
  }

  console.log('\n  VALIDATION');
  console.log('    8.3.0 recomputed vs published:',
    validation.recomputed_vs_published_8_3_0.stk_agreement, 'STK,',
    validation.recomputed_vs_published_8_3_0.ttk_agreement, 'TTK');
  for (const d of validation.recomputed_vs_published_8_3_0.disagreements) console.log('      ' + d);
  if (validation.krome_10_0_0_vs_shipped_json) {
    const v = validation.krome_10_0_0_vs_shipped_json;
    console.log(`    10.0.0 sheet vs shipped JSON: ${v.fields_compared} fields, ${v.mismatches.length} mismatches`);
    for (const m of v.mismatches.slice(0, 12)) console.log('      ' + m);
  }
}

main();
