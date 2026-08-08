# Patch-note ingest progress

Working state for the sweep through every season's patch notes. Delete this file
once every season is covered.

## URL patterns (they differ by era)

    seasons 1-9    https://www.reachthefinals.com/patchnotes/<major><minor>0
                   e.g. 9.4.0 -> /940, 9.12.0 -> /9120, 7.6.0 -> /760
    seasons 10-11  https://www.reachthefinals.com/patchnotes/<major>-<minor><patch>
                   e.g. 11.3.0 -> /11-30, 10.14.0 -> /10-140

A 404 usually means the wrong era pattern, not a missing patch.

## Method, per patch

1. Fetch, asking for the WEAPONS balance section verbatim plus every Dev Note.
2. Write `csv/patches/<version>_patch.csv`. Header-only if it changed no weapon
   stats — that is "read, nothing happened", which is different from "not looked
   at". Most store updates are header-only.
3. Add a row to `index.csv` (version, date, title, url).
4. Re-run `node tools/ingest_weapon_history.mjs` and check the gap shrink.

Verify every stated "from" value against the sheet that precedes it. They have
matched almost everywhere so far; where they do not, record BOTH in the note
rather than picking a side.

## Coverage

Every season is ingested: **136 patch records, 1.5.1 through 11.4.1**, of which 88
are header-only ("read, changed no weapon stats"). Delete this file whenever you
like — it is a working note, not part of the data.

The only patches deliberately not recorded are those before the earliest data
sheet with no bearing on any interval (1.0.0-1.5.0), and gadget/specialization
changes throughout, which this weapons-keyed schema has no home for.

## Remaining sheet-diff gaps

These are measured changes no patch note accounts for. What is left is mostly
irreducible: the `1.5` and `5.8` sheets reconstruct several columns rather than
measuring them, so their diffs are low-confidence by construction.

| Interval | Unexplained | Was |
|---|---|---|
| 1.5 → 2.4.0 | 10 | 12 |
| 2.4.0 → 5.8 | 12 | 32 |
| 5.8 → 7.3.0 | 11 | 22 |
| 7.3.0 → 8.3.0 | 3 | 14 |
| 8.3.0 → 10.0.0 | 8 | 34 |
| 10.0.0 → 11.3.0 | 11 | 25 |

## Conventions worth not re-deriving

- `dropoff_reduction` is damage **retained** at max range. Patch notes write it as
  a multiplier (0.64), the sheets as a percent (64). Convert, and higher = buff.
- Shotgun damage: notes give per-pellet, sheets give the total. Multiply by the
  pellet count of the day — SH1900 15, Cerberus 11-13, Model 1887 8 then 9,
  SA1216 12-13. The counts change, so read the note for that patch.
- Headshot multiplier changes: sheets store absolute head damage. Multiply.
- A stated figure whose unit does not match the sheets is kept as a note-only
  row, never forced into the numeric column. The recurring cases are burst-cycle
  RPM for the 93R and FAMAS (the sheets count bullets) and the Recurve Bow's
  draw-rate RPM.
- `kind` column: blank derives buff/nerf/soft from the numbers. Set it by hand
  only where the prose states a prior the schema cannot see (lunge distances) or
  where the arithmetic misleads. `dev` marks a Dev Note.
- The `5.8` sheet was captured BEFORE patch 5.8.0 — see the caveat on that source
  in tools/ingest_weapon_history.mjs.
