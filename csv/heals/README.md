# Heal item records

The four healing sources, and how their stats moved across seasons. Hand-authored
inputs — run `node tools/ingest_heals.mjs` to build `csv/cleaned/heal_timeline.json`
from them.

| UI name | Wiki name | Slot | Since |
|---|---|---|---|
| beam | Healing Beam | Medium specialization | 1.0.0 |
| ball | Healing Emitter | Heavy gadget | 7.0.0 |
| infuser | H+ Infuser | Light gadget | 7.0.0 |
| canister | Healing Barrel | arena carriable | 6.6.0 |

The UI uses the short names. The wiki names live in `items.csv` so every number
traces back to where it came from.

## Two files

`items.csv` holds what never changes — the name, the slot, when it arrived,
whether it can heal the person carrying it. One row per item.

`snapshots.csv` holds the stats, one row per **(item, version)**, and each row is
a **complete snapshot** of that item at that version rather than a list of what
changed. Blank stats are `-`.

## Why snapshots here, when `csv/patches/` records changes

The patch rail records only what a patch changed, because its source is a stream
of patch notes arriving one at a time and an absolute record means a missing
patch cannot corrupt anything downstream.

These come from the other direction. The source is a wiki page giving each item's
**current** stats plus a change log, so reconstructing 7.0.0 means running that
log backwards. That reconstruction has to happen exactly once, and writing the
result down as a snapshot makes it auditable — you can read the 4.0.0 row and
check it against the wiki without replaying four earlier rows in your head.
Recording deltas instead would hide the arithmetic that was already done.

The dataset is also 14 rows. The machinery that makes deltas worth it on 150
patch files earns nothing here.

## Resolving an item at a version

Newest snapshot at or before the version asked for. Asking for the beam at 9.2.0
gives the 8.0.0 row, because nothing moved in between.

Asking for an item **before it existed** is allowed and is not an error — see
`provenance` below.

## What is known, and what is assumed

Only the fields a patch note actually names are known to have moved. Everything
else on a row is the current value carried backwards on the assumption that
nothing ever changed it, which is the weakest claim in this dataset.

Concretely, on the beam: `heal_rate`, `overheat_time`, `range` and `acquire_range`
all have real change records behind them. `overheat_cooldown`, `recharge_delay`
and `recharge_rate` do not — no patch note has ever mentioned them, so the 1.0.0
row carries today's numbers. If one of them silently moved in Season 2, nothing
here would show it.

Two figures are deliberately **not** stored because they are derived, and storing
them would let them drift out of step with the values they come from:

- The beam's **253 HP overheat capacity** is `heal_rate × overheat_time`
  (46 × 5.5). The wiki quotes both; only the time is recorded here. This is also
  what makes the history self-consistent — the same 5.5s gives 275 HP at the
  4.0.0 rate and 220 HP at the 8.0.0 rate, and the quoted capacity tracks it.
- The infuser's **220 HP magazine** is `heal_per_shot × capacity`.

## Provenance

Every resolved item carries one of three labels, and every part of the UI that
shows a heal number renders off it:

| | Meaning |
|---|---|
| `exact` | this version has a snapshot for this item |
| `carried` | inherited from an earlier snapshot — normal, and matches how weapons behave |
| `theoretical` | the version asked for **predates the item**; its earliest snapshot is used |

`theoretical` exists so that cross-era comparisons are answerable rather than
refused. Putting Season 1's 50 HP/s beam against the ball's launch build is a
reasonable question; the tool answers it and marks the answer, instead of hiding
the ball and pretending the question was never asked.

Nothing renders a `theoretical` number without saying so.

## Adding a version

Append a row to `snapshots.csv` carrying the item's **full** state at that
version, not just the field that moved, and put the patch note's wording in
`note`. Re-run the ingest. Rows may be added in any order; the ingest sorts them.

## Sources

Per-item pages on <https://www.thefinals.wiki>, which carry the patch-history
tables these rows were reconstructed from: `Healing_Beam`, `Healing_Emitter`,
`Infuser`, `Healing_Barrel`. Retrieved 2026-08-15, current as of game version
11.4.1.

## Stacking

Two supports on one fighter deliver both rates. The Healing Beam and the H+
Infuser add on top of anything else in the stack.

Placed fields do not. The Healing Emitter and the Healing Barrel overlap to
the higher of their two rates, not the sum — standing in both is worth no
more than standing in the better one. The Barrel's contact burst is an
instant heal rather than a field rate, so it still lands on top.

The Emitter's non-stacking is from in-game testing. The Barrel behaving the
same way is assumed by analogy and has not been measured; `ZONE_STACKING` in
`heals.js` is the one place to flip if it turns out to combine.
