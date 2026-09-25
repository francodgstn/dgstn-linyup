// Server-side resolution of a team's effective ranking systems.
//
// The RULE (an organization's systems override its studios', when it has any)
// lives in @linyup/shared so the client hook, the automation builder and this
// cannot disagree. Only the READ is here.
//
// It exists because the automation engine used to consult
// `teamData.ranking_systems` alone. For a tenant whose systems live on the
// ORGANIZATION — which is how the whole org tier is meant to be used, and how
// HMD is set up — that list is empty, so every `update_field` on a rank was
// dropped with a "not in allowlist" log and no rank automation could ever fire.
import * as admin from 'firebase-admin'
import {
  ORGANIZATIONS_COLLECTION,
  effectiveRankingSystems,
  type RankingSystem,
} from '@linyup/shared'

/**
 * The ranking systems that apply to the team whose document is `teamData`.
 *
 * Reads the organization only when the team belongs to one, so a standalone
 * studio pays nothing for the org tier existing.
 */
export async function resolveRankingSystems(
  teamData: Record<string, unknown> | undefined | null,
): Promise<RankingSystem[]> {
  const teamSystems = (teamData?.ranking_systems as RankingSystem[] | undefined) ?? []
  const orgId = teamData?.org_id as string | undefined
  if (!orgId) return teamSystems

  const snap = await admin
    .firestore()
    .collection(ORGANIZATIONS_COLLECTION)
    .doc(orgId)
    .get()
  const orgSystems = (snap.data()?.ranking_systems as RankingSystem[] | undefined) ?? []
  return effectiveRankingSystems(teamSystems, orgSystems)
}
