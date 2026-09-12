# Decoupling the rank scale — a plan

**Status: Phases 1–4 shipped — #322 (ids), #324 (every reader resolves a
level by `RankRef` and order is array position), and Phase 4 on 2026-09-12
(`RankLevel` has no `value`; `id` is required; `effectiveRankingSystems` mints
a missing id on read; the orphan stand-in in `primaryRank` is gone; cup
categories' `min_rank`/`max_rank` are `RankRef`s). What remains of the number
is the field a ladder document written before Phase 4 still carries, read by
`legacyRankValue` alone (`rankValueCensus.test.ts` pins its callers) until
`backfill:rank-refs --strip-values` removes it — Phase 4b, run after the flip.
Phase 5 shipped the same day: both editors reorder by drag-and-drop and insert a
level at any position. Phase 6 blocked on the reassignment decision.** Decided 2026-09-11: ids are opaque strings, not a reinterpreted
`value`, and installed mobile apps will show no belt between the Phase 2 data
flip and their update — so that flip is a script run on Franco's timing, never
a merge side effect. Written 2026-09-11 after the HMD belt
scale change was found to have no implementation, and after Franco asked whether
the progression dimension should be decoupled so the ladder can be changed at any
time, "considering also that ranks might be changed in order, i.e. with
drag-n-drop in UI".

---

## The fault

`RankLevel.value` does three jobs at once:

| job | who depends on it |
|---|---|
| **identity** | `Contact.ranks[systemId]` stores the number, and nothing else |
| **order** | `orderedLevels` sorts by it; `nextLevel` finds `l.value > current` |
| **rule key** | `RankProgression.rules[].from` / `.to` name a number |

Change the numbering and all three change together. Every stored number keeps
its old shape and acquires a new meaning, so the data is not corrupted in any way
a reader can detect — it is simply about a different belt than it was yesterday.

## Why drag-and-drop is what forces the decision

This is the part that turns a deferred migration into a design defect.

`expandRankRange`'s doc comment records the rule explicitly: **"ORDER IS BY
`value`, NOT BY POSITION in the levels array"**, because "nothing sorts or
validates `levels` on write, so array position is not authoritative". That was a
correct call for the code as it stands.

But it means **order can only be expressed by rewriting `value`**. A drag-and-drop
reorder therefore has to renumber — and renumbering is the migration-scale event
described above. Ship the gesture onto today's model and a studio manager
reassigns everyone's grade by dragging a row, with no warning and no error.

So the question is not whether decoupling is worth it in the abstract. It is that
the requested feature is not safely implementable without it.

## Where the number is stored today

The census. Add to this list, never copy it.

- **`Contact.ranks[systemId]`** — the number, per system. On staging: 3,276 values
  across 1,638 contacts, on `hmd` and `kd`.
- **`checkin_data.disciplines[systemId]`** on exam check-ins — the graded level.
  1,400 rows in a 4,000-check-in sample.
- **`ContactFilter.rankFilter[systemId]`** — an array of numbers. Saved filter
  presets hold it, and so does every **dynamic contact group rule**. A band like
  "Blue and above" is *expanded into explicit numbers* by `expandRankRange` when
  it is saved.
- **`RankProgression.rules[].from` / `.to`** — the seeded dan bands, keyed on 11
  through 14. These live in `PLUGIN_SEEDS` in shared source, not in the database,
  so no data migration reaches them.
- **`TeamPublicProfile.ranking_systems`** — the whole ladder, mirrored per team by
  `syncTeamPublicProfile`.
- **Badge artwork object names in Cloud Storage** — `RankLevelFields` uploads to
  `${storagePath}/level-${level.value}.${ext}`. The *filename* carries the
  ordinal, so a renumber silently repoints every uploaded badge at another level.
- **`rank_promotions`** — the ledger. Zero rows today; it is not built yet, which
  is the one piece of luck in this list.

Dynamic groups deserve a second mention. They are derived lazily and never
materialised, by design — there is no sync job and nothing to re-run. That is
normally the feature's strength, and here it is the trap: a renumber leaves the
stored *rule* holding stale numbers, and nothing anywhere recomputes it.

## Why the failure is silent rather than loud

`primaryRank` already tolerates a value the scale no longer defines. When the
exact value is missing it falls back to the highest level *at or below* it and
returns `orphaned: true`:

```ts
const exact = levels.find((l) => l.value === value)
const level = exact ?? levels.slice().sort((a, b) => b.value - a.value).find((l) => l.value <= value)
```

That fallback exists for good reason, and it means a renumber does not throw, does
not blank a badge, and does not fail a test. It **demotes**. A contact resolves to
a real, plausible, lower belt, and the only signal is a flag almost nothing reads.

*(Removed in Phase 4: an orphan of either kind now resolves to nothing, and the
`orphaned` flag is gone with the stand-in.)*

## The design

Give every level a stable identity and stop storing order.

```ts
export interface RankLevel {
  /** Opaque, assigned once, NEVER reused and NEVER renumbered. */
  id: string
  label: string
  // …colour, secondColor, emoji as today
}
```

Three rules follow, and they are the whole design:

1. **Records reference `id`.** `Contact.ranks` becomes `Record<string, string>`:
   system id → level id.
2. **Order is position in `levels`.** The array becomes authoritative, which is
   the opposite of today's rule, so `expandRankRange`'s comment and every reader
   that sorts by `value` change together.
3. **No ordinal is ever persisted.** Comparisons resolve an ordinal from the
   current ladder at read time (`levels.findIndex(l => l.id === held)`), so a
   reorder changes what "Blue and above" means *and that is correct* — the ladder
   itself changed. What must never happen is a stored number meaning one belt on
   Monday and another on Tuesday.

Insertion then costs nothing: splice a new level into the array at the right
position and no stored value moves. Reordering costs nothing for the same reason.

## Two things the editor cannot do today

*(Both shipped: the cap went in Phase 1, insert-at-position and drag-and-drop in
Phase 5 — `RankLevelFields` takes a `handle` and an `onInsertBelow`, and both
editors wrap the rows in the house `SortableList`. Kept as written because it
records why they were load-bearing.)*

Worth knowing before planning UI work, because both are load-bearing for HMD:

- **`addLevel` only appends.** It assigns `Math.max(...values) + 1`, so there is
  no way to add an intermediate level at all. Adding White-Yellow between White
  and Yellow is currently not expressible except by retyping every label
  downward, which is the renumber performed by hand.
- **The editor caps a system at 10 levels** (`disabled={form.levels.length >= 10}`).
  HMD already has 15, so the ladder it actually needs cannot be extended through
  this screen even once the insert problem is solved.

And one prerequisite for the drag-and-drop itself: the level rows are keyed by
array index (`key={i}`). Reordering index-keyed rows makes React reuse row state
across positions, so focus and in-progress input attach to the wrong level. Stable
ids fix this too, which is convenient but is a separate reason from the data one.

## A cheaper interim, and its limit

The code **already supports non-contiguous values**. `nextLevel` finds
`l.value > current` rather than `current + 1`, with a comment stating a scale's
values need not be contiguous.

So the two HMD belts could be added *today*, with no schema change and no data
migration, by giving them values between the existing ones — `1.5`, or a one-time
re-spacing to multiples of ten followed by inserts at the gaps. Nothing stored
moves. It needs an editor that can express an intermediate value, which is a small
change against the "only appends" limit above.

**It does not solve reordering**, because reordering still means rewriting
`value`. Treat it as a way to unblock the belt addition, not as an alternative to
this plan.

## Phases

**Phase 0 — decide the reassignment, separately.** See the section below. It is
not a code task and it blocks nothing else here.

**Phase 1 — introduce `id`, keep `value`.** Add the field, have the migration and
both seeders assign one, and backfill every existing level. `value` stays exactly
as it is and stays authoritative. Nothing reads `id` yet. This phase is additive
and reversible.

**Phase 2 — convert the readers, one store at a time.** In census order, because
the risk is uneven: `Contact.ranks` and `primaryRank` first (widest blast radius,
easiest to test), then exam check-ins, then the filter and its expanded mirror,
then the progression rules, then the public-profile mirror, then the Storage
object names. Each conversion reads `id` and falls back to `value` for records
not yet converted.

**Phase 3 — flip the order rule.** Array position becomes authoritative;
`orderedLevels` returns `levels` unsorted; `expandRankRange` and its comment are
rewritten. This is the one irreversible step and wants its own review.

**Phase 4 — drop `value` from the stored shape**, once nothing reads it. Assert
it in a source-scanning test in `packages/functions`, the way
`connect/commitSites.test.ts` pins call sites across the functions/web boundary.

*Shipped 2026-09-12, in two halves.* The SHAPE half is code: `RankLevel` declares
no `value`, `id` is required, every seed, preset and the migration write
id-only ladders (the migration keeps the source ordinal as `legacyValue` in its
own table, never on the ladder), and the type system refuses every ordinary
read. The DATA half waits for the flip: a ladder document written before Phase
4 still carries the number, `legacyRankValue` is the one sanctioned peek at it
— the resolver's numeric arm and the two editors' holder counts, which must
still find a contact holding the number — and `backfill:rank-refs
--strip-values` removes the field from every ladder and refreshes the public
mirrors once no record holds a number any more (Phase 4b; it refuses while any
orphan number remains). Two consequences to know: `primaryRank` no longer
stands an orphaned number in at the nearest level below — an orphan of either
kind resolves to nothing, which is the honest answer — and
`effectiveRankingSystems` mints a missing id on read with the same slug the
backfill writes, so a ladder nobody backfilled still resolves (and the id it
stores is the one the backfill would have put there). **Deploy order:**
`backfill:rank-level-ids` is no longer a precondition of resolving, but it is
still owed before `backfill:rank-refs`, which refuses an id-less ladder.

**Phase 5 — the UI.** Drag-and-drop reorder and insert-at-position, which are now
ordinary array edits. Also raise or remove the 10-level cap.

*Shipped 2026-09-12.* `arrayMove` and a `splice` — nothing else, which is the
whole point of Phases 1–4. The handle is the same `SortableList` the bio-link,
website and task editors use (drag-by-handle, keyboard reorder); the "+" on a
row inserts an empty level right below it, minted with `newRankLevelId`. A
reorder is saved with the rest of the form and reaches every reader through
`orderedLevels`: the badge strips, the contacts filter band, the progression
bands and the dashboard donut change meaning together, and no contact's stored
ref moves.

**Phase 6 — add the two HMD belts** as a plain ladder edit, and apply whatever
reassignment Phase 0 decided as a separate, explicit, auditable step.

## What decoupling does not solve

**Insertion becomes free. Reassignment never does.**

Adding White-Yellow — a belt nobody holds yet — is a pure ladder edit after this
work, with no data migration and no mapping table.

Deciding that today's Yellow holders are now *Yellow-Orange* is a different kind
of statement. It is a claim about what real people have earned, affecting 79
contacts on `hmd` and 75 on `kd` at the time of writing. No schema change can
answer it, and it must not be smuggled in as a side effect of a scale edit: it
wants an explicit, recorded, reversible action with the federation's decision
attached.

## Sequencing against the HMD cutover

Do Phases 1 through 4 **before the production cutover** if they are done at all.
Today the data exists only on staging and is fully reproducible by re-running the
migration; the promotion ledger is empty, so the ordering constraint the HMD plan
records ("run the remap before the ledger backfill, or the ledger records
pre-renumber values") is currently free. Every one of those advantages disappears
the day real studios are reading their own belts.

## Verification

- `pnpm build` · `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm i18n:check`.
- A source-scanning census test that fails when a new reader of `RankLevel.value`
  appears, mirroring `connect/commitSites.test.ts`.
- Against the HMD staging data specifically: after each conversion phase, compare
  **belt LABELS** per contact before and after, never values. The numbers are the
  thing under change, so a check that reads them proves nothing.
- One dynamic contact group with a rank band, saved before and re-evaluated after,
  returning the same people.
