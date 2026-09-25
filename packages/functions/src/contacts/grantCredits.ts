// Admin callable — manually grant lesson credits to a contact (the counterpart
// of a Stripe pack purchase, for cash/bank-transfer sales or goodwill make-up
// lessons). Writes a CreditGrant under contacts/{id}/credit_grants — the ONLY
// client-reachable way to create one, since Firestore rules deny direct writes
// (credits_used must never be client-mutable). The onCreditGrantWrite sync
// recomputes Contact.credit_summary.
//
// TWO THINGS UX-80 ADDED, and the first is why the second is safe:
//
//   • `idempotencyKey` makes the grant doc id DETERMINISTIC, written with
//     `.create()`. A double-click used to mint two grants — twice the credits,
//     silently — and now writes one and reports the second as a duplicate. The
//     key is optional: an omitted one keeps the old auto-id behavior, so no
//     existing caller changes shape.
//   • `sendReceipt` tells the contact they now hold N credits. It is the same
//     credit-pack body the shop sends, with `granted: true` (nobody bought
//     anything here) and no paid line. It is skipped on a duplicate, so the
//     double-click that no longer double-grants also does not double-mail.
//     See payments/deskReceipt.ts for the posture.
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { isTeamMember } from '../utils/teams'
import { sendGrantedCreditsReceipt } from '../payments/deskReceipt'
import {
  CONTACTS_COLLECTION,
  CONTACT_CREDIT_GRANTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type SubscriptionPrice,
} from '@linyup/shared'

export const grantCredits = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.')

  const data = request.data as {
    contactId?: string
    subscriptionTypeId?: string
    priceId?: string
    // Explicit override for a custom grant (no priceId): 1..100 credits.
    credits?: number
    // Validity in months from now (defaults to the price's included_months).
    validityMonths?: number
    // Stable dedupe key; falls back to a fresh doc id (no dedup) when omitted.
    idempotencyKey?: string
    // "Let the contact know" — omitted means no. See the header.
    sendReceipt?: boolean
  }
  if (!data?.contactId || !data?.subscriptionTypeId) {
    throw new HttpsError('invalid-argument', 'contactId and subscriptionTypeId are required.')
  }

  const db = admin.firestore()
  const contactSnap = await db.collection(CONTACTS_COLLECTION).doc(data.contactId).get()
  if (!contactSnap.exists) throw new HttpsError('not-found', 'Contact not found.')
  const teamId = (contactSnap.data()?.teamId ?? contactSnap.data()?.teacher) as string | undefined
  if (!teamId) throw new HttpsError('failed-precondition', 'Contact is not associated with a team.')

  if (!(await isTeamMember(request.auth.uid, teamId))) {
    throw new HttpsError('permission-denied', 'You do not have permission for this contact.')
  }

  const typeSnap = await db
    .collection(TEAMS_COLLECTION)
    .doc(teamId)
    .collection('subscription_types')
    .doc(data.subscriptionTypeId)
    .get()
  if (!typeSnap.exists) throw new HttpsError('not-found', 'Subscription type not found.')
  const typeName = (typeSnap.data()?.name as string) ?? null
  const prices = (typeSnap.data()?.prices as SubscriptionPrice[] | undefined) ?? []
  const price = data.priceId ? prices.find((p) => p.id === data.priceId) : undefined
  if (data.priceId && !price) throw new HttpsError('not-found', 'Price not found on this type.')

  const credits = data.credits ?? price?.credits ?? 0
  if (!Number.isInteger(credits) || credits < 1 || credits > 100) {
    throw new HttpsError('invalid-argument', 'credits must be an integer between 1 and 100.')
  }
  const months = data.validityMonths ?? price?.included_months ?? 0
  let expiresAt: Timestamp | null = null
  if (months > 0) {
    const d = new Date()
    d.setMonth(d.getMonth() + months)
    expiresAt = Timestamp.fromDate(d)
  }

  const grantsCol = db
    .collection(CONTACTS_COLLECTION)
    .doc(data.contactId)
    .collection(CONTACT_CREDIT_GRANTS_SUBCOLLECTION)
  // The key becomes a DOCUMENT ID, so it is stripped to characters that cannot
  // change the path (a '/' would silently address a different subcollection).
  const rawKey = (data.idempotencyKey ?? '').trim().replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 120)
  const grantRef = grantsCol.doc(rawKey || grantsCol.doc().id)
  const payload = {
    teamId,
    subscription_type_id: data.subscriptionTypeId,
    subscription_type_name: typeName,
    price_id: data.priceId ?? null,
    credits_total: credits,
    credits_used: 0,
    expires_at: expiresAt,
    source: 'manual',
    created_at: FieldValue.serverTimestamp(),
    created_by: request.auth.uid,
  }

  // `.create()`, not `.set()`: on a deterministic id a second click must be
  // refused, not overwritten — overwriting would reset `credits_used` on a pack
  // the contact has already drawn on.
  let duplicate = false
  try {
    await grantRef.create(payload)
  } catch (err: unknown) {
    // ALREADY_EXISTS (code 6) — the same grant, clicked twice.
    if ((err as { code?: number }).code === 6) duplicate = true
    else throw err
  }

  if (data.sendReceipt === true && !duplicate) {
    await sendGrantedCreditsReceipt({
      teamId,
      contactId: data.contactId,
      grantId: grantRef.id,
      planName: typeName ?? 'Credits',
    })
  }

  return {
    success: true,
    grantId: grantRef.id,
    credits,
    expiresAt: expiresAt?.toMillis() ?? null,
    duplicate,
  }
})
