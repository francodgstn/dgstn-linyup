// Tarif 595 — reads of the three documents an issue needs before it touches a
// contact: the SHARED legal profile (settings/legal_profile), the plugin's own
// config (tarif595_settings/config) and the per-contact insurer data
// (tarif595_contacts/{contactId}). Every callable that renders a document goes
// through `requireCompleteSetup`, which runs the SAME validators the settings
// pages run (`validateLegalProfile`, `validateTarif595Config` from
// @linyup/shared) — one rule set, so the client and the server never disagree
// about what "complete" means.

import * as admin from 'firebase-admin'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  LEGAL_PROFILE_SETTINGS_DOC_ID,
  TARIF595_CONTACTS_SUBCOLLECTION,
  TARIF595_SETTINGS_DOC,
  TARIF595_SETTINGS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_SETTINGS_SUBCOLLECTION,
  validateLegalProfile,
  validateTarif595Config,
  type StudioLegalProfile,
  type Tarif595Config,
  type Tarif595ContactData,
} from '@linyup/shared'
import { tarif595Position } from '@linyup/shared/tarif595-positions'

function teamRef(teamId: string) {
  return admin.firestore().collection(TEAMS_COLLECTION).doc(teamId)
}

export async function loadTarif595Config(teamId: string): Promise<Tarif595Config | null> {
  const snap = await teamRef(teamId).collection(TARIF595_SETTINGS_SUBCOLLECTION).doc(TARIF595_SETTINGS_DOC).get()
  return snap.exists ? (snap.data() as Tarif595Config) : null
}

export async function loadLegalProfile(teamId: string): Promise<StudioLegalProfile | null> {
  const snap = await teamRef(teamId).collection(TEAM_SETTINGS_SUBCOLLECTION).doc(LEGAL_PROFILE_SETTINGS_DOC_ID).get()
  return snap.exists ? (snap.data() as StudioLegalProfile) : null
}

export async function loadTarif595ContactData(teamId: string, contactId: string): Promise<Tarif595ContactData | null> {
  const snap = await teamRef(teamId).collection(TARIF595_CONTACTS_SUBCOLLECTION).doc(contactId).get()
  return snap.exists ? (snap.data() as Tarif595ContactData) : null
}

export interface Tarif595Setup {
  config: Tarif595Config
  legalProfile: StudioLegalProfile
}

export type SetupIssue =
  | { code: 'plugin_config_incomplete'; detail: string }
  | { code: 'legal_profile_incomplete'; detail: string }

/** Both documents, validated; the issues are returned (not thrown) so the
 *  preview can list them next to the contact's own. */
export async function loadSetup(teamId: string): Promise<{ setup: Tarif595Setup | null; issues: SetupIssue[] }> {
  const [config, legalProfile] = await Promise.all([loadTarif595Config(teamId), loadLegalProfile(teamId)])
  const issues: SetupIssue[] = []
  const configIssues = validateTarif595Config(config, { positionExists: (code) => tarif595Position(code) !== null })
  for (const i of configIssues) issues.push({ code: 'plugin_config_incomplete', detail: `${i.path}:${i.code}` })
  const profileIssues = validateLegalProfile(legalProfile)
  for (const i of profileIssues) issues.push({ code: 'legal_profile_incomplete', detail: `${i.path}:${i.code}` })
  if (issues.length > 0 || !config || !legalProfile) return { setup: null, issues }
  return { setup: { config, legalProfile }, issues: [] }
}

export async function requireCompleteSetup(teamId: string): Promise<Tarif595Setup> {
  const { setup, issues } = await loadSetup(teamId)
  if (!setup) {
    throw new HttpsError('failed-precondition', 'Tarif 595 is not fully set up for this team.', {
      reason: issues[0]?.code ?? 'plugin_config_incomplete',
      issues,
    })
  }
  return setup
}
