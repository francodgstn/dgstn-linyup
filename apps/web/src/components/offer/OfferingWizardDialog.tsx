'use client'

/**
 * SET UP WITH A GUIDE: the help center's offering walkthrough, asked in the app
 * and turned into records.
 *
 * The walkthrough (apps/help/src/data/offeringWalkthrough.ts) asks a studio
 * owner what they want to sell, in their words, and answers with instructions.
 * This asks the same questions, collects the values that matter under the
 * answer that needs them, shows what it will create, and creates it through
 * `applyOfferingSetup` (one writer shared with the AI draft; decisions in the
 * courses plan file, section 8, Franco 2026-09-26).
 *
 * ONE THING PER RUN, like the walkthrough. Classes, appointments, courses and
 * plans are created here; an online course, a product or an event points at
 * its own page, as the walkthrough does.
 *
 * WHAT IT LEAVES TO THE FULL FORMS: the rarer settings. An appointment picks
 * its lengths from the usual presets and has no party pricing or multi-date
 * bookings here; a course has no class, place, coach or program yet. Each is
 * one tap away in the pane the new record opens in.
 *
 * THE PATH IS DERIVED, NEVER STORED: `nextStep` reads the answers every time,
 * so going back and changing one re-routes what follows instead of replaying a
 * stale path. Back walks the steps actually visited.
 *
 * Every string is a literal key: the i18n check verifies literal keys and only
 * counts computed ones.
 */

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import type { Route } from 'next'
import { Check, Wand2, X } from 'lucide-react'
import {
  studioDropInOf,
  type Activity,
  type BookingSettings,
  type OfferingSetup,
  type SetupCourseSchedule,
  type SetupLength,
  type SubscriptionType,
  type UsageLimitPeriod,
} from '@linyup/shared'
import { Link } from '@/i18n/navigation'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { formatCurrency } from '@/lib/format'
import { callFunction } from '@/lib/callFunction'
import { APPOINTMENT_DURATION_PRESETS, parsePriceInput } from '@/components/activities/AppointmentDurationsEditor'
import { formatDuration } from '@/components/sessions/SessionFormDialog'

type Kind = 'class' | 'appointment' | 'course' | 'plan' | 'online' | 'product' | 'event'
type Step =
  | 'what'
  | 'handoff'
  | 'class-name'
  | 'class-who'
  | 'class-pay'
  | 'class-rate'
  | 'class-newcomers'
  | 'appt-name'
  | 'appt-price'
  | 'appt-lengths'
  | 'appt-members'
  | 'course-name'
  | 'course-when'
  | 'course-places'
  | 'course-price'
  | 'course-members'
  | 'course-who'
  | 'course-close'
  | 'plan-kind'
  | 'plan-details'
  | 'plan-limit'
  | 'plan-intro'
  | 'plan-includes'
  | 'plan-sell'
  | 'review'
  | 'done'

type Pay = 'included' | 'per_class' | 'both' | 'free'
type PlanKind = 'membership' | 'pack' | 'complimentary' | 'partner'
type ApptPrice = 'priced' | 'some_free' | 'free' | 'plan_only'
type Created = { kind: 'class' | 'plan' | 'appointment' | 'course'; id: string }

/** One appointment length, as the wizard holds it. */
interface LengthRow {
  minutes: number
  /** Only read when some lengths are free and some are not. */
  free: boolean
  price: string
  /** A fixed member price for this length. */
  memberPrice: string
}

/** One hand-entered course lesson. */
interface DayRow {
  /** `YYYY-MM-DD`, local. */
  date: string
  /** `HH:MM`, local. */
  time: string
  minutes: string
}

interface Answers {
  kind: Kind | null
  name: string
  description: string
  // class (and a course's "who")
  signupRequired: boolean | null
  pay: Pay | null
  includedPlanIds: string[]
  dropInMode: 'studio' | 'custom'
  dropInPrice: string
  rate: 'yes' | 'no' | null
  ratePlanIds: string[]
  rateEffect: 'percent_off' | 'fixed_price'
  rateValue: string
  trial: 'free' | 'priced' | 'no' | null
  trialPrice: string
  // appointment
  apptPrice: ApptPrice | null
  lengths: LengthRow[]
  apptDeal: 'included' | 'less' | 'no' | null
  dealPlanIds: string[]
  dealEffect: 'percent_off' | 'fixed_price'
  dealPercent: string
  // course
  courseMode: 'weekly' | 'dates' | null
  startDate: string
  startTime: string
  courseMinutes: string
  endDate: string
  skipDates: string[]
  skipDraft: string
  days: DayRow[]
  placesLimited: 'yes' | 'no' | null
  places: string
  coursePrice: 'priced' | 'free' | null
  coursePriceAmount: string
  courseMembers: 'included' | 'cheaper' | 'no' | null
  close: 'days' | 'open' | null
  closeDays: string
  // plan
  planKind: PlanKind | null
  monthly: string
  annual: string
  packPrice: string
  credits: string
  validMonths: string
  payout: string
  limit: 'unlimited' | 'limited' | null
  limitCount: string
  limitPer: UsageLimitPeriod
  intro: 'yes' | 'no' | null
  introAmount: string
  introPeriods: string
  includedActivityIds: string[]
  sell: 'online' | 'assign' | null
}

const emptyDay = (): DayRow => ({ date: '', time: '10:00', minutes: '60' })

const EMPTY: Answers = {
  kind: null,
  name: '',
  description: '',
  signupRequired: null,
  pay: null,
  includedPlanIds: [],
  dropInMode: 'studio',
  dropInPrice: '',
  rate: null,
  ratePlanIds: [],
  rateEffect: 'percent_off',
  rateValue: '',
  trial: null,
  trialPrice: '',
  apptPrice: null,
  lengths: [{ minutes: 60, free: false, price: '', memberPrice: '' }],
  apptDeal: null,
  dealPlanIds: [],
  dealEffect: 'percent_off',
  dealPercent: '',
  courseMode: null,
  startDate: '',
  startTime: '15:45',
  courseMinutes: '60',
  endDate: '',
  skipDates: [],
  skipDraft: '',
  days: [emptyDay()],
  placesLimited: null,
  places: '',
  coursePrice: null,
  coursePriceAmount: '',
  courseMembers: null,
  close: null,
  closeDays: '3',
  planKind: null,
  monthly: '',
  annual: '',
  packPrice: '',
  credits: '10',
  validMonths: '',
  payout: '',
  limit: null,
  limitCount: '2',
  limitPer: 'week',
  intro: null,
  introAmount: '',
  introPeriods: '1',
  includedActivityIds: [],
  sell: null,
}

/** A number the studio typed, or null. Commas count as decimal points. */
const num = (s: string): number | null => {
  if (s.trim() === '') return null
  const n = parsePriceInput(s)
  return Number.isFinite(n) ? n : null
}
const chargeable = (s: string) => (num(s) ?? 0) >= 0.5
const whole = (s: string, min: number, max: number) => {
  const n = num(s)
  return n !== null && Number.isInteger(n) && n >= min && n <= max
}

/** A local date+time pair → the instant, through the browser's own timezone,
 *  which is the studio's. The spelling `CourseBlockDialog` uses. */
function localInstant(date: string, time: string): number | null {
  if (!date || !time) return null
  const at = new Date(`${date}T${time}`)
  return Number.isNaN(at.getTime()) ? null : at.getTime()
}

/** How one length is sold, from the price answer and the row. */
function lengthSale(a: Answers, row: LengthRow): SetupLength['sale'] {
  if (a.apptPrice === 'free') return 'free'
  if (a.apptPrice === 'plan_only') return 'plan_only'
  if (a.apptPrice === 'some_free' && row.free) return 'free'
  return 'priced'
}

/**
 * The lessons a course's answers produce, as `CourseBlockDialog` previews
 * them: the same count the studio will put on the card. The server resolves
 * it again and is the authority.
 */
function courseDates(a: Answers): Date[] {
  if (a.courseMode === 'dates') {
    return a.days
      .map((d) => localInstant(d.date, d.time))
      .filter((ms): ms is number => ms !== null)
      .sort((x, y) => x - y)
      .map((ms) => new Date(ms))
  }
  const from = localInstant(a.startDate, a.startTime)
  if (from === null || !a.endDate) return []
  const until = new Date(`${a.endDate}T23:59`)
  if (Number.isNaN(until.getTime())) return []
  const skip = new Set(a.skipDates)
  const out: Date[] = []
  const cursor = new Date(from)
  while (cursor <= until && out.length <= 400) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    if (!skip.has(key)) out.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 7)
  }
  return out
}

/** Is anything in these answers paid for online, so Stripe has to be connected? */
function sellsOnline(a: Answers): boolean {
  switch (a.kind) {
    case 'plan':
      return a.sell === 'online'
    case 'class':
      return a.pay === 'per_class' || a.pay === 'both' || (a.pay !== 'free' && a.trial === 'priced')
    case 'appointment':
      return a.lengths.some((r) => lengthSale(a, r) === 'priced')
    case 'course':
      return a.coursePrice === 'priced'
    default:
      return false
  }
}

/** What follows `step`, from the answers as they stand. */
function nextStep(step: Step, a: Answers, ctx: { plansOutsideIncluded: number; planCount: number }): Step {
  switch (step) {
    case 'what':
      return a.kind === 'class'
        ? 'class-name'
        : a.kind === 'plan'
          ? 'plan-kind'
          : a.kind === 'appointment'
            ? 'appt-name'
            : a.kind === 'course'
              ? 'course-name'
              : 'handoff'
    case 'class-name':
      return 'class-who'
    case 'class-who':
      return 'class-pay'
    case 'class-pay':
      if (a.pay === 'free') return 'review'
      if (a.pay === 'included') return 'class-newcomers'
      // A member rate is only worth asking about when some plan does NOT
      // already include the class: its holders are the ones who would pay.
      return ctx.plansOutsideIncluded > 0 ? 'class-rate' : 'class-newcomers'
    case 'class-rate':
      return 'class-newcomers'
    case 'class-newcomers':
      return 'review'
    case 'appt-name':
      return 'appt-price'
    case 'appt-price':
      return 'appt-lengths'
    case 'appt-lengths':
      // Nothing for a plan to do on a free appointment, and nothing to ask
      // about with no plans, unless the appointment needs one to be booked.
      if (a.apptPrice === 'free') return 'review'
      return ctx.planCount > 0 || a.apptPrice === 'plan_only' ? 'appt-members' : 'review'
    case 'appt-members':
      return 'review'
    case 'course-name':
      return 'course-when'
    case 'course-when':
      return 'course-places'
    case 'course-places':
      return 'course-price'
    case 'course-price':
      // A free course can't be linked to plans: nothing to include or discount.
      return a.coursePrice === 'priced' && ctx.planCount > 0 ? 'course-members' : 'course-who'
    case 'course-members':
      return 'course-who'
    case 'course-who':
      return 'course-close'
    case 'course-close':
      return 'review'
    case 'plan-kind':
      return 'plan-details'
    case 'plan-details':
      return a.planKind === 'membership' ? 'plan-limit' : 'plan-includes'
    case 'plan-limit':
      return 'plan-intro'
    case 'plan-intro':
      return 'plan-includes'
    case 'plan-includes':
      return 'plan-sell'
    case 'plan-sell':
      return 'review'
    default:
      return step
  }
}

/** Can this step move on? */
function stepComplete(step: Step, a: Answers): boolean {
  switch (step) {
    case 'what':
      return a.kind !== null
    case 'class-name':
    case 'appt-name':
    case 'course-name':
      return a.name.trim().length > 0
    case 'class-who':
    case 'course-who':
      return a.signupRequired !== null
    case 'class-pay': {
      if (!a.pay) return false
      const needsPlans = a.pay === 'included' || a.pay === 'both'
      const needsDropIn = a.pay === 'per_class' || a.pay === 'both'
      if (needsPlans && a.includedPlanIds.length === 0) return false
      if (needsDropIn && a.dropInMode === 'custom' && !chargeable(a.dropInPrice)) return false
      return true
    }
    case 'class-rate':
      if (a.rate === 'no') return true
      if (a.rate !== 'yes' || a.ratePlanIds.length === 0) return false
      return a.rateEffect === 'percent_off' ? whole(a.rateValue, 1, 99) : chargeable(a.rateValue)
    case 'class-newcomers':
      return a.trial === 'free' || a.trial === 'no' || (a.trial === 'priced' && chargeable(a.trialPrice))
    case 'appt-price':
      return a.apptPrice !== null
    case 'appt-lengths':
      return (
        a.lengths.length > 0 &&
        a.lengths.every((r) => lengthSale(a, r) !== 'priced' || chargeable(r.price))
      )
    case 'appt-members': {
      if (a.apptPrice === 'plan_only') return a.apptDeal === 'included' && a.dealPlanIds.length > 0
      if (a.apptDeal === 'no') return true
      if (!a.apptDeal || a.dealPlanIds.length === 0) return false
      if (a.apptDeal === 'included') return true
      if (a.dealEffect === 'percent_off') return whole(a.dealPercent, 1, 99)
      return a.lengths.every((r) => lengthSale(a, r) !== 'priced' || chargeable(r.memberPrice))
    }
    case 'course-when':
      if (a.courseMode === 'weekly') return whole(a.courseMinutes, 5, 720) && courseDates(a).length > 0
      if (a.courseMode === 'dates') {
        return (
          a.days.length > 0 &&
          a.days.every((d) => localInstant(d.date, d.time) !== null && whole(d.minutes, 5, 720))
        )
      }
      return false
    case 'course-places':
      return a.placesLimited === 'no' || (a.placesLimited === 'yes' && whole(a.places, 1, 1000))
    case 'course-price':
      return a.coursePrice === 'free' || (a.coursePrice === 'priced' && chargeable(a.coursePriceAmount))
    case 'course-members':
      if (a.courseMembers === 'no') return true
      if (a.courseMembers === 'included') return a.includedPlanIds.length > 0
      if (a.courseMembers !== 'cheaper' || a.ratePlanIds.length === 0) return false
      return a.rateEffect === 'percent_off' ? whole(a.rateValue, 1, 99) : chargeable(a.rateValue)
    case 'course-close':
      return a.close === 'open' || (a.close === 'days' && whole(a.closeDays, 0, 365))
    case 'plan-kind':
      return a.planKind !== null
    case 'plan-details':
      if (a.name.trim().length === 0) return false
      if (a.planKind === 'membership') return num(a.monthly) !== null || num(a.annual) !== null
      if (a.planKind === 'pack') {
        return num(a.packPrice) !== null && whole(a.credits, 1, 1000) && (a.validMonths.trim() === '' || whole(a.validMonths, 1, 60))
      }
      return true
    case 'plan-limit':
      return a.limit === 'unlimited' || (a.limit === 'limited' && whole(a.limitCount, 1, 1000))
    case 'plan-intro':
      return a.intro === 'no' || (a.intro === 'yes' && (num(a.introAmount) ?? -1) >= 0 && whole(a.introPeriods, 1, 24))
    case 'plan-includes':
      return true
    case 'plan-sell':
      return a.sell !== null
    default:
      return true
  }
}

/** The answers as the callable takes them. */
function toSetup(a: Answers): OfferingSetup {
  const description = a.description.trim() || undefined
  const named = { name: a.name.trim(), ...(description ? { description } : {}) }

  if (a.kind === 'appointment') {
    const deal = a.apptPrice === 'plan_only' ? 'included' : a.apptPrice === 'free' ? 'no' : (a.apptDeal ?? 'no')
    const fixed = deal === 'less' && a.dealEffect === 'fixed_price'
    return {
      kind: 'appointment',
      appointment: {
        ...named,
        lengths: a.lengths.map((r) => {
          const sale = lengthSale(a, r)
          return {
            minutes: r.minutes,
            sale,
            ...(sale === 'priced' ? { priceAmount: num(r.price)! } : {}),
            ...(fixed && sale === 'priced' ? { memberAmount: num(r.memberPrice)! } : {}),
          }
        }),
        ...(deal === 'included'
          ? { memberDeal: { planIds: a.dealPlanIds, effect: 'included' as const } }
          : deal === 'less'
            ? {
                memberDeal: {
                  planIds: a.dealPlanIds,
                  effect: a.dealEffect,
                  ...(a.dealEffect === 'percent_off' ? { percent: num(a.dealPercent)! } : {}),
                },
              }
            : {}),
      },
    }
  }

  if (a.kind === 'course') {
    const schedule: SetupCourseSchedule =
      a.courseMode === 'weekly'
        ? {
            kind: 'weekly',
            startMs: localInstant(a.startDate, a.startTime)!,
            minutes: num(a.courseMinutes)!,
            weekday: new Date(localInstant(a.startDate, a.startTime)!).getDay(),
            endMs: new Date(`${a.endDate}T23:59`).getTime(),
            skipMs: a.skipDates.map((d) => new Date(`${d}T12:00`).getTime()),
          }
        : {
            kind: 'dates',
            meetings: a.days.map((d) => ({ startMs: localInstant(d.date, d.time)!, minutes: num(d.minutes)! })),
          }
    const priced = a.coursePrice === 'priced'
    return {
      kind: 'course',
      course: {
        ...named,
        schedule,
        ...(a.placesLimited === 'yes' ? { places: num(a.places)! } : {}),
        ...(priced ? { priceAmount: num(a.coursePriceAmount)! } : {}),
        includedPlanIds: priced && a.courseMembers === 'included' ? a.includedPlanIds : [],
        ...(priced && a.courseMembers === 'cheaper'
          ? {
              memberRate: {
                planIds: a.ratePlanIds,
                effect: a.rateEffect,
                ...(a.rateEffect === 'percent_off' ? { percent: num(a.rateValue)! } : { amount: num(a.rateValue)! }),
              },
            }
          : {}),
        signupRequired: a.signupRequired === true,
        ...(a.close === 'days' ? { closeDaysBefore: num(a.closeDays)! } : {}),
      },
    }
  }

  if (a.kind === 'plan') {
    const kind = a.planKind ?? 'membership'
    return {
      kind: 'plan',
      plan: {
        ...named,
        kind,
        public: a.sell === 'online',
        includedActivityIds: a.includedActivityIds,
        ...(kind === 'membership'
          ? {
              ...(num(a.monthly) !== null ? { monthlyAmount: num(a.monthly)! } : {}),
              ...(num(a.annual) !== null ? { annualAmount: num(a.annual)! } : {}),
              ...(a.limit === 'limited' ? { limit: { count: num(a.limitCount)!, per: a.limitPer } } : {}),
              ...(a.intro === 'yes' ? { intro: { amount: num(a.introAmount)!, periods: num(a.introPeriods)! } } : {}),
            }
          : {}),
        ...(kind === 'pack'
          ? {
              packAmount: num(a.packPrice)!,
              credits: num(a.credits)!,
              ...(num(a.validMonths) !== null ? { validMonths: num(a.validMonths)! } : {}),
            }
          : {}),
        ...(kind === 'partner' && num(a.payout) !== null ? { payoutPerVisit: num(a.payout)! } : {}),
      },
    }
  }

  const sellsAtDoor = a.pay === 'per_class' || a.pay === 'both'
  const included = a.pay === 'included' || a.pay === 'both'
  return {
    kind: 'class',
    class: {
      ...named,
      signupRequired: a.signupRequired === true,
      includedPlanIds: included ? a.includedPlanIds : [],
      dropIn: !sellsAtDoor
        ? { mode: 'off' }
        : a.dropInMode === 'custom'
          ? { mode: 'custom', priceAmount: num(a.dropInPrice)! }
          : { mode: 'studio' },
      ...(sellsAtDoor && a.rate === 'yes'
        ? {
            memberRate: {
              planIds: a.ratePlanIds,
              effect: a.rateEffect,
              ...(a.rateEffect === 'percent_off' ? { percent: num(a.rateValue)! } : { amount: num(a.rateValue)! }),
            },
          }
        : {}),
      ...(a.pay !== 'free' && a.trial === 'free' ? { trial: {} } : {}),
      ...(a.pay !== 'free' && a.trial === 'priced' ? { trial: { priceAmount: num(a.trialPrice)! } } : {}),
    },
  }
}

export function OfferingWizardDialog({
  open,
  onOpenChange,
  teamId,
  currency,
  plans,
  activities,
  bookingSettings,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  currency: string
  plans: SubscriptionType[]
  activities: Activity[]
  bookingSettings: Partial<BookingSettings> | undefined
  /** The record exists: select it in the catalog. */
  onCreated: (created: Created) => void
}) {
  const t = useTranslations('OfferingWizard')
  const [a, setA] = useState<Answers>(EMPTY)
  const [visited, setVisited] = useState<Step[]>(['what'])
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const step = visited[visited.length - 1]
  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => setA((prev) => ({ ...prev, [k]: v }))

  const livePlans = useMemo(() => plans.filter((p) => p.active !== false), [plans])
  const classes = useMemo(
    () => activities.filter((x) => x.type !== 'appointment' && x.isActive !== false),
    [activities]
  )
  const usual = studioDropInOf(bookingSettings)
  const plansOutsideIncluded = livePlans.filter(
    (p) => !(a.pay === 'both' ? a.includedPlanIds : []).includes(p.id)
  ).length
  const money = (n: number) => formatCurrency(n, currency)
  const lessons = useMemo(() => (a.kind === 'course' ? courseDates(a) : []), [a])

  const reset = () => {
    setA(EMPTY)
    setVisited(['what'])
    setCreated(null)
  }
  const close = (v: boolean) => {
    if (!v) reset()
    onOpenChange(v)
  }
  /** A different kind starts from nothing: a class's plans are not a course's. */
  const chooseKind = (kind: Kind) => setA((prev) => (prev.kind === kind ? prev : { ...EMPTY, kind }))
  const goNext = () =>
    setVisited((v) => [...v, nextStep(step, a, { plansOutsideIncluded, planCount: livePlans.length })])
  const goBack = () => setVisited((v) => (v.length > 1 ? v.slice(0, -1) : v))

  const setLength = (minutes: number, patch: Partial<LengthRow>) =>
    set(
      'lengths',
      a.lengths.map((r) => (r.minutes === minutes ? { ...r, ...patch } : r))
    )
  const toggleLength = (minutes: number) =>
    set(
      'lengths',
      a.lengths.some((r) => r.minutes === minutes)
        ? a.lengths.filter((r) => r.minutes !== minutes)
        : [...a.lengths, { minutes, free: false, price: '', memberPrice: '' }].sort((x, y) => x.minutes - y.minutes)
    )
  const setDay = (i: number, patch: Partial<DayRow>) =>
    set(
      'days',
      a.days.map((d, j) => (j === i ? { ...d, ...patch } : d))
    )

  const create = async () => {
    setSaving(true)
    try {
      const res = await callFunction<{ teamId: string; setup: OfferingSetup }, Created>('applyOfferingSetup')({
        teamId,
        setup: toSetup(a),
      })
      setCreated(res.data)
      setVisited((v) => [...v, 'done'])
      onCreated(res.data)
    } catch (err) {
      console.error('[wizard] create failed:', err)
      toast.error(t('createFailed'))
    } finally {
      setSaving(false)
    }
  }

  // ── the screens ──
  const screen = (() => {
    switch (step) {
      case 'what':
        return (
          <Question ask={t('whatAsk')} help={t('whatHelp')}>
            <Option selected={a.kind === 'class'} onClick={() => chooseKind('class')} label={t('whatClass')} hint={t('whatClassHint')} />
            <Option selected={a.kind === 'appointment'} onClick={() => chooseKind('appointment')} label={t('whatAppointment')} hint={t('whatAppointmentHint')} />
            <Option selected={a.kind === 'course'} onClick={() => chooseKind('course')} label={t('whatCourse')} hint={t('whatCourseHint')} />
            <Option selected={a.kind === 'plan'} onClick={() => chooseKind('plan')} label={t('whatPlan')} hint={t('whatPlanHint')} />
            <Option selected={a.kind === 'online'} onClick={() => chooseKind('online')} label={t('whatOnline')} hint={t('whatOnlineHint')} />
            <Option selected={a.kind === 'product'} onClick={() => chooseKind('product')} label={t('whatProduct')} hint={t('whatProductHint')} />
            <Option selected={a.kind === 'event'} onClick={() => chooseKind('event')} label={t('whatEvent')} hint={t('whatEventHint')} />
          </Question>
        )

      case 'handoff':
        return (
          <Question
            ask={a.kind === 'online' ? t('handoffOnline') : a.kind === 'product' ? t('handoffProduct') : t('handoffEvent')}
            help={
              a.kind === 'online' ? t('handoffOnlineNote') : a.kind === 'product' ? t('handoffProductNote') : t('handoffEventNote')
            }
          >
            <Button
              render={
                <Link
                  href={
                    (a.kind === 'online'
                      ? '/manage/online-courses?new=1'
                      : a.kind === 'product'
                        ? '/manage/products?new=1'
                        : '/events') as Route
                  }
                />
              }
            >
              {t('handoffOpen')}
            </Button>
          </Question>
        )

      case 'class-name':
      case 'appt-name':
      case 'course-name':
      case 'plan-details':
        return (
          <Question
            ask={
              step === 'class-name'
                ? t('classNameAsk')
                : step === 'appt-name'
                  ? t('apptNameAsk')
                  : step === 'course-name'
                    ? t('courseNameAsk')
                    : t('planDetailsAsk')
            }
          >
            <Field label={t('nameLabel')}>
              <Input value={a.name} onChange={(e) => set('name', e.target.value)} maxLength={80} autoFocus />
            </Field>
            <Field label={t('descriptionLabel')} hint={t('descriptionHint')}>
              <Textarea rows={2} value={a.description} onChange={(e) => set('description', e.target.value)} maxLength={600} />
            </Field>
            {step === 'plan-details' && a.planKind === 'membership' && (
              <div className="flex flex-wrap gap-4">
                <Field label={t('monthlyLabel')}>
                  <MoneyInput currency={currency} value={a.monthly} onChange={(v) => set('monthly', v)} label={t('monthlyLabel')} />
                </Field>
                <Field label={t('annualLabel')}>
                  <MoneyInput currency={currency} value={a.annual} onChange={(v) => set('annual', v)} label={t('annualLabel')} />
                </Field>
              </div>
            )}
            {step === 'plan-details' && a.planKind === 'pack' && (
              <div className="flex flex-wrap gap-4">
                <Field label={t('packPriceLabel')}>
                  <MoneyInput currency={currency} value={a.packPrice} onChange={(v) => set('packPrice', v)} label={t('packPriceLabel')} />
                </Field>
                <Field label={t('creditsLabel')}>
                  <Input inputMode="numeric" value={a.credits} onChange={(e) => set('credits', e.target.value)} className="h-9 w-20" />
                </Field>
                <Field label={t('validMonthsLabel')} hint={t('validMonthsHint')}>
                  <Input inputMode="numeric" value={a.validMonths} onChange={(e) => set('validMonths', e.target.value)} className="h-9 w-20" />
                </Field>
              </div>
            )}
            {step === 'plan-details' && a.planKind === 'partner' && (
              <Field label={t('payoutLabel')} hint={t('payoutHint')}>
                <MoneyInput currency={currency} value={a.payout} onChange={(v) => set('payout', v)} label={t('payoutLabel')} />
              </Field>
            )}
          </Question>
        )

      case 'class-who':
      case 'course-who':
        return (
          <Question ask={step === 'class-who' ? t('classWhoAsk') : t('courseWhoAsk')}>
            <Option selected={a.signupRequired === false} onClick={() => set('signupRequired', false)} label={t('classWhoAnyone')} />
            <Option
              selected={a.signupRequired === true}
              onClick={() => set('signupRequired', true)}
              label={t('classWhoSignedUp')}
              hint={t('classWhoSignedUpHint')}
            />
          </Question>
        )

      case 'class-pay': {
        const needsPlans = a.pay === 'included' || a.pay === 'both'
        const needsDropIn = a.pay === 'per_class' || a.pay === 'both'
        return (
          <Question ask={t('classPayAsk')}>
            <Option selected={a.pay === 'included'} onClick={() => set('pay', 'included')} label={t('classPayIncluded')} hint={t('classPayIncludedHint')} />
            <Option selected={a.pay === 'per_class'} onClick={() => set('pay', 'per_class')} label={t('classPayPerClass')} hint={t('classPayPerClassHint')} />
            <Option selected={a.pay === 'both'} onClick={() => set('pay', 'both')} label={t('classPayBoth')} />
            <Option selected={a.pay === 'free'} onClick={() => set('pay', 'free')} label={t('classPayFree')} hint={t('classPayFreeHint')} />
            {needsPlans && (
              <Field label={t('includedPlansLabel')}>
                <Picker
                  items={livePlans}
                  picked={a.includedPlanIds}
                  onChange={(ids) => set('includedPlanIds', ids)}
                  empty={t('noPlansYet')}
                />
              </Field>
            )}
            {needsDropIn && (
              <div className="space-y-2">
                <span className="text-xs font-medium text-muted-foreground">{t('dropInLabel')}</span>
                <Option
                  selected={a.dropInMode === 'studio'}
                  onClick={() => set('dropInMode', 'studio')}
                  label={t('dropInUsual')}
                  hint={usual?.enabled && typeof usual.priceAmount === 'number' ? t('dropInUsualIs', { price: money(usual.priceAmount) }) : t('dropInUsualUnset')}
                />
                <Option selected={a.dropInMode === 'custom'} onClick={() => set('dropInMode', 'custom')} label={t('dropInOwn')} />
                {a.dropInMode === 'custom' && (
                  <MoneyInput currency={currency} value={a.dropInPrice} onChange={(v) => set('dropInPrice', v)} label={t('dropInOwn')} />
                )}
              </div>
            )}
          </Question>
        )
      }

      case 'class-rate':
        return (
          <Question ask={t('classRateAsk')} help={t('classRateHelp')}>
            <Option selected={a.rate === 'yes'} onClick={() => set('rate', 'yes')} label={t('yes')} />
            <Option selected={a.rate === 'no'} onClick={() => set('rate', 'no')} label={t('classRateNo')} />
            {a.rate === 'yes' && (
              <RateFields
                t={t}
                currency={currency}
                plans={livePlans.filter((p) => !(a.pay === 'both' ? a.includedPlanIds : []).includes(p.id))}
                a={a}
                set={set}
              />
            )}
          </Question>
        )

      case 'class-newcomers':
        return (
          <Question ask={t('classNewcomersAsk')} help={t('classNewcomersHelp')}>
            <Option selected={a.trial === 'free'} onClick={() => set('trial', 'free')} label={t('trialFree')} />
            <Option selected={a.trial === 'priced'} onClick={() => set('trial', 'priced')} label={t('trialPriced')} />
            {a.trial === 'priced' && (
              <MoneyInput currency={currency} value={a.trialPrice} onChange={(v) => set('trialPrice', v)} label={t('trialPriced')} />
            )}
            <Option selected={a.trial === 'no'} onClick={() => set('trial', 'no')} label={t('trialNo')} />
            {a.trial === 'no' && a.pay === 'included' && <p className="text-xs text-muted-foreground">{t('trialNoNote')}</p>}
          </Question>
        )

      case 'appt-price':
        return (
          <Question ask={t('apptPriceAsk')} help={t('apptPriceHelp')}>
            <Option selected={a.apptPrice === 'priced'} onClick={() => set('apptPrice', 'priced')} label={t('apptPriced')} />
            <Option selected={a.apptPrice === 'some_free'} onClick={() => set('apptPrice', 'some_free')} label={t('apptSomeFree')} hint={t('apptSomeFreeHint')} />
            <Option selected={a.apptPrice === 'free'} onClick={() => set('apptPrice', 'free')} label={t('apptFree')} hint={t('apptFreeHint')} />
            <Option selected={a.apptPrice === 'plan_only'} onClick={() => set('apptPrice', 'plan_only')} label={t('apptPlanOnly')} hint={t('apptPlanOnlyHint')} />
          </Question>
        )

      case 'appt-lengths':
        return (
          <Question ask={t('apptLengthsAsk')} help={t('apptLengthsHelp')}>
            <div className="flex flex-wrap gap-1.5">
              {APPOINTMENT_DURATION_PRESETS.map((m) => {
                const on = a.lengths.some((r) => r.minutes === m)
                return (
                  <Button key={m} size="sm" variant={on ? 'default' : 'outline'} aria-pressed={on} onClick={() => toggleLength(m)}>
                    {formatDuration(m)}
                  </Button>
                )
              })}
            </div>
            {(a.apptPrice === 'priced' || a.apptPrice === 'some_free') && (
              <div className="space-y-2">
                {a.lengths.map((r) => (
                  <div key={r.minutes} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                    <span className="w-16 text-sm font-medium">{formatDuration(r.minutes)}</span>
                    {a.apptPrice === 'some_free' && (
                      <>
                        <Button size="sm" variant={r.free ? 'default' : 'outline'} onClick={() => setLength(r.minutes, { free: true })}>
                          {t('lengthFree')}
                        </Button>
                        <Button size="sm" variant={!r.free ? 'default' : 'outline'} onClick={() => setLength(r.minutes, { free: false })}>
                          {t('lengthPriced')}
                        </Button>
                      </>
                    )}
                    {lengthSale(a, r) === 'priced' && (
                      <MoneyInput currency={currency} value={r.price} onChange={(v) => setLength(r.minutes, { price: v })} label={t('priceLabel')} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </Question>
        )

      case 'appt-members': {
        const planOnly = a.apptPrice === 'plan_only'
        const fixed = a.apptDeal === 'less' && a.dealEffect === 'fixed_price'
        return (
          <Question ask={t('apptMembersAsk')} help={planOnly ? t('apptPlanOnlyNote') : undefined}>
            <Option
              selected={a.apptDeal === 'included'}
              onClick={() => set('apptDeal', 'included')}
              label={t('apptDealIncluded')}
              hint={t('apptDealIncludedHint')}
            />
            {!planOnly && (
              <>
                <Option selected={a.apptDeal === 'less'} onClick={() => set('apptDeal', 'less')} label={t('apptDealLess')} />
                <Option selected={a.apptDeal === 'no'} onClick={() => set('apptDeal', 'no')} label={t('apptDealNo')} />
              </>
            )}
            {(a.apptDeal === 'included' || a.apptDeal === 'less') && (
              <Field label={t('ratePlansLabel')}>
                <Picker items={livePlans} picked={a.dealPlanIds} onChange={(ids) => set('dealPlanIds', ids)} empty={t('noPlansYet')} />
              </Field>
            )}
            {a.apptDeal === 'less' && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={a.dealEffect === 'percent_off' ? 'default' : 'outline'} onClick={() => set('dealEffect', 'percent_off')}>
                  {t('ratePercent')}
                </Button>
                <Button size="sm" variant={a.dealEffect === 'fixed_price' ? 'default' : 'outline'} onClick={() => set('dealEffect', 'fixed_price')}>
                  {t('rateFixed')}
                </Button>
                {a.dealEffect === 'percent_off' && (
                  <div className="flex items-center gap-1">
                    <Input inputMode="numeric" value={a.dealPercent} onChange={(e) => set('dealPercent', e.target.value)} className="h-9 w-20" aria-label={t('ratePercent')} />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                )}
              </div>
            )}
            {fixed &&
              a.lengths
                .filter((r) => lengthSale(a, r) === 'priced')
                .map((r) => (
                  <div key={r.minutes} className="flex items-center gap-2">
                    <span className="w-16 text-sm font-medium">{formatDuration(r.minutes)}</span>
                    <MoneyInput
                      currency={currency}
                      value={r.memberPrice}
                      onChange={(v) => setLength(r.minutes, { memberPrice: v })}
                      label={t('memberPriceLabel', { length: formatDuration(r.minutes) })}
                    />
                  </div>
                ))}
          </Question>
        )
      }

      case 'course-when':
        return (
          <Question ask={t('courseWhenAsk')}>
            <Option selected={a.courseMode === 'weekly'} onClick={() => set('courseMode', 'weekly')} label={t('courseWeekly')} hint={t('courseWeeklyHint')} />
            <Option selected={a.courseMode === 'dates'} onClick={() => set('courseMode', 'dates')} label={t('courseDates')} hint={t('courseDatesHint')} />
            {a.courseMode === 'weekly' && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  <Field label={t('firstLessonLabel')}>
                    <Input type="date" value={a.startDate} onChange={(e) => set('startDate', e.target.value)} className="h-9 w-40" />
                  </Field>
                  <Field label={t('timeLabel')}>
                    <Input type="time" value={a.startTime} onChange={(e) => set('startTime', e.target.value)} className="h-9 w-28" />
                  </Field>
                  <Field label={t('lengthMinutesLabel')}>
                    <Input inputMode="numeric" value={a.courseMinutes} onChange={(e) => set('courseMinutes', e.target.value)} className="h-9 w-20" />
                  </Field>
                  <Field label={t('lastLessonLabel')}>
                    <Input type="date" value={a.endDate} min={a.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} className="h-9 w-40" />
                  </Field>
                </div>
                <Field label={t('skipDatesLabel')} hint={t('skipDatesHint')}>
                  <div className="flex items-center gap-2">
                    <Input type="date" value={a.skipDraft} onChange={(e) => set('skipDraft', e.target.value)} className="h-9 w-40" />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!a.skipDraft || a.skipDates.includes(a.skipDraft)}
                      onClick={() => setA((p) => ({ ...p, skipDates: [...p.skipDates, p.skipDraft].sort(), skipDraft: '' }))}
                    >
                      {t('addSkipDate')}
                    </Button>
                  </div>
                </Field>
                {a.skipDates.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {a.skipDates.map((d) => (
                      <span key={d} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                        {new Date(`${d}T12:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                        <button
                          type="button"
                          aria-label={t('removeLabel')}
                          onClick={() => set('skipDates', a.skipDates.filter((x) => x !== d))}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {a.courseMode === 'dates' && (
              <div className="space-y-2">
                {a.days.map((d, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Field label={t('dateLabel')}>
                      <Input type="date" value={d.date} onChange={(e) => setDay(i, { date: e.target.value })} className="h-9 w-40" />
                    </Field>
                    <Field label={t('timeLabel')}>
                      <Input type="time" value={d.time} onChange={(e) => setDay(i, { time: e.target.value })} className="h-9 w-28" />
                    </Field>
                    <Field label={t('lengthMinutesLabel')}>
                      <Input inputMode="numeric" value={d.minutes} onChange={(e) => setDay(i, { minutes: e.target.value })} className="h-9 w-20" />
                    </Field>
                    {a.days.length > 1 && (
                      <Button size="sm" variant="ghost" aria-label={t('removeLabel')} onClick={() => set('days', a.days.filter((_, j) => j !== i))}>
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => set('days', [...a.days, emptyDay()])}>
                  {t('addDate')}
                </Button>
              </div>
            )}
            {a.courseMode && lessons.length > 0 && (
              <p className="text-sm font-medium">{t('lessonCount', { count: lessons.length })}</p>
            )}
          </Question>
        )

      case 'course-places':
        return (
          <Question ask={t('coursePlacesAsk')}>
            <Option selected={a.placesLimited === 'yes'} onClick={() => set('placesLimited', 'yes')} label={t('yes')} hint={t('coursePlacesHint')} />
            {a.placesLimited === 'yes' && (
              <Field label={t('placesLabel')}>
                <Input inputMode="numeric" value={a.places} onChange={(e) => set('places', e.target.value)} className="h-9 w-20" />
              </Field>
            )}
            <Option selected={a.placesLimited === 'no'} onClick={() => set('placesLimited', 'no')} label={t('coursePlacesNo')} />
          </Question>
        )

      case 'course-price':
        return (
          <Question ask={t('coursePriceAsk')}>
            <Option selected={a.coursePrice === 'priced'} onClick={() => set('coursePrice', 'priced')} label={t('coursePriced')} hint={t('coursePricedHint')} />
            {a.coursePrice === 'priced' && (
              <MoneyInput currency={currency} value={a.coursePriceAmount} onChange={(v) => set('coursePriceAmount', v)} label={t('coursePriced')} />
            )}
            <Option selected={a.coursePrice === 'free'} onClick={() => set('coursePrice', 'free')} label={t('courseFree')} />
          </Question>
        )

      case 'course-members':
        return (
          <Question ask={t('courseMembersAsk')}>
            <Option selected={a.courseMembers === 'included'} onClick={() => set('courseMembers', 'included')} label={t('courseIncluded')} />
            {a.courseMembers === 'included' && (
              <Field label={t('includedPlansLabel')}>
                <Picker items={livePlans} picked={a.includedPlanIds} onChange={(ids) => set('includedPlanIds', ids)} empty={t('noPlansYet')} />
              </Field>
            )}
            <Option selected={a.courseMembers === 'cheaper'} onClick={() => set('courseMembers', 'cheaper')} label={t('courseCheaper')} />
            {a.courseMembers === 'cheaper' && <RateFields t={t} currency={currency} plans={livePlans} a={a} set={set} />}
            <Option selected={a.courseMembers === 'no'} onClick={() => set('courseMembers', 'no')} label={t('no')} />
          </Question>
        )

      case 'course-close':
        return (
          <Question ask={t('courseCloseAsk')}>
            <Option selected={a.close === 'days'} onClick={() => set('close', 'days')} label={t('courseCloseDays')} />
            {a.close === 'days' && (
              <Field label={t('closeDaysLabel')}>
                <Input inputMode="numeric" value={a.closeDays} onChange={(e) => set('closeDays', e.target.value)} className="h-9 w-20" />
              </Field>
            )}
            <Option selected={a.close === 'open'} onClick={() => set('close', 'open')} label={t('courseCloseOpen')} />
          </Question>
        )

      case 'plan-kind':
        return (
          <Question ask={t('planKindAsk')}>
            <Option selected={a.planKind === 'membership'} onClick={() => set('planKind', 'membership')} label={t('planMembership')} hint={t('planMembershipHint')} />
            <Option selected={a.planKind === 'pack'} onClick={() => set('planKind', 'pack')} label={t('planPack')} hint={t('planPackHint')} />
            <Option selected={a.planKind === 'complimentary'} onClick={() => set('planKind', 'complimentary')} label={t('planComplimentary')} hint={t('planComplimentaryHint')} />
            <Option selected={a.planKind === 'partner'} onClick={() => set('planKind', 'partner')} label={t('planPartner')} hint={t('planPartnerHint')} />
          </Question>
        )

      case 'plan-limit':
        return (
          <Question ask={t('planLimitAsk')}>
            <Option selected={a.limit === 'unlimited'} onClick={() => set('limit', 'unlimited')} label={t('planUnlimited')} />
            <Option selected={a.limit === 'limited'} onClick={() => set('limit', 'limited')} label={t('planLimited')} hint={t('planLimitedHint')} />
            {a.limit === 'limited' && (
              <div className="flex flex-wrap items-center gap-2">
                <Input inputMode="numeric" value={a.limitCount} onChange={(e) => set('limitCount', e.target.value)} className="h-9 w-20" aria-label={t('planLimited')} />
                <span className="text-sm text-muted-foreground">{t('limitClassesPer')}</span>
                {(['day', 'week', 'month'] as const).map((per) => (
                  <Button key={per} size="sm" variant={a.limitPer === per ? 'default' : 'outline'} onClick={() => set('limitPer', per)}>
                    {per === 'day' ? t('perDay') : per === 'week' ? t('perWeek') : t('perMonth')}
                  </Button>
                ))}
              </div>
            )}
          </Question>
        )

      case 'plan-intro':
        return (
          <Question ask={t('planIntroAsk')}>
            <Option selected={a.intro === 'yes'} onClick={() => set('intro', 'yes')} label={t('planIntroYes')} />
            {a.intro === 'yes' && (
              <div className="flex flex-wrap gap-4">
                <Field label={t('introAmountLabel')} hint={t('introAmountHint')}>
                  <MoneyInput currency={currency} value={a.introAmount} onChange={(v) => set('introAmount', v)} label={t('introAmountLabel')} />
                </Field>
                <Field label={t('introPeriodsLabel')}>
                  <Input inputMode="numeric" value={a.introPeriods} onChange={(e) => set('introPeriods', e.target.value)} className="h-9 w-20" />
                </Field>
              </div>
            )}
            <Option selected={a.intro === 'no'} onClick={() => set('intro', 'no')} label={t('no')} />
          </Question>
        )

      case 'plan-includes':
        return (
          <Question ask={t('planIncludesAsk')} help={t('planIncludesHelp')}>
            <Picker
              items={classes}
              picked={a.includedActivityIds}
              onChange={(ids) => set('includedActivityIds', ids)}
              empty={t('noClassesYet')}
            />
          </Question>
        )

      case 'plan-sell':
        return (
          <Question ask={t('planSellAsk')}>
            <Option selected={a.sell === 'online'} onClick={() => set('sell', 'online')} label={t('planSellOnline')} hint={t('planSellOnlineHint')} />
            <Option selected={a.sell === 'assign'} onClick={() => set('sell', 'assign')} label={t('planSellAssign')} hint={t('planSellAssignHint')} />
          </Question>
        )

      case 'review':
        return (
          <Question ask={t('reviewAsk')} help={t('reviewHelp')}>
            <ul className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
              {reviewLines(a, { t, money, plans: livePlans, classes, lessons }).map((line, i) => (
                <li key={i} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Question>
        )

      case 'done':
        return (
          <Question
            ask={t('doneAsk', { name: a.name.trim() })}
            help={created?.kind === 'course' ? t('donePublish') : t('doneHelp')}
          >
            <div className="flex flex-col gap-2">
              {created?.kind === 'class' && (
                <Button variant="outline" render={<Link href={'/schedule?new=1' as Route} />}>
                  {t('nextCalendar')}
                </Button>
              )}
              {created?.kind === 'appointment' && (
                <Button variant="outline" render={<Link href={'/schedule/availability' as Route} />}>
                  {t('nextAvailability')}
                </Button>
              )}
              {sellsOnline(a) && (
                <Button variant="outline" render={<Link href={'/settings/team?tab=payments' as Route} />}>
                  {t('nextPayments')}
                </Button>
              )}
              <Button variant="outline" render={<Link href={'/manage/pricing' as Route} />}>
                {t('nextPricing')}
              </Button>
              <Button variant="ghost" onClick={reset}>
                {t('nextAnother')}
              </Button>
            </div>
          </Question>
        )
      default:
        return null
    }
  })()

  const canContinue = stepComplete(step, a)
  const terminal = step === 'handoff' || step === 'done'

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            {t('title')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">{screen}</DialogBody>
        {step !== 'done' && (
          <DialogFooter>
            {visited.length > 1 && (
              <Button variant="outline" onClick={goBack} disabled={saving}>
                {t('back')}
              </Button>
            )}
            {!terminal &&
              (step === 'review' ? (
                <Button onClick={() => void create()} disabled={saving}>
                  {saving ? t('creating') : t('create')}
                </Button>
              ) : (
                <Button onClick={goNext} disabled={!canContinue}>
                  {t('continue')}
                </Button>
              ))}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Question({ ask, help, children }: { ask: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-base font-semibold">{ask}</p>
        {help && <p className="mt-1 text-sm text-muted-foreground">{help}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

// ── building blocks ──────────────────────────────────────────────────────────
// At MODULE scope, never inside the dialog: a component declared in a render is
// a new component type on every render, so its inputs remount and lose focus
// on each keystroke.

type WizardT = (key: string, values?: Record<string, string | number>) => string

/** "Members pay less": which plans, and a percentage or a member price. Asked
 *  the same way of a class and of a course. */
function RateFields({
  t,
  currency,
  plans,
  a,
  set,
}: {
  t: WizardT
  currency: string
  plans: SubscriptionType[]
  a: Answers
  set: <K extends keyof Answers>(k: K, v: Answers[K]) => void
}) {
  return (
    <div className="space-y-3">
      <Field label={t('ratePlansLabel')}>
        <Picker items={plans} picked={a.ratePlanIds} onChange={(ids) => set('ratePlanIds', ids)} empty={t('noPlansYet')} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={a.rateEffect === 'percent_off' ? 'default' : 'outline'} onClick={() => set('rateEffect', 'percent_off')}>
          {t('ratePercent')}
        </Button>
        <Button size="sm" variant={a.rateEffect === 'fixed_price' ? 'default' : 'outline'} onClick={() => set('rateEffect', 'fixed_price')}>
          {t('rateFixed')}
        </Button>
        {a.rateEffect === 'percent_off' ? (
          <div className="flex items-center gap-1">
            <Input inputMode="numeric" value={a.rateValue} onChange={(e) => set('rateValue', e.target.value)} className="h-9 w-20" aria-label={t('ratePercent')} />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        ) : (
          <MoneyInput currency={currency} value={a.rateValue} onChange={(v) => set('rateValue', v)} label={t('rateFixed')} />
        )}
      </div>
    </div>
  )
}

function Option({
  selected,
  onClick,
  label,
  hint,
}: {
  selected: boolean
  onClick: () => void
  label: string
  hint?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected ? 'border-primary bg-primary/5' : 'hover:border-foreground/40'
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
        {label}
      </span>
      {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
    </button>
  )
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

function MoneyInput({
  currency,
  value,
  onChange,
  label,
}: {
  currency: string
  value: string
  onChange: (v: string) => void
  label: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{currency}</span>
      <Input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
        aria-label={label}
        className="h-9 w-28"
      />
    </div>
  )
}

function Picker({
  items,
  picked,
  onChange,
  empty,
}: {
  items: { id: string; name: string }[]
  picked: string[]
  onChange: (ids: string[]) => void
  empty: string
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="max-h-56 space-y-1.5 overflow-y-auto">
      {items.map((it) => {
        const on = picked.includes(it.id)
        return (
          <button
            key={it.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? picked.filter((x) => x !== it.id) : [...picked, it.id])}
            className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${
              on ? 'border-primary bg-primary/5' : 'hover:border-foreground/40'
            }`}
          >
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                on ? 'border-primary bg-primary text-primary-foreground' : ''
              }`}
            >
              {on && <Check className="h-3 w-3" />}
            </span>
            {it.name}
          </button>
        )
      })}
    </div>
  )
}

/** What the review lists, one sentence per decision, in the studio's words. */
function reviewLines(
  a: Answers,
  ctx: {
    t: WizardT
    money: (n: number) => string
    plans: SubscriptionType[]
    classes: Activity[]
    lessons: Date[]
  }
): string[] {
  const { t, money } = ctx
  const names = (ids: string[], list: { id: string; name: string }[]) =>
    ids.map((id) => list.find((x) => x.id === id)?.name ?? '').filter(Boolean).join(', ')
  const n = (s: string) => num(s) ?? 0
  const rate = () =>
    a.rateEffect === 'percent_off'
      ? t('reviewRatePercent', { percent: n(a.rateValue), plans: names(a.ratePlanIds, ctx.plans) })
      : t('reviewRateFixed', { price: money(n(a.rateValue)), plans: names(a.ratePlanIds, ctx.plans) })
  const lines: string[] = []

  if (a.kind === 'class') {
    lines.push(t('reviewClass', { name: a.name.trim() }))
    lines.push(a.signupRequired ? t('reviewSignedUpOnly') : t('reviewAnyone'))
    if (a.pay === 'free') lines.push(t('reviewFree'))
    if (a.pay === 'included' || a.pay === 'both') {
      lines.push(t('reviewIncludedIn', { plans: names(a.includedPlanIds, ctx.plans) }))
    }
    if (a.pay === 'included') lines.push(t('reviewNoDropIn'))
    if (a.pay === 'per_class' || a.pay === 'both') {
      lines.push(
        a.dropInMode === 'custom'
          ? t('reviewDropInOwn', { price: money(n(a.dropInPrice)) })
          : t('reviewDropInUsual')
      )
      if (a.rate === 'yes') lines.push(rate())
    }
    if (a.pay !== 'free' && a.trial === 'free') lines.push(t('reviewTrialFree'))
    if (a.pay !== 'free' && a.trial === 'priced') lines.push(t('reviewTrialPriced', { price: money(n(a.trialPrice)) }))
    return lines
  }

  if (a.kind === 'appointment') {
    lines.push(t('reviewAppointment', { name: a.name.trim() }))
    const deal = a.apptPrice === 'plan_only' ? 'included' : a.apptPrice === 'free' ? 'no' : a.apptDeal
    const fixed = deal === 'less' && a.dealEffect === 'fixed_price'
    for (const r of a.lengths) {
      const length = formatDuration(r.minutes)
      const sale = lengthSale(a, r)
      lines.push(
        sale === 'free'
          ? t('reviewLengthFree', { length })
          : sale === 'plan_only'
            ? t('reviewLengthPlanOnly', { length })
            : fixed
              ? t('reviewLengthMember', { length, price: money(n(r.price)), member: money(n(r.memberPrice)) })
              : t('reviewLengthPriced', { length, price: money(n(r.price)) })
      )
    }
    if (deal === 'included') lines.push(t('reviewIncludedIn', { plans: names(a.dealPlanIds, ctx.plans) }))
    if (deal === 'less') {
      lines.push(
        a.dealEffect === 'percent_off'
          ? t('reviewRatePercent', { percent: n(a.dealPercent), plans: names(a.dealPlanIds, ctx.plans) })
          : t('reviewDealFixed', { plans: names(a.dealPlanIds, ctx.plans) })
      )
    }
    return lines
  }

  if (a.kind === 'course') {
    lines.push(t('reviewCourse', { name: a.name.trim() }))
    const first = ctx.lessons[0]
    if (first) {
      lines.push(
        t('reviewLessons', {
          count: ctx.lessons.length,
          first: first.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        })
      )
    }
    lines.push(a.placesLimited === 'yes' ? t('reviewPlaces', { count: n(a.places) }) : t('reviewNoPlaceLimit'))
    lines.push(a.coursePrice === 'priced' ? t('reviewCoursePrice', { price: money(n(a.coursePriceAmount)) }) : t('reviewFree'))
    if (a.coursePrice === 'priced' && a.courseMembers === 'included') {
      lines.push(t('reviewIncludedIn', { plans: names(a.includedPlanIds, ctx.plans) }))
    }
    if (a.coursePrice === 'priced' && a.courseMembers === 'cheaper') lines.push(rate())
    lines.push(a.signupRequired ? t('reviewSignedUpOnly') : t('reviewAnyone'))
    lines.push(a.close === 'days' ? t('reviewCloseDays', { count: n(a.closeDays) }) : t('reviewCloseOpen'))
    lines.push(t('reviewDraft'))
    return lines
  }

  lines.push(t('reviewPlan', { name: a.name.trim() }))
  if (a.planKind === 'membership') {
    if (num(a.monthly) !== null) lines.push(t('reviewMonthly', { price: money(n(a.monthly)) }))
    if (num(a.annual) !== null) lines.push(t('reviewAnnual', { price: money(n(a.annual)) }))
    lines.push(
      a.limit === 'limited'
        ? t('reviewLimit', {
            count: n(a.limitCount),
            per: a.limitPer === 'day' ? t('perDay') : a.limitPer === 'week' ? t('perWeek') : t('perMonth'),
          })
        : t('reviewUnlimited')
    )
    if (a.intro === 'yes') lines.push(t('reviewIntro', { price: money(n(a.introAmount)), count: n(a.introPeriods) }))
  }
  if (a.planKind === 'pack') {
    lines.push(t('reviewPack', { price: money(n(a.packPrice)), count: n(a.credits) }))
    if (num(a.validMonths) !== null) lines.push(t('reviewValid', { count: n(a.validMonths) }))
  }
  if (a.planKind === 'complimentary') lines.push(t('reviewComplimentary'))
  if (a.planKind === 'partner') {
    lines.push(num(a.payout) !== null ? t('reviewPartnerPayout', { price: money(n(a.payout)) }) : t('reviewPartner'))
  }
  lines.push(
    a.includedActivityIds.length
      ? t('reviewIncludes', { classes: names(a.includedActivityIds, ctx.classes.map((c) => ({ id: c.id, name: c.name }))) })
      : t('reviewIncludesNone')
  )
  lines.push(a.sell === 'online' ? t('reviewPublic') : t('reviewPrivate'))
  return lines
}
