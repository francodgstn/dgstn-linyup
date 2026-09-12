import { buildParticipantDoc } from '@linyup/shared'

/** A Firestore Timestamp (admin or client shape), a Date, or nothing → epoch ms. */
function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime()
  if (v && typeof v === 'object') {
    const t = v as { toMillis?: () => number; seconds?: number; _seconds?: number }
    if (typeof t.toMillis === 'function') return t.toMillis()
    const secs = t.seconds ?? t._seconds
    if (typeof secs === 'number') return secs * 1000
  }
  return null
}

export function transformSession(
  src: Record<string, unknown>,
  activityMap: Map<string, { name: string; type: string }>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...src }

  // Field renames
  if ('activity_id' in out) {
    out.activityId = out.activity_id
    delete out.activity_id
  }
  // HMD's instructorId/instructorName → the unified providerId/providerName
  // (dgstn-lineup merged the instructor/coach split into a single provider field).
  if ('instructorId' in out) {
    out.providerId = out.instructorId
    delete out.instructorId
  }
  if ('instructorName' in out) {
    out.providerName = out.instructorName
    delete out.instructorName
  }
  delete out.id // let Firestore doc ID be the canonical id; avoid collisions in web app spread
  // HMD's legacy source field is `portal_bookings_count` (this reads the immutable
  // hmd-lineup export schema). Map it to `bookings_count` — the single counter both
  // classes and appointments use for bookings HOLDING CAPACITY (status neither
  // 'cancelled' nor 'no_show') — and drop the source field. pass06 overwrites the
  // value with the real subcollection count anyway.
  if (out.bookings_count == null)
    out.bookings_count = (out.portal_bookings_count as number | undefined) ?? 0
  delete out.portal_bookings_count
  delete out.notes // session comments/descriptions excluded from migration

  // Enrich with activity name/type
  const actId = out.activityId as string | undefined
  const act = actId ? activityMap.get(actId) : undefined
  out.activityName = act?.name ?? null
  out.activityType = act?.type ?? 'class'

  // New fields.
  //
  // `allowBooking` is the per-session online-booking door (server readers
  // require `=== true`). It used to be derived from whether the OLD portal had
  // ever taken a booking for the session — which closed every upcoming class
  // nobody had happened to book yet, so a freshly imported studio's calendar
  // was empty on the public page until someone re-saved each session. The rule
  // now: an upcoming session is bookable, and being outside the booking
  // calendar is the exception a studio sets on purpose (2026-09-11). A past
  // session stays closed — the public queries bound on `start`, so nothing
  // past is bookable anyway, and closing it keeps the mirror honest — and so
  // does a cancelled one.
  const startMs = toMillis(src.start)
  const cancelled = src.status === 'cancelled' || src.cancelled === true
  out.allowBooking = !cancelled && startMs != null && startMs >= Date.now()
  out.createdBy = out.createdBy ?? null

  return out
}

/**
 * THE ATTENDANCE ROW — built by `buildParticipantDoc`, never by hand.
 *
 * This used to write a shape of its own: `{contactId, teamId, checked_in_at,
 * checked_in_by, created_at}`. It shared exactly ONE field with what the
 * product writes, and the source's names — present on 100% of hmd-lineup's
 * participant docs — were dropped on the floor. Three consequences, in
 * increasing order of how long they took to notice:
 *
 *  1. The roster rendered blank names, because `ParticipantDoc` reads
 *     `firstname`/`lastname`.
 *  2. `contact` was absent, so the roster's contact link went nowhere AND the
 *     "add from confirmed bookings" dedupe (`existingParticipantIds`, built
 *     from `p.contact`) never matched — offering to add people already on the
 *     roster.
 *  3. `checked_in_at` is not `checkedInAt`, and the contact's attendance
 *     history is a collection-group query ordered on the latter, behind a
 *     SPARSE_ALL index. A document missing the ordered field is not in the
 *     index at all, so every migrated attendance was invisible — the identical
 *     failure `useContactRecentSessions` documents having already been fixed
 *     once on the reader side.
 *
 * `buildParticipantDoc` exists precisely so writers cannot disagree like this;
 * the migration was simply a writer nobody converted.
 *
 * TWO DELIBERATE DEPARTURES FROM COPYING THE SOURCE:
 *
 *  • `fullname` is REBUILT, not copied. hmd-lineup wrote it both ways round —
 *    "Mues Heinrich Maximilian" from the roster, "Linus Lamon" from the
 *    bookings list — which is the sort bug `buildParticipantDoc`'s header
 *    describes. Copying the field would import the bug with the data.
 *  • `checkedInAt` is the SESSION'S START. The old system recorded no
 *    attendance time — presence in the subcollection was the whole fact — and
 *    the class is when the attendance happened. Writing null instead would
 *    keep the row in the index but pile every historical attendance at the
 *    bottom of a descending sort. `demoTenant.ts` stamps the session start for
 *    the same reason.
 *
 * `teamId` is kept ALONGSIDE the canonical shape, not instead of any of it —
 * the rules reach the parent session for tenancy, but every other migrated
 * subcollection carries the stamp and dropping it here would be a lone
 * exception.
 *
 * `rank` (the belt at the time, on every source row) is dropped: the target
 * has no field for it, and a field nothing reads is the shape this repo has
 * already recorded as a mistake once.
 */
export function transformParticipant(
  docId: string,
  src: Record<string, unknown>,
  teamId: string,
  sessionId: string,
  checkedInAt: unknown
): Record<string, unknown> {
  return {
    ...buildParticipantDoc({
      // The participant doc ID is the contactId in the old system, and
      // `buildParticipantDoc` enforces that same invariant on the new one.
      contactId: docId,
      sessionId,
      who: {
        firstname: (src.firstname as string | null | undefined) ?? null,
        lastname: (src.lastname as string | null | undefined) ?? null,
        avatar_url: (src.avatar_url as string | null | undefined) ?? null,
      },
      checkedInBy: 'migration',
      checkedInAt,
      fromBooking: src.confirmedFromBooking === true,
    }),
    teamId,
  }
}

export function transformBooking(
  docId: string,
  src: Record<string, unknown>,
  teamId: string
): Record<string, unknown> {
  // In hmd-lineup the booking doc ID is the contactId, and the contact field
  // stores the same value. dgstn-lineup queries bookings by contactId, so we
  // need to surface both field names.
  const contactId = (src.contact as string | undefined) ?? docId

  const out: Record<string, unknown> = {
    ...src,
    id: docId,
    contact: contactId,
    contactId: contactId,
    teamId,
    is_new_contact: src.is_new_contact ?? true,
    joinedAt: src.joinedAt ?? src.created_at ?? null,
    booking_token: src.booking_token ?? null,
  }

  // HMD's source booking flag is `fromPortal`; our model uses `fromBioLink`
  // (queried + Firestore-indexed). Map it so migrated bookings match no-show
  // scans and bio-link automation rules.
  if ('fromPortal' in out) {
    out.fromBioLink = out.fromPortal
    delete out.fromPortal
  }

  return out
}
