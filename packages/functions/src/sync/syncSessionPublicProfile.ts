// Keeps sessions/{sessionId}/public_profile/{sessionId} in sync.
// Regular sessions: synced when allowBooking === true, OR when the session is a
// lesson of a COURSE, see the visibility note below.
// Appointment sessions (activityType === 'appointment'): synced when
// status !== 'cancelled' AND status !== 'pending_payment' — a paid-booking hold
// (awaiting Stripe checkout) is never published.
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import type { Timestamp } from 'firebase-admin/firestore'


export const syncSessionPublicProfile = onDocumentWritten('sessions/{sessionId}', async (event) => {
  const { sessionId } = event.params
  const afterRef = event.data!.after.ref

  const data = event.data!.after.exists ? event.data!.after.data()! : null
  const isAppointment = data?.activityType === 'appointment'

  // Remove public profile when:
  // - session deleted
  // - regular session with allowBooking disabled
  // - appointment session explicitly canceled, OR a paid-booking HOLD
  //   ('pending_payment') — holds are never published, so an abandoned/awaiting
  //   checkout never leaks onto public feeds. Once the webhook confirms it,
  //   status flips to 'full' and this write republishes it normally.
  // - a staff-created BLOCKED-TIME hold (`blocked_time`) — a coach's private
  //   personal block, not a bookable slot; its manager note must never surface
  //   on public feeds.
  //
  // VISIBLE IS NOT BOOKABLE. A course's lessons are sold as the course, so each
  // one carries `allowBooking: false` and has no booking form of its own, but a
  // visitor still has to be able to SEE that the hall is busy on Wednesdays at
  // 15:45, and the studio's public calendar would otherwise have a course-shaped
  // hole in it. So a course lesson is published, with `allowBooking: false` and
  // its `course_block_id`, and a click on it belongs to the course rather than
  // to a booking form.
  const shouldBePublic =
    data &&
    (isAppointment
      ? data.status !== 'cancelled' && data.status !== 'pending_payment' && data.blocked_time !== true
      : data.allowBooking === true || !!data.course_block_id)

  if (!shouldBePublic) {
    await afterRef.collection('public_profile').doc(sessionId).delete()
    return
  }

  if (isAppointment) {
    // Appointment session — public profile includes slot-specific fields
    const publicProfile = {
      type: 'appointment_session',
      teamId: data.teamId,
      activityType: 'appointment',
      activityName: data.activityName || null,
      providerId: data.providerId || null,
      providerName: data.providerName || null,
      templateId: data.templateId || null,
      start: data.start as Timestamp,
      end: data.end as Timestamp,
      duration_minutes: data.duration_minutes || null,
      // WHERE, as an id. `location` is the studio's free-text note, which is
      // all the public surfaces have ever had, so two sessions at two venues
      // are indistinguishable to them whenever the note is blank or the same.
      // The id is what lets a public page resolve the venue itself.
      placeId: data.placeId || null,
      roomId: data.roomId || null,
      location: data.location || null,
      onlineUrl: data.onlineUrl || null,
      max_participants: data.max_participants || null,
      bookings_count: data.bookings_count || 0,
      // NOTE: no accessRule any more — appointments dropped the access gate
      // entirely (2026-07); the price is the only gate. See docs/appointments.md.
      status: data.status || 'open',
      allowBooking: true,
      bookingMandatory: data.bookingMandatory === true,
      // Only mirrored when the studio opted in — see Session.headlinePublic.
      ...(data.headlinePublic === true && data.headline ? { headline: data.headline } : {}),
    }
    await afterRef.collection('public_profile').doc(sessionId).set(publicProfile)
  } else {
    // Regular class session
    const publicProfile = {
      type: 'session',
      teamId: data.teamId,
      activityType: data.activityType || 'class',
      // Present ⇒ this lesson belongs to a course: shown, not separately
      // bookable, and the click belongs to the course.
      ...(data.course_block_id ? { course_block_id: data.course_block_id } : {}),
      activityId: data.activityId || null,
      activityName: data.activityName || null,
      activityColor: data.activityColor || null,
      start: data.start as Timestamp,
      end: data.end as Timestamp,
      // WHERE, as an id, see the appointment branch above.
      placeId: data.placeId || null,
      roomId: data.roomId || null,
      location: data.location || null,
      capacity: data.capacity || null,
      participants_count: data.participants_count || 0,
      allowBooking: data.allowBooking === true,
      slug: data.slug || null,
      providerName: data.providerName || null,
      providerId: data.providerId || null,
      max_participants: data.max_participants || null,
      bookings_count: data.bookings_count || 0,
      // Queue SIZE only — an aggregate, never an identity. The public form
      // derives "full" from max_participants vs bookings_count (this branch
      // carries no `status`, and must not start), so this is all a "12 waiting"
      // chip needs.
      waitlist_count: data.waitlist_count || 0,
      bookingMandatory: data.bookingMandatory === true,
      // Only mirrored when the studio opted in — see Session.headlinePublic.
      ...(data.headlinePublic === true && data.headline ? { headline: data.headline } : {}),
    }
    await afterRef.collection('public_profile').doc(sessionId).set(publicProfile)
  }
})
