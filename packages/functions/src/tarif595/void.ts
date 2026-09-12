// voidTarif595Receipt — withdraws an issued receipt. A receipt is never edited
// or deleted (Qualitop FAQ 3.11: "Ein Rückforderungsbeleg kann nicht manuell
// korrigiert werden"): the studio voids it and issues a new one, which takes
// the next number and records `replaces`. The files stay — a voided receipt is
// still a record of what was handed out.
//
// NOT plugin-gated: this winds DOWN existing state (docs/plugins.md, "The
// server gate" — gate creation, never consumption). No money moves and no
// journal row is touched: voiding an attestation is not a refund.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { TARIF595_RECEIPTS_SUBCOLLECTION, TEAMS_COLLECTION, type Tarif595ReceiptDoc, type Tarif595VoidRequest } from '@linyup/shared'
import { assertManager } from '../connect/access'

const REASON_MAX = 350

export const voidTarif595Receipt = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const data = (request.data ?? {}) as Partial<Tarif595VoidRequest>
  const teamId = typeof data.teamId === 'string' ? data.teamId.trim() : ''
  const receiptId = typeof data.receiptId === 'string' ? data.receiptId.trim() : ''
  if (!teamId || !receiptId) throw new HttpsError('invalid-argument', 'teamId and receiptId are required')
  const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, REASON_MAX) : null

  await assertManager(request.auth.uid, teamId)

  const ref = admin.firestore().collection(TEAMS_COLLECTION).doc(teamId).collection(TARIF595_RECEIPTS_SUBCOLLECTION).doc(receiptId)
  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'Receipt not found')
    const r = snap.data() as Tarif595ReceiptDoc
    if (r.status === 'voided') return
    if (r.status !== 'issued') {
      // A pending receipt is mid-issue (or a crashed issue waiting to be
      // resumed); voiding it would strand its number. Resume it first.
      throw new HttpsError('failed-precondition', 'Only an issued receipt can be voided', { reason: 'receipt_not_issued' })
    }
    tx.update(ref, {
      status: 'voided',
      voided_at: FieldValue.serverTimestamp(),
      voided_by: request.auth!.uid,
      void_reason: reason || null,
    })
  })

  console.log(`[tarif595] voided team=${teamId} receipt=${receiptId} by=${request.auth.uid}`)
  return { receiptId, status: 'voided' as const }
})
