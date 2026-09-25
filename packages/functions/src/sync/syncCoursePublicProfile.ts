// Keeps courses/{courseId}/public_profile/{courseId} in sync
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { touchTeamForSurfaceRecompute } from '../utils/plugins'

// A course counts toward the team's Space surface when it's published and not
// archived — mirror the public_profile write/delete gate below.
const isLiveCourse = (d?: Record<string, unknown>): boolean =>
  !!d && d.status === 'published' && d.archived_at == null

export const syncCoursePublicProfile = onDocumentWritten('courses/{courseId}', async (event) => {
  const { courseId } = event.params
  const afterRef = event.data!.after.ref

  const beforeData = event.data!.before.data()
  const afterData = event.data!.after.data()

  // Remove public profile when document is deleted, not published, or archived
  if (!event.data!.after.exists || afterData?.status !== 'published' || afterData?.archived_at != null) {
    await afterRef.collection('public_profile').doc(courseId).delete()
  } else {
    const data = afterData!

    const publicProfile = {
      type: 'course',
      teamId: data.teamId,
      slug: data.slug,
      title: data.title,
      summary: data.summary || '',
      coverImageUrl: data.coverImageUrl || null,
      accessType: data.accessRule?.type ?? 'registered',
      subscriptionTypeIds: data.accessRule?.subscriptionTypeIds ?? [],
      // One-off shop price for 'purchase'-tier courses (major units). null for the
      // free/registered/subscription tiers so the shop can ignore them.
      priceAmount: typeof data.accessRule?.priceAmount === 'number' ? data.accessRule.priceAmount : null,
      // Subscriber benefit on the purchase price — public-safe (type ids are
      // already public in the shop); the shop renders the member price from it.
      benefit: data.benefit ?? null,
      // The shop lists ALL tiers; a studio can still hide a specific course from the
      // catalog. Absent/false ⇒ visible.
      hideFromShop: data.hideFromShop === true,
      moduleCount: data.moduleCount ?? 0,
      lessonCount: data.lessonCount ?? 0,
      order: data.order ?? 0,
    }

    await afterRef.collection('public_profile').doc(courseId).set(publicProfile)
  }

  // When this course crosses the published/archived boundary it may flip whether
  // the team's Space surface is live — nudge the team doc so the surface
  // recompute runs. Skip unrelated edits (title, price, …) that don't change it.
  if (isLiveCourse(beforeData) !== isLiveCourse(afterData)) {
    const teamId = (afterData?.teamId ?? beforeData?.teamId) as string | undefined
    if (teamId) await touchTeamForSurfaceRecompute(teamId)
  }
})
