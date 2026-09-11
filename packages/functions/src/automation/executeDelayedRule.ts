// Tier 2 — Cloud Tasks handler for delayed automation rule execution.
// Registered as a task queue function (onTaskDispatched). Firebase automatically
// creates the Cloud Tasks queue with the same name as this function, in the
// function's region — which is why enqueuers address it by its fully-qualified
// name (see DELAYED_RULE_FUNCTION in utils/automationEngine.ts).
//
// TWO KINDS of delayed run land here, and the payload's `kind` says which:
//
//   'session' — enqueued by onSessionWrite for a session_ended rule, against
//               the session's END time. Participants are re-read from the
//               session at fire time (check-in happens AFTER enqueue).
//               `kind` ABSENT also means session: tasks enqueued before event
//               delays existed carry none.
//   'event'   — enqueued by fireEventRules for any other event trigger whose
//               rule carries trigger.delayMinutes > 0, against NOW + the delay.
//               contactIds are snapshotted at enqueue; the contact DOCUMENTS
//               are re-read here.
//
// WHAT IS DECIDED HERE, not at enqueue time: everything about the contact.
// runRule -> runContactRule re-reads each contact and skips it when archived,
// deleted, unsubscribed, without an email, inside the per-rule/per-contact
// dedup window, or no longer matching the rule's conditions. A delayed rule
// therefore cannot mail someone who left in the meantime.
//
// Idempotency: before executing, checks automation_logs for a doc with
// idempotency_key matching the payload. If found, the task is a no-op.
// Session keys are {ruleId}:{sessionId} (re-enqueue after an end-time edit
// collapses onto the same key); event keys are built by
// buildEventIdempotencyKey — see its docstring for why the occurrence is the
// event and not the contact. There is no third dedup mechanism: this guard and
// the per-contact window in runContactRule are the two, and they compose (a
// retry that lost its log write is still caught per contact).
import { onTaskDispatched } from 'firebase-functions/v2/tasks'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { to } from '../utils/async'
import { normalizeRule, runRule, type ContactData, type DelayedRulePayload } from '../utils/automationEngine'
import { withLedgerExpiry } from '../utils/ledgerRetention'

export const executeDelayedRule = onTaskDispatched(
  {
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 20 },
  },
  async (req) => {
    const { ruleId, teamId, sessionId, contactIds, idempotencyKey, kind, triggerType } =
      req.data as DelayedRulePayload

    if (!ruleId || !teamId || !idempotencyKey) {
      console.error('[executeDelayedRule] Invalid payload:', req.data) // eslint-disable-line no-console
      return // Don't throw — Cloud Tasks would retry
    }

    const db = admin.firestore()

    // Idempotency check — if we've already executed this key, skip silently
    const [checkErr, logSnap] = await to(
      db
        .collection('teams').doc(teamId)
        .collection('automation_logs')
        .where('idempotency_key', '==', idempotencyKey)
        .limit(1)
        .get()
    )
    if (!checkErr && logSnap && !logSnap.empty) {
      console.log(`[executeDelayedRule] Already executed idempotencyKey=${idempotencyKey}, skipping`) // eslint-disable-line no-console
      return
    }

    // Load rule
    const [ruleErr, ruleDoc] = await to(
      db.collection('teams').doc(teamId).collection('automation_rules').doc(ruleId).get()
    )
    if (ruleErr || !ruleDoc || !ruleDoc.exists) {
      console.error(`[executeDelayedRule] Rule ${ruleId} not found for team ${teamId}`) // eslint-disable-line no-console
      return
    }

    const rule = normalizeRule(ruleId, ruleDoc.data() as Record<string, unknown>)
    if (!rule.active) {
      console.log(`[executeDelayedRule] Rule ${ruleId} is inactive, skipping`) // eslint-disable-line no-console
      return
    }

    // Event-kind only: if the studio re-pointed the rule at a different trigger
    // while this task was in flight, drop it rather than run the new rule's
    // actions against contacts gathered for the old one. Session-kind tasks
    // carry no triggerType and are untouched by this check.
    if (triggerType && rule.trigger.type !== triggerType) {
      console.log(`[executeDelayedRule] Rule ${ruleId} trigger changed ${triggerType} -> ${rule.trigger.type}, skipping`) // eslint-disable-line no-console
      return
    }

    // Load team data for variable substitution
    const [teamErr, teamDoc] = await to(db.collection('teams').doc(teamId).get())
    const teamData = !teamErr && teamDoc && teamDoc.exists
      ? (teamDoc.data() as Record<string, unknown>)
      : {}

    // Resolve the contact set. Either way the contact DOCUMENTS are read now, at
    // fire time — never trusted from the enqueue-time snapshot.
    let contactIdsToLoad: string[]
    if (kind === 'event') {
      // Event-kind: the subjects the event named. A contact deleted in the
      // meantime simply drops out below.
      contactIdsToLoad = contactIds ?? []
    } else {
      // Session-kind: we intentionally do NOT use the snapshotted contactIds because
      // participants are created during check-in (which happens during/after the session,
      // not at enqueue time). Loading at execution time captures everyone who attended.
      contactIdsToLoad = []
      if (sessionId) {
        const [partErr, partSnap] = await to(
          db.collection('sessions').doc(sessionId).collection('participants').get()
        )
        if (!partErr && partSnap && !partSnap.empty) {
          contactIdsToLoad = partSnap.docs.map((d) => d.id)
        }
      }
    }

    const contacts: ContactData[] = []
    for (const contactId of contactIdsToLoad) {
      const [cErr, cDoc] = await to(db.collection('contacts').doc(contactId).get())
      if (!cErr && cDoc && cDoc.exists) {
        contacts.push({ id: contactId, ...(cDoc.data() as Omit<ContactData, 'id'>) })
      }
    }

    if (contacts.length === 0) {
      console.log(`[executeDelayedRule] No contacts for rule=${ruleId} kind=${kind ?? 'session'} session=${sessionId ?? '-'} — writing idempotency log only`) // eslint-disable-line no-console
      // Still write a log entry so the idempotency guard works on duplicate tasks
    }

    const log = await runRule(rule, contacts, teamId, teamData, {
      triggerTier: 'delayed',
      force: false,
    })

    // Write idempotency-guarded log entry
    await to(
      db.collection('teams').doc(teamId).collection('automation_logs').add(
        withLedgerExpiry('automation_logs', {
          ...log,
          idempotency_key: idempotencyKey,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
      )
    )
    await to(
      db.collection('teams').doc(teamId).collection('automation_rules').doc(ruleId).update({
        last_run_at: FieldValue.serverTimestamp(),
        last_run_sent: log.actions_executed,
      })
    )

    console.log(`[executeDelayedRule] rule=${ruleId} team=${teamId} kind=${kind ?? 'session'} session=${sessionId ?? '-'}`, { // eslint-disable-line no-console
      contacts: contacts.length,
      executed: log.actions_executed,
      failed: log.actions_failed,
    })
  }
)
