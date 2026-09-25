'use client'

// ─── THE ONE EDGE EDITOR ─────────────────────────────────────────────────────
//
// One component, mounted in BOTH directions. `direction` decides only what each
// ROW is labelled by — a plan name, or an activity name. The controls, the
// validation and the write are identical, which is what makes "same edge, from
// either side" a property of the code rather than a claim about it. The write
// itself is `activityPlanEdgeUpdate` in @linyup/shared, pinned by
// packages/functions/src/offer/activityPlanLink.test.ts.
//
// It REPLACES two editors that each owned a copy of where to write: the access
// tier + benefit blocks in offer/activities/page.tsx, and "Activities this
// subscription unlocks" in components/subscriptions/SubscriptionTypesManager.
//
// ── TWO CONTROLS PER ROW, BECAUSE THERE ARE TWO FACTS ───────────────────────
// ACCESS ("is it included free") and RATE ("what do they pay otherwise") are
// independent — a class can be included in Premium AND give Premium a reduced
// drop-in rate. An appointment has no access facet at all (the price is the
// gate), so that control is absent on those rows rather than
// present-and-ignored.
//
// BOTH TICKED IS NOT A CONTRADICTION, and the row says so out loud. It looks
// like one — included free, and yet a rate? — which is why every row carries a
// one-line outcome underneath. The pair is exactly what a LIMITED plan needs:
// "3 a week included, the member rate after that". Reading the two checkboxes
// as mutually exclusive is the single most common way this screen is
// misunderstood, so the sentence is not decoration and must not be dropped to
// save a line.
//
// ── THE RATE WARNING IS LOAD-BEARING ────────────────────────────────────────
// `memberBenefit` is ONE rule per activity, shared by every plan on it. Setting
// "20% off" from Premium reprices Basic and Gold too. The warning NAMES them and
// appears while the draft is being edited — BEFORE Save, because there is no
// per-pair slot to fall back on and no undo afterwards. Never make it
// dismissible, never move it after the write.

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { doc, runTransaction } from 'firebase/firestore'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, AlertTriangle, ChevronsDown } from 'lucide-react'

import {
  coursePlanFacets,
  offeringFacets,
  offeringPlanEdge,
  foldOfferingPlanEdgeUpdates,
  offeringRateChoiceOf,
  offeringRateEffects,
  offeringRateLengths,
  rateHasAPriceToApplyTo,
  studioDropInOf,
  resolveUsageLimit,
  isAppointmentActivity,
  type OfferingFacets,
  plansSharingOfferingRate,
  type ActivityPlanEdge,
  type ActivityRateChoice,
  type OfferableRateEffect,
  type PlanLinkTarget,
  type SubscriptionType,
} from '@linyup/shared'
import { db } from '@/lib/firebase'
import { useBookingSettings } from '@/hooks/useBookingSettings'
import { refreshQueries } from '@/lib/queryRefresh'
import { Link } from '@/i18n/navigation'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SectionHeading } from '@/components/layout/SectionHeading'
import { Tip } from '@/components/ui/tip'
import { useSaveBarSection } from '@/components/forms/SaveBar'
import { toast } from 'sonner'

const DEFAULT_ACCENT = '#6366f1'

/** THE ONE COLUMN TEMPLATE. Every grid in this editor uses it — the heading
 *  strip and each per-length block — which is the whole reason several detached
 *  tables can sit under a single set of headings and still line up. */
const GRID_COLS = 'grid min-w-[36rem] grid-cols-[minmax(9rem,1fr)_repeat(4,5.75rem)]'

/** Effects a rate may carry, per offering — `offeringRateEffects` derives them
 *  from the sets the RESOLVER honours, so this editor can no longer offer an
 *  effect that would be ignored (it used to offer `included` on a class, where
 *  coverage is the access facet's job and the benefit is a price rule). */
type RateEffect = OfferableRateEffect

// ── ONE EXCLUSIVE CHOICE PER ROW ────────────────────────────────────────────
// What a plan does to an offering is ONE answer, so the row asks for one. It
// used to ask twice — an "access" checkbox and a "rate" checkbox, each with its
// own vocabulary — and the pair was unreadable in both directions: on an
// unlimited plan the two were genuinely exclusive (a covered member never
// reaches the drop-in price, so a rate beside it is dead), while on a class the
// rate's own "Included" effect looked like a second way to say the same thing
// and in fact did nothing at all.
//
// The choice below is the studio's question — "is this in the plan, or cheaper,
// or neither?" — and the two stored facets are an implementation detail this
// component maps to. WHICH facet stores "Included" depends on the offering: a
// class or a subscription-tier course has an access gate; an appointment or a
// purchase-tier course has none (the price is the gate) and says it with the
// `included` rate effect instead. The studio never has to know which.
type RowChoice = 'none' | RateEffect

/** The options this offering can honour, in a fixed order. */
function rowChoicesFor(t: PlanLinkTarget): RowChoice[] {
  const facets = offeringFacets(t)
  if (!facets.access && !facets.rate) return []
  const effects = facets.rate ? offeringRateEffects(t) : []
  // `included` comes from the ACCESS facet where there is one, and from the rate
  // vocabulary where there is not — either way it is offered exactly once.
  const included: RowChoice[] = facets.access ? ['included'] : []
  return ['none', ...included, ...effects.filter((e) => !(facets.access && e === 'included'))]
}

/**
 * Why a column is a DASH rather than a control.
 *
 * THE ONE CASE THERE IS: a course that is free to everyone or open to any
 * signed-in contact. There is nothing for a plan to open or discount, so all
 * four columns are dashes — and a studio meets this in the CATALOGUE, which
 * mounts the matcher beside every course rather than only the plan-bearing
 * ones.
 *
 * An unsold course is NOT this case. Its rate columns are live-but-dimmed with
 * `noPriceHint`, exactly like a class that sells no drop-in yet — the two were
 * unified on 2026-09-01, when a course gained the same gate-plus-rate pair a
 * class has always had.
 *
 * SAYING WHY IS THE WHOLE POINT. The dimmed cells have explained themselves on
 * hover since they existed; the dash explained nothing, which left the only
 * unavailable state in the grid as the only one with no reason attached.
 */
function isOpenCourse(t: PlanLinkTarget): boolean {
  return t.kind === 'course' && !coursePlanFacets(t.doc).access
}

/** Which option the stored edge currently represents. */
function choiceOf(edge: ActivityPlanEdge, rate: RateDraft, facets: OfferingFacets): RowChoice {
  if (edge.access) return 'included' // with or without an after-allowance rate
  if (!edge.rate) return 'none'
  return facets.access && rate.effect === 'included' ? 'none' : rate.effect
}

/**
 * The edge a choice writes. `keepAfterAllowance` preserves the second, optional
 * answer a LIMITED plan can give (see `AfterAllowance` below) — every other
 * choice clears it, because a rate beside "not included" or beside a discount is
 * not a state the studio asked for.
 */
function edgeForChoice(
  choice: RowChoice,
  facets: OfferingFacets,
  keepAfterAllowance: boolean
): ActivityPlanEdge {
  if (choice === 'none') return { access: false, rate: false }
  if (choice === 'included') {
    return facets.access
      ? { access: true, rate: keepAfterAllowance }
      : { access: false, rate: true }
  }
  return { access: false, rate: true }
}

/** Draft state is kept as STRINGS, so a half-typed "2" in a percent field is not
 *  read as the number 2 and saved by a stray click. */
interface RateDraft {
  effect: RateEffect
  percent: string
  amount: string
}

/** One pending change, keyed by the pair it belongs to. */
interface RowDraft {
  edge: ActivityPlanEdge
  rate: RateDraft
}

function rateDraftOf(t: PlanLinkTarget): RateDraft {
  const c = offeringRateChoiceOf(t)
  const offerable = offeringRateEffects(t)
  return {
    // A stored effect this offering cannot honour falls back to the first one it
    // can. Nothing is rewritten by reading — a row is only saved once the studio
    // touches it — so this surfaces an inert rule rather than hiding it.
    effect: offerable.includes(c.effect as RateEffect)
      ? (c.effect as RateEffect)
      : offerable[0],
    percent: c.percent != null ? String(c.percent) : '',
    amount: c.amount != null ? String(c.amount) : '',
  }
}

function toChoice(d: RateDraft): ActivityRateChoice {
  return {
    effect: d.effect,
    percent: d.percent.trim() === '' ? null : Number(d.percent),
    amount: d.amount.trim() === '' ? null : Number(d.amount),
  }
}

/** 1–99 integer, and >= 0.50 (Stripe's floor) — the same rules the standalone
 *  BenefitEditor enforces, so a rate saved here cannot be one that editor
 *  refuses. */
function rateError(d: RateDraft): 'percent' | 'amount' | null {
  if (d.effect === 'percent_off') {
    const n = Number(d.percent)
    if (!(d.percent.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 99)) return 'percent'
  }
  if (d.effect === 'fixed_price') {
    const n = Number(d.amount)
    if (!(d.amount.trim() !== '' && Number.isFinite(n) && n >= 0.5)) return 'amount'
  }
  return null
}

export type EdgeDirection = 'from-offering' | 'from-plan'

/** An activity or a course, flattened to what a row needs plus the document the
 *  writer dispatches on. Products and gift cards are absent by construction —
 *  see the note above `PlanLinkTarget` in @linyup/shared. */
export interface Offering {
  id: string
  /** Row identity, when `id` is not unique among the rows. An appointment is
   *  expanded to one offering PER SESSION LENGTH in the `from-plan` direction
   *  — same document, same id, different rule — so the length has to be part of
   *  what tells two of those rows apart. Defaults to `id`. */
  key?: string
  name: string
  /** Firestore collection the document lives in — the transaction reads it back
   *  from here before writing. */
  collection: string
  target: PlanLinkTarget
  color?: string
  /** A short word for what kind it is, shown on the row in the plan direction. */
  badge?: string
  /**
   * WRITE THROUGH A CALLABLE instead of the client transaction below.
   *
   * For a document whose collection denies client writes. A scheduled course is
   * the one today: it carries a capacity counter and a price, so
   * `firestore.rules` refuses every client write to it, and relaxing that for
   * two fields would put a second rule shape in front of a document whose whole
   * story is "everything goes through a callable".
   *
   * It receives the same EDITS this editor would have folded, and the callable
   * runs `foldOfferingPlanEdgeUpdates` server-side against a document it read
   * inside its own transaction. The fold stays shared, which is the part that
   * matters: it is what stops several plans on one document overwriting each
   * other, and a second implementation would lose that the first time it drifted.
   */
  writeEdits?: (
    edits: Parameters<typeof foldOfferingPlanEdgeUpdates>[1]
  ) => Promise<void>
}

export function ActivityPlanLinks({
  direction,
  offering,
  plan,
  offerings,
  plans,
  currency,
  canEdit,
  hostedInForm,
  onBeforeSave,
  saveBlocked,
  saveHandle,
  onDirtyChange,
}: {
  direction: EdgeDirection
  /** The fixed side when direction is 'from-offering'. */
  offering?: Offering
  /** The fixed side when direction is 'from-plan'. */
  plan?: SubscriptionType
  offerings: Offering[]
  plans: SubscriptionType[]
  currency: string
  canEdit: boolean
  /**
   * Mounted INSIDE a form that already holds unsaved input — today the activity
   * dialog. Two things change: the empty state names its destination without
   * LINKING it (a client-side push out of a half-filled dialog discards every
   * field the studio typed, which is the defect the in-place editor exists to
   * remove), and the host is told when this editor holds ticks of its own.
   */
  hostedInForm?: boolean
  /**
   * Flush host state this editor's write DEPENDS ON, before the transaction.
   *
   * The transaction re-reads each document inside itself, which is what makes
   * concurrent edits merge — and also means it sees the STORED offering, not
   * the half-edited form wrapped around it. A course page whose tier is still
   * a draft would therefore have its ticks computed against the old tier. The
   * host persists that decision here; this editor then reads it like any other
   * stored fact. Awaited, so a failure aborts the save.
   */
  onBeforeSave?: () => Promise<void>
  /** Why the host cannot accept a save right now — shown, and the button is
   *  disabled. Null/absent when it can. */
  saveBlocked?: string | null
  /**
   * Hand this editor's save to the host, and HIDE ITS OWN BUTTON.
   *
   * A pane tab with two Save buttons asks a studio which one their change
   * belongs to — a question they should never have to answer, because the two
   * write different fields of the same record and both are "save this"
   * (Franco, 2026-09-02). The host calls `run()` after its own write; `dirty`
   * lets it enable one button for either half being touched.
   */
  saveHandle?: (h: {
    run: () => Promise<void>
    dirty: boolean
    blocked: string | null
    /** Drop every unsaved tick — the host's Discard. */
    reset: () => void
  }) => void
  /** Called whenever this editor gains or loses unsaved ticks, so a host with
   *  its own Save can say that pressing it will not write them. Pass a STABLE
   *  function (a setState updater) — it is an effect dependency. */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const t = useTranslations('OfferCatalogue')
  const tb = useTranslations('Benefit')
  const tCommon = useTranslations('Common')
  const qc = useQueryClient()
  // A class following the studio's default drop-in stores no price, so both
  // "is there a price for a member rate to reduce?" and the edge writer's
  // "does this class sell at the door?" are asked with the default in hand.
  const bookingSettingsQuery = useBookingSettings()
  const studioDropIn = studioDropInOf(bookingSettingsQuery.data)
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({})
  const [saving, setSaving] = useState(false)
  const [showErrors, setShowErrors] = useState(false)

  // Rows are the OTHER side. Everything below is written against (offering,
  // plan) pairs, so the two directions differ only in which of the two each row
  // supplies.
  //
  // ── ONE TABLE PER SESSION LENGTH, on an appointment ────────────────────────
  // An appointment carries one member rule PER LENGTH, so "what does this plan
  // do about this appointment" is not one question — it is one per length, and
  // a single table answering it once could only ever write one of them. The
  // rows below are therefore (length × plan) there, and grouped under a heading
  // at render. Everything else — a class, a course — has one rule and one
  // group, which is why `group` is null rather than a special case.
  const rows = useMemo(() => {
    if (direction === 'from-offering') {
      const o = offering!
      const lengths = offeringRateLengths(o.target)
      if (!lengths.length) {
        return plans.map((p) => ({ key: p.id, plan: p, off: o, group: null as number | null }))
      }
      return lengths.flatMap((m) =>
        plans.map((p) => ({
          key: `${m}:${p.id}`,
          plan: p,
          // A TARGET PER LENGTH. Every read below (`offeringPlanEdge`,
          // `rateDraftOf`, `plansSharingOfferingRate`) dispatches on it, so
          // pointing it at the length is all it takes for the whole row to be
          // about that length.
          off: { ...o, target: { ...o.target, minutes: m } as PlanLinkTarget },
          group: m as number | null,
        }))
      )
    }
    return offerings.map((o) => ({
      key: o.key ?? o.id,
      plan: plan!,
      off: o,
      group: null as number | null,
    }))
  }, [direction, plans, offerings, offering, plan])

  /** The rows, cut into consecutive runs of one session length. A run per
   *  length on an appointment; exactly one run of `null` for everything else,
   *  which is what `grouped` tests. */
  const groups = useMemo(() => {
    const out: { key: string; minutes: number | null; rows: typeof rows }[] = []
    for (const r of rows) {
      const last = out[out.length - 1]
      if (last && last.minutes === r.group) last.rows.push(r)
      else out.push({ key: String(r.group ?? 'all'), minutes: r.group, rows: [r] })
    }
    return out
  }, [rows])
  /** Narrowed, not asserted: the grouped branch renders THESE, so a group whose
   *  length is null can never reach a caption that needs a number. */
  const lengthGroups = groups.filter(
    (g): g is { key: string; minutes: number; rows: typeof rows } => g.minutes !== null
  )
  const grouped = groups.length > 0 && lengthGroups.length === groups.length

  const draftFor = (key: string, off: Offering, planId: string): RowDraft =>
    drafts[key] ?? {
      edge: offeringPlanEdge(off.target, planId),
      rate: rateDraftOf(off.target),
    }

  const setDraft = (key: string, next: RowDraft) => setDrafts((d) => ({ ...d, [key]: next }))

  /** Set every row that can honour this choice to it, in one draft update. */
  const setColumn = (choice: RowChoice) => {
    if (!canEdit) return
    setDrafts((prev) => {
      const next = { ...prev }
      for (const r of rows) {
        if (!rowChoicesFor(r.off.target).includes(choice)) continue
        const cur =
          prev[r.key] ?? {
            edge: offeringPlanEdge(r.off.target, r.plan.id),
            rate: rateDraftOf(r.off.target),
          }
        const facets = offeringFacets(r.off.target)
        next[r.key] = {
          edge: edgeForChoice(choice, facets, false),
          rate:
            choice === 'none' || choice === 'included'
              ? cur.rate
              : { ...cur.rate, effect: choice },
        }
      }
      return next
    })
  }

  const dirty = Object.keys(drafts).length > 0
  // Reported upward rather than merely shown here: the host's Save writes the
  // SAME document this editor writes, and it writes the STORED plan list — so a
  // tick that has not been saved here is discarded by that Save.
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  // Reported upward on every change, so the host's one button tracks this
  // editor's state without owning it.
  useEffect(() => {
    saveHandle?.({
      run: save,
      dirty,
      blocked: saveBlocked ?? null,
      reset: () => {
        setDrafts({})
        setShowErrors(false)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saveBlocked, saving, JSON.stringify(drafts)])

  const errors = rows
    .map((r) => {
      const d = draftFor(r.key, r.off, r.plan.id)
      return d.edge.rate ? rateError(d.rate) : null
    })
    .filter(Boolean)

  // A STANDALONE editor (a course pane, where nothing else hosts it) saves
  // from the page's floating bar when there is one. A hosted editor hands its
  // save to the host through `saveHandle` instead, so it never registers.
  const { inSaveBar } = useSaveBarSection('plan-links', {
    dirty: !saveHandle && canEdit && dirty,
    valid: !saveBlocked,
    save: async () => {
      // Rate errors are refused by `save` itself, which then shows them on
      // their rows; the bar stays up rather than claiming a save.
      if (errors.length) {
        setShowErrors(true)
        return false
      }
      try {
        await save()
        return true
      } catch (err) {
        console.error('[offer] plan table save failed:', err)
        toast.error(tCommon('saveFailed'))
        return false
      }
    },
    reset: () => {
      setDrafts({})
      setShowErrors(false)
    },
  })

  async function save() {
    if (errors.length || saveBlocked) {
      setShowErrors(true)
      return
    }
    setSaving(true)
    try {
      // THE DEFAULT MUST BE KNOWN, not assumed absent. Still loading (or failed)
      // reads as "no studio default", and on a legacy class that sells at the
      // default door the edge writer would then store "plan required" — the
      // very write UX-103 removed. So a save waits for the settings, and a
      // failed read fails the save rather than guessing.
      const studioDropInAtSave =
        bookingSettingsQuery.data === undefined
          ? studioDropInOf((await bookingSettingsQuery.refetch({ throwOnError: true })).data)
          : studioDropIn
      // BEFORE the transaction, never inside it: this writes the host's own
      // document, and a write from within would be read back by the same
      // transaction as a conflict.
      await onBeforeSave?.()
      // One transaction over every touched document, whatever kind it is. Each
      // is re-read INSIDE the transaction and its id lists recomputed from that
      // read, so a second studio ticking a different plan on the same offering
      // merges rather than losing.
      //
      // GROUPED BY DOCUMENT, because in the `from-offering` direction every row
      // is a different PLAN on the SAME offering. Writing them one at a time
      // put several updates on one ref, each computed from the same snapshot,
      // and only the last survived — "set all" saved one row (Franco,
      // 2026-09-02). `foldOfferingPlanEdgeUpdates` applies each edit to the
      // result of the previous and yields one payload.
      const byDoc = new Map<
        string,
        { off: (typeof rows)[number]['off']; edits: Parameters<typeof foldOfferingPlanEdgeUpdates>[1] }
      >()
      for (const r of rows) {
        const d = drafts[r.key]
        if (!d) continue
        const key = `${r.off.collection}/${r.off.id}`
        const entry = byDoc.get(key) ?? { off: r.off, edits: [] }
        entry.edits.push({
          subTypeId: r.plan.id,
          next: d.edge,
          choice: d.edge.rate ? toChoice(d.rate) : undefined,
          // WHICH LENGTH this edit is about. It travels with the EDIT, not
          // with the group's target, because one fold covers every length of
          // one document; see `foldOfferingPlanEdgeUpdates`.
          minutes: r.off.target.kind === 'activity' ? r.off.target.minutes : undefined,
        })
        byDoc.set(key, entry)
      }
      const groups = [...byDoc.values()]
      // ROUTED first, and one call per document: a collection that denies
      // client writes cannot take part in the transaction below, and the
      // callable does its own read-fold-write. Awaited, so a refusal fails the
      // save rather than being swallowed behind a green transaction.
      for (const g of groups.filter((x) => x.off.writeEdits)) {
        await g.off.writeEdits!(g.edits)
      }
      const direct = groups.filter((g) => !g.off.writeEdits)
      if (direct.length) {
        await runTransaction(db, async (tx) => {
          const snaps = await Promise.all(
            direct.map((g) => tx.get(doc(db, g.off.collection, g.off.id)))
          )
          snaps.forEach((snap, i) => {
            if (!snap.exists()) return
            const g = direct[i]
            const update = foldOfferingPlanEdgeUpdates(
              { kind: g.off.target.kind, doc: snap.data(), studioDropIn: studioDropInAtSave } as PlanLinkTarget,
              g.edits
            )
            if (update) tx.update(snap.ref, update)
          })
        })
      }
      setDrafts({})
      setShowErrors(false)
      // Marked stale, not awaited — see `refreshQueries`. The third key is
      // NOT redundant: 'course' does not prefix-match 'courses', and the course
      // settings page reads that single-course query, so without it the page
      // never saw the gate this editor had just written.
      refreshQueries(qc, ['activities'], ['courses'], ['course'], ['course-blocks'])
    } finally {
      setSaving(false)
    }
  }


  /** ONE ROW OF THE MATCHER, lifted out of the map so a group can wrap a subset
   *  of them in its own block. `display: contents` keeps placing its cells into
   *  whichever grid encloses it, which is what lets several grids share one set
   *  of column headings. */
  const renderRow = ({ key, off, plan: p }: (typeof rows)[number]) => {
          const d = draftFor(key, off, p.id)
          // Which controls this offering can actually honour. An appointment has
          // no gate; a course honours one facet or the other depending on its
          // tier, and neither on a free or sign-in-only one.
          const facets = offeringFacets(off.target)
          const label = direction === 'from-offering' ? p.name : off.name
          // Everyone ELSE on this offering's ONE rate rule — named, because the
          // effect chosen here applies to them too. Read from the SAVED document
          // plus the draft, so a plan just ticked on is already counted.
          const others = plansSharingOfferingRate(off.target, p.id)
          const sharedWith = [...new Set(others)]
            .map((id) => plans.find((s) => s.id === id)?.name)
            .filter((n): n is string => !!n)
          const err = showErrors && d.edge.rate ? rateError(d.rate) : null
          const active = d.edge.access || d.edge.rate
          const choices = rowChoicesFor(off.target)
          const choice = choiceOf(d.edge, d.rate, facets)
          // THE SECOND QUESTION EXISTS ONLY WHEN IT HAS AN ANSWER. "Included,
          // and then a member rate" is meaningless on an unlimited plan — a
          // covered member never reaches the drop-in price, so the rate can
          // never apply. It becomes real the moment the plan carries a usage
          // limit ("3 a week"), because booking four sends the member to the
          // drop-in path, where the rate is what she pays. So the follow-up is
          // shown against the plan's ACTUAL limit and hidden otherwise, instead
          // of leaving a second control on screen that usually does nothing.
          const limit = resolveUsageLimit(p)
          const asksAfterAllowance = choice === 'included' && facets.access && facets.rate && !!limit
          const afterAllowance: 'full' | RateEffect = d.edge.rate ? d.rate.effect : 'full'
          // 'included' is dropped: see the panel below for why it is the one
          // answer this question cannot take.
          const afterAllowanceEffects = offeringRateEffects(off.target).filter(
            (e) => e !== 'included'
          )
          // WHAT A COLUMN MEANS IS NOT A PROPERTY OF THE ROW, so it is not
          // printed on one. It was: every ticked row carried a sentence
          // explaining its answer, and those sentences are invariant per column
          // — twelve plans meant three sentences repeated twelve times. They are
          // the column headers' tooltips now.
          //
          // What is genuinely row-specific stays here. `noPriceHint` is the
          // sharpest of it: a class's rate applies to its DROP-IN price
          // specifically, so on a members-only class that sells no drop-in there
          // is nothing for the rule to reduce and it would sit there doing
          // nothing. That fires on the exact rows where it is true, on the dot
          // it is about, rather than as prose under all of them.
          const isAppointment =
            off.target.kind === 'activity' && isAppointmentActivity(off.target.doc)
          const hasPriceToReduce = rateHasAPriceToApplyTo(
            off.target.kind === 'activity' ? { ...off.target, studioDropIn } : off.target
          )
          // Three kinds of "no price yet", and each names the control that
          // creates one — a class's drop-in, an appointment's duration price, a
          // course's sale switch. A generic sentence would leave the studio
          // hunting for which of those it meant.
          const noPriceHint =
            off.target.kind === 'course'
              ? t('noPriceCourse')
              : isAppointment
                ? t('noPriceAppointment')
                : t('noPriceDropIn')

          // The sub-row is drawn only when it has something to say, so an
          // untouched list stays exactly one line per row.
          const detail = err || (sharedWith.length > 0 && d.edge.rate)

          return (
            // NO PER-ROW BORDER. A card around every ticked row turned a list of
            // twelve plans into twelve boxes, and the noise scaled with exactly
            // the studios that need this screen most. A live row is marked by a
            // tint and its accent bar, which reads at a glance without drawing a
            // box. `display: contents` lets one logical row place its cells
            // directly into the shared grid, so the columns line up across every
            // row without a table element.
            <div key={key} className="contents">
              {/* ONE LINE, DRAWN ONCE, ACROSS THE WHOLE ROW. Each cell used to
                  carry its own `border-t`, and the row's left accent bar pushed
                  the first of them inwards — so the rule arrived in pieces with
                  a notch at the start of every line. A single spanning element
                  cannot be interrupted by what the cells beside it do. */}
              <div className="col-span-5 border-t" />
              <div
                className={`flex min-w-0 items-center gap-2 px-3 py-2 text-sm ${
                  active ? 'border-l-2 border-l-primary bg-muted/40' : 'border-l-2 border-l-transparent'
                }`}
              >
                {direction === 'from-plan' && off.color !== undefined && (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: off.color || DEFAULT_ACCENT }}
                  />
                )}
                <span className="truncate">{label}</span>
                {direction === 'from-plan' && off.badge && (
                  <Badge variant="outline" className="text-xs font-normal">
                    {off.badge}
                  </Badge>
                )}
              </div>

              {/* One cell per column, ALWAYS four, so the grid lines up across
                  rows of different kinds. A column this offering cannot honour
                  is a dash, not a disabled control: an appointment has no gate
                  (the price is the gate) and a subscription-tier course has no
                  price to discount — "not applicable here", which is a different
                  statement from "off". */}
              {(['none', 'included', 'percent_off', 'fixed_price'] as const).map((c) => {
                const offered = choices.includes(c)
                const on = offered && choice === c
                // MUTED, NOT ABSENT. A price effect with no price to reduce
                // would do nothing if chosen — a members-only class that sells
                // no drop-in has no second price, and an unpriced appointment is
                // already free. Hiding the option would leave the studio
                // wondering where it went; showing it live would let them
                // configure a rule that silently never applies. So it stays
                // visible, dimmed, and says why on hover. It is NOT disabled: a
                // studio mid-setup may well tick it before adding the price, and
                // the stored rule is correct the moment that price exists.
                const inert = offered && c !== 'none' && c !== 'included' && !hasPriceToReduce
                const naHint = !offered && isOpenCourse(off.target) ? t('naCourseOpen') : null
                return (
                  <div
                    key={c}
                    className={`flex h-full flex-col items-center justify-center gap-1 px-1 py-2 ${
                      active ? 'bg-muted/40' : ''
                    }`}
                  >
                    {!offered ? (
                      <span
                        className="text-xs text-muted-foreground/40"
                        title={naHint ?? undefined}
                      >
                        <span aria-hidden>—</span>
                        {naHint && <span className="sr-only">{naHint}</span>}
                      </span>
                    ) : (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={`${label} — ${
                          c === 'none' ? t('choiceNone') : tb(`effect_${c}` as const)
                        }`}
                        title={inert ? noPriceHint : undefined}
                        disabled={!canEdit}
                        onClick={() =>
                          setDraft(key, {
                            ...d,
                            // Switching AWAY from "Included" drops any
                            // after-allowance rate with it: that rate only ever
                            // meant "…and then this", so leaving it behind would
                            // store an answer to a question the studio just
                            // stopped asking.
                            edge: edgeForChoice(c, facets, false),
                            rate:
                              c === 'none' || c === 'included'
                                ? d.rate
                                : { ...d.rate, effect: c },
                          })
                        }
                        // Small, but unmistakable when chosen: at a glance down a
                        // column the answer has to read without comparing
                        // shades, which the ring does without the dot having to
                        // be large enough to crowd the row.
                        //
                        // SEMANTIC, NOT DECORATIVE — and a THREE-step scale,
                        // because there are three answers and not two: nothing
                        // (rose), reduced (amber), free (emerald). Amber earns
                        // its place by carrying information green would throw
                        // away: scanning a column, "included" and "20% off" are
                        // the difference between a plan that covers a class and
                        // one that merely discounts it.
                        //
                        // Muted, not an alarm palette: "not included" is an
                        // ordinary, correct answer for most pairings, not a
                        // fault to fix. And colour is never the only signal —
                        // the ring, the row tint and the sentence underneath all
                        // say the same thing, which is what keeps the table
                        // readable for anyone who cannot separate these hues.
                        className={choiceDotClass(
                          on,
                          c === 'none' ? 'none' : c === 'included' ? 'included' : 'reduced',
                          inert
                        )}
                      />
                    )}

                    {/* THE VALUE LIVES IN ITS OWN CELL, directly under the
                        answer it belongs to — read from the far side of the row
                        it belonged to nothing in particular. Keeping it inside
                        the cell (rather than in a second row of cells) is what
                        makes it impossible for the tint, the accent bar or the
                        column alignment to come apart around it. */}
                    {on && c === 'percent_off' && (
                      <span className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={1}
                          max={99}
                          value={d.rate.percent}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setDraft(key, { ...d, rate: { ...d.rate, percent: e.target.value } })
                          }
                          placeholder="0"
                          className="h-7 w-12 px-1 text-center text-xs"
                          aria-label={tb('percentLabel')}
                        />
                        <span className="text-xs text-muted-foreground">%</span>
                      </span>
                    )}
                    {on && c === 'fixed_price' && (
                      <span className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={0.5}
                          step="0.01"
                          value={d.rate.amount}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setDraft(key, { ...d, rate: { ...d.rate, amount: e.target.value } })
                          }
                          placeholder="0.00"
                          className="h-7 w-14 px-1 text-center text-xs"
                          aria-label={tb('amountLabel')}
                        />
                        <span className="text-xs text-muted-foreground">{currency}</span>
                      </span>
                    )}
                  </div>
                )
              })}

              {/* ── THE FOLLOW-UP, IN THE SAME COLUMNS ──────────────────────
                  Asked only of a LIMITED plan (see `asksAfterAllowance`): once
                  the allowance runs out, what does a member pay?

                  IT IS A GRID ROW, not a line inside the spanning detail block
                  below. It is the same question as the row above it — what this
                  plan does about this activity — asked about the classes past
                  the allowance, so its answers belong UNDER THE SAME HEADERS.
                  Free-flowing beneath them, the reader had to re-read three
                  labels that were already written across the top of the table
                  (Franco, 2026-08-31).

                  "Full price" lands in the `Not included` column, which is what
                  it means here: beyond the allowance the plan covers nothing, so
                  the member pays what anyone else would. THE `Included` COLUMN
                  IS DELIBERATELY EMPTY — "after your first 3 a week, the rest
                  are included" says the limit is not a limit, and it is the one
                  answer this question cannot take. An empty cell says that more
                  plainly than an absent option ever did.

                  History: this began as a joined button group with no way to
                  type the percent or the price it asked for — `rateError` then
                  refused the save over a blank field with no control on screen
                  that could fill it. The value inputs are the same ones the
                  cells above use, in the same cells. */}
              {asksAfterAllowance && (
                <>
                  <div
                    className={`flex min-w-0 items-center justify-end px-3 py-1.5 text-right text-xs text-muted-foreground ${
                      active ? 'border-l-2 border-l-primary bg-muted/40' : 'border-l-2 border-l-transparent'
                    }`}
                  >
                    {t('afterAllowance', { count: limit!.count, per: t(`per_${limit!.per}`) })}
                  </div>
                  {(['none', 'included', 'percent_off', 'fixed_price'] as const).map((col) => {
                    // The column this sub-row's options live under. `included`
                    // has none — see above.
                    const opt = col === 'none' ? 'full' : col
                    const offered =
                      col === 'none' ||
                      (col !== 'included' && afterAllowanceEffects.includes(col))
                    const chosen = offered && afterAllowance === opt
                    return (
                      <div
                        key={col}
                        className={`flex h-full flex-col items-center justify-center gap-1 px-1 py-1.5 ${
                          active ? 'bg-muted/40' : ''
                        }`}
                      >
                        {!offered ? (
                          <span className="text-xs text-muted-foreground/40" aria-hidden>
                            —
                          </span>
                        ) : (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={chosen}
                            disabled={!canEdit}
                            aria-label={`${t('afterAllowance', {
                              count: limit!.count,
                              per: t(`per_${limit!.per}`),
                            })} ${
                              opt === 'full'
                                ? t('afterAllowanceFull')
                                : tb(`effect_${opt}` as const)
                            }`}
                            onClick={() =>
                              setDraft(key, {
                                ...d,
                                edge: { access: true, rate: opt !== 'full' },
                                rate:
                                  opt === 'full'
                                    ? d.rate
                                    : { ...d.rate, effect: opt as RateEffect },
                              })
                            }
                            className={choiceDotClass(chosen, opt === 'full' ? 'none' : 'reduced')}
                          />
                        )}
                        {chosen && opt === 'percent_off' && (
                          <span className="flex items-center gap-1">
                            <Input
                              type="number"
                              min={1}
                              max={99}
                              value={d.rate.percent}
                              disabled={!canEdit}
                              onChange={(e) =>
                                setDraft(key, {
                                  ...d,
                                  rate: { ...d.rate, percent: e.target.value },
                                })
                              }
                              placeholder="0"
                              className="h-7 w-12 px-1 text-center text-xs"
                              aria-label={tb('percentLabel')}
                            />
                            <span className="text-xs text-muted-foreground">%</span>
                          </span>
                        )}
                        {chosen && opt === 'fixed_price' && (
                          <span className="flex items-center gap-1">
                            <Input
                              type="number"
                              min={0.5}
                              step="0.01"
                              value={d.rate.amount}
                              disabled={!canEdit}
                              onChange={(e) =>
                                setDraft(key, {
                                  ...d,
                                  rate: { ...d.rate, amount: e.target.value },
                                })
                              }
                              placeholder="0.00"
                              className="h-7 w-14 px-1 text-center text-xs"
                              aria-label={tb('amountLabel')}
                            />
                            <span className="text-xs text-muted-foreground">{currency}</span>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </>
              )}

              {/* The row's own line: what it means, and the warning that names
                  who else this rate touches. It SPANS the grid, so nothing here
                  can shift the columns. */}
              {detail && (
                <div
                  className={`col-span-5 space-y-1.5 border-l-2 px-3 pb-2 text-xs ${
                    active ? 'border-l-primary bg-muted/40' : 'border-l-transparent'
                  }`}
                >
                  {err && (
                    <p className="text-destructive">
                      {tb(err === 'percent' ? 'percentValidation' : 'amountValidation')}
                    </p>
                  )}
                  {/* THE WARNING. Before the write, naming names. */}
                  {d.edge.rate && sharedWith.length > 0 && (
                    <p className="flex items-start gap-1.5 text-amber-600">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{t('sharedRule', { names: sharedWith.join(', ') })}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
          )
  }

  /** The column strip and the set-all line, named once and rendered into
   *  whichever grid needs them — the grouped layout has ONE of these above
   *  several tables, the flat layout has it inside the only one. */
  const headerCells = (
    <>
        {/* ── THE HEADER: LABELS ONLY ─────────────────────────────────────
            It draws no bottom rule of its own: every row draws ONE continuous
            line above itself (see below), and a second line here would sit a
            hair off it.

            EACH LABEL USED TO BE THE COLUMN'S SET-ALL BUTTON. Two jobs on one
            target: a heading names a column, and a heading you can press CHANGES
            EVERY ROW — the most destructive gesture on the screen, on the one
            element a reader clicks to find out what a column means (Franco,
            2026-08-31). The set-all moved to its own line below, where it is
            visibly a control rather than a caption.

            THE LABEL NOW CARRIES THE EXPLANATION, as a tooltip. That sentence
            used to be printed UNDER EVERY TICKED ROW, and it is invariant per
            column — "Holders get it for free" says the same thing about the
            fortieth row as the first, so a list of twelve plans repeated three
            sentences twelve times. What is genuinely row-specific stayed on the
            row: the shared-rule warning, the validation error, and the
            "nothing to reduce here" hint on the dot itself. */}
        <div className="bg-muted/30 px-3 py-1.5" />
        {(['none', 'included', 'percent_off', 'fixed_price'] as const).map((c) => (
          <div
            key={c}
            title={
              c === 'none' ? t('choiceNoneDesc') : tb(`effect_${c}_desc` as const)
            }
            className="cursor-help bg-muted/30 px-1 py-1.5 text-center text-xs font-medium text-muted-foreground"
          >
            {c === 'none' ? t('choiceNone') : tb(`effect_${c}` as const)}
          </div>
        ))}

        {/* ── THE SET-ALL LINE ────────────────────────────────────────────────
            Its own row under the headers, because it is an ACTION and the row
            above it is a caption. Once the answers are columns, "everything is
            included in this plan" is a column, and setting it row by row is work
            the shape of the screen already suggests should be one click.

            It only touches rows that can HONOUR the choice — an appointment has
            no gate to include, and skipping it silently is right: the
            alternative is refusing the whole gesture over a row the studio was
            not thinking about. Like every other edit here it lands as an unsaved
            draft, so it is reviewed before it is written. */}
        {canEdit && (
          <>
            <div className="flex items-center justify-end bg-muted/10 px-3 py-1 text-xs uppercase tracking-wide text-muted-foreground/60">
              {t('setAllLabel')}
            </div>
            {(['none', 'included', 'percent_off', 'fixed_price'] as const).map((c) => {
              const choiceLabel = c === 'none' ? t('choiceNone') : tb(`effect_${c}` as const)
              return (
                <div key={c} className="flex items-center justify-center bg-muted/10 px-1 py-1">
                  <Tip label={t('setColumn', { choice: choiceLabel })}>
                    <button
                      type="button"
                      onClick={() => setColumn(c)}
                      aria-label={t('setColumn', { choice: choiceLabel })}
                      className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <ChevronsDown className="h-3.5 w-3.5" />
                    </button>
                  </Tip>
                </div>
              )
            })}
          </>
        )}
    </>
  )

  // ── empty states ──
  // Both name a destination AND link it (UX-99): the mirror-image empty states
  // these replace each named one and went nowhere.
  if (direction === 'from-offering' && plans.length === 0) {
    return hostedInForm ? (
      <p className="text-xs text-muted-foreground">{t('noPlans')}</p>
    ) : (
      <EmptyLink text={t('noPlans')} action={t('noPlansAction')} href={'/offer/plans' as Route} />
    )
  }
  if (direction === 'from-plan' && offerings.length === 0) {
    return hostedInForm ? (
      <p className="text-xs text-muted-foreground">{t('noActivities')}</p>
    ) : (
      <EmptyLink
        text={t('noActivities')}
        action={t('noActivitiesAction')}
        href={'/offer/activities' as Route}
      />
    )
  }

  return (
    <div className="space-y-3">
      {/* FROM A CLASS it is one more setting on the tab, so it is set like one
          (label + hint, the SettingRow type) rather than as a section heading
          that out-shouts the rows around it (Franco, 2026-09-19). From a plan
          it still heads that pane's own section. */}
      {direction === 'from-offering' ? (
        <div>
          <p className="text-sm font-medium">{t('plansHeading')}</p>
          <p className="text-xs text-muted-foreground">
            {rows.some((r) => r.group !== null) ? t('durationRulesHint') : t('plansHint')}
          </p>
        </div>
      ) : (
      <SectionHeading
        level="sub"
        title={t('includesHeading')}
        description={
          // SAID ONCE, ABOVE THE TABLES, rather than repeated on each heading
          // band: a studio meeting three copies of the same plan list needs to
          // know WHY before it reads the first one, and the reason is the same
          // for every group.
          rows.some((r) => r.group !== null) ? t('durationRulesHint') : t('includesHint')
        }
      />
      )}

      {/* UX-109 (interim) — the ONLY explanation of what a column means used to
          be the `title` on its header cell, which a mouse can find and a touch
          screen (or a keyboard user tabbing past it) never will. A one-line,
          always-visible legend says the same four sentences the tooltips
          already carry — never a second copy of them — and wraps rather than
          scrolling, so it reads at 375px same as everywhere else on this page.
          The real fix (a stacked card-per-row layout below `sm`) is a separate,
          larger pass; this is the shipped-here half. Shown only once there is a
          table under it, and only on narrow screens: where a pointer can hover
          the header, four always-on sentences are clutter the tooltips already
          cover. */}
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground sm:hidden">
          {(['none', 'included', 'percent_off', 'fixed_price'] as const).map((c) => (
            <span key={c} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={choiceDotClass(true, c === 'none' ? 'none' : c === 'included' ? 'included' : 'reduced')}
              />
              <span>
                <span className="font-medium text-foreground">
                  {c === 'none' ? t('choiceNone') : tb(`effect_${c}` as const)}
                </span>{' '}
                — {c === 'none' ? t('choiceNoneDesc') : tb(`effect_${c}_desc` as const)}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* ── A TABLE, BECAUSE IT IS ALWAYS THE SAME QUESTION ────────────────
          Every row asks one question with the same four answers, so the
          answers are named ONCE, at the top, and each row is a line of radio
          cells under them. Repeating four labels on every row was most of the
          noise on this screen, and it hid the thing a studio actually wants to
          see: the COLUMN — "what is included in everything" read down the page
          rather than word by word across it.

          Wide content scrolls in its own container (never the page): a phone
          cannot fit a name plus four columns, and the name column stays put
          while the answers scroll so a row is never anonymous. */}
      {/* ── SEPARATE TABLES, ONE SET OF HEADINGS ────────────────────────
          On an appointment the rows are grouped by session length, and a
          heading BAND inside a single table did not read as a divider: it was
          one more full-width tinted strip among rows whose own live tint is
          almost the same value, so it looked like a row and the sections were
          invisible (Franco, staging, 2026-09-03).

          So the groups are actually detached — each length is its own bordered
          block, with a caption, separated by real gaps. The column headings
          stay above all of them because the question and its four answers are
          the same for every length; repeating the strip per block would be four
          identical captions arguing they were different.

          THE COLUMNS STILL LINE UP because every block uses the SAME grid
          template and the same `min-w`, inside one scroll container. The
          heading strip carries a TRANSPARENT border so it is inset by exactly
          the pixel the bordered blocks below it are — without it the headings
          sit one pixel left of the answers they name, which is visible. */}
      {grouped ? (
        <div className="overflow-x-auto">
          <div
            className={`${GRID_COLS} rounded-md border border-transparent bg-muted/30`}
          >
            {headerCells}
          </div>
          {lengthGroups.map((g) => (
            <div key={g.key} className="mt-2.5 overflow-hidden rounded-md border">
              <div className="min-w-[36rem] border-b bg-muted px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/80">
                {t('lengthGroup', { minutes: g.minutes })}
              </div>
              <div className={GRID_COLS}>{g.rows.map(renderRow)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          {/* `items-stretch` (the default) is load-bearing: a cell grows to the
              row's height, so the one column holding an input keeps the others
              filled beside it rather than leaving gaps in the tint. */}
          <div className={GRID_COLS}>
            {headerCells}
            {rows.map(renderRow)}
          </div>
        </div>
      )}

      {canEdit && !saveHandle && inSaveBar && saveBlocked && (
        <p className="border-t pt-3 text-right text-xs text-destructive">{saveBlocked}</p>
      )}
      {canEdit && !saveHandle && !inSaveBar && (
        <div className="flex items-center justify-end gap-3 border-t pt-3">
          {saveBlocked ? (
            <span className="text-xs text-destructive">{saveBlocked}</span>
          ) : (
            dirty && <span className="text-xs text-muted-foreground">{t('unsaved')}</span>
          )}
          <Button size="sm" disabled={!dirty || saving || !!saveBlocked} onClick={() => void save()}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * THE ANSWER DOT — one control for every "what does this plan do here?" answer
 * on this screen, in the grid cells and in the after-allowance follow-up alike.
 *
 * Extracted when the follow-up stopped being a joined button group (2026-08-31):
 * two controls for one decision, drawn two ways, is how a reader learns that
 * they are different decisions.
 *
 * SEMANTIC, NOT DECORATIVE — and a THREE-step scale, because there are three
 * answers and not two: nothing (rose), reduced (amber), free (emerald). Amber
 * earns its place by carrying information green would throw away: scanning a
 * column, "included" and "20% off" are the difference between a plan that covers
 * a class and one that merely discounts it.
 *
 * Muted, not an alarm palette: "not included" is an ordinary, correct answer for
 * most pairings, not a fault to fix. And colour is never the only signal — the
 * ring, the row tint and the sentence underneath all say the same thing, which
 * is what keeps this readable for anyone who cannot separate these hues.
 *
 * `inert` dims an option that would do nothing if chosen (a price effect with no
 * price to reduce). It is NOT disabled: a studio mid-setup may well tick it
 * before adding the price, and the stored rule is correct the moment that price
 * exists.
 */
function choiceDotClass(
  on: boolean,
  tone: 'none' | 'included' | 'reduced',
  inert = false
): string {
  return [
    'h-3.5 w-3.5 rounded-full border transition-colors disabled:opacity-50',
    inert ? 'opacity-40' : '',
    on
      ? tone === 'none'
        ? 'border-rose-500 bg-rose-500 ring-2 ring-rose-500/25'
        : tone === 'included'
          ? 'border-emerald-500 bg-emerald-500 ring-2 ring-emerald-500/25'
          : 'border-amber-500 bg-amber-500 ring-2 ring-amber-500/25'
      : 'border-muted-foreground/40 hover:border-foreground/70',
  ]
    .filter(Boolean)
    .join(' ')
}

function EmptyLink({ text, action, href }: { text: string; action: string; href: Route }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{text}</p>
      <Link href={href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        <Plus className="h-3.5 w-3.5" />
        {action}
      </Link>
    </div>
  )
}
