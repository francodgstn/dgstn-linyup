// ─── The offering setup wizard's answer ──────────────────────────────────────
//
// What the in-app wizard sends once a studio has answered its questions (the
// help centre's walkthrough, apps/help/src/data/offeringWalkthrough.ts, asked
// in the app and turned into records). `applyOfferingSetup` re-parses it here
// and writes it through the SAME document builders the AI draft uses
// (functions/src/offer/offeringWriter.ts), so a class made either way is one
// shape (Franco, 2026-09-26: one writer, two inputs).
//
// HOW IT DIFFERS FROM `OfferingDraft`, on purpose:
//
//   IT MAY NAME EXISTING RECORDS, for links only. A new class may join plans
//   the studio already has, and a new plan may include classes it already
//   has; "included in my membership" is the commonest answer there is. The
//   server checks every id against the caller's own team, and the ONE change
//   it makes to an existing record is adding that link, through the plan-link
//   writer. The AI draft stays id-free: a model's output must not be able to
//   address anything, a studio's own clicks may.
//
//   IT CARRIES THE ANSWERS THE DRAFT CANNOT: the sign-up wall, how the drop-in
//   is priced, a trial, a member rate, a plan's billing, intro price, limit and
//   whether it is public.
//
//   APPOINTMENTS AND COURSES ride the same parse. An appointment's member rule
//   is per LENGTH (`resolveDurationBenefit`), so the wizard's one answer is
//   written onto each length it means something for; a course is created by
//   the course creator itself (courseBlocks/index.ts), with the links the
//   studio picked applied before it is first written.
//
//   ONE THING PER RUN. The walkthrough sets up one offering at a time ("walk
//   through again for the next thing"), and so does this.

import type { UsageLimitPeriod } from './contact'
import type { DropInMode } from './activity'
import { MAX_COURSE_MEETINGS } from './courseBlock'

export const OFFERING_SETUP_LIMITS = {
  nameChars: 80,
  descriptionChars: 600,
  /** Existing records one setup may link to. */
  links: 50,
  credits: 1000,
  validMonths: 60,
  introPeriods: 24,
  limitCount: 1000,
  /** An appointment's lengths ("30, 45, 60 and 90 minutes"). */
  lengths: 8,
  lengthMinutes: 12 * 60,
  places: 1000,
  closeDaysBefore: 365,
  skipDates: 60,
} as const

/** How a class answers the drop-in question (`DropInMode`), with its price
 *  only where it has one of its own. */
export type SetupDropIn =
  | { mode: Exclude<DropInMode, 'custom'> }
  | { mode: 'custom'; priceAmount: number }

/** "Members pay less": a member rate on the drop-in price for these plans. */
export interface SetupMemberRate {
  planIds: string[]
  effect: 'percent_off' | 'fixed_price'
  /** percent_off: 1 to 99. */
  percent?: number
  /** fixed_price: the member price, major units. */
  amount?: number
}

export interface SetupClass {
  name: string
  description?: string
  /** "Only people who have signed up with me". */
  signupRequired: boolean
  /** EXISTING plans that include it: their holders book it free. */
  includedPlanIds: string[]
  dropIn: SetupDropIn
  /** Only meaningful beside a drop-in price; dropped otherwise. */
  memberRate?: SetupMemberRate
  /** Present = a trial for newcomers. No price = the trial is free. */
  trial?: { priceAmount?: number }
}

export type SetupPlanKind = 'membership' | 'pack' | 'complimentary' | 'partner'

export interface SetupPlan {
  name: string
  description?: string
  kind: SetupPlanKind
  /** membership: at least one of the two. */
  monthlyAmount?: number
  annualAmount?: number
  /** membership: "two classes a week". */
  limit?: { count: number; per: UsageLimitPeriod }
  /** membership: a lower price for the first periods of the first recurring
   *  price (monthly when there is one). */
  intro?: { amount: number; periods: number }
  /** pack: the price, how many classes, and how long they stay valid. */
  packAmount?: number
  credits?: number
  validMonths?: number
  /** partner: what the partner app pays the studio per visit. */
  payoutPerVisit?: number
  /** Shown on the public pricing page and in the shop. */
  public: boolean
  /** EXISTING classes it includes ("Can book"). */
  includedActivityIds: string[]
}

/** How one appointment length is sold (`resolveDurationSale`'s three answers):
 *  a price, free, or only through a plan that includes it. */
export type SetupLengthSale = 'priced' | 'free' | 'plan_only'

export interface SetupLength {
  minutes: number
  sale: SetupLengthSale
  /** priced: what one booking of this length costs. */
  priceAmount?: number
  /** A fixed member price for THIS length. Asked per length on purpose: one
   *  member price for thirty minutes and for ninety cannot be right for both,
   *  which is why the rule is per length at all (`ActivityDurationBenefit`). */
  memberAmount?: number
}

/** "Do members get a better deal?" on an appointment: one answer for the
 *  plans, written as each length's rule. A fixed price carries its amount on
 *  each length (`SetupLength.memberAmount`). */
export interface SetupMemberDeal {
  planIds: string[]
  effect: 'included' | 'percent_off' | 'fixed_price'
  /** percent_off: 1 to 99. */
  percent?: number
}

export interface SetupAppointment {
  name: string
  description?: string
  lengths: SetupLength[]
  /** Required when any length is `plan_only`, and then it must INCLUDE: a
   *  percentage off a price that does not exist opens nothing
   *  (`benefitOpensDoorAt`). */
  memberDeal?: SetupMemberDeal
}

/** When a course runs, as the wizard asks it. Instants are the studio's own
 *  wall clock read in the browser, the same spelling `CourseBlockDialog` uses,
 *  and the weekday is sent rather than re-derived so the server never has to
 *  guess which timezone "Wednesday" was meant in. */
export type SetupCourseSchedule =
  | {
      kind: 'weekly'
      /** The first lesson's start. */
      startMs: number
      minutes: number
      /** 0 (Sunday) to 6. */
      weekday: number
      /** The end of the last lesson's day. */
      endMs: number
      /** A moment on each day with no lesson. */
      skipMs: number[]
    }
  | { kind: 'dates'; meetings: { startMs: number; minutes: number }[] }

export interface SetupCourse {
  name: string
  description?: string
  schedule: SetupCourseSchedule
  /** Absent = no limit. */
  places?: number
  /** For the whole course. Absent = free, and a free course links to no plan:
   *  there is nothing to include or discount (`courseBlockPlanFacets`). */
  priceAmount?: number
  /** EXISTING plans whose holders get it free. */
  includedPlanIds: string[]
  /** EXISTING plans whose holders pay less. */
  memberRate?: SetupMemberRate
  signupRequired: boolean
  /** Absent = bookings stay open until it starts. */
  closeDaysBefore?: number
}

export type OfferingSetup =
  | { kind: 'class'; class: SetupClass }
  | { kind: 'plan'; plan: SetupPlan }
  | { kind: 'appointment'; appointment: SetupAppointment }
  | { kind: 'course'; course: SetupCourse }

// ─── validation ──────────────────────────────────────────────────────────────

export interface SetupProblem {
  path: string
  code: 'missing' | 'type' | 'too_long' | 'bad_enum' | 'bad_number' | 'bad_id' | 'too_many'
}

const DROP_IN_MODES: DropInMode[] = ['off', 'studio', 'custom']
const PLAN_KINDS: SetupPlanKind[] = ['membership', 'pack', 'complimentary', 'partner']
const LIMIT_PERIODS: UsageLimitPeriod[] = ['day', 'week', 'month']
const LENGTH_SALES: SetupLengthSale[] = ['priced', 'free', 'plan_only']
const DEAL_EFFECTS: SetupMemberDeal['effect'][] = ['included', 'percent_off', 'fixed_price']
/** A Firestore auto-id or any id the app writes: no slashes, nothing exotic. */
const ID = /^[A-Za-z0-9_-]{1,64}$/

/** A price a studio could charge: finite, not negative, not absurd. */
function money(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000
}
/** A price somebody PAYS: at least Stripe's 0.50 floor. */
function chargeable(v: unknown): v is number {
  return money(v) && v >= 0.5
}
function wholeIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}
/** An instant a browser could have produced: after 2000, before 2200. */
function instant(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 946_684_800_000 && v < 7_258_118_400_000
}
function text(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
}

/**
 * Parse what the wizard sent into a setup, or say why not. DROPS RATHER THAN
 * TRUSTS, like `parseOfferingDraft`: every field is read by name and a NEW
 * object returned, so nothing the client adds survives into the writer.
 * A setup with any problem is refused whole: the studio is looking at the
 * form that produced it and can fix it, unlike a model's draft.
 */
export function parseOfferingSetup(input: unknown): {
  setup: OfferingSetup | null
  problems: SetupProblem[]
} {
  const problems: SetupProblem[] = []
  const bad = (path: string, code: SetupProblem['code']) => void problems.push({ path, code })
  const ids = (v: unknown, path: string): string[] => {
    if (v === undefined) return []
    if (!Array.isArray(v)) return bad(path, 'type'), []
    if (v.length > OFFERING_SETUP_LIMITS.links) bad(path, 'too_many')
    const out = [...new Set(v.slice(0, OFFERING_SETUP_LIMITS.links))]
    if (out.some((id) => typeof id !== 'string' || !ID.test(id))) return bad(path, 'bad_id'), []
    return out as string[]
  }
  const name = (v: unknown, path: string): string | null => {
    if (!text(v, OFFERING_SETUP_LIMITS.nameChars)) return bad(path, 'missing'), null
    return (v as string).trim()
  }
  const description = (v: unknown, path: string): string | undefined => {
    if (v === undefined || v === '') return undefined
    if (!text(v, OFFERING_SETUP_LIMITS.descriptionChars)) return bad(path, 'too_long'), undefined
    return (v as string).trim()
  }

  /** "Members pay less", read the same way wherever it is asked. */
  const memberRate = (v: unknown, path: string): SetupMemberRate | undefined => {
    if (v === undefined || v === null) return undefined
    const r = v as Record<string, unknown>
    const planIds = ids(r.planIds, `${path}.planIds`)
    let out: SetupMemberRate | undefined
    if (r.effect === 'percent_off') {
      if (wholeIn(r.percent, 1, 99)) out = { planIds, effect: 'percent_off', percent: r.percent }
      else bad(`${path}.percent`, 'bad_number')
    } else if (r.effect === 'fixed_price') {
      if (chargeable(r.amount)) out = { planIds, effect: 'fixed_price', amount: r.amount }
      else bad(`${path}.amount`, 'bad_number')
    } else bad(`${path}.effect`, 'bad_enum')
    if (out && planIds.length === 0) {
      bad(`${path}.planIds`, 'missing')
      return undefined
    }
    return out
  }

  if (!input || typeof input !== 'object') return { setup: null, problems: [{ path: '', code: 'type' }] }
  const root = input as Record<string, unknown>

  if (root.kind === 'class') {
    const c = (root.class ?? {}) as Record<string, unknown>
    const n = name(c.name, 'class.name')
    const d = (c.dropIn ?? {}) as Record<string, unknown>
    let dropIn: SetupDropIn | null = null
    if (!DROP_IN_MODES.includes(d.mode as DropInMode)) bad('class.dropIn.mode', 'bad_enum')
    else if (d.mode === 'custom') {
      if (chargeable(d.priceAmount)) dropIn = { mode: 'custom', priceAmount: d.priceAmount }
      else bad('class.dropIn.priceAmount', 'bad_number')
    } else dropIn = { mode: d.mode as Exclude<DropInMode, 'custom'> }

    const out: Partial<SetupClass> = {
      name: n ?? '',
      signupRequired: c.signupRequired === true,
      includedPlanIds: ids(c.includedPlanIds, 'class.includedPlanIds'),
    }
    const desc = description(c.description, 'class.description')
    if (desc) out.description = desc
    if (dropIn) out.dropIn = dropIn

    const rate = memberRate(c.memberRate, 'class.memberRate')
    if (rate) out.memberRate = rate
    if (c.trial !== undefined && c.trial !== null) {
      const tr = c.trial as Record<string, unknown>
      if (tr.priceAmount === undefined || tr.priceAmount === null) out.trial = {}
      else if (chargeable(tr.priceAmount)) out.trial = { priceAmount: tr.priceAmount }
      else bad('class.trial.priceAmount', 'bad_number')
    }
    return problems.length ? { setup: null, problems } : { setup: { kind: 'class', class: out as SetupClass }, problems }
  }

  if (root.kind === 'plan') {
    const p = (root.plan ?? {}) as Record<string, unknown>
    const n = name(p.name, 'plan.name')
    const kind = p.kind as SetupPlanKind
    if (!PLAN_KINDS.includes(kind)) bad('plan.kind', 'bad_enum')
    const out: Partial<SetupPlan> = {
      name: n ?? '',
      kind,
      public: p.public === true,
      includedActivityIds: ids(p.includedActivityIds, 'plan.includedActivityIds'),
    }
    const desc = description(p.description, 'plan.description')
    if (desc) out.description = desc

    if (kind === 'membership') {
      if (p.monthlyAmount !== undefined) {
        if (money(p.monthlyAmount)) out.monthlyAmount = p.monthlyAmount
        else bad('plan.monthlyAmount', 'bad_number')
      }
      if (p.annualAmount !== undefined) {
        if (money(p.annualAmount)) out.annualAmount = p.annualAmount
        else bad('plan.annualAmount', 'bad_number')
      }
      if (out.monthlyAmount === undefined && out.annualAmount === undefined) bad('plan.monthlyAmount', 'missing')
      if (p.limit !== undefined && p.limit !== null) {
        const l = p.limit as Record<string, unknown>
        if (wholeIn(l.count, 1, OFFERING_SETUP_LIMITS.limitCount) && LIMIT_PERIODS.includes(l.per as UsageLimitPeriod)) {
          out.limit = { count: l.count, per: l.per as UsageLimitPeriod }
        } else bad('plan.limit', 'bad_number')
      }
      if (p.intro !== undefined && p.intro !== null) {
        const i = p.intro as Record<string, unknown>
        if (money(i.amount) && wholeIn(i.periods, 1, OFFERING_SETUP_LIMITS.introPeriods)) {
          out.intro = { amount: i.amount, periods: i.periods }
        } else bad('plan.intro', 'bad_number')
      }
    } else if (kind === 'pack') {
      if (money(p.packAmount)) out.packAmount = p.packAmount
      else bad('plan.packAmount', 'bad_number')
      if (wholeIn(p.credits, 1, OFFERING_SETUP_LIMITS.credits)) out.credits = p.credits
      else bad('plan.credits', 'bad_number')
      if (p.validMonths !== undefined && p.validMonths !== null) {
        if (wholeIn(p.validMonths, 1, OFFERING_SETUP_LIMITS.validMonths)) out.validMonths = p.validMonths
        else bad('plan.validMonths', 'bad_number')
      }
    } else if (kind === 'partner') {
      if (p.payoutPerVisit !== undefined && p.payoutPerVisit !== null) {
        if (money(p.payoutPerVisit)) out.payoutPerVisit = p.payoutPerVisit
        else bad('plan.payoutPerVisit', 'bad_number')
      }
    }
    return problems.length ? { setup: null, problems } : { setup: { kind: 'plan', plan: out as SetupPlan }, problems }
  }

  if (root.kind === 'appointment') {
    const a = (root.appointment ?? {}) as Record<string, unknown>
    const out: Partial<SetupAppointment> = { name: name(a.name, 'appointment.name') ?? '' }
    const desc = description(a.description, 'appointment.description')
    if (desc) out.description = desc

    const rawLengths: unknown[] = Array.isArray(a.lengths) ? a.lengths : []
    if (rawLengths.length === 0) bad('appointment.lengths', 'missing')
    if (rawLengths.length > OFFERING_SETUP_LIMITS.lengths) bad('appointment.lengths', 'too_many')
    const lengths: SetupLength[] = []
    const seen = new Set<number>()
    rawLengths.slice(0, OFFERING_SETUP_LIMITS.lengths).forEach((raw, i) => {
      const l = (raw ?? {}) as Record<string, unknown>
      const path = `appointment.lengths.${i}`
      if (!wholeIn(l.minutes, 5, OFFERING_SETUP_LIMITS.lengthMinutes) || seen.has(l.minutes)) {
        return bad(`${path}.minutes`, 'bad_number')
      }
      seen.add(l.minutes)
      if (!LENGTH_SALES.includes(l.sale as SetupLengthSale)) return bad(`${path}.sale`, 'bad_enum')
      const length: SetupLength = { minutes: l.minutes, sale: l.sale as SetupLengthSale }
      if (length.sale === 'priced') {
        if (chargeable(l.priceAmount)) length.priceAmount = l.priceAmount
        else bad(`${path}.priceAmount`, 'bad_number')
      }
      if (l.memberAmount !== undefined && l.memberAmount !== null) {
        if (chargeable(l.memberAmount)) length.memberAmount = l.memberAmount
        else bad(`${path}.memberAmount`, 'bad_number')
      }
      lengths.push(length)
    })
    out.lengths = lengths

    if (a.memberDeal !== undefined && a.memberDeal !== null) {
      const m = a.memberDeal as Record<string, unknown>
      const planIds = ids(m.planIds, 'appointment.memberDeal.planIds')
      const effect = m.effect as SetupMemberDeal['effect']
      if (!DEAL_EFFECTS.includes(effect)) bad('appointment.memberDeal.effect', 'bad_enum')
      else if (planIds.length === 0) bad('appointment.memberDeal.planIds', 'missing')
      else if (effect === 'percent_off') {
        if (wholeIn(m.percent, 1, 99)) out.memberDeal = { planIds, effect, percent: m.percent }
        else bad('appointment.memberDeal.percent', 'bad_number')
      } else out.memberDeal = { planIds, effect }
    }
    // A plan-only length is opened by an INCLUDED rule and by nothing else.
    if (lengths.some((l) => l.sale === 'plan_only') && out.memberDeal?.effect !== 'included') {
      bad('appointment.memberDeal', 'missing')
    }
    // A fixed member price is a price per length, so every priced length needs one.
    if (out.memberDeal?.effect === 'fixed_price') {
      lengths.forEach((l, i) => {
        if (l.sale === 'priced' && l.memberAmount === undefined) bad(`appointment.lengths.${i}.memberAmount`, 'missing')
      })
    }
    return problems.length
      ? { setup: null, problems }
      : { setup: { kind: 'appointment', appointment: out as SetupAppointment }, problems }
  }

  if (root.kind === 'course') {
    const c = (root.course ?? {}) as Record<string, unknown>
    const out: Partial<SetupCourse> = {
      name: name(c.name, 'course.name') ?? '',
      signupRequired: c.signupRequired === true,
      includedPlanIds: ids(c.includedPlanIds, 'course.includedPlanIds'),
    }
    const desc = description(c.description, 'course.description')
    if (desc) out.description = desc

    const sc = (c.schedule ?? {}) as Record<string, unknown>
    if (sc.kind === 'weekly') {
      const skip: unknown[] = Array.isArray(sc.skipMs) ? sc.skipMs : []
      if (skip.length > OFFERING_SETUP_LIMITS.skipDates || skip.some((ms) => !instant(ms))) {
        bad('course.schedule.skipMs', 'bad_number')
      }
      if (
        instant(sc.startMs) &&
        instant(sc.endMs) &&
        sc.endMs > sc.startMs &&
        wholeIn(sc.minutes, 5, OFFERING_SETUP_LIMITS.lengthMinutes) &&
        wholeIn(sc.weekday, 0, 6)
      ) {
        out.schedule = {
          kind: 'weekly',
          startMs: sc.startMs,
          minutes: sc.minutes,
          weekday: sc.weekday,
          endMs: sc.endMs,
          skipMs: skip.filter(instant).slice(0, OFFERING_SETUP_LIMITS.skipDates),
        }
      } else bad('course.schedule', 'bad_number')
    } else if (sc.kind === 'dates') {
      const meetings: unknown[] = Array.isArray(sc.meetings) ? sc.meetings : []
      const clean = meetings
        .map((m) => (m ?? {}) as Record<string, unknown>)
        .filter((m) => instant(m.startMs) && wholeIn(m.minutes, 5, OFFERING_SETUP_LIMITS.lengthMinutes))
        .map((m) => ({ startMs: m.startMs as number, minutes: m.minutes as number }))
      if (clean.length === 0 || clean.length !== meetings.length) bad('course.schedule.meetings', 'bad_number')
      else if (clean.length > MAX_COURSE_MEETINGS) bad('course.schedule.meetings', 'too_many')
      else out.schedule = { kind: 'dates', meetings: clean }
    } else bad('course.schedule.kind', 'bad_enum')

    if (c.places !== undefined && c.places !== null) {
      if (wholeIn(c.places, 1, OFFERING_SETUP_LIMITS.places)) out.places = c.places
      else bad('course.places', 'bad_number')
    }
    if (c.priceAmount !== undefined && c.priceAmount !== null) {
      if (chargeable(c.priceAmount)) out.priceAmount = c.priceAmount
      else bad('course.priceAmount', 'bad_number')
    }
    const rate = memberRate(c.memberRate, 'course.memberRate')
    if (rate) out.memberRate = rate
    // A free course is open to everybody: a plan has nothing to include or
    // discount, so a link there is a mistake to refuse, not to drop silently.
    if (out.priceAmount === undefined && (out.includedPlanIds?.length || out.memberRate)) {
      bad('course.priceAmount', 'missing')
    }
    if (c.closeDaysBefore !== undefined && c.closeDaysBefore !== null) {
      if (wholeIn(c.closeDaysBefore, 0, OFFERING_SETUP_LIMITS.closeDaysBefore)) out.closeDaysBefore = c.closeDaysBefore
      else bad('course.closeDaysBefore', 'bad_number')
    }
    return problems.length
      ? { setup: null, problems }
      : { setup: { kind: 'course', course: out as SetupCourse }, problems }
  }

  return { setup: null, problems: [{ path: 'kind', code: 'bad_enum' }] }
}
