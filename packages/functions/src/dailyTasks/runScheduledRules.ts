// Generic daily scanner for automation rules with trigger.type === 'schedule_daily'.
// Kept intentionally open-ended — inactivity rules are the primary use case today,
// but any time-based condition that cannot be expressed as a Firestore event simply
// sets trigger.type: 'schedule_daily' and gets picked up here automatically.
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { to } from '../utils/async'
import { normalizeRule, runRule, type ContactData } from '../utils/automationEngine'
import { withLedgerExpiry } from '../utils/ledgerRetention'

const TEAMS_COLLECTION = 'teams'
const AUTOMATION_RULES_SUBCOLLECTION = 'automation_rules'
const CONTACTS_COLLECTION = 'contacts'

export async function runScheduledRules(): Promise<{ teams: number; rules: number; sent: number; errors: number }> {
  console.log('[runScheduledRules] Starting scheduled automation rules scan') // eslint-disable-line no-console

  const db = admin.firestore()
  const summary = { teams: 0, rules: 0, sent: 0, errors: 0 }

  // Load all active rules across all teams
  const [rulesErr, rulesSnap] = await to(
    db.collectionGroup(AUTOMATION_RULES_SUBCOLLECTION).where('active', '==', true).get()
  )
  if (rulesErr) {
    console.error('[runScheduledRules] Error fetching automation rules:', rulesErr)
    throw rulesErr
  }

  if (!rulesSnap || rulesSnap.empty) {
    console.log('[runScheduledRules] No active automation rules found') // eslint-disable-line no-console
    return summary
  }

  console.log(`[runScheduledRules] Found ${rulesSnap.size} active rule(s)`) // eslint-disable-line no-console

  // Group rules by team
  const rulesByTeam = new Map<string, Array<ReturnType<typeof normalizeRule>>>()
  for (const ruleDoc of rulesSnap.docs) {
    const teamId = ruleDoc.ref.parent.parent!.id
    const rule = normalizeRule(ruleDoc.id, ruleDoc.data() as Record<string, unknown>)

    // Only process schedule_daily rules in this task
    if (rule.trigger.type !== 'schedule_daily') continue

    if (!rulesByTeam.has(teamId)) rulesByTeam.set(teamId, [])
    rulesByTeam.get(teamId)!.push(rule)
  }

  for (const [teamId, rules] of rulesByTeam) {
    summary.teams++

    // Load team document for variable substitution + plan check
    const [teamErr, teamDoc] = await to(db.collection(TEAMS_COLLECTION).doc(teamId).get())
    const teamData = !teamErr && teamDoc && teamDoc.exists
      ? (teamDoc.data() as Record<string, unknown>)
      : {}

    // Plan gate: automation rules require studio+ plan
    const teamPlan = (teamData.plan as string) || 'coach'
    if (!['studio', 'organization'].includes(teamPlan)) {
      console.log(`[runScheduledRules] Team ${teamId} on plan '${teamPlan}' — automation requires studio+, skipping`) // eslint-disable-line no-console
      continue
    }

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
  }

  console.log('[runScheduledRules] Completed:', summary) // eslint-disable-line no-console
  return summary
}
