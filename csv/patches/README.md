# Patch records

One file per patch, holding **only what that patch changed**. Nothing is repeated
from the full data sheets, and no file ever rewrites another — dropping a new
patch in here is purely an append.

## Naming

    <version>_patch.csv        e.g. 11.4.0_patch.csv

Files beginning with `_` are ignored, so `_template_patch.csv` is a template
rather than data. `index.csv` carries the date, title and source URL per patch.

## Columns

| Column | Meaning |
|---|---|
| `weapon` | Weapon name as the patch notes write it. Resolved through `tools/weapon_aliases.json`, so any spelling already known there works. |
| `field` | Which stat changed. Leave blank for a change that is not a number. |
| `value` | The stat's value **after** the patch. Absolute, never a delta — see below. |
| `note` | Free text. Use it for the wording of the patch note, or for a change with no `field`. |
| `kind` | Optional. Blank on a stat row means "work it out from the numbers", which is almost always right. See below. |

Valid `field` values:

    body_dmg          head_dmg          rpm               magazine_size
    empty_reload      tactical_reload   shots_per_burst   burst_delay
    dropoff_min       dropoff_max       dropoff_reduction

and four the patch notes state but no data sheet records:

    precision_angle   lunge_distance    lunge_angle       stamina_regen

These four exist because the 11.0.0 melee rework is written almost entirely in
terms of them. They never take part in the sheet-to-sheet diff and never get
checked against a measurement, because there is no measurement to check.

Unknown weapons, field names or kinds stop the ingest with the file and line,
rather than being skipped quietly.

### Two fields whose units need converting

Patch notes sometimes state a change in a unit the sheets do not use. Convert
once, here, and say so in the `note`:

- **`dropoff_reduction`** — notes give a multiplier ("falloff multiplier from
  0.64 to 0.675"), the sheets give a percentage. Record `67.5`. Despite the
  name this is damage *retained* at max range, so **higher is a buff**.
- **`body_dmg` for shotguns** — notes give per-pellet damage, the sheets give
  the total across all pellets. The Model 1887's "pellet damage from 12 to 13"
  is recorded as `117`, being 13 × 9 pellets.

The same goes for a headshot *multiplier* change: the sheets store absolute head
damage, so the Pike's "1.5 to 1.75" is recorded as `85.75`.

## Buff, nerf, or soft change

Every change is classified so the UI can mark it — green ↑, red ↓, or a yellow
line. This is **derived from the numbers**, not hand-tagged, because which
direction is *good* is a property of the field, not of the change: more damage
is a buff, more reload time is a nerf. A hand-written label can silently
disagree with the value sitting next to it; a derived one cannot.

A change is **soft** when there is no tracked stat behind it — the patch altered
an interaction or a stat nothing records. That is the honest answer, not a
fallback: "Improved hip-fire spread while moving" has no number in this schema.
A stat being recorded for the **first time** is also soft, because a first value
has a magnitude but no direction.

The `kind` column overrides the derivation, and is worth using for:

| Value | Use |
|---|---|
| `buff` / `nerf` | A note-only row whose direction the prose makes obvious — "Decreased sweep range by ~0.5m" is a nerf, but no field holds sweep range. |
| `soft` | A stat row where the arithmetic misleads. |
| `dev` | Not a change at all — a **Dev Note**. The row carries only `weapon` and `note`, and renders as commentary beside the changes rather than as one of them. |

An override that agrees with the derivation is recorded as derived anyway, so
adding one never overstates how much was decided by hand.

## Record the value, not the change

A patch note saying "Flamethrower damage reduced by 5, from 30 to 25" is recorded
as `25`, not `-5`. This matters more than it looks:

- **A missing patch cannot corrupt anything.** With deltas, one un-ingested patch
  silently poisons every later value. With absolute values a gap just means the
  nearest recorded value is used, and it can be labelled as such.
- **Order of arrival stops mattering.** Because no record is expressed relative to
  another, a patch found later slots in wherever it belongs and nothing needs
  recomputing — including a patch older than the earliest data sheet.
- Patch notes mix "reduced to 25" with "reduced by 10%". Converting to an absolute
  value once, here, avoids compounding rounding forever after.

## Patches you skip, and patches that changed nothing

Most patches touch no weapon stats at all, and you will not ingest every one. That
is fine and needs no special handling: because every record is absolute, a version
with no record simply resolves to the newest record before it. Asking for 11.4.2
when the nearest records are 11.3.0 and 11.5.0 correctly gives you 11.3.0's state.

The only thing the gap costs you is provenance, so there is a way to say which kind
of gap it is:

| | Meaning |
|---|---|
| `<version>_patch.csv` with data rows | Ingested, and these stats changed |
| `<version>_patch.csv` with only a header | Ingested, and no weapon stats changed |
| no file at all | Not looked at yet |

The middle case is worth recording for a patch you have read and confirmed changes
nothing — it is the difference between "nothing happened" and "nobody checked".

## How a value gets chosen

Asking for a weapon's stats at version V:

1. Start from the newest **data sheet** at or before V. A blank in that sheet means
   "not applicable" and is left alone — sheets are dense, so their gaps are
   deliberate.
2. Lay any **patch records** after that sheet and at or before V over the top,
   oldest first, each replacing only the fields it names. A field a patch does not
   mention is unchanged by definition.
3. If no sheet exists at or before V — a patch older than every sheet — the nearest
   later sheet is used as the base and the result is flagged, because nothing
   earlier was ever recorded.

Patches at or before the base sheet are not applied: a sheet is a measurement of
the game as it actually shipped, so it already includes them. Where such a patch
disagrees with the sheet that followed it, that disagreement is reported rather
than resolved — a stated change that never showed up in a measurement is exactly
what a shadow change looks like.

## Stated against measured

Once patches fill the gap between two sheets, each stated value can be checked
against the next sheet that measured it, and every change gets one of:

- **confirmed** — the next sheet measures what the patch note said. Recorded on
  the event as `stated_vs_measured`.
- **superseded** — a later patch moved the same field before any sheet saw it,
  so there is nothing to check. The 93R went to 25 damage in 10.3.0 and back to
  24 in 11.0.0; the 11.3.0 sheet reading 24 confirms 11.0.0 and says nothing
  about 10.3.0.
- **unannounced** — a sheet-to-sheet diff moved a stat that the patch notes read
  for that interval never mention, flagged `shadow_change_candidate`. Either it
  changed silently, or a patch in the gap has not been ingested yet.

What makes a change "unannounced" is that the notes for the interval were **read**
— not that they touched the weapon. A stat that moved across a stretch where every
patch was ingested and not one of them so much as names the weapon is the strongest
signal available, and scoping the test to the weapon's own records would make
exactly that case silent. Header-only files count as read: that is what they are for.

Two things are deliberately not flagged, because a patch note would never have
announced either:

- a **head damage** value that moved in step with a stated body-damage change at an
  unchanged multiplier — that is the stated change showing its arithmetic;
- a row the alias file lists under `rescoped`, which changed what it *measures* at
  that version rather than what the game does.

Where a patch and a sheet both describe the same interval, the **patch wins and
the diff is dropped** — not because it is more trustworthy, but because it is
finer. The sheets show the KS-23 going 100 → 104 across Season 11 and call it a
buff; the patch notes show 100 → 110 → 104, a buff followed by a larger nerf.
Keeping both would print the misleading version beside the accurate one.

One exception: head damage that moves in step with a stated body-damage change,
at an unchanged multiplier, is that change showing its arithmetic rather than a
separate one, and is not flagged.
