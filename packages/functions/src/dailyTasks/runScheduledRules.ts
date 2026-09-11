// Generic daily scanner for automation rules with trigger.type === 'schedule_daily'.
// Kept intentionally open-ended — inactivity rules are the primary use case today,
// but any time-based condition that cannot be expressed as a Firestore event simply
// sets trigger.type: 'schedule_daily' and gets picked up here automatically.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { to } from '../utils/async'
import { normalizeRule, runRule, type ContactData } from '../utils/automationEngine'
import { withLedgerExpiry } from '../utils/ledgerRetention'
import { dispatchTenantJob, type FanOutResult } from '../utils/tenantFanOut'

const TEAMS_COLLECTION = 'teams'
const AUTOMATION_RULES_SUBCOLLECTION = 'automation_rules'
const CONTACTS_COLLECTION = 'contacts'

export interface ScheduledRulesStats {
  rules: number
  sent: number
  errors: number
}

/**
 * ONE tenant's scheduled rules. The worker body and the dispatcher's inline
 * path.
 *
 * This was the heaviest of the four fan-outs: it read every active rule in the
 * product with one collection-group query, then loaded EVERY CONTACT of every
 * team with a scheduled rule into one process's memory
 * (docs/scalability-2026-09.md §9 sized it at ~150k sequential reads at five
 * hundred studios). Per tenant, the rule query is the team's own subcollection
 * and the roster is one studio's.
 *
 * THE PLAN GATE IS READ BEFORE THE ROSTER, deliberately: automation needs
 * studio+, and a team below it must not cost a contact read to discover that.
 */
export async function runScheduledRulesForTeam(teamId: string): Promise<ScheduledRulesStats> {
  const db = admin.firestore()
  const summary: ScheduledRulesStats = { rules: 0, sent: 0, errors: 0 }

  // Load team document for variable substitution + plan check
  const [teamErr, teamDoc] = await to(db.collection(TEAMS_COLLECTION).doc(teamId).get())
  const teamData = !teamErr && teamDoc && teamDoc.exists
    ? (teamDoc.data() as Record<string, unknown>)
    : {}

  // Plan gate: automation rules require studio+ plan
  const teamPlan = (teamData.plan as string) || 'coach'
  if (!['studio', 'organization'].includes(teamPlan)) return summary

  const [rulesErr, rulesSnap] = await to(
    db
      .collection(TEAMS_COLLECTION)
      .doc(teamId)
      .collection(AUTOMATION_RULES_SUBCOLLECTION)
      .where('active', '==', true)
      .get()
  )
  if (rulesErr) {
    console.error(`[runScheduledRules] team ${teamId}: rule read failed:`, rulesErr)
    throw rulesErr
  }

  const rules = (rulesSnap?.docs ?? [])
    .map((d) => normalizeRule(d.id, d.data() as Record<string, unknown>))
    .filter((r) => r.trigger.type === 'schedule_daily')
  // No scheduled rule, no roster read — which is most studios, most days.
  if (rules.length === 0) return summary

  // Load all active contacts for this team (shared across all rules for this team)
  const [contactsErr, contactsSnap] = await to(
    db.collection(CONTACTS_COLLECTION).where('teamId', '==', teamId).get()
  )
  // Legacy contacts with teacher field (backward compat)
  const [legacyErr, legacySnap] = await to(
    db.collection(CONTACTS_COLLECTION).where('teacher', '==', teamId).get()
  )

  const seenIds = new Set<string>()
  const allContacts: ContactData[] = []

  if (!contactsErr && contactsSnap) {
    for (const doc of contactsSnap.docs) {
      seenIds.add(doc.id)
      allContacts.push({ id: doc.id, ...(doc.data() as Omit<ContactData, 'id'>) })
    }
  }
  if (!legacyErr && legacySnap) {
    for (const doc of legacySnap.docs) {
      if (!seenIds.has(doc.id)) {
        allContacts.push({ id: doc.id, ...(doc.data() as Omit<ContactData, 'id'>) })
      }
    }
  }

  for (const rule of rules) {
    summary.rules++

    try {
      const log = await runRule(rule, allContacts, teamId, teamData, {
        triggerTier: 'scheduled',
      })

      summary.sent += log.actions_executed
      summary.errors += log.actions_failed

      // Write log entry and update rule metadata
      await to(
        db.collection(TEAMS_COLLECTION).doc(teamId).collection('automation_logs').add(withLedgerExpiry('automation_logs', log))
      )
      await to(
        db
          .collection(TEAMS_COLLECTION)
          .doc(teamId)
          .collection(AUTOMATION_RULES_SUBCOLLECTION)
          .doc(rule.id)
          .update({
            last_run_at: FieldValue.serverTimestamp(),
            last_run_sent: log.actions_executed,
          })
      )
    } catch (err) {
      console.error(`[runScheduledRules] Rule ${rule.id} team ${teamId} failed:`, (err as Error).message)
      summary.errors++
    }
  }

  return summary
}

/** THE DISPATCHER — one task per tenant, daily. */
export async function runScheduledRules(): Promise<FanOutResult> {
  console.log('[runScheduledRules] dispatch started') // eslint-disable-line no-console
  const result = await dispatchTenantJob({
    functionName: 'scheduledRulesForTeam',
    granularity: 'day',
    perTeam: runScheduledRulesForTeam,
    label: 'scheduledRules',
  })
  console.log('[runScheduledRules] dispatch completed:', result) // eslint-disable-line no-console
  return result
}
