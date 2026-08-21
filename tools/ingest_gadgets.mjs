// ═══════════════════════════════════════════════════════════════════
// GADGET INGEST — csv/gadgets/ -> csv/cleaned/gadget_timeline.json
//
// Same shape and same trust model as ingest_heals.mjs: hand-authored
// items + complete per-version snapshots in, one timeline out. Read
// csv/gadgets/README.md before changing anything here.
//
// The one structural difference is that most rows carry no stats at all.
// This dataset is the whole kit roster — every specialization, gadget and
// carriable — and it exists first to answer "who is allowed to bring
// what", which needs only the class and the slot. Numbers arrive per item,
// as each one is actually modelled, and an item without them is a normal
// state rather than an unfinished one.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN_DIR = join(ROOT, 'csv', 'gadgets');
const OUT_DIR = join(ROOT, 'csv', 'cleaned');

// ── CSV ────────────────────────────────────────────────────────────
// Quote-aware, same parser as the heal ingest. Notes carry commas.
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
function compareVersions(a, b) {
  const A = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const B = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const diff = (A[i] ?? 0) - (B[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

// ── Schema ─────────────────────────────────────────────────────────
// Direction of "better" per field, so a buff/nerf label can never
// disagree with the number next to it. Same rule as the heal ingest:
// more health is a buff, a longer cooldown is a nerf.
const FIELD_POLARITY = {
  device_hp: +1, duration: +1, radius: +1, cooldown: -1, charges: +1
};

const STAT_FIELDS = Object.keys(FIELD_POLARITY);

const CLASSES = new Set(['light', 'medium', 'heavy']);
const SLOTS = new Set(['specialization', 'gadget', 'carriable']);
// What, if anything, in this repo turns the item into simulated behaviour.
//   none   — roster only: it is on the list and legal in a loadout, and
//            nothing reads its numbers.
//   heals  — the numbers live in csv/heals/ and heals.js owns them; the
//            row here exists so the loadout rules can see the slot.
//   shield — gadgets.js builds a damage pool out of it.
const MODELS = new Set(['none', 'heals', 'shield']);

const UNKNOWN_VERSION = '?';

const problems = [];
function fail(where, msg) { problems.push(`${where}: ${msg}`); }

function num(raw, where, field) {
  if (raw === '' || raw === '-') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) { fail(where, `${field} is not a number: "${raw}"`); return null; }
  return n;
}

/** "light" | "all" | "medium/heavy" -> ['light'] | [all three] | [...] */
function parseClasses(raw, where) {
  if (raw === 'all') return ['light', 'medium', 'heavy'];
  const parts = raw.split('/').map(s => s.trim()).filter(Boolean);
  if (!parts.length) { fail(where, 'missing classes'); return []; }
  for (const p of parts) {
    if (!CLASSES.has(p)) fail(where, `unknown class "${p}" in "${raw}"`);
  }
  return parts;
}

// ── Read ───────────────────────────────────────────────────────────
const itemRows = readTable('items.csv');
const snapRows = readTable('snapshots.csv');

const items = {};
for (const r of itemRows) {
  const where = `items.csv:${r.__line}`;
  if (!r.id) { fail(where, 'missing id'); continue; }
  if (items[r.id]) fail(where, `duplicate id "${r.id}"`);
  if (!SLOTS.has(r.slot)) fail(where, `unknown slot "${r.slot}" (expected ${[...SLOTS].join(', ')})`);
  if (!['yes', 'no'].includes(r.self_use)) fail(where, `self_use must be yes or no, got "${r.self_use}"`);
  if (!MODELS.has(r.model)) fail(where, `unknown model "${r.model}" (expected ${[...MODELS].join(', ')})`);
  if ((r.model === 'heals') !== !!r.heal_id) {
    fail(where, `model "${r.model}" and heal_id "${r.heal_id}" disagree — heal_id belongs to exactly the model=heals rows`);
  }
  if (r.heal_id && r.heal_id !== r.id) {
    // The two datasets are joined on the id itself. Keeping them equal
    // means nothing has to carry a mapping table around.
    fail(where, `heal_id "${r.heal_id}" must match the gadget id "${r.id}"`);
  }

  items[r.id] = {
    id: r.id,
    name: r.name,
    wiki_name: r.wiki_name,
    classes: parseClasses(r.classes, where),
    slot: r.slot,
    category: r.category,
    introduced: r.introduced === UNKNOWN_VERSION ? null : r.introduced,
    removed: r.removed || null,
    // Whether the person carrying it is helped by it. A Heal Beam cannot
    // heal its own user and a Defibrillator does nothing for someone still
    // standing, so neither can be the thing keeping the defender alive.
    self_use: r.self_use === 'yes',
    heal_id: r.heal_id || null,
    model: r.model,
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
for (const item of Object.values(items)) {
  const versions = Object.keys(item.snapshots).sort(compareVersions);

  // Anything the simulation reads has to have numbers behind it. Anything
  // else may be roster-only, which is the normal state for most of this file.
  if (item.model === 'shield' && !versions.length) {
    fail('items.csv', `${item.id} is model=shield but has no snapshots — it cannot be simulated`);
  }
  if (!versions.length) continue;

  if (!item.introduced) {
    fail('items.csv',
      `${item.id} has snapshots but its introduced version is "?" — a snapshot means the version is known`);
    continue;
  }
  if (versions[0] !== item.introduced) {
    fail('snapshots.csv',
      `${item.id}: earliest snapshot is ${versions[0]} but items.csv says it was introduced at ${item.introduced}`);
  }
  for (const v of versions) {
    if (compareVersions(v, item.introduced) < 0) {
      fail('snapshots.csv', `${item.id}: snapshot ${v} predates its introduction at ${item.introduced}`);
    }
  }

  // Same rule as the heal ingest: a stat that is set anywhere must be set
  // everywhere, so resolving an early version can never report "no radius"
  // when what it means is "nobody wrote the radius down".
  const everSet = STAT_FIELDS.filter(f => versions.some(v => item.snapshots[v].fields[f] !== null));
  for (const v of versions) {
    const missing = everSet.filter(f => item.snapshots[v].fields[f] === null);
    if (missing.length) {
      fail('snapshots.csv', `${item.id} at ${v}: ${missing.join(', ')} blank here but set at another version`);
    }
  }
}

// A shield with no health is not a shield. Checked here rather than in
// gadgets.js so a bad row fails the build instead of quietly absorbing
// nothing in the middle of a grid run.
for (const item of Object.values(items)) {
  if (item.model !== 'shield') continue;
  for (const [v, snap] of Object.entries(item.snapshots)) {
    if (!(snap.fields.device_hp > 0)) {
      fail('snapshots.csv', `${item.id} at ${v}: model=shield needs a positive device_hp`);
    }
  }
}

// ── Change log ─────────────────────────────────────────────────────
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

// ── Write ──────────────────────────────────────────────────────────
if (problems.length) {
  console.error('\n  GADGET INGEST FAILED\n');
  for (const p of problems) console.error('    ' + p);
  console.error('');
  process.exit(1);
}

const allVersions = [...new Set(
  Object.values(items).flatMap(i => Object.keys(i.snapshots))
)].sort(compareVersions);

const timeline = {
  generated: new Date().toISOString(),
  note: 'Generated by tools/ingest_gadgets.mjs from csv/gadgets/. Do not edit by hand.',
  versions: allVersions,
  items
};

for (const item of Object.values(timeline.items)) {
  for (const snap of Object.values(item.snapshots)) delete snap.__line;
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'gadget_timeline.json'), JSON.stringify(timeline) + '\n');

// ── Report ─────────────────────────────────────────────────────────
const all = Object.values(items);
const snapCount = all.reduce((n, i) => n + Object.keys(i.snapshots).length, 0);
const changeCount = all.reduce((n, i) => n + i.changes.length, 0);
const modelled = all.filter(i => i.model !== 'none');
const unknownIntro = all.filter(i => !i.introduced);

console.log(`\n  ${all.length} kit items, ${snapCount} snapshots, ${changeCount} changes  →  csv/cleaned/gadget_timeline.json`);
console.log(`  versions: ${allVersions.join(', ')}\n`);

const bySlot = slot => all.filter(i => i.slot === slot).length;
console.log(`  ${bySlot('specialization')} specializations, ${bySlot('gadget')} gadgets, ${bySlot('carriable')} carriables`);
for (const c of ['light', 'medium', 'heavy']) {
  console.log(`    ${c.padEnd(7)} ${all.filter(i => i.classes.includes(c)).length} items available`);
}

console.log('\n  MODELLED');
for (const item of modelled) {
  const versions = Object.keys(item.snapshots).sort(compareVersions);
  const newest = versions[versions.length - 1];
  const where = item.model === 'heals' ? 'numbers in csv/heals/' : `${versions.length} snapshots, newest ${newest}`;
  console.log(`    ${item.name.padEnd(16)} ${item.model.padEnd(7)} ${where}`);
}

if (unknownIntro.length) {
  console.log(`\n  ${unknownIntro.length} items have no introduction version yet ("?" in items.csv):`);
  console.log(`    ${unknownIntro.map(i => i.id).join(', ')}`);
}
console.log('');
