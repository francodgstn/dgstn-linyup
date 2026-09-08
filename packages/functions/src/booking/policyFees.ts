/* eslint-disable no-console */
// No-show policy (E5) — the strike counter + fee lifecycle. See
// @linyup/shared types/policy.ts for the settings/fee shapes and the model
// (TeamUp-style: every no-show increments a rolling counter; hitting the
// team's threshold creates ONE fee and resets the counter). Fees live at
// teams/{teamId}/policy_fees/{feeId} — manager read, function-only write
// (firestore.rules already covers this).
//
// This file owns:
//  • processNoShowStrike — the transactional strike counter, called
//    best-effort from automation/onBookingWrite.ts on every 'booking_no_show'
//    transition. Never throws — a policy failure must not break automations.
//  • createPolicyFeeCheckoutUrl — mints the Stripe Connect payment link for a
//    fee (reuses the same money core as every other one-off checkout).
//  • markPolicyFeePaid — called by the Connect webhook (kind 'policy_fee') to
//    settle a fee idempotently.
//  • resendPolicyFeeLink / waivePolicyFee — manager callables.
//
// v1 deliberately never auto-charges a saved card: the fee is ALWAYS an
// emailed payment link (or, if the team has no chargeable Connect account,
// settle-in-person instructions). Off-session card charges are a separate,
// reviewed follow-up.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  CONTACTS_COLLECTION,
  POLICY_FEES_SUBCOLLECTION,
  TEAMS_COLLECTION,
  resolveNoShowPolicy,
  type PolicyFee,
} from '@linyup/shared'
import { assertManager, loadEnabledTeam, requireChargeableAccount, type EnabledTeam } from '../connect/access'
import {
  buildResultUrls,
  defaultIdempotencyKey,
  requireChargeableAmountFromMajor,
  startOneOffCheckout,
} from '../connect/checkout'
import { getTeam } from '../utils/teams'
import { sendEmail, buildEmailTemplate } from '../utils/email'
import { ctaButton } from '../utils/emailLayout'
import { escapeHtml } from '../utils/html'

// Rolling ref list kept on the contact — capped so it never grows unbounded
// across a long no-show streak below threshold.
const MAX_STRIKE_REFS = 10

function policyFeesRef(teamId: string): FirebaseFirestore.CollectionReference {
  return admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(POLICY_FEES_SUBCOLLECTION)
}

// ─────────────────────────────────────────────────────────────────────────────
// createPolicyFeeCheckoutUrl — mint the Stripe Connect payment link for a fee.
// ─────────────────────────────────────────────────────────────────────────────
export async function createPolicyFeeCheckoutUrl(params: {
  team: EnabledTeam
  fee: PolicyFee
  locale?: string
}): Promise<string> {
  const { team, fee } = params
  const locale = params.locale ?? 'en'
  const amountMinor = requireChargeableAmountFromMajor(fee.amount)
  const { successUrl, cancelUrl } = await buildResultUrls(locale, { teamId: team.id })

  const metadata: Record<string, string> = {
    teamId: team.id,
    kind: 'policy_fee',
    purpose: 'policy_fee',
    feeId: fee.id,
    contactId: fee.contactId,
  }

  const checkout = await startOneOffCheckout({
    team,
    amountMinor,
    productName: 'No-show fee',
    successUrl,
    cancelUrl,
    customerEmail: fee.contactEmail ?? undefined,
    metadata,
    idempotencyKey: defaultIdempotencyKey('fee', team.id, fee.id),
    label: 'createPolicyFeeCheckoutUrl',
  })
  return checkout.url
}

// ─────────────────────────────────────────────────────────────────────────────
// The strike email — professional, no emoji. Omits the "Pay now" button (and
// says so) when the team has no chargeable Connect account.
// ─────────────────────────────────────────────────────────────────────────────
function buildPolicyFeeEmail(params: {
  firstname: string
  teamName: string
  strikeCount: number
  amountMajor: number
  currency: string
  paymentUrl: string | null
}) {
  const { firstname, teamName, strikeCount, amountMajor, currency, paymentUrl } = params
  const amountStr = `${currency} ${amountMajor.toFixed(2)}`
  const classesWord = strikeCount === 1 ? 'class' : 'classes'
  const body = [
    `<p>Hi ${escapeHtml(firstname)},</p>`,
    `<p>You have missed ${strikeCount} booked ${classesWord} without cancelling in advance. Per ${escapeHtml(
      teamName
    )}'s no-show policy, a fee of <strong>${amountStr}</strong> now applies.</p>`,
    paymentUrl
      ? `<p style="margin:16px 0;text-align:center;">${ctaButton(paymentUrl, 'Pay now')}</p>`
      : `<p>Please settle this fee directly with ${escapeHtml(teamName)}.</p>`,
    `<p>If you believe this is a mistake, please get in touch with ${escapeHtml(teamName)}.</p>`,
  ].join('\n')
  return buildEmailTemplate({ title: 'No-show fee', body })
}

/** Best-effort: build (when the team has a chargeable Connect account) a
 *  payment link and email the fee to the contact. Never throws — a mail or
 *  Connect failure must not surface to the strike-counting transaction that
 *  already committed. */
async function sendPolicyFeeEmail(params: { teamId: string; teamName: string; fee: PolicyFee }): Promise<void> {
  const { teamId, teamName, fee } = params
  if (!fee.contactEmail) {
    console.warn(`[policyFees] fee=${fee.id}: contact has no email, skipping notification`)
    return
  }

  let paymentUrl: string | null = null
  try {
    const enabledTeam = await loadEnabledTeam(teamId)
    requireChargeableAccount(enabledTeam) // throws if onboarding isn't complete
    paymentUrl = await createPolicyFeeCheckoutUrl({ team: enabledTeam, fee })
  } catch (err) {
    // No chargeable account (or Connect disabled) — fall back to
    // settle-in-person copy, never block the notification on this.
    console.warn(`[policyFees] fee=${fee.id}: no payment link available:`, err)
  }

  const firstname = fee.contactName?.split(' ')[0]?.trim() || 'there'
  const { html, text } = buildPolicyFeeEmail({
    firstname,
    teamName,
    strikeCount: fee.strike_booking_refs.length,
    amountMajor: fee.amount,
    currency: fee.currency,
    paymentUrl,
  })

  await sendEmail({
    to: fee.contactEmail,
    subject: `No-show fee — ${teamName}`,
    html,
    text,
    teamId,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// processNoShowStrike — the transactional strike counter. Called best-effort
// from onBookingWrite on every 'booking_no_show' transition.
// ─────────────────────────────────────────────────────────────────────────────
export async function processNoShowStrike(params: {
  teamId: string
  contactId: string
  sessionId: string
  bookingId: string
}): Promise<void> {
  const { teamId, contactId, sessionId, bookingId } = params

  const team = await getTeam(teamId)
  if (!team) return
  const policy = resolveNoShowPolicy(team.settings)
  if (!policy) return // policy off — nothing to do

  const db = admin.firestore()
  const contactRef = db.collection(CONTACTS_COLLECTION).doc(contactId)
  const feeRef = policyFeesRef(teamId).doc()
  const strikeRef = `${sessionId}/${bookingId}`

  let createdFee: PolicyFee | null = null

  await db.runTransaction(async (tx) => {
    // A Firestore transaction RETRIES this closure on contention — reset the
    // out-param first, or an aborted attempt that reached the threshold leaks
    // its fee into the email step while the final attempt wrote nothing
    // (phantom fee with a live payment link).
    createdFee = null
    const cSnap = await tx.get(contactRef)
    if (!cSnap.exists || cSnap.data()?.teamId !== teamId) return
    const contact = cSnap.data()!

    const strikes = ((contact.no_show_strikes as number | undefined) ?? 0) + 1
    const refs = [...((contact.no_show_strike_refs as string[] | undefined) ?? []), strikeRef].slice(
      -MAX_STRIKE_REFS
    )

    if (strikes < policy.threshold) {
      tx.set(contactRef, { no_show_strikes: strikes, no_show_strike_refs: refs }, { merge: true })
      return
    }

    // Threshold reached: create the fee, reset the counter.
    const contactName =
      `${(contact.firstname as string | undefined) ?? ''} ${(contact.lastname as string | undefined) ?? ''}`
        .trim() || null
    const fee: PolicyFee = {
      id: feeRef.id,
      teamId,
      contactId,
      contactName,
      contactEmail: (contact.email as string | undefined) ?? null,
      amount: policy.feeAmount,
      currency: (team.default_currency as string | undefined) ?? 'CHF',
      status: 'pending',
      strike_booking_refs: refs,
    }
    tx.set(feeRef, { ...fee, created_at: FieldValue.serverTimestamp() })
    tx.set(contactRef, { no_show_strikes: 0, no_show_strike_refs: [] }, { merge: true })
    createdFee = fee
  })

  if (createdFee) {
    await sendPolicyFeeEmail({ teamId, teamName: team.name || 'the studio', fee: createdFee }).catch((err) => {
      console.error(`[policyFees] strike notification failed (fee=${(createdFee as PolicyFee).id}):`, err)
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// markPolicyFeePaid — called by the Connect webhook (kind 'policy_fee').
// Idempotent: a redelivered event (checkout.session.completed +
// payment_intent.succeeded) is a no-op once already paid.
// ─────────────────────────────────────────────────────────────────────────────
export async function markPolicyFeePaid(params: {
  teamId: string
  feeId: string
  paymentIntentId: string | null
}): Promise<void> {
  const ref = policyFeesRef(params.teamId).doc(params.feeId)
  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return
    if (snap.data()?.status === 'paid') return
    tx.set(
      ref,
      {
        status: 'paid',
        paid_at: FieldValue.serverTimestamp(),
        payment_intent_id: params.paymentIntentId,
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// resendPolicyFeeLink — manager callable, re-sends the payment-link email.
// ─────────────────────────────────────────────────────────────────────────────
export const resendPolicyFeeLink = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = request.data as { teamId?: string; feeId?: string }
  if (!data?.teamId || !data?.feeId) {
    throw new HttpsError('invalid-argument', 'teamId and feeId are required')
  }
  await assertManager(request.auth.uid, data.teamId)

  const snap = await policyFeesRef(data.teamId).doc(data.feeId).get()
  if (!snap.exists || snap.data()?.teamId !== data.teamId) {
    throw new HttpsError('not-found', 'Fee not found')
  }
  const fee = { id: snap.id, ...snap.data() } as PolicyFee
  if (fee.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'This fee is not pending')
  }

  const team = await getTeam(data.teamId)
  if (!team) throw new HttpsError('not-found', 'Team not found')

  await sendPolicyFeeEmail({ teamId: data.teamId, teamName: team.name || 'the studio', fee })
  return { ok: true }
})

// ─────────────────────────────────────────────────────────────────────────────
// waivePolicyFee — manager callable, e.g. a legitimate exception.
// ─────────────────────────────────────────────────────────────────────────────
export const waivePolicyFee = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = request.data as { teamId?: string; feeId?: string }
  if (!data?.teamId || !data?.feeId) {
    throw new HttpsError('invalid-argument', 'teamId and feeId are required')
  }
  await assertManager(request.auth.uid, data.teamId)

  const ref = policyFeesRef(data.teamId).doc(data.feeId)
  const snap = await ref.get()
  if (!snap.exists || snap.data()?.teamId !== data.teamId) {
    throw new HttpsError('not-found', 'Fee not found')
  }
  if (snap.data()?.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Only a pending fee can be waived')
  }

  await ref.set(
    {
      status: 'waived',
      waived_at: FieldValue.serverTimestamp(),
      waived_by: request.auth.uid,
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )
  return { ok: true }
})
