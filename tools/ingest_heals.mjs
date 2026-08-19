// ═══════════════════════════════════════════════════════════════════
// HEAL INGEST — csv/heals/ -> csv/cleaned/heal_timeline.json
//
// Reads the two hand-authored heal files and emits the timeline the app
// fetches. Deliberately separate from ingest_weapon_history.mjs: that
// pipeline is keyed on weapons all the way down, and its patch schema has
// no field that could hold a heal rate.
//
// Every row in snapshots.csv is a complete state, so this tool does no
// reconstruction — it validates, diffs consecutive snapshots into a change
// log, and writes. See csv/heals/README.md for the trust model.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN_DIR = join(ROOT, 'csv', 'heals');
const OUT_DIR = join(ROOT, 'csv', 'cleaned');

// ── CSV ────────────────────────────────────────────────────────────
// Quote-aware, same shape as the parser in ingest_weapon_history.mjs.
// Notes carry commas, so a split(',') would silently shear them.
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
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function readTable(file) {
  const rows = parseCSV(readFileSync(join(IN_DIR, file), 'utf8'));
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map((cells, i) => {
    const rec = { __line: i + 2 };
    header.forEach((h, j) => { rec[h] = (cells[j] ?? '').trim(); });
    return rec;
  });
}

// ── Versions ───────────────────────────────────────────────────────
// Same comparison as ingest_weapon_history.mjs and ui_shell.js: compare
// numerically segment by segment so a two-segment version like 5.8 sorts
// against a three-segment one without special-casing.
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

// ── Schema ─────────────────────────────────────────────────────────
// Which way is "better" is a property of the field, not of the change:
// a longer overheat time is a buff, a longer cooldown is a nerf. Deriving
// direction from this table rather than hand-tagging each row means a
// label can never disagree with the number sitting next to it.
const FIELD_POLARITY = {
  heal_rate: +1, heal_per_shot: +1, rpm: +1, capacity: +1, burst_heal: +1,
  ramp_from: +1, ramp_to: +1, ramp_time: -1,
  overheat_time: +1, overheat_cooldown: -1,
  recharge_delay: -1, recharge_rate: +1,
  active_duration: +1, cooldown: -1, charges: +1, device_hp: +1,
  radius: +1, range: +1, acquire_range: +1
};

const STAT_FIELDS = Object.keys(FIELD_POLARITY);
const KINDS = new Set(['targeted', 'zone', 'projectile']);

const problems = [];
function fail(where, msg) { problems.push(`${where}: ${msg}`); }

function num(raw, where, field) {
  if (raw === '' || raw === '-') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) { fail(where, `${field} is not a number: "${raw}"`); return null; }
  return n;
}

// ── Read ───────────────────────────────────────────────────────────
const itemRows = readTable('items.csv');
const snapRows = readTable('snapshots.csv');

const items = {};
for (const r of itemRows) {
  const where = `items.csv:${r.__line}`;
  if (!r.id) { fail(where, 'missing id'); continue; }
  if (items[r.id]) fail(where, `duplicate id "${r.id}"`);
  if (!KINDS.has(r.kind)) fail(where, `unknown kind "${r.kind}" (expected ${[...KINDS].join(', ')})`);
  if (!['yes', 'no'].includes(r.self_heal)) fail(where, `self_heal must be yes or no, got "${r.self_heal}"`);

  items[r.id] = {
    id: r.id,
    name: r.name,
    wiki_name: r.wiki_name,
    source_slot: r.source_slot,
    kind: r.kind,
    introduced: r.introduced,
    self_heal: r.self_heal === 'yes',
    notes: r.notes || null,
    snapshots: {},
    changes: []
  };
}

for (const r of snapRows) {
  const where = `snapshots.csv:${r.__line}`;
  const item = items[r.id];
  if (!item) { fail(where, `unknown item id "${r.id}" — add it to items.csv`); continue; }
  if (item.snapshots[r.version]) fail(where, `duplicate snapshot for ${r.id} at ${r.version}`);

  const fields = {};
  for (const f of STAT_FIELDS) {
    if (!(f in r)) { fail(where, `missing column "${f}"`); continue; }
    fields[f] = num(r[f], where, f);
  }

  item.snapshots[r.version] = { version: r.version, fields, note: r.note || null };
}

// ── Validate ───────────────────────────────────────────────────────
// An item whose earliest snapshot disagrees with its stated introduction
// would make every "theoretical" label wrong, so it is worth catching here
// rather than discovering it in the UI.
for (const item of Object.values(items)) {
  const versions = Object.keys(item.snapshots).sort(compareVersions);
  if (!versions.length) { fail(`items.csv`, `${item.id} has no snapshots`); continue; }

  if (versions[0] !== item.introduced) {
    fail('snapshots.csv',
      `${item.id}: earliest snapshot is ${versions[0]} but items.csv says it was introduced at ${item.introduced}`);
  }
  for (const v of versions) {
    if (compareVersions(v, item.introduced) < 0) {
      fail('snapshots.csv', `${item.id}: snapshot ${v} predates its introduction at ${item.introduced}`);
    }
  }

  // Every stat that is ever set must be set on every snapshot. A field that
  // appears halfway through the history would resolve to null for anyone
  // asking about an earlier version, which reads as "this item has no
  // radius" rather than "nobody recorded it".
  const everSet = STAT_FIELDS.filter(f => versions.some(v => item.snapshots[v].fields[f] !== null));
  for (const v of versions) {
    const missing = everSet.filter(f => item.snapshots[v].fields[f] === null);
    if (missing.length) {
      fail('snapshots.csv', `${item.id} at ${v}: ${missing.join(', ')} blank here but set at another version`);
    }
  }
}

// ── Change log ─────────────────────────────────────────────────────
// Diff consecutive snapshots. Mirrors weapon_timeline.json's `changes` so
// a heal history page can render from the same shape.
for (const item of Object.values(items)) {
  const versions = Object.keys(item.snapshots).sort(compareVersions);

  for (let i = 1; i < versions.length; i++) {
    const from = item.snapshots[versions[i - 1]];
    const to = item.snapshots[versions[i]];

    for (const f of STAT_FIELDS) {
      const a = from.fields[f], b = to.fields[f];
      if (a === null || b === null || a === b) continue;

      const direction = Math.sign(b - a) * FIELD_POLARITY[f];
      item.changes.push({
        item: item.id,
        from_version: versions[i - 1],
        to_version: versions[i],
        field: f,
        from: a,
        to: b,
        kind: direction > 0 ? 'buff' : 'nerf',
        note: to.note
      });
    }
  }
}

// ── Derived figures ────────────────────────────────────────────────
// Not stored (see csv/heals/README.md), recomputed here so the ingest can
// print them and the numbers the wiki quotes can be eyeballed against the
// rows that produce them.
function derived(item, version) {
  const f = item.snapshots[version].fields;
  if (item.kind === 'targeted' && f.heal_rate && f.overheat_time) {
    return `overheat capacity ${+(f.heal_rate * f.overheat_time).toFixed(1)} HP`;
  }
  if (item.kind === 'projectile' && f.heal_per_shot && f.capacity) {
    return `magazine ${f.heal_per_shot * f.capacity} HP`;
  }
  return null;
}

// ── Write ──────────────────────────────────────────────────────────
if (problems.length) {
  console.error('\n  HEAL INGEST FAILED\n');
  for (const p of problems) console.error('    ' + p);
  console.error('');
  process.exit(1);
}

const allVersions = [...new Set(
  Object.values(items).flatMap(i => Object.keys(i.snapshots))
)].sort(compareVersions);

const timeline = {
  generated: new Date().toISOString(),
  note: 'Generated by tools/ingest_heals.mjs from csv/heals/. Do not edit by hand.',
  versions: allVersions,
  items
};

// Drop the line markers the reader used for error messages.
for (const item of Object.values(timeline.items)) {
  for (const snap of Object.values(item.snapshots)) delete snap.__line;
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'heal_timeline.json'), JSON.stringify(timeline) + '\n');

// ── Report ─────────────────────────────────────────────────────────
const itemCount = Object.keys(items).length;
const snapCount = Object.values(items).reduce((n, i) => n + Object.keys(i.snapshots).length, 0);
const changeCount = Object.values(items).reduce((n, i) => n + i.changes.length, 0);

console.log(`\n  ${itemCount} items, ${snapCount} snapshots, ${changeCount} changes  →  csv/cleaned/heal_timeline.json`);
console.log(`  versions: ${allVersions.join(', ')}\n`);

for (const item of Object.values(items)) {
  const versions = Object.keys(item.snapshots).sort(compareVersions);
  const newest = versions[versions.length - 1];
  const d = derived(item, newest);
  console.log(`  ${item.name.padEnd(14)} ${item.introduced.padEnd(8)} ${versions.length} snapshots` +
    `  (newest ${newest}${d ? ', ' + d : ''})`);
}

console.log('\n  DERIVED FIGURES BY VERSION');
for (const item of Object.values(items)) {
  const lines = Object.keys(item.snapshots).sort(compareVersions)
    .map(v => [v, derived(item, v)]).filter(([, d]) => d);
  for (const [v, d] of lines) console.log(`    ${item.id.padEnd(9)} ${v.padEnd(9)} ${d}`);
}
console.log('');
