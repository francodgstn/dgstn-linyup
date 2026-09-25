// The course rail's PRICING inputs, in one place.
//
// Same reason as booking/dropInPricing.ts: `previewPromoCode` must quote what
// `createCourseCheckout` would charge (N22), and a course's price depends on
// four things that are easy to assemble differently — the access rule, the
// subscriber benefit, WHICH subscription types the snapshot was loaded for, and
// whether the buyer already owns it.
//
// What deliberately does NOT live here: the "you already have access" refusal.
// That is a checkout decision (it compares the resolver's answer against what
// the security RULES would actually grant), and a preview must not refuse a
// purchase — it only reports what a code does to a price.

import * as admin from 'firebase-admin'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  COURSES_COLLECTION,
  COURSE_PURCHASES_SUBCOLLECTION,
  GUEST_SNAPSHOT,
  normalizeBenefit,
  type ContactPaymentSnapshot,
  type Course,
  type CourseTarget,
} from '@linyup/shared'
import { loadContactPaymentSnapshot } from '../booking/access'

export interface CoursePricing {
  course: Course
  /** THE target the resolver prices. */
  target: CourseTarget
  /** Carries `ownsCourse` already — the purchase entitlement is part of what the
   *  resolver may know about the caller, not a separate check. */
  snapshot: ContactPaymentSnapshot
  /** The plan types `canReadPublishedCourse` checks — the contact's
   *  `held_plan_type_ids` mirror, which the checkout compares against before
   *  refusing an already-entitled buyer. */
  rulesHeldTypeIds: string[]
  /** The buyer's contact document, already read for the snapshot. Returned so the
   *  promo AUDIENCE gate costs no second read — and so the checkout has no reason
   *  to fetch it itself, which is how the two assemblies drifted apart before. */
  contact: (FirebaseFirestore.DocumentData & { id: string }) | null
  /** The AUTHORED purchase price, in major units, already proven to be a number
   *  by the "not for sale" refusal above. Saves every caller re-narrowing
   *  `accessRule.priceAmount` from its optional declaration. */
  listMajor: number
}

/**
 * Load everything needed to price ONE course for ONE caller. Throws the same
 * refusals `createCourseCheckout` has always thrown for a course that is not
 * sellable at all (missing, another team's, unpublished, not purchase-tier) —
 * those are facts about the course, not about the caller, so the preview wants
 * them too.
 *
 * `contactId: null` ⇒ an anonymous caller: GUEST_SNAPSHOT, no entitlement.
 */
export async function loadCoursePricing(params: {
  teamId: string
  courseId: string
  contactId: string | null
}): Promise<CoursePricing> {
  const { teamId, courseId, contactId } = params
  const db = admin.firestore()

  const courseSnap = await db.collection(COURSES_COLLECTION).doc(courseId).get()
  if (!courseSnap.exists) throw new HttpsError('not-found', 'Course not found')
  const course = courseSnap.data() as Course
  if (course.teamId !== teamId) throw new HttpsError('not-found', 'Course not found')
  if (course.status !== 'published') {
    throw new HttpsError('failed-precondition', 'This course is not available')
  }
  if (course.accessRule?.type !== 'purchase' || typeof course.accessRule.priceAmount !== 'number') {
    throw new HttpsError('failed-precondition', 'This course is not for sale')
  }

  const benefit = normalizeBenefit(course.benefit)
  const target: CourseTarget = { kind: 'course', accessRule: course.accessRule, benefit }
  const listMajor = course.accessRule.priceAmount

  if (!contactId) {
    return {
      course,
      target,
      snapshot: GUEST_SNAPSHOT,
      rulesHeldTypeIds: [],
      contact: null,
      listMajor,
    }
  }

  const [contactSnap, purchaseSnap] = await Promise.all([
    db.collection(CONTACTS_COLLECTION).doc(contactId).get(),
    db
      .collection(COURSES_COLLECTION)
      .doc(courseId)
      .collection(COURSE_PURCHASES_SUBCOLLECTION)
      .doc(contactId)
      .get(),
  ])
  const contact: (FirebaseFirestore.DocumentData & { id: string }) | null =
    contactSnap.exists && contactSnap.data()?.teamId === teamId
      ? { ...contactSnap.data()!, id: contactSnap.id }
      : null

  const base = await loadContactPaymentSnapshot({
    teamId,
    contact,
    // The union of every id the resolution can touch — the legacy free-inclusion
    // list AND the explicit benefit. Loading only one of them silently drops the
    // other's coverage.
    relevantTypeIds: [
      ...(course.accessRule.subscriptionTypeIds ?? []),
      ...(benefit?.subscriptionTypeIds ?? []),
    ],
  })

  return {
    course,
    target,
    snapshot: { ...base, ownsCourse: purchaseSnap.exists },
    rulesHeldTypeIds: Array.isArray(contact?.held_plan_type_ids)
      ? (contact!.held_plan_type_ids as unknown[]).filter(
          (id): id is string => typeof id === 'string'
        )
      : [],
    contact,
    listMajor,
  }
}
