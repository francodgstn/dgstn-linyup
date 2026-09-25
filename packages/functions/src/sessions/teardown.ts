// ─── Series teardown — the ONE path that calls a session off ──────────────────
//
// Everything that cancels or deletes a session on the studio's behalf goes
// through `cancelSingleSession` here: the `cancelSession` callable (inline, for
// a small scope) and `runSeriesTeardownBatch` (the Cloud Task worker, for a
// large one). They share this module precisely so "delete three classes" and
// "delete two hundred" cannot drift into two different definitions of what
// canceling a class means.
//
// The concurrency contract — why a job may run while the calendar is live — is
// written down ONCE, on `SeriesTeardownJob` in
// packages/shared/src/types/sessionSeriesJob.ts. Read it there. The two halves
// it names that live in THIS file:
//
//   • the drain query (`teardownScopeQuery`) is a LIVE query, which is what
//     makes a session deleted by somebody else mid-run a no-op rather than an
//     error — it simply stops being returned;
//   • `claimSessionForTeardown` is the transaction that stops two workers
//     mailing one roster twice, and the only reason a claim carries a timestamp
//     is so a worker that died cannot wedge a session forever.

import * as admin from 'firebase-admin'
import { Timestamp, FieldValue, type Firestore } from 'firebase-admin/firestore'
import {
  SESSIONS_COLLECTION,
  SESSION_SERIES_COLLECTION,
  SESSION_SERIES_JOBS_COLLECTION,
  SERIES_TEARDOWN_BATCH,
  SERIES_TEARDOWN_CLAIM_TTL_MS,
  SERIES_TEARDOWN_MAX_FAILURES,
  SERIES_TEARDOWN_MAX_ROUNDS,
  bookingWasPaidFor,
  localizedPublicUrl,
  type SeatHold,
  type SeriesTeardownStatus,
} from '@linyup/shared'
import { to } from '../utils/async'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { ctaButton } from '../utils/emailLayout'
import { systemEmailEnabledFor } from '../utils/systemEmails'
import { getHostingUrl } from '../utils/env'
import { closeSessionWaitlist } from '../booking/waitlist/teardown'
import {
  DISPOSED_BOOKING_STATUSES,
  replacedBookingWasCounted,
  type ReplacedBookingShape,
} from '../booking'

const TEAMS_COLLECTION = 'teams'
const ACTIVITIES_COLLECTION = 'activities'

/**
 * The queue is created by Firebase with the same name as the handler, in the
 * handler's region. `taskQueue('name')` with a bare name defaults to
 * us-central1 — a queue that does not exist — so the fully-qualified partial
 * resource name is mandatory. Same rule, same reason, as DELAYED_RULE_FUNCTION
 * in utils/automationEngine.ts.
 */
const TEARDOWN_FUNCTION = 'locations/europe-west6/functions/runSeriesTeardown'

export interface SeriesTeardownPayload {
  jobId: string
  round: number
}

export interface TeamData {
  name: string
  language: string
  slug: string | null
  ctaUrl: string | null
}

export async function getTeamData(db: Firestore, teamId: string): Promise<TeamData> {
  const [teamErr, teamDoc] = await to(db.collection(TEAMS_COLLECTION).doc(teamId).get())
  if (!teamErr && teamDoc && teamDoc.exists) {
    const team = teamDoc.data()!
    return {
      name: (team.name as string) || 'Our Team',
      language: (team.language as string) || 'en',
      slug: (team.slug as string) || null,
      ctaUrl: (team.settings?.trialBookingCtaUrl as string) || null,
    }
  }
  return { name: 'Our Team', language: 'en', slug: null, ctaUrl: null }
}

export function buildCancellationEmail(params: {
  firstname: string
  teamName: string
  activityName: string
  sessionStart: Date
  sessionEnd: Date
  rebookUrl: string | null
}): { subject: string; html: string; text: string } {
  const dateStr = params.sessionStart.toLocaleDateString('en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const timeStr = `${params.sessionStart.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })} – ${params.sessionEnd.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`
  const rebookLine = params.rebookUrl
    ? `<p style="text-align:center;margin-top:24px;">${ctaButton(params.rebookUrl, 'Book another session')}</p>`
    : ''
  const subject = `Session Canceled – ${params.activityName}`
  const { html } = buildEmailTemplate({
    title: 'Session canceled',
    body: `<p>Hi ${params.firstname},</p><p>Your session <strong>${params.activityName}</strong> on ${dateStr} at ${timeStr} has been canceled by ${params.teamName}.</p><p>We apologize for the inconvenience.</p>${rebookLine}`,
  })
  const text = `Hi ${params.firstname},\n\nYour session ${params.activityName} on ${dateStr} at ${timeStr} has been canceled by ${params.teamName}.\n${params.rebookUrl ? `Book another session: ${params.rebookUrl}\n` : ''}We apologize for the inconvenience.`
  return { subject, html, text }
}

export async function cancelSingleSession(
  db: Firestore,
  sessionId: string,
  sessionRef: admin.firestore.DocumentReference,
  sessionData: admin.firestore.DocumentData,
  teamData: TeamData,
  markAsException: boolean,
  /**
   * The caller already wrote `allowBooking: false` (the teardown claim does it
   * transactionally). Skips the redundant marker write — the ORDERING it exists
   * to guarantee has already happened, earlier and more strongly.
   */
  preMarked = false,
  /**
   * Whether this session mails its own roster. TRUE for every caller but one.
   *
   * It suppresses the MESSAGE and nothing else: the waitlist still closes, every
   * `pending_bookings_count` still moves, the bookings and the session are still
   * deleted. Those are facts about the booking; the mail is news about it, and
   * only the news is ever somebody else's to deliver.
   *
   * The one caller that says false is a whole-course cancellation, which sends
   * one mail for the course instead of one per lesson. See
   * `SeriesTeardownJob.notify`, which owns the reasoning.
   */
  notify = true
): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0

  // THE SESSION IS MARKED CALLED-OFF FIRST, before anything touches the queue.
  // Closing the queue releases claim holds, and every release writes
  // `bookings_count` — which is precisely the `seatFreedEdge` that
  // `promoteWaitlistOnSeatFreed` watches. With the marker not yet written the
  // promoter re-reads a session that still looks bookable and cheerfully mails
  // "A place has opened up" for a class being called off as it does so; a join
  // landing mid-teardown survives it for the same reason. `joinWaitlist` and the
  // promoter both refuse on `isSessionCancelled` / `allowBooking`, so the marker
  // is all the ordering constraint they need.
  if (markAsException) {
    // The exception pair IS the cancellation record for an occurrence of a
    // series (status and allowBooking are deliberately left alone — see
    // isSessionCancelled). Unguarded on purpose: if this write fails the class
    // is NOT canceled, and mailing everyone that it was would be the worse
    // outcome.
    await sessionRef.update({
      isException: true,
      exceptionType: 'cancelled',
      cancelled_at: FieldValue.serverTimestamp(),
    })
  } else if (!preMarked) {
    // The delete branch has no marker to write — the document is going away at
    // the end of this function — so it borrows the one every waitlist path
    // already tests. Best-effort: the session is about to be deleted, and a
    // cancellation must complete even if this does not.
    const [markErr] = await to(sessionRef.update({ allowBooking: false }))
    if (markErr) {
      console.error(`cancelSingleSession: could not close bookings on ${sessionId}:`, markErr) // eslint-disable-line no-console
    }
  }

  // BEFORE the bookings are read, because closing the queue deletes the claim
  // holds it owns: a hold is an ordinary `pending` booking, so a teardown that
  // ran afterwards would decrement `pending_bookings_count` twice for the same
  // person (once here, once inside the release). That constraint is about the
  // BOOKINGS READ below, not about the marker above — the two orderings are
  // independent and both hold. The people whose offer was withdrawn come back as
  // `offerHolders` and are mailed alongside the real bookings below — they are
  // the ones who believed they had a seat.
  const offerHolders = await closeSessionWaitlist(sessionRef)

  const [bookingsErr, bookingsSnap] = await to(sessionRef.collection('bookings').get())
  const bookings = bookingsErr ? [] : (bookingsSnap?.docs ?? [])

  // ── THE COUNTER IS A FACT ABOUT THE BOOKING; THE MAIL IS A MESSAGE ABOUT IT ──
  // `pending_bookings_count` used to be decremented INSIDE the notification loop
  // below, so a studio that switched `session_cancellation` off canceled classes
  // without anybody's counter moving — and the contacts list went on saying those
  // people needed chasing for a session that no longer exists. (UX-76 then made
  // paid bookings notify regardless, which left free and paid decrementing
  // differently: an improvement and an inconsistency.) It is settled here, once
  // per booking, before a single mail is built: no toggle, no delivery outcome
  // and no missing email address can reach it.
  //
  // WHICH documents own a count — decided by the ledger's existing seams, never a
  // fresh expression of the question (booking/index.ts, shape table in
  // docs/waitlist.md, fixtures in booking/pendingBookingsCount.test.ts):
  //  • a DISPOSED booking (canceled / no_show / rebooked) owns none — whoever
  //    disposed of it already gave the count back, and these documents are still
  //    sitting in the subcollection this read just returned.
  //  • a PLAIN drop-in payment hold (`payment_status: 'required'` without
  //    `waitlist_claim`) is uncounted for its whole life — `replacedBookingWasCounted`
  //    is the one predicate that knows that, and decrementing it here drove a real
  //    person's counter negative, which is the failure somebody notices.
  // A CLAIM hold that was still unclaimed never reaches this read at all:
  // `closeSessionWaitlist` above deleted it and gave its count back, which is
  // exactly why that call has to come first.
  //
  // `increment(-1)`, deliberately, and against the standing preference for an
  // absolute value: this counter is per CONTACT and spans every session they hold
  // a seat in, so this function's read set (one session's bookings) cannot
  // produce the true total, and nothing recounts it. Every writer of the field
  // moves it the same way — see the ledger note in booking/index.ts, which owns
  // that rule (`bookings_count`, which IS recountable, is the one that must be
  // written absolute, and this function does not touch it). Best-effort per
  // contact rather than batched: a purged provisional contact makes `update`
  // throw, and one missing document must not stop the rest of the roster moving.
  for (const bookingDoc of bookings) {
    const booking = bookingDoc.data()
    if (!booking.contact) continue
    if (booking.status && DISPOSED_BOOKING_STATUSES.has(booking.status as string)) continue
    if (!replacedBookingWasCounted(booking as ReplacedBookingShape)) continue
    const [countErr] = await to(
      db
        .collection('contacts')
        .doc(booking.contact as string)
        .update({ pending_bookings_count: FieldValue.increment(-1) })
    )
    if (countErr) {
      console.error( // eslint-disable-line no-console
        `cancelSingleSession: pending_bookings_count decrement failed for contact ${booking.contact}:`,
        countErr
      )
    }
  }

  // THE SUPPRESSION SITS HERE, below every counter write and above every mail,
  // which is the line it is allowed to cross. Emptying the list rather than
  // skipping past the block also takes the PAID exception with it: a course's
  // buyers are precisely the paid seats, and they are the people the course's
  // own single mail is addressed to.
  let bookingsToNotify = notify ? bookings : []

  // Member cancellation notices are per-team toggleable (Automations → System
  // emails) — EXCEPT for someone who paid.
  //
  // Same test as the paid booking's receipt (booking/paidConfirmation.ts) and as
  // the waitlist offer (booking/waitlist/notify.ts): does switching it off
  // quieten the feature, or break it? For a FREE booking it quietens a courtesy
  // — the person loses nothing but news. For a PAID one it breaks it: they have
  // been charged for a class the studio has just called off, and silence means
  // they travel to a locked door and only then start asking for their money
  // back. So a paid seat is notified whatever the toggle says, and the toggle
  // keeps its meaning for everybody else.
  const cancellationTeamId = (sessionData.teamId || sessionData.teacher) as string | undefined
  const cancellationEmailsEnabled =
    notify && (bookingsToNotify.length > 0 || offerHolders.length > 0)
      ? !!cancellationTeamId &&
        (await systemEmailEnabledFor(cancellationTeamId, 'session_cancellation'))
      : false
  if (bookingsToNotify.length > 0 && !cancellationEmailsEnabled) {
    const paidOnly = bookingsToNotify.filter((d) => bookingWasPaidFor(d.data() as SeatHold))
    console.log( // eslint-disable-line no-console
      `cancelSingleSession: cancellation emails disabled for team ${cancellationTeamId} — ` +
        `notifying ${paidOnly.length} of ${bookingsToNotify.length} booking(s) anyway (they paid)`
    )
    bookingsToNotify = paidOnly
  }

  if (bookingsToNotify.length > 0 || (offerHolders.length > 0 && cancellationEmailsEnabled)) {
    let activityName = 'Session'
    if (sessionData.activityId) {
      const [actErr, actDoc] = await to(
        db
          .collection(ACTIVITIES_COLLECTION)
          .doc(sessionData.activityId as string)
          .get()
      )
      if (!actErr && actDoc && actDoc.exists)
        activityName = (actDoc.data()?.name as string) || 'Session'
    }

    // Locale-pinned on the team's language: the cancellation mail below is
    // written in it, so the booking page this opens must answer in it too.
    const rebookUrl =
      teamData.slug && sessionData.activityId
        ? localizedPublicUrl(getHostingUrl(), teamData.language, teamData.slug, 'booking', {
            activity: sessionData.activityId,
          })
        : null

    for (const bookingDoc of bookingsToNotify) {
      const booking = bookingDoc.data()
      if (!booking.email) continue
      try {
        const email = buildCancellationEmail({
          firstname: (booking.firstname as string) || 'Guest',
          teamName: teamData.name,
          activityName,
          sessionStart: (sessionData.start as Timestamp).toDate(),
          sessionEnd: (sessionData.end as Timestamp).toDate(),
          rebookUrl,
        })
        await sendEmail({
          to: booking.email as string,
          teamId: (sessionData.teamId || sessionData.teacher) as string,
          subject: email.subject,
          html: email.html,
          text: email.text,
        })
        // No counter write here — it was settled above, for every booking this
        // cancellation resolves, whether or not this mail goes out or lands.
        sent++
      } catch (err) {
        console.error(`Error sending cancellation to ${booking.email}:`, err) // eslint-disable-line no-console
        failed++
      }
    }

    // The withdrawn offers. Same class, same story — but their seat was a hold
    // this function already gave back, so the loop above cannot reach them, and
    // being told nothing is the one outcome they would notice: a claim link that
    // silently stops working reads as a bug. No counter to move here; the
    // release decremented it when it deleted the hold.
    if (cancellationEmailsEnabled) {
      for (const holder of offerHolders) {
        if (!holder.email) continue
        try {
          const email = buildCancellationEmail({
            firstname: holder.firstname,
            teamName: teamData.name,
            activityName,
            sessionStart: (sessionData.start as Timestamp).toDate(),
            sessionEnd: (sessionData.end as Timestamp).toDate(),
            rebookUrl,
          })
          await sendEmail({
            to: holder.email,
            teamId: (sessionData.teamId || sessionData.teacher) as string,
            subject: email.subject,
            html: email.html,
            text: email.text,
          })
          sent++
        } catch (err) {
          console.error(`Error sending cancellation to waitlist offer ${holder.email}:`, err) // eslint-disable-line no-console
          failed++
        }
      }
    }
  }

  // The exception marker was written at the top of this function; only the
  // delete branch has work left.
  if (!markAsException) {
    // Delete bookings subcollection
    const [allBookErr, allBookSnap] = await to(sessionRef.collection('bookings').get())
    if (!allBookErr && allBookSnap && !allBookSnap.empty) {
      const bk = db.batch()
      allBookSnap.docs.forEach((d) => bk.delete(d.ref))
      await bk.commit()
    }
    // Delete participants subcollection
    const [partErr, partSnap] = await to(sessionRef.collection('participants').get())
    if (!partErr && partSnap && !partSnap.empty) {
      const bk = db.batch()
      partSnap.docs.forEach((d) => bk.delete(d.ref))
      await bk.commit()
    }
    // The queue's own documents are removed by the session-delete trigger
    // (`teardownWaitlistOnSessionDeleted`), which owns that job because a
    // standalone session is deleted client-side and never reaches this function.
    await sessionRef.delete()
  }

  return { sent, failed }
}

// ─── Scope ────────────────────────────────────────────────────────────────────

/**
 * "This occurrence and every later one." The SAME query shape the inline path
 * has always used, so it rides the existing composite index — the background
 * path only adds an ordering (already implied by the inequality) and a limit.
 *
 * Exceptions are excluded because an occurrence the studio already modified or
 * canceled by hand is no longer the series speaking for it.
 */
export function teardownScopeQuery(
  db: Firestore,
  seriesId: string,
  cutoff: Timestamp
): admin.firestore.Query {
  return db
    .collection(SESSIONS_COLLECTION)
    .where('seriesId', '==', seriesId)
    .where('start', '>=', cutoff)
    .where('isException', '==', false)
    .orderBy('start', 'asc')
}

/** Scope size, measured once at enqueue. An aggregate — not a document read per
 *  session, which on a large series would cost as much as the teardown. */
export async function countTeardownScope(
  db: Firestore,
  seriesId: string,
  cutoff: Timestamp
): Promise<number> {
  const snap = await teardownScopeQuery(db, seriesId, cutoff).count().get()
  return snap.data().count
}

// ─── The claim ────────────────────────────────────────────────────────────────

export type ClaimOutcome = 'claimed' | 'taken' | 'gone'

/**
 * Take exclusive ownership of one session's teardown.
 *
 * This is NOT what makes the job idempotent — deleting a session that is already
 * gone is a no-op all by itself. It is what stops two workers doing the one part
 * of a teardown that CANNOT be taken back: mailing a roster "your class is
 * canceled" twice.
 *
 * The claim carries `at` so it can expire. A worker that dies mid-session would
 * otherwise leave a document nothing may ever touch again — and a session that
 * can never be deleted stalls the whole drain, because the query keeps handing
 * it back. Past the TTL the claim is assumed abandoned and may be taken over:
 * the risk is one duplicate mail, the alternative is a job that never finishes.
 *
 * `allowBooking: false` rides along, so the ordering `cancelSingleSession`
 * depends on (seats closed before the waitlist is touched) is established here,
 * transactionally, rather than in a best-effort write afterwards.
 */
export async function claimSessionForTeardown(
  db: Firestore,
  sessionRef: admin.firestore.DocumentReference,
  jobId: string,
  nowMs: number
): Promise<{ outcome: ClaimOutcome; data?: admin.firestore.DocumentData }> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef)
    if (!snap.exists) return { outcome: 'gone' as const }

    const data = snap.data()!
    const claim = data.teardown_claim as { job?: string; at?: Timestamp } | undefined
    if (claim?.job && claim.job !== jobId) {
      const claimedAtMs = claim.at?.toMillis?.() ?? 0
      if (nowMs - claimedAtMs < SERIES_TEARDOWN_CLAIM_TTL_MS) {
        return { outcome: 'taken' as const }
      }
    }

    tx.update(sessionRef, {
      allowBooking: false,
      teardown_claim: { job: jobId, at: Timestamp.fromMillis(nowMs) },
    })
    return { outcome: 'claimed' as const, data }
  })
}

// ─── Freezing the series ──────────────────────────────────────────────────────

/**
 * The synchronous write that makes a background teardown safe, done in the
 * callable BEFORE the task is enqueued.
 *
 * `status: 'deleting'` is load-bearing and deliberately reuses a field the daily
 * roller already filters on (`where('status','==','active')`), so the generator
 * stops re-materializing occurrences behind the job with no change to
 * rollSessionSeries at all. `teardown_job_id` is the explicit half the editing
 * callables refuse on.
 */
export async function freezeSeriesForTeardown(
  db: Firestore,
  seriesId: string,
  jobId: string
): Promise<void> {
  await db.collection(SESSION_SERIES_COLLECTION).doc(seriesId).update({
    status: 'deleting',
    teardown_job_id: jobId,
    updatedAt: FieldValue.serverTimestamp(),
  })
}

/**
 * The series is over. "Delete this and all following" ENDS a series — leaving it
 * active was a real defect: `rollSessionSeries` resumes from
 * `lastGeneratedUntil`, so three months later the studio's deleted Tuesday class
 * quietly reappeared beyond the old horizon. `ended` is a status the roller
 * already skips.
 */
export async function endSeriesAfterTeardown(db: Firestore, seriesId: string): Promise<void> {
  const [err] = await to(
    db.collection(SESSION_SERIES_COLLECTION).doc(seriesId).update({
      status: 'ended',
      teardown_job_id: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    })
  )
  if (err) console.error(`[teardown] could not end series ${seriesId}:`, err) // eslint-disable-line no-console
}

// ─── The worker's unit of work ────────────────────────────────────────────────

export interface BatchResult {
  processed: number
  sent: number
  failed: number
  newFailedIds: string[]
  /** Nothing processable is left — the caller should finalize. */
  drained: boolean
}

/**
 * Tear down up to SERIES_TEARDOWN_BATCH sessions and report what happened. Does
 * not touch the job document — the worker owns that, so this stays testable
 * against a bare Firestore.
 *
 * `failedIds` are fetched but skipped: the drain query keeps returning a session
 * that was never deleted, so without this a single poisoned document would be
 * retried until the round cap.
 */
export async function runSeriesTeardownBatch(params: {
  db: Firestore
  jobId: string
  seriesId: string
  cutoff: Timestamp
  teamData: TeamData
  failedIds: string[]
  nowMs?: number
  /** Passed straight to each session's teardown; absent reads as true. See
   *  `SeriesTeardownJob.notify`. */
  notify?: boolean
  /**
   * Seam for tests ONLY — production always uses `cancelSingleSession`. The
   * policy this loop encodes (gone = progress, claimed-elsewhere = skip, throw =
   * quarantine) is the part worth pinning, and it is unreachable in a unit test
   * if every case has to drag a mail provider and a waitlist behind it.
   */
  teardownSession?: typeof cancelSingleSession
}): Promise<BatchResult> {
  const { db, jobId, seriesId, cutoff, teamData, failedIds } = params
  const teardown = params.teardownSession ?? cancelSingleSession
  const nowMs = params.nowMs ?? Date.now()
  const skip = new Set(failedIds)

  // Over-fetch by the number of known-bad documents so they cannot crowd real
  // work out of a batch.
  const snap = await teardownScopeQuery(db, seriesId, cutoff)
    .limit(SERIES_TEARDOWN_BATCH + skip.size)
    .get()

  const candidates = snap.docs.filter((d) => !skip.has(d.id)).slice(0, SERIES_TEARDOWN_BATCH)
  if (candidates.length === 0) {
    return { processed: 0, sent: 0, failed: 0, newFailedIds: [], drained: true }
  }

  const result: BatchResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    newFailedIds: [],
    drained: false,
  }

  for (const doc of candidates) {
    try {
      const claim = await claimSessionForTeardown(db, doc.ref, jobId, nowMs)
      // Already gone — somebody deleted it while we were draining. That IS the
      // outcome we wanted, so it counts as progress and never as an error.
      if (claim.outcome === 'gone') {
        result.processed++
        continue
      }
      // Another worker holds a live claim. Leave it alone; it will have gone by
      // the next round, and the drain query will simply stop returning it.
      if (claim.outcome === 'taken') continue

      const { sent, failed } = await teardown(
        db,
        doc.id,
        doc.ref,
        claim.data ?? doc.data(),
        teamData,
        false, // a series teardown always DELETES; the exception marker is the single-occurrence path
        true, // the claim already wrote allowBooking: false
        params.notify ?? true
      )
      result.processed++
      result.sent += sent
      result.failed += failed
    } catch (err) {
      console.error(`[teardown] session ${doc.id} failed:`, err) // eslint-disable-line no-console
      result.newFailedIds.push(doc.id)
    }
  }

  return result
}

// ─── Job lifecycle ────────────────────────────────────────────────────────────

export function jobRef(db: Firestore, jobId: string): admin.firestore.DocumentReference {
  return db.collection(SESSION_SERIES_JOBS_COLLECTION).doc(jobId)
}

/** Mint the progress document. The ONE writer of a job's initial shape, so the
 *  client polling it and the worker updating it agree on every field. */
export async function createTeardownJob(params: {
  db: Firestore
  teamId: string
  seriesId: string
  anchorSessionId: string
  cutoff: Timestamp
  total: number
  createdBy: string
  /** Whether each session mails its own roster. Absent reads as true; the
   *  whole-course cancellation is the one caller that sets it false. */
  notify?: boolean
}): Promise<string> {
  const ref = params.db.collection(SESSION_SERIES_JOBS_COLLECTION).doc()
  await ref.set({
    teamId: params.teamId,
    seriesId: params.seriesId,
    anchorSessionId: params.anchorSessionId,
    cutoff: params.cutoff,
    status: 'running' satisfies SeriesTeardownStatus,
    total: params.total,
    processed: 0,
    notified: 0,
    notify_failed: 0,
    failed_ids: [],
    rounds: 0,
    notify: params.notify ?? true,
    createdBy: params.createdBy,
    error: null,
    finished_at: null,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  return ref.id
}

/**
 * Enqueue one round.
 *
 * The task id is deterministic per (job, round), which is what stops a
 * redelivered round from starting a SECOND chain over the same sessions. Cloud
 * Tasks enforces that by REFUSING the duplicate — `functions/task-already-exists`
 * — rather than quietly dropping it, so the refusal has to be read as the
 * success it is: the round we wanted queued is already queued. Letting it
 * propagate would fail a worker that had in fact done its job, and Cloud Tasks
 * would retry a chain that is already moving.
 *
 * The id's PREFIX is the job id — a Firestore auto-id, so uniformly distributed.
 * That matters: Cloud Tasks degrades badly on sequential id prefixes, and a
 * round-first key like `r3-<job>` would be exactly that.
 */
export async function enqueueTeardownRound(jobId: string, round: number): Promise<void> {
  if (round > SERIES_TEARDOWN_MAX_ROUNDS) {
    throw new Error(`series teardown ${jobId} exceeded ${SERIES_TEARDOWN_MAX_ROUNDS} rounds`)
  }
  const { getFunctions } = await import('firebase-admin/functions')
  const queue = getFunctions().taskQueue<SeriesTeardownPayload>(TEARDOWN_FUNCTION)
  try {
    await queue.enqueue({ jobId, round }, { id: `${jobId}-r${round}` })
  } catch (err) {
    if ((err as { code?: string })?.code === 'functions/task-already-exists') {
      console.log(`[teardown] round ${round} of ${jobId} was already queued`) // eslint-disable-line no-console
      return
    }
    throw err
  }
}

export async function finalizeTeardownJob(
  db: Firestore,
  jobId: string,
  seriesId: string,
  status: SeriesTeardownStatus,
  error?: string
): Promise<void> {
  await jobRef(db, jobId).update({
    status,
    error: error ?? null,
    finished_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  })
  // A run that stopped early leaves the series FROZEN on purpose: `deleting`
  // keeps the roller off a series whose future is half-removed, which is the
  // safe direction. Only a drained scope ends it.
  if (status !== 'failed') await endSeriesAfterTeardown(db, seriesId)
  console.log(`[teardown] job ${jobId} → ${status}${error ? `: ${error}` : ''}`) // eslint-disable-line no-console
}

export { SERIES_TEARDOWN_MAX_FAILURES, SERIES_TEARDOWN_MAX_ROUNDS }
