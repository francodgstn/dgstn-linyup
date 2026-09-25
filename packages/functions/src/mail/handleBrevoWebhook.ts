/* eslint-disable no-console */
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { MAIL_SENDS_COLLECTION, type BrevoWebhookEvent, type MailSuppressionReason } from '@linyup/shared'
import { getSecret } from '../utils/secrets'
import { timingSafeEqualStr } from '../utils/secureCompare'
import { addSuppression } from './suppression'

// Normalize Brevo's event names (payloads use snake_case; the create-webhook API
// uses camelCase) onto our suppression reasons. Only events that mean "stop
// sending to this address" produce a suppression.
const SUPPRESSION_EVENTS: Record<string, MailSuppressionReason> = {
  hard_bounce: 'hardBounce',
  hardbounce: 'hardBounce',
  blocked: 'blocked',
  spam: 'spam',
  invalid_email: 'invalid',
  invalid: 'invalid',
  unsubscribed: 'unsubscribed',
}

// Delivery-status mapping for the send ledger (best-effort, by provider message id).
const LEDGER_STATUS: Record<string, string> = {
  delivered: 'delivered',
  hard_bounce: 'bounced',
  hardbounce: 'bounced',
  soft_bounce: 'bounced',
  blocked: 'blocked',
  spam: 'spam',
  invalid_email: 'failed',
  invalid: 'failed',
}

function eventKey(event: string): string {
  return event.trim().toLowerCase().replace(/[\s-]/g, '_')
}

// Pure classification of a Brevo event name → what it means for us. Exported for
// unit testing.
export function classifyBrevoEvent(event: string): {
  suppression?: MailSuppressionReason
  ledgerStatus?: string
} {
  const key = eventKey(event)
  return {
    suppression: SUPPRESSION_EVENTS[key],
    ledgerStatus: LEDGER_STATUS[key],
  }
}

function messageId(e: BrevoWebhookEvent): string | undefined {
  return e['message-id'] || e.messageId
}

async function updateLedgerStatus(providerMessageId: string, status: string): Promise<void> {
  try {
    const snap = await admin
      .firestore()
      .collection(MAIL_SENDS_COLLECTION)
      .where('provider_message_id', '==', providerMessageId)
      .limit(1)
      .get()
    if (!snap.empty) {
      await snap.docs[0].ref.set({ status, updated_at: FieldValue.serverTimestamp() }, { merge: true })
    }
  } catch (err) {
    console.warn('[brevo-webhook] ledger update failed (non-fatal):', err)
  }
}

async function processEvent(e: BrevoWebhookEvent): Promise<void> {
  // Email events only. Brevo's documented SMS payloads carry `msg_status` / `to`
  // and no `event` or `email`, so they stop here and SMS ledger rows keep
  // `sent` — see README → "SMS opt-out" for why that is not wired yet.
  if (!e?.event || !e.email) return
  const mid = messageId(e)
  const { suppression, ledgerStatus } = classifyBrevoEvent(e.event)

  if (suppression) {
    await addSuppression(e.email, suppression, mid)
  }
  if (ledgerStatus && mid) {
    await updateLedgerStatus(mid, ledgerStatus)
  }
}

// Consumes Brevo transactional event webhooks. Verified by a shared token in the
// query string (the webhook URL is configured as
// https://<region>-<project>.cloudfunctions.net/handleBrevoWebhook?token=<secret>).
// Always returns 200 so Brevo does not retry-storm on our processing errors.
export const handleBrevoWebhook = onRequest({ invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed')
    return
  }

  // ── Verify the shared token ────────────────────────────────────────────────
  let expected: string
  try {
    expected = await getSecret('brevo-webhook-secret')
  } catch (err) {
    console.error('[brevo-webhook] secret unavailable:', err)
    res.status(200).json({ ok: false })
    return
  }
  // Prefer the header (kept out of URLs/access logs) over the query param.
  const provided = req.get('x-webhook-token') ?? (req.query.token as string | undefined) ?? ''
  if (!expected || !timingSafeEqualStr(provided, expected)) {
    res.status(401).send('Unauthorized')
    return
  }

  try {
    const body = req.body as BrevoWebhookEvent | BrevoWebhookEvent[] | { events?: BrevoWebhookEvent[] }
    const events: BrevoWebhookEvent[] = Array.isArray(body)
      ? body
      : Array.isArray((body as { events?: BrevoWebhookEvent[] })?.events)
        ? (body as { events: BrevoWebhookEvent[] }).events
        : [body as BrevoWebhookEvent]

    for (const e of events) {
      await processEvent(e)
    }
  } catch (err) {
    console.error('[brevo-webhook] processing error (acking anyway):', err)
  }

  res.status(200).json({ ok: true })
})
