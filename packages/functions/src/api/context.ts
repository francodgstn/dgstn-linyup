// ─── Read context — the team facts every projection needs, loaded once ───────

import * as admin from 'firebase-admin'
import {
  DEFAULT_CURRENCY,
  TEAMS_COLLECTION,
  resolveRegional,
  type EngagementThresholds,
  type Team,
} from '@linyup/shared'
import { principalMay, type ApiPrincipal } from './auth/principal'
import { notFound } from './errors'
import type { ApiProjectionContext } from '@linyup/shared'

export interface TeamReadContext {
  teamId: string
  name: string
  slug: string | null
  language: string
  currency: string
  timeZone: string
  engagementThresholds: EngagementThresholds | undefined
}

export async function loadTeamContext(teamId: string): Promise<TeamReadContext> {
  const snap = await admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).get()
  if (!snap.exists) throw notFound('team')
  const team = snap.data() as Team & { default_currency?: string }
  return {
    teamId,
    name: team.name,
    slug: team.slug ?? null,
    language: team.language ?? 'en',
    currency: typeof team.default_currency === 'string' && team.default_currency ? team.default_currency : DEFAULT_CURRENCY,
    timeZone: resolveRegional(team.regional).timezone,
    engagementThresholds: team.engagement_thresholds,
  }
}

/** The projection context for this principal: PII only when granted AND usable. */
export function projectionContext(principal: ApiPrincipal, team: TeamReadContext, nowMs: number): ApiProjectionContext {
  return {
    nowMs,
    currency: team.currency,
    engagementThresholds: team.engagementThresholds,
    timeZone: team.timeZone,
    pii: principalMay(principal, 'contacts:read:pii'),
  }
}
