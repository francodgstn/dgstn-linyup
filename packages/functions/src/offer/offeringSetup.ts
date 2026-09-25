// ─── applyOfferingSetup: the setup wizard's one write ────────────────────────
//
// The in-app wizard asks the help centre's offering questions and sends what
// the studio answered (`OfferingSetup`, packages/shared/src/types/offeringSetup.ts).
// This creates the class, plan or appointment through the shared writer
// (offeringWriter.ts), the same builders the AI draft uses, and a course
// through the course creator itself (`createCourseBlockRecord`), the one way a
// course comes into being.
//
// WHO: the people the forms let create the same thing, checked the same way the
// rules check them. A class or an appointment needs `activities.manage` (the
// `activities` create rule); a course needs `schedule.manage`, as
// `createCourseBlock` does; a plan needs the manager role (the
// `subscription_types` write rule), plus `activities.manage` when it includes
// existing classes, because that writes those classes. Not owner-only, and not
// behind the AI plugin (Franco, 2026-09-26).
//
// EXISTING RECORDS ARE LINKED, NEVER OTHERWISE CHANGED. Every id the wizard
// names is checked against the caller's own team before anything is written.
// A new class carries its plan links on itself; a new plan is added to each
// existing class it includes through `activityPlanEdgeUpdate`, THE edge writer,
// read inside the transaction so a studio editing that class at the same moment
// is merged with rather than overwritten.

import * as admin from 'firebase-admin'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  ACTIVITIES_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  activityPlanEdge,
  activityPlanEdgeUpdate,
  isAppointmentActivity,
  parseOfferingSetup,
  studioDropInOf,
  type ActivityEdgeFields,
} from '@linyup/shared'
import { hasTeamRole, requireCapability } from '../utils/teams'
import { loadBookingSettings } from '../booking/bookingSettings'
import { createCourseBlockRecord } from '../courseBlocks'
import {
  newClassDocument,
  planDocument,
  setupAppointmentDocument,
  setupCourseLinks,
  setupCourseWrite,
  setupPlanFields,
} from './offeringWriter'

export const applyOfferingSetup = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.')
  const uid = request.auth.uid
  const { teamId, setup: incoming } = (request.data ?? {}) as { teamId?: string; setup?: unknown }
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId is required.')

  const { setup, problems } = parseOfferingSetup(incoming)
  if (!setup) {
    throw new HttpsError('invalid-argument', 'The setup is not complete.', { problems })
  }

  const db = admin.firestore()
  const teamRef = db.collection(TEAMS_COLLECTION).doc(teamId)
  const plansRef = teamRef.collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)

  /** Every plan named must be one of this team's: it is read under the team. */
  const requireTeamPlans = async (ids: string[]) => {
    const planIds = [...new Set(ids)]
    if (!planIds.length) return
    const snaps = await db.getAll(...planIds.map((id) => plansRef.doc(id)))
    if (snaps.some((s) => !s.exists)) {
      throw new HttpsError('failed-precondition', 'A plan in this setup no longer exists.', { reason: 'unknown_plan' })
    }
  }
  const nextActivityOrder = async () =>
    (await db.collection(ACTIVITIES_COLLECTION).where('teamId', '==', teamId).count().get()).data().count

  if (setup.kind === 'appointment') {
    await requireCapability(uid, teamId, 'activities.manage')
    await requireTeamPlans(setup.appointment.memberDeal?.planIds ?? [])
    const ref = db.collection(ACTIVITIES_COLLECTION).doc()
    await ref.set(
      setupAppointmentDocument(setup.appointment, { teamId, uid, order: await nextActivityOrder(), createdVia: 'wizard' })
    )
    return { kind: 'appointment' as const, id: ref.id }
  }

  if (setup.kind === 'course') {
    await requireCapability(uid, teamId, 'schedule.manage')
    const course = setup.course
    await requireTeamPlans([...course.includedPlanIds, ...(course.memberRate?.planIds ?? [])])
    const made = await createCourseBlockRecord(db, uid, teamId, setupCourseWrite(course), {
      links: setupCourseLinks(course),
      createdVia: 'wizard',
    })
    return { kind: 'course' as const, id: made.id, lessons: made.meetings }
  }

  const studioDropIn = studioDropInOf(await loadBookingSettings(teamId))

  if (setup.kind === 'class') {
    await requireCapability(uid, teamId, 'activities.manage')
    const cls = setup.class
    await requireTeamPlans([...cls.includedPlanIds, ...(cls.memberRate?.planIds ?? [])])
    const order = await nextActivityOrder()
    const ref = db.collection(ACTIVITIES_COLLECTION).doc()
    await ref.set(newClassDocument(cls, { teamId, uid, order, createdVia: 'wizard' }, studioDropIn))
    return { kind: 'class' as const, id: ref.id }
  }

  // ── a plan ──
  if (!(await hasTeamRole(uid, teamId, 'manager'))) {
    throw new HttpsError('permission-denied', 'Only a manager or the owner can create plans.')
  }
  const plan = setup.plan
  if (plan.includedActivityIds.length) await requireCapability(uid, teamId, 'activities.manage')

  const count = await plansRef.count().get()
  const planRef = plansRef.doc()
  const activityRefs = plan.includedActivityIds.map((id) => db.collection(ACTIVITIES_COLLECTION).doc(id))

  await db.runTransaction(async (tx) => {
    // ALL READS FIRST: every class the plan includes, as it stands now.
    const snaps = activityRefs.length ? await tx.getAll(...activityRefs) : []
    const updates: { ref: FirebaseFirestore.DocumentReference; update: Record<string, unknown> }[] = []
    for (const snap of snaps) {
      const a = snap.data()
      // Only this team's classes: an appointment has no "Can book", and is
      // linked from its own page, as the walkthrough says.
      if (!snap.exists || a?.teamId !== teamId || isAppointmentActivity(a as ActivityEdgeFields)) {
        throw new HttpsError('failed-precondition', 'A class in this setup no longer exists.', {
          reason: 'unknown_activity',
        })
      }
      const fresh = a as ActivityEdgeFields
      // Adds the ACCESS facet ("Can book") and leaves the rate facet as it is.
      const now = activityPlanEdge(fresh, planRef.id)
      const update = activityPlanEdgeUpdate(fresh, planRef.id, { access: true, rate: now.rate }, undefined, undefined, studioDropIn)
      if (update) updates.push({ ref: snap.ref, update })
    }
    tx.set(
      planRef,
      planDocument(
        setupPlanFields(plan),
        { teamId, uid, order: count.data().count, createdVia: 'wizard' },
        (i) => `${planRef.id}-${i}`
      )
    )
    for (const u of updates) tx.update(u.ref, u.update)
  })
  return { kind: 'plan' as const, id: planRef.id, linked: activityRefs.length }
})
