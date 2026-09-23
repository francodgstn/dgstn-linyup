/* eslint-disable no-console */
// ─── The rolling horizon for recurring sessions ───────────────────────────────
//
// A series is materialised six months ahead ONCE, at creation, by the
// `generateRecurringSessions` callable. Nothing extended it. So a studio that
// set "every Tuesday, ends never" had an empty calendar in month seven — taking
// every public booking link with it — and nothing in the product could have
// warned them. This task is the thing that extends it.
//
// It rolls every ACTIVE series forward to a rolling `SERIES_HORIZON_MONTHS`
// horizon, and it is deliberately lazy: a series is touched only once its
// coverage falls inside `SERIES_REFRESH_MONTHS`, so the steady-state run is one
// document read per series and no writes at all.
//
// IDEMPOTENCY comes from `materializeOccurrences`, which owns the one dedupe
// rule (`seriesId` + `instanceDate`). This file adds no second rule and no
// second write path: running it twice in a day creates nothing the second time,
// and a crash halfway through leaves a partially-rolled series that the next run
// simply finishes.
//
// Ported from hmd-lineup/functions/src/dailyTasks/tasks/generateRecurringSessions.js
// (v1 → v2, plus the end-condition correction described on `planSeriesRoll`).
import * as admin from 'firebase-admin'
import { addMonths } from 'date-fns'
import { Timestamp, type Firestore } from 'firebase-admin/firestore'
import { calculateOccurrences, validateRecurrence } from '../utils/recurrence'
import type { RecurrencePattern, Timestamp as SharedTimestamp } from '@linyup/shared'
import {
  SESSION_SERIES_COLLECTION,
  SERIES_HORIZON_MONTHS,
  SERIES_REFRESH_MONTHS,
  materializeOccurrences,
  seriesHorizonUpdate,
  type Occurrence,
} from '../sessions/series'

/** Sessions created per run, across all tenants. A first run after deploy
 *  back-fills six months for every series that ever existed; this bounds that
 *  into visible, resumable chunks. Each series advances its own
 *  `lastGeneratedUntil` as it completes, and the scan order is stable, so a run
 *  that stops early is finished by the following one rather than starving the
 *  series it never reached. */
export const MAX_SESSIONS_PER_RUN = 2000
/** Sessions created for ONE series per run — a runaway recurrence (interval 1,
 *  frequency daily, six-month horizon ≈ 183) cannot consume the whole budget. */
export const MAX_SESSIONS_PER_SERIES = 250

export type SeriesRollReason = 'inactive' | 'invalid' | 'covered' | 'extend' | 'fixed'

export interface SeriesRollPlan {
  roll: boolean
  reason: SeriesRollReason
  /** Where the occurrence CALCULATION starts (see the count-series note). */
  calcFromMs: number
  /** Occurrences before this instant are discarded — they are already
   *  materialised, or in the past. */
  keepFromMs: number
  /** The horizon: where materialisation stops. */
  toMs: number
}

/**
 * Should this series be rolled, and over what window? Pure — the whole
 * end-condition decision lives here so it can be tested without Firestore.
 *
 * - Only `status === 'active'` rolls. Paused, ended and soft-deleted series are
 *   left exactly as they are (matching hmd-lineup's original query).
 * - A COURSE'S SERIES NEVER ROLLS. Its meetings are a list, materialised in full
 *   at creation, so there is nothing to extend — and extending one would invent
 *   lessons nobody bought. The query's `status == 'active'` filter already keeps
 *   it out (a course series is `fixed`), which is what makes this free; the
 *   check below is the structural half, so the guarantee survives somebody
 *   flipping a status back by hand.
 * - A series whose coverage already reaches past `refreshBeforeMs` is skipped.
 * - THE COUNT CORRECTION: `calculateOccurrences` counts occurrences *within the
 *   window it is given*, so asking it for "the next six months" of an
 *   `endCondition: 'count'` series would restart the count and quietly generate
 *   more sessions than the studio asked for. For those series the calculation
 *   therefore starts at the recurrence's own `startDate` — the count is global,
 *   by definition — and everything before `keepFromMs` is discarded afterwards.
 *   Every other end condition calculates from the cheap cursor.
 */
export function planSeriesRoll(input: {
  status?: string | null
  endCondition?: string | null
  recurrenceStartMs: number
  lastGeneratedUntilMs: number | null
  nowMs: number
  horizonMs: number
  refreshBeforeMs: number
  recurrenceValid?: boolean
  /** True for a series whose occurrences are a fixed list — a course's. */
  fixedOccurrences?: boolean
}): SeriesRollPlan {
  const keepFromMs = Math.max(input.lastGeneratedUntilMs ?? input.nowMs, input.nowMs)
  const calcFromMs = input.endCondition === 'count' ? input.recurrenceStartMs : keepFromMs
  const base = { calcFromMs, keepFromMs, toMs: input.horizonMs }

  if (input.fixedOccurrences) return { roll: false, reason: 'fixed', ...base }
  if (input.status !== 'active') return { roll: false, reason: 'inactive', ...base }
  if (input.recurrenceValid === false) return { roll: false, reason: 'invalid', ...base }
  if (input.lastGeneratedUntilMs !== null && input.lastGeneratedUntilMs >= input.refreshBeforeMs) {
    return { roll: false, reason: 'covered', ...base }
  }
  return { roll: true, reason: 'extend', ...base }
}

export interface RollSessionSeriesResult {
  series: number
  rolled: number
  created: number
  skipped: number
  invalid: number
  errors: number
  /** True when the run exhausted its per-run session budget and stopped early.
   *  A partial run is a logged fact, never a silent one. */
  truncated: boolean
  remaining: number
}

export interface RollLimits {
  perRun: number
  perSeries: number
}

export async function rollSessionSeries(
  db: Firestore = admin.firestore(),
  now: Date = new Date(),
  limits: RollLimits = { perRun: MAX_SESSIONS_PER_RUN, perSeries: MAX_SESSIONS_PER_SERIES }
): Promise<RollSessionSeriesResult> {
  const horizon = addMonths(now, SERIES_HORIZON_MONTHS)
  const refreshBefore = addMonths(now, SERIES_REFRESH_MONTHS)

  const snap = await db
    .collection(SESSION_SERIES_COLLECTION)
    .where('status', '==', 'active')
    .get()

  const result: RollSessionSeriesResult = {
    series: snap.size,
    rolled: 0,
    created: 0,
    skipped: 0,
    invalid: 0,
    errors: 0,
    truncated: false,
    remaining: 0,
  }

  for (const doc of snap.docs) {
    if (result.created >= limits.perRun) {
      result.truncated = true
      result.remaining += 1
      continue
    }

    const data = doc.data()
    try {
      const recurrence = data.recurrence as
        | (RecurrencePattern & { startDate: SharedTimestamp; endDate?: SharedTimestamp })
        | undefined
      const validation = recurrence
        ? validateRecurrence(recurrence)
        : { valid: false, errors: ['Missing recurrence'] }

      const plan = planSeriesRoll({
        status: data.status as string | undefined,
        endCondition: recurrence?.endCondition,
        recurrenceStartMs: recurrence?.startDate?.toMillis?.() ?? now.getTime(),
        lastGeneratedUntilMs: (data.lastGeneratedUntil as Timestamp | undefined)?.toMillis() ?? null,
        nowMs: now.getTime(),
        horizonMs: horizon.getTime(),
        refreshBeforeMs: refreshBefore.getTime(),
        recurrenceValid: validation.valid,
        fixedOccurrences: !!data.course_block_id,
      })

      if (!plan.roll) {
        if (plan.reason === 'invalid') {
          result.invalid += 1
          console.warn(
            `[series] ${doc.id} skipped — invalid recurrence: ${validation.errors.join(', ')}`
          )
        } else {
          result.skipped += 1
        }
        continue
      }

      const due: Occurrence[] = calculateOccurrences(
        recurrence!,
        new Date(plan.calcFromMs),
        new Date(plan.toMs)
      ).filter((o) => o.start.getTime() >= plan.keepFromMs)
      const occurrences = due.slice(0, limits.perSeries)

      const created = await materializeOccurrences(db, doc.id, data, occurrences)
      result.created += created
      result.rolled += 1

      // The horizon is written AFTER the sessions exist, and only to the instant
      // they were actually generated to. A series with nothing left to generate
      // (its end date falls inside the horizon) still records the horizon: we
      // did materialise everything up to it — there was simply nothing there.
      // A series that hit its per-run cap records the last occurrence it
      // actually wrote, so the next run resumes rather than believing a horizon
      // it never reached.
      const capped = occurrences.length < due.length
      const generatedUntil =
        capped && occurrences.length > 0 ? occurrences[occurrences.length - 1].start : horizon
      if (capped) {
        console.warn(
          `[series] ${doc.id} capped at ${limits.perSeries} sessions — horizon held at ${generatedUntil.toISOString()}`
        )
      }
      await doc.ref.update(seriesHorizonUpdate(generatedUntil, created))

      if (created > 0) {
        console.log(`[series] ${doc.id}: +${created} sessions to ${horizon.toISOString()}`)
      }
    } catch (err) {
      // One broken series must not take the rest of the platform's timetable
      // down with it; tomorrow's run retries it from storage.
      result.errors += 1
      console.error(`[series] rolling ${doc.id} failed:`, err)
    }
  }

  if (result.truncated) {
    console.warn(
      `[series] run capped at ${limits.perRun} sessions — ${result.remaining} series left for the next run`
    )
  }
  console.log('[series] rollSessionSeries:', result)
  return result
}
