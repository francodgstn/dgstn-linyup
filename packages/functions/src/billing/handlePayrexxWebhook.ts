/* eslint-disable no-console */
// handlePayrexxWebhook — receives signed payment notifications from Payrexx.
//
// This is the TEAM-LEVEL payment webhook (teams charging their students).
// It is separate from handleStripeWebhook, which handles Linyup's own SaaS billing.
//
// URL: POST /handlePayrexxWebhook?teamId={teamId}
//
// Payload (Payrexx sends a JSON body):
//   { transaction: { id, uuid, amount, currency, status, mode, referenceId,
//                    contact: { email, firstname, lastname },
//                    subscription: { id, valid_until } } }
//
// Signature: X-Webhook-Signature header — HMAC-SHA256(rawBody, signingSecret) as hex.
// Constant-time comparison prevents timing attacks.
//
// Processing rules:
//   • status must be 'confirmed'
//   • mode must not be 'TEST' (override with ALLOW_TEST_PAYREXX=true env var for staging)
//   • Idempotency: a payment_events/{payrexx:{transactionId}} doc is written atomically.
//     Duplicate webhooks from Payrexx are silently acknowledged.
//
// The payment is ALWAYS recorded as an ExternalPayment (even when no contact
// matches) so nothing is silently dropped. A contact is linked ONLY on a UNIQUE
// active email match (resolveSingleContact) — none/ambiguous → assignment_status
// 'unassigned', and a manager assigns it later from the payments dashboard.
//
// When (and only when) uniquely assigned, the contact record is also updated:
//   • membership_expiration ← subscription.valid_until (ISO date)
//   • subscription_type_id  ← transaction.referenceId (merchant-set) or gateway default
//   • last_payment_at       ← now

import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import * as crypto from 'crypto'
import { to } from '../utils/async'
import { resolveSingleContact } from '../utils/contacts'
import {
  TEAMS_COLLECTION,
  CONTACTS_COLLECTION,
  SUBSCRIPTION_TYPES_SUBCOLLECTION,
  PAYMENT_EVENTS_SUBCOLLECTION,
  buildExternalPaymentTxn,
} from '@linyup/shared'
import type { PayrexxGatewayConfig } from '@linyup/shared'
import { recordFinanceTransaction } from '../finance/journal'
import { withLedgerExpiry } from '../utils/ledgerRetention'

export const handlePayrexxWebhook = onRequest(
  { invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, reason: 'method_not_allowed' })
      return
    }

    // ── 1. Identify team ──────────────────────────────────────────────────────
    const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : null
    if (!teamId) {
      console.warn('[handlePayrexxWebhook] Missing teamId query param')
      res.status(400).json({ ok: false, reason: 'missing_team_id' })
      return
    }

    const db = admin.firestore()

    // ── 2. Load integration config (Admin SDK, bypasses Firestore rules) ──────
    const [intErr, intSnap] = await to(
      db.collection(TEAMS_COLLECTION).doc(teamId)
        .collection('integrations')
        .where('type', '==', 'payment_gateway')
        .where('config.type', '==', 'payrexx')
        .limit(1)
        .get()
    )
    if (intErr || !intSnap || intSnap.empty) {
      console.warn(`[handlePayrexxWebhook] No Payrexx integration for team=${teamId}`)
      // Return 200 to avoid Payrexx retrying indefinitely for misconfigured teams
      res.status(200).json({ ok: false, reason: 'no_integration' })
      return
    }

    const cfg = intSnap.docs[0].data().config as PayrexxGatewayConfig
    const signingSecret = cfg.webhook_signing_secret ?? ''

    // ── 3. Verify signature ───────────────────────────────────────────────────
    const signatureHeader = req.headers['x-webhook-signature'] as string | undefined
    if (!signatureHeader) {
      console.warn(`[handlePayrexxWebhook] Missing X-Webhook-Signature team=${teamId}`)
      res.status(401).json({ ok: false, reason: 'missing_signature' })
      return
    }

    if (signingSecret) {
      // rawBody is available on Firebase Functions v2 onRequest
      const rawBody: Buffer =
        (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body))
      const expected = crypto.createHmac('sha256', signingSecret).update(rawBody).digest('hex')
      let signatureValid = false
      try {
        const expectedBuf = Buffer.from(expected, 'hex')
        const receivedBuf = Buffer.from(signatureHeader, 'hex')
        signatureValid =
          expectedBuf.length === receivedBuf.length &&
          crypto.timingSafeEqual(expectedBuf, receivedBuf)
      } catch {
        // Invalid hex in header
        signatureValid = false
      }
      if (!signatureValid) {
        console.warn(`[handlePayrexxWebhook] Signature mismatch team=${teamId}`)
        res.status(401).json({ ok: false, reason: 'invalid_signature' })
        return
      }
    } else {
      // No signing secret configured — log a warning but allow through (setup phase)
      console.warn(`[handlePayrexxWebhook] No signing secret configured for team=${teamId} — skipping verification`)
    }

    // ── 4. Parse payload ──────────────────────────────────────────────────────
    const body = req.body as Record<string, unknown>
    const transaction = body.transaction as Record<string, unknown> | undefined
    if (!transaction || typeof transaction !== 'object') {
      console.warn(`[handlePayrexxWebhook] No transaction in body team=${teamId}`)
      res.status(200).json({ ok: false, reason: 'no_transaction' })
      return
    }

    const status = transaction.status as string | undefined
    const mode = transaction.mode as string | undefined
    const transactionId = transaction.id as number | string | undefined

    // Only process confirmed payments
    if (status !== 'confirmed') {
      res.status(200).json({ ok: false, reason: `skipped_status:${status ?? 'unknown'}` })
      return
    }
    // Ignore test transactions unless explicitly allowed (e.g. staging)
    if (mode === 'TEST' && process.env.ALLOW_TEST_PAYREXX !== 'true') {
      res.status(200).json({ ok: false, reason: 'test_mode' })
      return
    }
    if (transactionId === undefined || transactionId === null || transactionId === '') {
      res.status(200).json({ ok: false, reason: 'no_transaction_id' })
      return
    }

    // ── 5. Extract contact email ───────────────────────────────────────────────
    // Email may be absent — we still RECORD the payment (unassigned) so it never
    // silently disappears; a manager links it from the payments dashboard.
    const contactPayload = transaction.contact as Record<string, unknown> | undefined
    const email = (contactPayload?.email as string | undefined)?.trim() || null

    // ── 6. Resolve subscription_type_id ───────────────────────────────────────
    // referenceId is set by the merchant on the Payrexx payment link — use it as
    // the Linyup subscription_type_id. Fall back to the gateway-level default.
    const referenceId = transaction.referenceId as string | undefined
    const subscriptionTypeId =
      (referenceId && referenceId.trim()) || cfg.default_subscription_type_id || null

    // ── 7. Parse membership_expiration from subscription.valid_until ──────────
    const subscriptionPayload = transaction.subscription as Record<string, unknown> | undefined
    const validUntilStr = subscriptionPayload?.valid_until as string | undefined
    let membershipExpiration: Timestamp | null = null
    if (validUntilStr) {
      // Payrexx sends dates like "2026-12-31" — parse as end-of-day UTC
      const d = new Date(`${validUntilStr}T23:59:59Z`)
      if (!isNaN(d.getTime())) {
        membershipExpiration = Timestamp.fromDate(d)
      }
    }

    // ── 8. Default "what was paid" comment ─────────────────────────────────────
    // Suggest the subscription-type name when this payment maps to one, else a
    // generic Payrexx label. A manager can edit it via updatePaymentRecord.
    let comment = 'Payrexx payment'
    if (subscriptionTypeId) {
      const [, typeSnap] = await to(
        db
          .collection(TEAMS_COLLECTION)
          .doc(teamId)
          .collection(SUBSCRIPTION_TYPES_SUBCOLLECTION)
          .doc(subscriptionTypeId)
          .get()
      )
      const name = typeSnap?.exists ? (typeSnap.data()?.name as string | undefined) : undefined
      if (name) comment = name
    }

    // ── 9. Match the contact (UNIQUE active email match only) ──────────────────
    // None or ambiguous (a shared family email) → unassigned; never guess.
    const { contactId } = await resolveSingleContact(teamId, email)
    const assignmentStatus = contactId ? 'assigned' : 'unassigned'

    // ── 10. Atomic write with idempotency guard ────────────────────────────────
    const paymentEventRef = db.doc(
      `${TEAMS_COLLECTION}/${teamId}/${PAYMENT_EVENTS_SUBCOLLECTION}/payrexx:${transactionId}`
    )

    const [txErr] = await to(
      db.runTransaction(async (tx) => {
        const existing = await tx.get(paymentEventRef)
        if (existing.exists) {
          throw new Error('already_processed')
        }

        // Record the payment event (immutable audit trail) — always, even when
        // unassigned, so no payment is ever dropped.
        tx.set(paymentEventRef, {
          gateway: 'payrexx',
          gatewayRef: String(transactionId),
          contact_id: contactId,
          assignment_status: assignmentStatus,
          email,
          amount: typeof transaction.amount === 'number' ? transaction.amount : null,
          currency: cfg.currency,
          subscription_type_id: subscriptionTypeId,
          // Structured link — a manager can enrich it (course/product/price) on assign.
          line_item: subscriptionTypeId
            ? { kind: 'subscription', subscriptionTypeId, label: comment }
            : null,
          membership_expiration: membershipExpiration,
          comment,
          raw_status: status,
          processed_at: FieldValue.serverTimestamp(),
        })

        // Apply the subscription to the contact ONLY when uniquely assigned (same
        // transaction for atomicity). Unassigned payments touch no contact.
        // Note: membership_expiration is NOT written to the contact — the subscription
        // axis (subscription_type_id) is separate from the affiliation axis.
        if (contactId) {
          const contactUpdate: Record<string, unknown> = {
            last_payment_at: FieldValue.serverTimestamp(),
          }
          if (subscriptionTypeId) contactUpdate.subscription_type_id = subscriptionTypeId
          tx.update(db.collection(CONTACTS_COLLECTION).doc(contactId), contactUpdate)
        }
      })
    )

    if (txErr) {
      if ((txErr as Error).message === 'already_processed') {
        console.log(`[handlePayrexxWebhook] Duplicate webhook txId=${transactionId} team=${teamId}`)
        res.status(200).json({ ok: true, contact_id: contactId, duplicate: true })
        return
      }
      console.error(`[handlePayrexxWebhook] Transaction failed team=${teamId}:`, txErr)
      res.status(500).json({ ok: false, reason: 'internal_error' })
      return
    }

    console.log(
      `[handlePayrexxWebhook] team=${teamId} txId=${transactionId} ${assignmentStatus}` +
      (contactId ? ` contact=${contactId}` : ` email=${email ?? 'none'}`) +
      (subscriptionTypeId ? ` sub=${subscriptionTypeId}` : '') +
      (validUntilStr ? ` expires=${validUntilStr}` : '')
    )

    // Finance journal (core infrastructure, best-effort — a failure never breaks
    // payment recording; the backfill reconciles). BYO rails are fee-blind.
    if (typeof transaction.amount === 'number' && transaction.amount > 0) {
      try {
        await recordFinanceTransaction(
          buildExternalPaymentTxn({
            teamId,
            gateway: 'payrexx',
            gatewayRef: String(transactionId),
            amount: transaction.amount,
            currency: cfg.currency,
            contactId,
            lineItemKind: subscriptionTypeId ? 'subscription' : null,
            description: comment,
            occurredAtMs: Date.now(),
          })
        )
      } catch (err) {
        console.error(`[handlePayrexxWebhook] finance journal write failed team=${teamId}:`, err)
      }
    }

    // ── 11. Activity log (best-effort, outside transaction) — assigned only ────
    if (contactId) {
      const activityMsg = [
        `Payment confirmed via Payrexx (tx ${transactionId})`,
        subscriptionTypeId ? `subscription: ${subscriptionTypeId}` : null,
        validUntilStr ? `expires: ${validUntilStr}` : null,
      ].filter(Boolean).join(' · ')

      await to(
        db.collection(CONTACTS_COLLECTION).doc(contactId)
          .collection('activity_log').add(withLedgerExpiry('activity_log', {
            type: 'payment_received',
            source: 'payrexx',
            message: activityMsg,
            timestamp: FieldValue.serverTimestamp(),
          }))
      )
    }

    res.status(200).json({ ok: true, contact_id: contactId, assignment_status: assignmentStatus })
  }
)
