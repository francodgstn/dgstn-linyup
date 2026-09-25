import * as admin from 'firebase-admin'
import { createHash } from 'crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { MAIL_SUPPRESSIONS_COLLECTION, type MailSuppressionReason } from '@linyup/shared'

// Doc id for a suppressed recipient — sha256 of the normalized address, so a raw
// email is never used as a Firestore key.
export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

function suppressionRef(email: string) {
  return admin.firestore().collection(MAIL_SUPPRESSIONS_COLLECTION).doc(emailHash(email))
}

export async function isSuppressed(email: string): Promise<boolean> {
  const snap = await suppressionRef(email).get()
  return snap.exists
}

// Upserts a suppression. Preserves created_at on repeat events; refreshes reason
// + updated_at. Called by the webhook handler on bounce/block/spam/invalid.
export async function addSuppression(
  email: string,
  reason: MailSuppressionReason,
  providerMessageId?: string,
): Promise<void> {
  const ref = suppressionRef(email)
  const existing = await ref.get()
  await ref.set(
    {
      email: email.trim().toLowerCase(),
      reason,
      ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
      updated_at: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { created_at: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  )
}
