// Ported from hmd-lineup/functions/src/triggerAutomationRule/index.js
// Manually triggers a single automation rule for a team.
// Bypasses the dedup guard (force=true) so the rule fires even if contacts
// were already processed by a previous run.
// Requires studio+ plan.
import * as admin from 'firebase-admin'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { FieldValue } from 'firebase-admin/firestore'
import { to } from '../utils/async'
import { isTeamMember } from '../utils/teams'
import { requirePlan } from '../utils/plan'
import { normalizeRule, runRule, type ContactData } from '../utils/automationEngine'
import { withLedgerExpiry } from '../utils/ledgerRetention'

export const triggerAutomationRule = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'User must be authenticated.')
  }

  const { teamId, ruleId } = request.data as { teamId?: string; ruleId?: string }

  if (!teamId || !ruleId) {
    throw new HttpsError('invalid-argument', 'teamId and ruleId are required.')
  }

  const [memberErr, isMember] = await to(isTeamMember(request.auth.uid, teamId))
  if (memberErr || !isMember) {
    throw new HttpsError('permission-denied', 'You are not a member of this team.')
  }

  // Automations are available on every tier (Free/Coach are limited to their
  // active modules/add-ons at rule-creation time). requirePlan('free') still
  // rejects past_due / cancelled subscriptions.
  await requirePlan(teamId, 'free')

  const db = admin.firestore()

  const [ruleErr, ruleDoc] = await to(
    db.collection('teams').doc(teamId).collection('automation_rules').doc(ruleId).get()
  )
  if (ruleErr || !ruleDoc || !ruleDoc.exists) {
    throw new HttpsError('not-found', 'Automation rule not found.')
  }

  const rule = normalizeRule(ruleId, ruleDoc.data() as Record<string, unknown>)

  if (!rule.active) {
    throw new HttpsError('failed-precondition', 'Automation rule is inactive.')
  }

  const [teamErr, teamDoc] = await to(db.collection('teams').doc(teamId).get())
  const teamData =
    !teamErr && teamDoc && teamDoc.exists ? (teamDoc.data() as Record<string, unknown>) : {}

  // Load contacts for contact-based rules
  const contacts: ContactData[] = []
  const hasBookingCondition = rule.conditions.some((c) => c.type === 'bio_link_booking_no_show')
  if (!hasBookingCondition) {
    const [contactsErr, contactsSnap] = await to(
      db.collection('contacts').where('teamId', '==', teamId).get()
    )
    const [legacyErr, legacySnap] = await to(
      db.collection('contacts').where('teacher', '==', teamId).get()
    )
    const seenIds = new Set<string>()
    if (!contactsErr && contactsSnap) {
      for (const doc of contactsSnap.docs) {
        seenIds.add(doc.id)
        contacts.push({ id: doc.id, ...(doc.data() as Omit<ContactData, 'id'>) })
      }
    }
    if (!legacyErr && legacySnap) {
      for (const doc of legacySnap.docs) {
        if (!seenIds.has(doc.id)) {
          contacts.push({ id: doc.id, ...(doc.data() as Omit<ContactData, 'id'>) })
        }
      }
    }
  }

  const log = await runRule(rule, contacts, teamId, teamData, {
    triggerTier: 'manual',
    force: true,
  })

  // Persist log and update rule metadata
  await to(db.collection('teams').doc(teamId).collection('automation_logs').add(withLedgerExpiry('automation_logs', log)))
  await to(
    db.collection('teams').doc(teamId).collection('automation_rules').doc(ruleId).update({
      last_run_at: FieldValue.serverTimestamp(),
      last_run_sent: log.actions_executed,
    })
  )

  console.log(`[triggerAutomationRule] rule=${ruleId} team=${teamId}`, {
    // eslint-disable-line no-console
    matched: log.contacts_matched,
    executed: log.actions_executed,
    failed: log.actions_failed,
  })

  return {
    success: true,
    stats: {
      matched: log.contacts_matched,
      executed: log.actions_executed,
      failed: log.actions_failed,
    },
  }
})
