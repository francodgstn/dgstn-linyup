// ─── Offerings — activities and plans, as the studio sells them ─────────────
//
// Configuration, not a log: bounded by what a studio authors, so each list is
// read whole (under a ceiling) and sorted by the order the studio set.

import * as admin from 'firebase-admin'
import {
  ACTIVITIES_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  compareActivities,
  compareSubscriptionTypes,
  projectActivity,
  projectPlan,
  studioDropInOf,
  type Activity,
  type ApiActivity,
  type ApiPlan,
  type SubscriptionType,
} from '@linyup/shared'
import { loadBookingSettings } from '../../booking/bookingSettings'
import type { ApiPrincipal } from '../auth/principal'
import { requireScope, type ListPage } from '../access'
import type { TeamReadContext } from '../context'

/** A ceiling, not a page size: no studio authors this many. */
const CONFIG_CAP = 500

export async function listActivities(principal: ApiPrincipal, team: TeamReadContext): Promise<ListPage<ApiActivity>> {
  requireScope(principal, 'offerings:read')
  const [snap, settings] = await Promise.all([
    admin.firestore().collection(ACTIVITIES_COLLECTION).where('teamId', '==', principal.teamId).limit(CONFIG_CAP).get(),
    loadBookingSettings(principal.teamId),
  ])
  // A class that follows the studio's drop-in price stores none of its own, so
  // the studio default is part of the answer (resolveActivityDropIn).
  const studioDropIn = studioDropInOf(settings)
  const data = snap.docs
    .map((d) => ({ ...(d.data() as Activity), id: d.id }))
    .sort(compareActivities)
    .map((a) => projectActivity(a, { currency: team.currency, studioDropIn }))
    .filter((a): a is ApiActivity => a !== null)
  return { object: 'list', data, has_more: snap.size >= CONFIG_CAP, next_cursor: null }
}

export async function listPlans(principal: ApiPrincipal, team: TeamReadContext): Promise<ListPage<ApiPlan>> {
  requireScope(principal, 'offerings:read')
  const snap = await admin
    .firestore()
    .collection(TEAMS_COLLECTION)
    .doc(principal.teamId)
    .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
    .limit(CONFIG_CAP)
    .get()
  const data = snap.docs
    .map((d) => ({ ...(d.data() as SubscriptionType), id: d.id }))
    .sort(compareSubscriptionTypes)
    .map((t) => projectPlan(t, { currency: team.currency }))
  return { object: 'list', data, has_more: snap.size >= CONFIG_CAP, next_cursor: null }
}
