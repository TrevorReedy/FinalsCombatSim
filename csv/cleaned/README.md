# Cleaned weapon data + change history

Generated. Do not edit by hand — run `node tools/ingest_weapon_history.mjs` from the repo root.

The raw sheets in `csv/` are read-only inputs and are never modified by the pipeline.

## Contents

| File | What it is |
|---|---|
| `<version>_finals_weapon_data.csv` | One normalised snapshot per sheet, all in the 8.3.0 column layout |
| `weapon_history.json` | Event log of every stat difference between consecutive versions, plus provenance and validation |
| `weapon_timeline.json` | The same data indexed by weapon, fetched by the app's weapon history page |

Versions: `1.5`, `2.4.0`, `5.8`, `7.3.0`, `8.3.0`, `10.0.0`, `11.3.0`.

Inputs may be `.csv` or `.xlsx` — 11.3.0 arrived as an Excel workbook, and the ingest reads its
`SUMMARY` worksheet directly (an `.xlsx` is a zip of XML, and Node ships an inflater), so `csv/`
keeps exactly the file the author published.

## Format

Every snapshot uses the exact 26-column layout of Zafferman's 8.3.0 summary sheet, including the
`LIGHT` / `MEDIUM` / `HEAVY` section rows. Missing values are `-`, ranges carry `m`, dropoff
reduction carries `~` and `%`, and times are plain seconds.

Weapons missing from an earlier sheet are simply absent from that file — the game had fewer
weapons, and each author covered a different subset.

**Raw columns** (body damage, head damage, RPM, magazine, reloads, burst, dropoff) come from the
source sheet. **Derived columns** (damage per magazine, TTK, STK) are recomputed from those raw
values rather than copied, so every version is internally consistent and comparable to every other.

Timing matches `simulate.js`, so the history, the stats table and the simulator all agree.
Magazine exhaustion inserts an empty reload (which replaces the shot interval — you fire the moment
it completes). Weapons with no rate of fire (melee) get an STK but no TTK, matching the source
sheets.

### The two authors disagree about burst timing

*Delay until next burst* means different things in different sheets, and the ingest reports which
is which under `validation.burst_convention_by_sheet`:

| Sheet | Convention its published TTK follows |
|---|---|
| 2.4.0 | delay **replaces** the shot interval (10 of 12 burst cells) |
| 7.3.0 | delay **replaces** the shot interval (6 of 9) |
| 8.3.0 | delay **replaces** the shot interval (6 of 9) |
| 10.0.0 (Krome) | delay is **added** to the shot interval (9 of 9) |
| 11.3.0 | delay **replaces** the shot interval (6 of 9) |

This pipeline and `simulate.js` both use the **added** convention, because Krome's 10.0.0 sheet is
the source of `weapons_s10_cleaned.json` — the data the simulator actually runs on. The consequence
is that recomputed TTKs for burst weapons differ from what the Zafferman sheets print; that is a
convention difference, not an error on either side.

## Trust model

Sheets disagree about layout, units, and occasionally about what a column even means, so each
source declares a trust level per field:

- **measured** — the sheet has an explicit, labelled column for it
- **derived** — reconstructed (e.g. head damage from a headshot multiplier); diffed, but every
  resulting event is marked low confidence
- **untrusted** — recorded in the snapshot but never diffed (e.g. a reload column with no stated
  kind, which cannot be compared against a sheet that separates tactical from empty)

A field is only compared between two versions when both endpoints record it in a way worth
trusting. Per-source caveats are listed in `weapon_history.json` under `versions[].caveats`.

## Tolerances

Two authors frame-counting the same unchanged weapon must not produce a phantom balance change:

| Field | Tolerance |
|---|---|
| Body / head damage, magazine, shots per burst | exact |
| RPM | 2% relative |
| Reload times, burst delay | 0.05s |
| Dropoff min / max range | 0.5m |
| Dropoff reduction | 3 percentage points |

Any event with a derived or disputed endpoint additionally needs a 2% relative change to register,
which absorbs multiplier rounding (25 × 1.5 = 37.5 against a sheet that prints 38).

## Rate-of-fire sanity check

The 5.8 sheet's rate column matches independently-known RPM for 14 of 21 comparable weapons and is
far off for the rest — it is not uniformly RPM. Rather than trusting or discarding the whole
column, each value is checked against the versions either side of it:

- **Withheld (3 rows, all in 5.8)** — the value is >30% from both neighbours *and* the neighbours
  agree with each other within 25%. That pattern is a column/unit error, not a balance change. The
  93R reads 220 where 2.4.0 and 7.3.0 measure 1020 and 1000; XP-54 reads 280 against 850 and 860;
  SH1900 reads 180 against 100 and 80. The sheet's number is kept in the RPM column for reference,
  but the derived TTK columns are left blank and the value never enters the history.
- **Disputed (2 rows, Throwing Knives in 2.4.0 and 5.8)** — >30% from both neighbours, but the
  neighbours disagree with each other too, so a genuine rework cannot be ruled out. The value is
  kept and used; any change derived from it is marked low confidence.

Both cases are annotated in the row's Notes column.

## Validation

Two independent checks run on every ingest and are recorded in `weapon_history.json`:

1. **Recomputed vs published 8.3.0** — 193/195 STK cells and 161/195 TTK cells reproduce the
   sheet's own published values. The gap splits in two: burst weapons (93R, FAMAS, Throwing Knives)
   differ because of the convention above, and LH1, SR-84 and SA1216 differ because that sheet's
   TTK column cannot be derived from its own stat columns at all — LH1 publishes 0.67s where its
   stated 280 RPM implies 0.64s. Two STK cells also differ (Dagger, Sledgehammer Alt.). The
   recomputed value is used everywhere, and all disagreements are listed in full.
2. **Krome 10.0.0 vs the shipped simulator data** — 187 fields compared against
   `weapons_s10_cleaned.json`, 0 mismatches. This is what confirms the parser and the alias table.

## Event log

`weapon_history.json` holds one entry per difference:

```json
{
  "weapon": "pike_556", "name": "Pike .556",
  "from_version": "7.3.0", "to_version": "8.3.0",
  "type": "change", "field": "body_dmg", "label": "Body damage",
  "from": 50, "to": 48, "delta": -2, "delta_pct": -4,
  "confidence": "high", "note": null,
  "verified_against_patch_notes": false
}
```

`type: "coverage"` marks a weapon appearing in or disappearing from an author's sheet. That is
sheet coverage, **not** evidence the weapon entered or left the game.

`verified_against_patch_notes` is `false` on every event, because no patch-note source has been
ingested yet. Once one is, a change that still has no matching patch note is a shadow-change
candidate — that comparison is the reason the field exists.

## Known limits

- Attribution is to a **version range**, not a patch. A change between 2.4.0 and 5.8 happened
  somewhere in that window; these snapshots cannot say where.
- No gadgets. None of these sheets cover them.
- The 11.3.0 sheet records melee weapons with shots-to-kill only, so their rows there are blank.
  That is sheet coverage, not a change to those weapons.
- Renames that may also be re-definitions are declared in `tools/weapon_aliases.json` under
  `rescoped` and appear in the history as `type: "definition"` events beside the numbers they
  qualify — currently the CL-40 Splash → Outer Radius rename at 11.3.0.
- Alias decisions that affect continuity (the CL-40 direct/splash split, `MGL32` → `MGL-32`,
  `Pike` → `Pike .556`) are documented in `tools/weapon_aliases.json` and echoed into
  `weapon_history.json` under `alias_notes`.
