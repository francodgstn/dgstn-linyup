// Tarif 595 — previewTarif595Receipt + issueTarif595Receipt.
//
// Both are CREATION and therefore plugin-gated (assertPluginInstalled); the
// download, void and email callables consume what exists and are not
// (docs/plugins.md, "The server gate"; pinned by gate.test.ts).
//
// ── The two-phase issue ──────────────────────────────────────────────────────
// The receipt NUMBER is inside the bytes (request_id, the printed form, the QR
// sheet's XML), so the files cannot be written before the number exists, and
// the number must not be consumed unless a document is written. Hence:
//
//   Phase 1 (transaction): read the receipt ref and the counter; refuse when a
//     voided doc sits at this id (the caller bumps the revision); return the
//     existing doc when it is already issued (a retry is a no-op) or pending
//     (a crashed attempt — resume it); else allocate the number as an ABSOLUTE
//     counter value, freeze the snapshot (guid + timestamps included) with
//     status `pending`, and write both in the same commit.
//   Phase 2 (outside): build the XML and the PDF from the FROZEN snapshot only,
//     upload both with their sha256, flip to `issued`.
//
// A crash between the phases leaves a `pending` row holding a consumed number;
// calling issue again with the same inputs computes the same deterministic id,
// finds it pending, skips allocation and re-renders byte-identical files. The
// number is never lost and never doubled.
//
// NO FINANCE JOURNAL ROW is written here or anywhere in this module — a receipt
// is an attestation, not a money event (noJournal.test.ts pins it).

import * as admin from 'firebase-admin'
import { randomUUID } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import {
  TARIF595_NUMBER_MAX,
  TARIF595_PLUGIN_ID,
  TARIF595_RECEIPTS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_COUNTERS_SUBCOLLECTION,
  TEAM_TARIF595_RECEIPT_COUNTER_DOC,
  tarif595StoragePath,
  type Tarif595IssueRequest,
  type Tarif595IssueResult,
  type Tarif595PreviewResult,
  type Tarif595ReceiptDoc,
  type Tarif595ReceiptRequest,
  type Tarif595Source,
} from '@linyup/shared'
import { assertManager } from '../connect/access'
import { allocateNumber } from '../pdf/numbering'
import { saveWithSha256 } from '../pdf/files'
import { assertPluginInstalled } from '../utils/plugins'
import { buildReceiptDraft } from './draft'
import { sendReceiptEmail } from './email'
import { renderTarif595Pdf } from './render'
import { zurichDay } from './sources'
import { buildTarif595Xml } from './xml'

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

function parseSource(raw: unknown): Tarif595Source | null {
  const s = raw as Partial<Record<string, unknown>> | null
  if (!s || typeof s !== 'object') return null
  if (s.kind === 'subscription' && typeof s.historyId === 'string' && s.historyId) return { kind: 'subscription', historyId: s.historyId }
  if (s.kind === 'attendance' && typeof s.activityId === 'string' && s.activityId) return { kind: 'attendance', activityId: s.activityId }
  if (s.kind === 'course' && typeof s.courseId === 'string' && s.courseId) return { kind: 'course', courseId: s.courseId }
  return null
}

function parseRequest(raw: unknown): Tarif595ReceiptRequest {
  const d = (raw ?? {}) as Partial<Tarif595ReceiptRequest>
  const teamId = typeof d.teamId === 'string' ? d.teamId.trim() : ''
  const contactId = typeof d.contactId === 'string' ? d.contactId.trim() : ''
  const source = parseSource(d.source)
  if (!teamId || !contactId || !source) throw new HttpsError('invalid-argument', 'teamId, contactId and source are required')
  if (typeof d.from !== 'string' || typeof d.to !== 'string' || !ISO_RE.test(d.from) || !ISO_RE.test(d.to)) {
    throw new HttpsError('invalid-argument', 'from and to must be YYYY-MM-DD')
  }
  const unitPriceMinor =
    typeof d.unitPriceMinor === 'number' && Number.isFinite(d.unitPriceMinor) && d.unitPriceMinor >= 0
      ? Math.round(d.unitPriceMinor)
      : null
  return { teamId, contactId, source, from: d.from, to: d.to, unitPriceMinor }
}

export const previewTarif595Receipt = onCall(async (request): Promise<Tarif595PreviewResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const req = parseRequest(request.data)
  await assertManager(request.auth.uid, req.teamId)
  await assertPluginInstalled(req.teamId, TARIF595_PLUGIN_ID)
  const { result } = await buildReceiptDraft(req)
  return result
})

/** Phase 2 — deterministic from the snapshot; safe to run again. */
async function renderAndStore(ref: FirebaseFirestore.DocumentReference, receipt: Tarif595ReceiptDoc): Promise<void> {
  const xml = buildTarif595Xml(receipt)
  const pdf = await renderTarif595Pdf(receipt, xml)
  const meta = { receiptId: receipt.id, number: receipt.number, teamId: receipt.teamId }
  const [pdfRef, xmlRef] = await Promise.all([
    saveWithSha256(tarif595StoragePath(receipt.teamId, receipt.id, 'pdf'), pdf, 'application/pdf', meta),
    saveWithSha256(tarif595StoragePath(receipt.teamId, receipt.id, 'xml'), xml, 'application/xml', meta),
  ])
  await ref.update({ status: 'issued', issued_at: FieldValue.serverTimestamp(), files: { pdf: pdfRef, xml: xmlRef } })
}

export const issueTarif595Receipt = onCall(async (request): Promise<Tarif595IssueResult> => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required')
  const uid = request.auth.uid
  const req = parseRequest(request.data)
  const wantEmail = (request.data as Partial<Tarif595IssueRequest>)?.email === true
  await assertManager(uid, req.teamId)
  await assertPluginInstalled(req.teamId, TARIF595_PLUGIN_ID)

  const { result, frozen, setup } = await buildReceiptDraft(req)
  const db = admin.firestore()
  const teamRef = db.collection(TEAMS_COLLECTION).doc(req.teamId)
  const counterRef = teamRef.collection(TEAM_COUNTERS_SUBCOLLECTION).doc(TEAM_TARIF595_RECEIPT_COUNTER_DOC)

  // An already-issued or pending receipt for this source/period: no new number.
  if (result.existing) {
    const ref = teamRef.collection(TARIF595_RECEIPTS_SUBCOLLECTION).doc(result.existing.receiptId)
    const snap = await ref.get()
    const existing = snap.data() as Tarif595ReceiptDoc | undefined
    if (existing?.status === 'pending') {
      await renderAndStore(ref, existing)
      const emailed = wantEmail ? (await sendReceiptEmail(req.teamId, existing.id)).sent : false
      return { receiptId: existing.id, number: existing.number, status: 'issued', resumed: true, emailed }
    }
    return { receiptId: result.existing.receiptId, number: result.existing.number, status: result.existing.status, resumed: false, emailed: false }
  }
  if (!result.ok || !frozen || !setup) {
    throw new HttpsError('failed-precondition', 'The receipt cannot be issued', {
      reason: result.blocking[0]?.code ?? 'no_lines',
      blocking: result.blocking,
      warnings: result.warnings,
    })
  }

  const ref = teamRef.collection(TARIF595_RECEIPTS_SUBCOLLECTION).doc(frozen.id)
  const now = new Date()
  const issuedOn = zurichDay(now) ?? now.toISOString().slice(0, 10)
  const year = issuedOn.slice(0, 4)

  const outcome = await db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(ref)
    if (existingSnap.exists) {
      const d = existingSnap.data() as Tarif595ReceiptDoc
      if (d.status === 'voided') {
        throw new HttpsError('already-exists', 'This receipt was voided; issue a new revision', { reason: 'receipt_voided' })
      }
      return { receipt: d, resumed: d.status === 'pending', allocated: false }
    }
    const { number } = await allocateNumber(tx, counterRef, setup.config.numbering.prefix, year)
    if (number.length > TARIF595_NUMBER_MAX) {
      throw new HttpsError('failed-precondition', 'The receipt number is too long for the XML schema', { reason: 'number_too_long' })
    }
    const receipt: Tarif595ReceiptDoc = {
      ...frozen,
      number,
      status: 'pending',
      guid: randomUUID().replace(/-/g, ''),
      request_timestamp: Math.floor(now.getTime() / 1000),
      request_date: issuedOn,
      files: null,
      delivery: { send_count: 0, emailed_at: null },
      created_at: FieldValue.serverTimestamp() as unknown as Tarif595ReceiptDoc['created_at'],
      created_by: uid,
    }
    tx.set(ref, receipt)
    return { receipt, resumed: false, allocated: true }
  })

  const receipt = outcome.receipt
  if (receipt.status !== 'issued') await renderAndStore(ref, receipt)
  console.log(
    `[tarif595] issued team=${req.teamId} receipt=${receipt.id} number=${receipt.number} contact=${req.contactId} resumed=${outcome.resumed} by=${uid}`
  )
  const emailed = wantEmail ? (await sendReceiptEmail(req.teamId, receipt.id)).sent : false
  return { receiptId: receipt.id, number: receipt.number, status: 'issued', resumed: outcome.resumed, emailed }
})
