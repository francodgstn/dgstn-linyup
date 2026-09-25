/* eslint-disable no-console */
// The public half of a person's own place in a queue: reading it, and giving it
// back.
//
// Both are token-authenticated, and WHICH token decides what the holder may do.
// `entry_token` is long-lived and travels in the join-confirmation mail, which
// gets forwarded — so it opens the status view and the "leave" action, and
// nothing else. `offer_token` is minted per offer, single-use, and dies the
// moment the offer resolves in any direction — it is the claim credential.
// Forwarding a "you're on the list" mail must never hand someone else the seat.

import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  SESSIONS_COLLECTION,
  TEAMS_COLLECTION,
  WAITLIST_SUBCOLLECTION,
  type WaitlistStatus,
} from '@linyup/shared'
import { assertUnderCheckoutRateLimit, checkoutRateLimit } from '../../connect/checkout'
import { requireContactSessionForTeam } from '../../utils/contactSession'
import {
  WAITLIST_CLAIM_RATE_LIMIT_BUCKET,
  WAITLIST_QUEUE_SCAN_LIMIT,
  isSessionCancelled,
} from './constants'
import { offerWaitlistSeatsAndNotify } from './promote'
import { releaseWaitlistOffer } from './release'

/** Live entries only — the ones a person can still act on. A closed-out entry is
 *  history, and history on a class that already ran is not "my waitlist". */
const LIVE_STATUSES: readonly WaitlistStatus[] = ['waiting', 'offered']

/** Ceiling on how many of a contact's own entries one call resolves. Each one
 *  costs a session read (and a queue scan when it is still waiting), and nobody
 *  is meaningfully queueing for more classes than this. */
const MY_WAITLIST_LIMIT = 25

/** One live place in a queue, as a member surface renders it. */
interface MyWaitlistEntry {
  sessionId: string
  status: WaitlistStatus
  position: number | null
  entryToken: string | null
  offerExpiresAt: string | null
  session: {
    start: string | null
    end: string | null
    location: string | null
    activityName: string | null
    cancelled: boolean
  }
}

/**
 * Resolve a waitlist link to the one page that renders both of its modes.
 *
 * A callable rather than a client read, and it has to be: `firestore.rules`
 * gives the queue to team members and to a contact reading their OWN entry via
 * a contact session. A guest who joined from the public form has no session at
 * all — the token in their mail is their entire identity here.
 *
 * The offer token is tried FIRST. Both may be live at once (an offer does not
 * retire the entry token), and the claim view is the one with a deadline on it.
 */
export const getWaitlistEntry = onCall(async (request) => {
  const data = request.data as { token?: string }
  const token = typeof data?.token === 'string' ? data.token.trim() : ''
  if (!token) throw new HttpsError('invalid-argument', 'token is required')

  // Peeked, not charged, and on the claim bucket rather than the join one: this
  // callable is how the claim page RENDERS, so throttling it on the quota the
  // queue's joiners spend would make an offered seat unreachable from the same
  // NAT they queued from. Only a token that resolves to nothing costs quota
  // (below) — the peek is what bounds an enumerator before any query runs.
  await assertUnderCheckoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)

  const db = admin.firestore()
  const group = db.collectionGroup(WAITLIST_SUBCOLLECTION)
  const byOffer = await group.where('offer_token', '==', token).limit(1).get()
  const snap = byOffer.empty
    ? await group.where('entry_token', '==', token).limit(1).get()
    : byOffer
  if (snap.empty) {
    await checkoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)
    // Indistinguishable by construction: the offer token is DELETED when the
    // offer resolves, so "expired" and "already claimed" look identical from
    // here — and must, or the credential would outlive its own offer. The page
    // says so, and the long-lived entry link is where the person finds out
    // which it was.
    throw new HttpsError('not-found', 'This waitlist link is no longer valid')
  }

  const doc = snap.docs[0]
  const entry = doc.data()
  const mode: 'claim' | 'status' = byOffer.empty ? 'status' : 'claim'
  const status = entry.status as WaitlistStatus
  const teamId = entry.teamId as string
  const sessionId = entry.session as string

  const [sessionSnap, teamSnap] = await Promise.all([
    db.collection(SESSIONS_COLLECTION).doc(sessionId).get(),
    db.collection(TEAMS_COLLECTION).doc(teamId).get(),
  ])
  if (!sessionSnap.exists) throw new HttpsError('not-found', 'Session not found')
  const session = sessionSnap.data()!
  const team = teamSnap.data()

  // The activity's cancellation-policy override, read only when the session
  // names an activity. Best-effort: a missing or unreadable activity leaves the
  // page on the team-wide default it already has, which is the same fallback the
  // confirmation email applies — never a reason to fail the claim screen.
  const activityId = (session.activityId as string | undefined) ?? null
  let activityCancellationPolicy: string | null = null
  if (activityId) {
    const actSnap = await db.collection(ACTIVITIES_COLLECTION).doc(activityId).get()
    activityCancellationPolicy = (actSnap.data()?.cancellationPolicy as string | undefined)?.trim() || null
  }

  // Only meaningful while WAITING — an offered seat is not "third in line", it
  // is held. Derived from `joined_at ASC` at read time, never stored, so nobody
  // ahead leaving has to rewrite every entry behind them.
  let position: number | null = null
  if (status === 'waiting') {
    const queue = await sessionSnap.ref
      .collection(WAITLIST_SUBCOLLECTION)
      .where('status', '==', 'waiting')
      .orderBy('joined_at', 'asc')
      .limit(WAITLIST_QUEUE_SCAN_LIMIT)
      .get()
    const index = queue.docs.findIndex((d) => d.id === doc.id)
    position = index >= 0 ? index + 1 : null
  }

  const start = session.start as Timestamp | undefined
  const end = session.end as Timestamp | undefined
  const offerExpiresAt = entry.offer_expires_at as Timestamp | undefined
  return {
    mode,
    status,
    position,
    // Was this person ever actually OFFERED a seat? 'expired' covers two very
    // different endings — an offer whose window ran out, and a queue that closed
    // (the class ran, or was called off) without ever reaching them — and the
    // page has to tell them apart or it says "your offer expired" to somebody
    // who was never offered anything. `offered_at` is the discriminator and it
    // survives every closing path: the release transaction deletes only
    // `offer_token`, and the sweep's past-class pass and the cancellation
    // teardown write nothing but `status` + `expired_at`.
    wasOffered: !!entry.offered_at,
    firstname: (entry.firstname as string) ?? '',
    // Their OWN name and address, back to the holder of their own link — the
    // page already renders `firstname`. Both are here so the claim page's
    // consent step can identify the caller through the SAME email+name predicate
    // the booking rails use: without them `resolveWaiverRequirement` answers
    // conservatively for nobody, which would ask a member who signed last year
    // to sign again and could not resolve an `if_minor` age at all.
    lastname: (entry.lastname as string) ?? '',
    email: (entry.email as string | undefined) ?? null,
    // The claim page needs both to reach createDropInCheckout for a paid seat.
    teamId,
    sessionId,
    offerExpiresAt: mode === 'claim' && offerExpiresAt ? offerExpiresAt.toDate().toISOString() : null,
    session: {
      start: start ? start.toDate().toISOString() : null,
      end: end ? end.toDate().toISOString() : null,
      location: (session.location as string | undefined) ?? null,
      // The claim page's consent step needs it, and needs it to be the SAME
      // activity the claim's own gate resolves from the session document. Absent,
      // `resolveWaiverRequirement` would be called with a null activity — which
      // deliberately EXCLUDES an activity-scoped waiver rather than widening it —
      // so the page would show nothing, the claim would refuse, and the queued
      // member would spend their one offer on a document they were never shown.
      activityId: (session.activityId as string | undefined) ?? null,
      activityName: (session.activityName as string | undefined) ?? null,
      // BOTH cancellation shapes. A called-off OCCURRENCE of a recurring class
      // carries `isException` + `exceptionType` and leaves `status` untouched,
      // so a status-only test tells a waiting person their place lapsed when
      // the class was called off — and this page is their only channel for it
      // (the cancellation mail reaches released OFFER holders, not the queue).
      cancelled: isSessionCancelled(session),
      // The activity's own cancellation terms, so the claim screen can state
      // them before the button that takes the seat. Null falls back to the
      // team-wide default, which the page already holds from its public_profile
      // — resolved client-side by `resolveCancellationPolicy`, the same order
      // the confirmation email uses.
      cancellationPolicy: activityCancellationPolicy,
    },
    team: {
      name: (team?.name as string | undefined) ?? '',
      slug: (team?.slug as string | undefined) ?? null,
    },
  }
})

export const leaveWaitlist = onCall(async (request) => {
  const data = request.data as { entryToken?: string }
  const entryToken = typeof data?.entryToken === 'string' ? data.entryToken.trim() : ''
  if (!entryToken) throw new HttpsError('invalid-argument', 'entryToken is required')

  // Same posture as the two callables above: the holder of a live entry token is
  // never throttled, a miss always is.
  await assertUnderCheckoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)

  const db = admin.firestore()
  const tokenSnap = await db
    .collectionGroup(WAITLIST_SUBCOLLECTION)
    .where('entry_token', '==', entryToken)
    .limit(1)
    .get()
  if (tokenSnap.empty) {
    await checkoutRateLimit(request.rawRequest?.ip, WAITLIST_CLAIM_RATE_LIMIT_BUCKET)
    throw new HttpsError('not-found', 'This waitlist link is no longer valid')
  }
  const entryRef = tokenSnap.docs[0].ref

  // The same transaction the sweep runs — deliberately, because the guard it
  // applies (never delete a booking that is not still an UNCLAIMED hold) is what
  // stops a person who claimed and paid, then clicked the older "leave the
  // waitlist" link in their mailbox, from losing the seat they bought. Leaving
  // is idempotent on a terminal entry for the same reason.
  const { outcome, sessionId } = await releaseWaitlistOffer({
    entryRef,
    terminalStatus: 'left',
    from: ['waiting', 'offered'],
  })

  // Roll the seat on immediately rather than waiting for the hourly backstop.
  // The session write above usually fires the promotion trigger by itself, but
  // only when the class was exactly full before — a class already under its cap
  // (a lapsed hold elsewhere) produces no edge, and the queue would sit.
  // offerWaitlistSeats re-derives everything and no-ops when there is nothing to
  // do, so calling it twice costs reads and nothing else.
  if (outcome === 'released' && sessionId) {
    try {
      await offerWaitlistSeatsAndNotify(sessionId)
    } catch (err) {
      console.error(`[waitlist] re-offer after leave failed for session ${sessionId}:`, err)
    }
  }

  return { ok: true }
})

/**
 * Every place a signed-in contact currently holds in a queue, with positions.
 *
 * A callable rather than a client query, and the rules are the reason it has to
 * be: the collection-group read on `waitlist` requires `isTeamMember`, and the
 * nested `isSelfContact(entryId)` grant authorizes a GET of one already-known
 * document — neither of them lets a contact LIST their own entries across
 * sessions. A per-contact mirror was the alternative and was rejected: five
 * state transitions to keep in step with the entry, to replace one indexed
 * query.
 *
 * Live entries only. A queue place on a class that has already run, or one that
 * lapsed, is history — and the whole point of this view is the two things a
 * person can still act on: where they stand, and an offer waiting for them.
 */
export const listMyWaitlist = onCall(async (request) => {
  const data = request.data as { teamId?: string }
  const teamId = typeof data?.teamId === 'string' ? data.teamId.trim() : ''
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required')

  // Identity comes ONLY from the verified contact session. A contactId in the
  // request body proves nothing and would turn this into a queue enumerator for
  // every contact of the team.
  const { contactId } = await requireContactSessionForTeam(request, teamId)

  const db = admin.firestore()
  const snap = await db
    .collectionGroup(WAITLIST_SUBCOLLECTION)
    .where('teamId', '==', teamId)
    .where('contact', '==', contactId)
    .get()

  const nowMs = Date.now()
  // Narrowed in memory, not in the query: adding `status` and `session_start` to
  // it would need composite indexes of their own to filter a set already bounded
  // by how many classes one person can queue for.
  const live = snap.docs
    .filter((doc) => {
      const entry = doc.data()
      const start = entry.session_start as Timestamp | undefined
      return (
        LIVE_STATUSES.includes(entry.status as WaitlistStatus) &&
        !!start &&
        start.toMillis() > nowMs
      )
    })
    .sort(
      (a, b) =>
        (a.data().session_start as Timestamp).toMillis() -
        (b.data().session_start as Timestamp).toMillis()
    )
    .slice(0, MY_WAITLIST_LIMIT)

  const entries: MyWaitlistEntry[] = []
  for (const doc of live) {
    const entry = doc.data()
    const status = entry.status as WaitlistStatus
    const sessionId = entry.session as string

    // Derived at read time from `joined_at ASC`, never stored — so nobody ahead
    // leaving has to rewrite every entry behind them. Meaningless once offered:
    // that seat is not "third in line", it is held.
    let position: number | null = null
    if (status === 'waiting') {
      const queue = await doc.ref.parent
        .where('status', '==', 'waiting')
        .orderBy('joined_at', 'asc')
        .limit(WAITLIST_QUEUE_SCAN_LIMIT)
        .get()
      const index = queue.docs.findIndex((d) => d.id === doc.id)
      position = index >= 0 ? index + 1 : null
    }

    const sessionSnap = await db.collection(SESSIONS_COLLECTION).doc(sessionId).get()
    const session = sessionSnap.data()
    const start = session?.start as Timestamp | undefined
    const end = session?.end as Timestamp | undefined
    const offerExpiresAt = entry.offer_expires_at as Timestamp | undefined

    entries.push({
      sessionId,
      status,
      position,
      // The long-lived link only: it opens the status view and the "leave"
      // action. The single-use claim credential stays in the offer mail — this
      // response is not the place to mint a second copy of it.
      entryToken: (entry.entry_token as string | undefined) ?? null,
      offerExpiresAt: offerExpiresAt ? offerExpiresAt.toDate().toISOString() : null,
      session: {
        start: start ? start.toDate().toISOString() : null,
        end: end ? end.toDate().toISOString() : null,
        location: (session?.location as string | undefined) ?? null,
        activityName: (session?.activityName as string | undefined) ?? null,
        // Same pair as `getWaitlistEntry` above — a canceled occurrence of a
        // series never gets a `status`.
        cancelled: isSessionCancelled(session ?? {}),
      },
    })
  }

  return { entries }
})
