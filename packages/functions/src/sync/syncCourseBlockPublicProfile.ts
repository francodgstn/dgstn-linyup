// Keeps course_blocks/{blockId}/public_profile/{blockId} in sync.
//
// A COURSE IS PUBLIC ONLY WHEN PUBLISHED. A draft exists so the studio can put
// its lessons on the calendar and look at them before anybody can see it, so the
// mirror is deleted for a draft exactly as it is for a cancelled course. The
// door being shut for the season (`booking_closes_at` passed, or the course
// full) is NOT the same thing and must stay visible: "closed" and "sold out"
// are answers a visitor needs, and a card that vanishes instead reads as a
// studio that stopped running the course.
//
// AGGREGATES ONLY. `places` and `places_taken` are numbers; the enrolments
// themselves never leave the tenant. The same rule the class mirror follows with
// `bookings_count` and `waitlist_count`.
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { firstMeeting, lastMeeting, meetingCount, type CourseBlock } from '@linyup/shared'

/** What a public card needs to decide whether to render, and what to say. */
export function buildCourseBlockPublicProfile(
  data: FirebaseFirestore.DocumentData
): Record<string, unknown> {
  const block = data as CourseBlock
  const first = firstMeeting(block)
  const last = lastMeeting(block)

  return {
    type: 'course_block',
    teamId: block.teamId,
    name: block.name ?? '',
    description: block.description ?? null,
    // THE PROGRAM. Mirrored whole, unlike the meeting list beside it: an
    // outline is what a parent reads before paying for thirteen weeks, it is
    // bounded at COURSE_CURRICULUM_MAX_ITEMS, and a card that had to fetch it
    // separately would show the price first and the reason second.
    curriculum: block.curriculum ?? null,
    // The class behind it, so a card can borrow its picture and its terms
    // without the course restating them.
    activityId: block.activityId ?? null,
    activityName: block.activityName ?? null,
    // WHEN, as the three facts a card shows: when it starts, when it ends, and
    // how many lessons. The meeting LIST is deliberately not mirrored: it is up
    // to 200 entries, and a card needs a count rather than a calendar.
    first_meeting: first?.start ?? null,
    last_meeting: last?.end ?? null,
    meeting_count: meetingCount(block),
    // WHERE and WHO.
    placeId: block.placeId ?? null,
    location: block.location ?? null,
    providerId: block.providerId ?? null,
    providerName: block.providerName ?? null,
    // WHAT IT COSTS, as the base price only. What a given person pays is
    // `resolvePaymentOptions`' answer and depends on the plans they hold, so a
    // card shows this and the resolver prices the button.
    priceAmount: typeof block.priceAmount === 'number' ? block.priceAmount : null,
    // The plan edge, public-safe: the referenced subscription-type ids are
    // already public in the shop, and the card has to be able to say "included
    // with Premium" without a second round trip.
    includedSubscriptionTypeIds: block.includedSubscriptionTypeIds ?? [],
    benefit: block.benefit ?? null,
    audience: block.audience ?? 'anyone',
    // HOW FULL, as two numbers. Never who.
    places: typeof block.places === 'number' ? block.places : null,
    places_taken: block.places_taken ?? 0,
    // WHEN THE DOOR SHUTS. Absolute, so a public list can filter on it without
    // knowing the first lesson.
    booking_closes_at: block.booking_closes_at ?? null,
  }
}

/** Published and not cancelled. A draft has no public existence at all. */
function shouldBePublic(data: FirebaseFirestore.DocumentData | undefined): boolean {
  return !!data && data.status === 'published'
}

export const syncCourseBlockPublicProfile = onDocumentWritten(
  'course_blocks/{blockId}',
  async (event) => {
    const { blockId } = event.params
    const afterRef = event.data!.after.ref
    const data = event.data!.after.exists ? event.data!.after.data() : undefined

    if (!shouldBePublic(data)) {
      await afterRef.collection('public_profile').doc(blockId).delete()
      return
    }

    await afterRef
      .collection('public_profile')
      .doc(blockId)
      .set(buildCourseBlockPublicProfile(data!))
  }
)
