# Kit records — specializations, gadgets, carriables

Every item a player can equip, plus the arena carriable that behaves like one.
Hand-authored inputs — run `node tools/ingest_gadgets.mjs` to build
`csv/cleaned/gadget_timeline.json` from them.

This dataset answers two different questions, and it is worth being clear about
which is which:

1. **Who is allowed to bring what.** Answered for the whole roster. Every item
   has a class and a slot, which is all the loadout rules in `gadgets.js` need.
2. **What the item does, in numbers.** Answered for two items — the Mesh Shield
   and the Dome Shield. Everything else is a roster entry with no stats, and
   that is a finished state rather than an unfinished one.

## Two files

`items.csv` holds what never changes — the name, the class, the slot, whether
the carrier is helped by it. One row per item, 49 of them.

`snapshots.csv` holds the stats, one row per **(item, version)**, and each row
is a **complete snapshot** rather than a list of what changed. Blank stats are
`-`. Only items that something in this repo actually simulates appear here.

Same split, and the same reasoning, as `csv/heals/README.md`.

## Columns in `items.csv`

| Column | Meaning |
|---|---|
| `classes` | `light`, `medium`, `heavy`, `all`, or a `/`-separated list like `medium/heavy` |
| `slot` | `specialization` (one per player), `gadget` (three per player), `carriable` (no slot — picked up in the arena) |
| `category` | rough function: `shield`, `heal`, `damage`, `mobility`, `trap`, `vision`, `cover`, `control`, `breach`, `stealth`, `utility`, `revive`, `defense` |
| `introduced` | version it arrived, or `?` — see below |
| `removed` | version it left, blank if it is still in the game |
| `self_use` | whether the person carrying it is helped by it. `no` for the Heal Beam and H+ Infuser, which cannot heal their own user, and for the Defibrillator, which does nothing for someone still standing |
| `heal_id` | set on the four healing items, joining this row to `csv/heals/`, which owns their numbers |
| `model` | `none` (roster only), `heals` (numbers live in `csv/heals/`), `shield` (`gadgets.js` builds a damage pool from it) |

### `introduced` is `?` for most of the roster

Twenty items have no introduction version yet, because it has not been
researched — not because they were always there. `?` says so out loud rather
than putting a plausible `1.0.0` next to something that shipped in Season 4.
An item with snapshots must have a real version; the ingest enforces that.

## What the loadout rules do with this

`gadgets.js` seats every item in a squad of three: the defender, whose class is
fixed, and two teammates who can be anything. One specialization and three
gadgets each, items only in the hands of a class that can carry them, and
nothing that cannot help its own carrier sitting with the defender.

That filter does real work. Two of the sixteen healing combinations the Sustain
screen used to rank — anything with the Heal Beam, the H+ Infuser *and* the
Healing Emitter — need a Medium, a Light and a Heavy teammate, which is one
player more than a squad has. They were unfieldable, and they were ranked
anyway. A Heavy defender can carry the Emitter themselves, so for them all
sixteen stand.

## The two shields

| | Mesh Shield | Dome Shield |
|---|---|---|
| Slot | Heavy specialization | Heavy gadget |
| Health at 11.4.1 | 900 | 250 |
| Duration | none — it stands until broken | 5.5s |
| Radius | — | 4m |
| Cooldown | energy-based, see below | 30s |

Both are recorded the same way the heals are: the wiki gives current stats plus
a change log, and the log was run backwards once to reconstruct each version.
The Mesh's history is health only — its Season 5 rework onto an energy pool
(225 energy to raise it after lowering, 300 to redeploy after it is destroyed)
changed how it is paid for and not how much it absorbs, so it appears as a note
on a row that moves nothing.

### The one number without a citation

The Mesh at **900** in Season 11 is user-reported from play. The wiki's change
log ends at 850 in 9.0.0 and no patch note for the step to 900 has been found.
It is in `snapshots.csv` as an 11.0.0 row with that said plainly in its `note`,
on the same principle as the measured regeneration rate in `heals.js`: a
measured number beats a missing one, as long as nobody can mistake it for a
cited one.

### What the simulation assumes about them

Recorded here because none of it is in the data, and all of it is arguable:

- **They are up from t=0.** Same assumption the heal schedules make. Dropping a
  Dome late to cover the end of a steal is a real play the grid cannot see.
- **The Dome covers everything outside its radius and nothing inside it.** At
  1m the attacker is standing in the bubble with you. That is geometry, so it
  is computed rather than assumed.
- **The Mesh covers one arc, and how often that is the right arc is a guess.**
  `MESH_COVERAGE` in `gadgets.js` is the default, and the Sustain screen makes
  it a control because it is an assumption rather than a measurement.
- **A shield eats the whole shot that breaks it.** No damage carries through,
  which is why a 250 HP Dome is worth more against a sniper than 250 more
  health would be.
- **Nothing repairs a shield inside the window.** The Mesh's regeneration needs
  a pause in the incoming fire that a contested objective does not offer.
- **Explosives, melee and destruction mechanics are not modelled at all.** The
  only thing that happens to a shield here is bullets.

## Provenance

Identical to the heals dataset, with one addition:

| | Meaning |
|---|---|
| `exact` | this version has a snapshot for this item |
| `carried` | inherited from an earlier snapshot — normal |
| `theoretical` | the version asked for **predates the item**; its earliest snapshot is used |
| `roster` | the item has no snapshots at all — it has a class and a slot and nothing else |

## Adding to this

**A new item:** one row in `items.csv`. `model` is `none` and `introduced` may
be `?` if you do not know it. Nothing else has to change.

**Numbers for an existing item:** set `model`, fill in `introduced`, and append
complete snapshot rows. If it is a shield, `gadgets.js` picks it up as one; if
it is something else, it needs a model in code before the numbers mean anything.

**A new version of a shield:** append a row carrying its **full** state, put the
patch note's wording in `note`, and re-run the ingest. Rows may be added in any
order.

## Sources

<https://www.thefinals.wiki> — the `Gadgets` and `Specializations` list pages for
the roster, and the `Mesh_Shield` and `Dome_Shield` pages for the stats and
their patch-history tables. Retrieved 2026-08-19, current as of game version
11.4.1, except the Mesh's 900 as noted above.
