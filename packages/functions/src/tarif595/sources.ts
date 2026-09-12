// Tarif 595 — the studio's OWN records a receipt attests: a subscription
// period (contacts/{id}/subscription_history/{historyId}), the days a member
// attended a class (the participants rows, resolved to their sessions), or a
// course purchase (courses/{id}/purchases/{contactId}). Read-only; every
// function here returns plain values with wall dates (YYYY-MM-DD in
// Europe/Zurich, the zone the studio's calendar lives in).
//
// The attendance scan is the same query shape as booking/myAttendance.ts —
// `participants` collection-group on `contactId` + `checkedInAt` (camelCase;
// the `Participant` interface still says `checked_in_at` and is stale, see
// `buildParticipantDoc` in shared/types/session.ts) — with the sessions fetched
// by id afterwards and filtered on their START, because `checkedInAt` is when
// the coach ticked the box, not when the class was. That file's own test pins
// its query in place, which is why the shape is repeated here rather than
// lifted out of it.

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import {
  CONTACTS_COLLECTION,
  CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION,
  COURSES_COLLECTION,
  COURSE_PURCHASES_SUBCOLLECTION,
  PARTICIPANTS_SUBCOLLECTION,
  SESSIONS_COLLECTION,
  type SubscriptionHistoryEntry,
  type Tarif595Unit,
} from '@linyup/shared'
import { ATTENDANCE_SCAN_MARGIN_DAYS, MY_ATTENDANCE_SCAN_PAGE } from '../booking/myAttendance'

export const TARIF595_TIMEZONE = 'Europe/Zurich'
const DAY_MS = 86_400_000

const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TARIF595_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** A Timestamp (or anything with toMillis) → `YYYY-MM-DD` in Zurich; null when absent. */
export function zurichDay(v: unknown): string | null {
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return DAY_FMT.format(new Date((v as { toMillis(): number }).toMillis()))
  }
  if (v instanceof Date) return DAY_FMT.format(v)
  return null
}

/** Midnight Zurich of a `YYYY-MM-DD`, as epoch ms — bounds for range queries.
 *  Computed from the formatter rather than a fixed offset so DST is right. */
export function zurichDayStartMs(dayIso: string): number {
  const guess = Date.parse(`${dayIso}T00:00:00Z`)
  // Walk the candidate back until the Zurich day of (guess − x) is the previous day.
  for (const offsetH of [-1, -2, 0, 1]) {
    const ms = guess - offsetH * 3_600_000
    if (DAY_FMT.format(new Date(ms)) === dayIso && DAY_FMT.format(new Date(ms - 1)) !== dayIso) return ms
  }
  return guess - 3_600_000
}

// ─── Subscription period ──────────────────────────────────────────────────────

export interface SubscriptionPeriodSource {
  historyId: string
  subscriptionTypeId: string | null
  name: string | null
  recurrence: string | null
  /** Major units (CHF), per recurrence period — the snapshot the row carries. */
  amountMajor: number | null
  start: string | null
  /** null = still open. */
  end: string | null
}

export async function loadSubscriptionPeriod(contactId: string, historyId: string): Promise<SubscriptionPeriodSource | null> {
  const snap = await admin
    .firestore()
    .collection(CONTACTS_COLLECTION)
    .doc(contactId)
    .collection(CONTACT_SUBSCRIPTION_HISTORY_SUBCOLLECTION)
    .doc(historyId)
    .get()
  if (!snap.exists) return null
  const d = snap.data() as SubscriptionHistoryEntry
  return {
    historyId,
    subscriptionTypeId: d.subscription_type_id ?? null,
    name: d.subscription_type_name ?? null,
    recurrence: d.recurrence ?? null,
    amountMajor: typeof d.amount === 'number' ? d.amount : null,
    start: zurichDay(d.start_date),
    end: zurichDay(d.end_date),
  }
}

/**
 * The price of ONE unit from a recurrence's period price, in minor units.
 * `month` from an annual price is a twelfth; `year` from a monthly price is
 * twelve times; `flat`/`entry`/`lesson` take the period price as-is (a pass or
 * a package is one charge). Unknown recurrence → the price as-is.
 */
export function unitPriceMinorFor(unit: Tarif595Unit, recurrence: string | null, amountMajor: number | null): number {
  if (amountMajor === null || !(amountMajor > 0)) return 0
  const minor = Math.round(amountMajor * 100)
  const perMonth: Record<string, number> = { monthly: 1, quarterly: 1 / 3, annual: 1 / 12, weekly: 52 / 12, biweekly: 26 / 12 }
  const factor = recurrence ? perMonth[recurrence] : undefined
  if (unit === 'month') return factor === undefined ? minor : Math.round(minor * factor)
  if (unit === 'year') return factor === undefined ? minor : Math.round(minor * factor * 12)
  return minor
}

// ─── Attendance ───────────────────────────────────────────────────────────────

export interface AttendanceScan {
  /** Distinct `YYYY-MM-DD` days with a session of the activity the contact was checked into. */
  days: string[]
  truncated: boolean
}

export async function listAttendedDays(params: {
  teamId: string
  contactId: string
  activityId: string
  fromIso: string
  toIso: string
}): Promise<AttendanceScan> {
  const db = admin.firestore()
  const fromMs = zurichDayStartMs(params.fromIso)
  const toMs = zurichDayStartMs(params.toIso) + DAY_MS - 1
  const margin = ATTENDANCE_SCAN_MARGIN_DAYS * DAY_MS
  const snap = await db
    .collectionGroup(PARTICIPANTS_SUBCOLLECTION)
    .where('contactId', '==', params.contactId)
    .where('checkedInAt', '>=', Timestamp.fromMillis(fromMs - margin))
    .where('checkedInAt', '<=', Timestamp.fromMillis(toMs + margin))
    .orderBy('checkedInAt', 'desc')
    .limit(MY_ATTENDANCE_SCAN_PAGE)
    .get()

  const sessionIds = [...new Set(snap.docs.map((d) => d.ref.parent.parent?.id).filter((id): id is string => !!id))]
  const CHUNK = 300
  const days = new Set<string>()
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const refs = sessionIds.slice(i, i + CHUNK).map((id) => db.collection(SESSIONS_COLLECTION).doc(id))
    for (const s of await db.getAll(...refs)) {
      if (!s.exists) continue
      const session = s.data()!
      if (session.teamId !== params.teamId) continue
      if ((session.activityId as string | undefined) !== params.activityId) continue
      const day = zurichDay(session.start)
      if (day && day >= params.fromIso && day <= params.toIso) days.add(day)
    }
  }
  return { days: [...days].sort(), truncated: snap.size === MY_ATTENDANCE_SCAN_PAGE }
}

// ─── Course purchase ──────────────────────────────────────────────────────────

export interface CoursePurchaseSource {
  courseId: string
  title: string | null
  /** Minor units (the purchase row stores Rappen). */
  amountMinor: number | null
  purchasedOn: string | null
}

export async function loadCoursePurchase(courseId: string, contactId: string): Promise<CoursePurchaseSource | null> {
  const db = admin.firestore()
  const [purchase, course] = await Promise.all([
    db.collection(COURSES_COLLECTION).doc(courseId).collection(COURSE_PURCHASES_SUBCOLLECTION).doc(contactId).get(),
    db.collection(COURSES_COLLECTION).doc(courseId).get(),
  ])
  if (!purchase.exists) return null
  const p = purchase.data() ?? {}
  const c = course.exists ? course.data() ?? {} : {}
  return {
    courseId,
    title: (c.title as string | undefined) ?? (c.name as string | undefined) ?? null,
    amountMinor: typeof p.amount === 'number' ? Math.round(p.amount) : null,
    purchasedOn: zurichDay(p.purchasedAt),
  }
}
