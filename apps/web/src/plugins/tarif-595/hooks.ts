'use client'

// Tarif 595 plugin — client data access. Pattern: plugins/finance/hooks.ts.
//
// Config + per-contact insurer data are written directly by the client (the
// rules allow manager/owner); receipts are FUNCTIONS-ONLY and reached through the
// typed callables below. Line math never happens here — `previewTarif595Receipt`
// returns the lines the server would issue, and the UI renders exactly those.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import {
  TARIF595_CONTACTS_SUBCOLLECTION,
  TARIF595_RECEIPTS_SUBCOLLECTION,
  TARIF595_SETTINGS_DOC,
  TARIF595_SETTINGS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type Tarif595Config,
  type Tarif595ContactData,
  type Tarif595DownloadRequest,
  type Tarif595DownloadResult,
  type Tarif595EmailRequest,
  type Tarif595EmailResult,
  type Tarif595IssueRequest,
  type Tarif595IssueResult,
  type Tarif595PreviewResult,
  type Tarif595ReceiptDoc,
  type Tarif595ReceiptRequest,
  type Tarif595VoidRequest,
} from '@linyup/shared'
import { db, functions } from '@/lib/firebase'
import { usePagedQuery } from '@/hooks/usePagedQuery'

// ─── Config ───────────────────────────────────────────────────────────────────

export const TARIF595_CONFIG_KEY = 'tarif595-config'
export const TARIF595_CONTACT_KEY = 'tarif595-contact'
export const TARIF595_RECEIPTS_KEY = 'tarif595-receipts'
export const TARIF595_CONTACT_RECEIPTS_KEY = 'tarif595-contact-receipts'
export const TARIF595_RECEIPTS_PAGE_SIZE = 25

function configRef(teamId: string) {
  return doc(db, TEAMS_COLLECTION, teamId, TARIF595_SETTINGS_SUBCOLLECTION, TARIF595_SETTINGS_DOC)
}

export function useTarif595Config(teamId: string | null) {
  return useQuery<Tarif595Config | null>({
    queryKey: [TARIF595_CONFIG_KEY, teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDoc(configRef(teamId!))
      return snap.exists() ? (snap.data() as Tarif595Config) : null
    },
  })
}

export async function saveTarif595Config(
  teamId: string,
  uid: string | null,
  config: Omit<Tarif595Config, 'updated_at' | 'updated_by'>
): Promise<void> {
  // Whole-document write (no merge): the offerings map is a set, and a merge
  // would resurrect a mapping the manager just removed.
  await setDoc(configRef(teamId), { ...config, updated_at: serverTimestamp(), updated_by: uid ?? null })
}

// ─── Per-contact insurer data ─────────────────────────────────────────────────

function contactDataRef(teamId: string, contactId: string) {
  return doc(db, TEAMS_COLLECTION, teamId, TARIF595_CONTACTS_SUBCOLLECTION, contactId)
}

export function useTarif595ContactData(teamId: string | null, contactId: string | null) {
  return useQuery<Tarif595ContactData | null>({
    queryKey: [TARIF595_CONTACT_KEY, teamId, contactId],
    enabled: !!teamId && !!contactId,
    queryFn: async () => {
      const snap = await getDoc(contactDataRef(teamId!, contactId!))
      return snap.exists() ? (snap.data() as Tarif595ContactData) : null
    },
  })
}

export async function saveTarif595ContactData(
  teamId: string,
  contactId: string,
  uid: string | null,
  data: Omit<Tarif595ContactData, 'updated_at' | 'updated_by'>
): Promise<void> {
  await setDoc(
    contactDataRef(teamId, contactId),
    { ...data, updated_at: serverTimestamp(), updated_by: uid ?? null },
    { merge: true }
  )
}

// ─── Receipts (read-only from the client) ─────────────────────────────────────

export type Tarif595ReceiptRow = Tarif595ReceiptDoc & { id: string }

function receiptsCol(teamId: string) {
  return collection(db, TEAMS_COLLECTION, teamId, TARIF595_RECEIPTS_SUBCOLLECTION)
}

function toReceipt(d: QueryDocumentSnapshot<DocumentData>): Tarif595ReceiptRow {
  return { ...(d.data() as Tarif595ReceiptDoc), id: d.id }
}

/** The team's receipts, newest first, paged (LOG collection — bounded by the hook). */
export function useTarif595Receipts(teamId: string | null, pageSize = TARIF595_RECEIPTS_PAGE_SIZE) {
  return usePagedQuery<Tarif595ReceiptRow>({
    queryKey: [TARIF595_RECEIPTS_KEY, teamId],
    enabled: !!teamId,
    pageSize,
    base: () => query(receiptsCol(teamId!), orderBy('created_at', 'desc')),
    map: toReceipt,
  })
}

const CONTACT_RECEIPTS_LIMIT = 100

/** One contact's receipts, newest first. Bounded: a person accumulates a few a year. */
export function useContactTarif595Receipts(teamId: string | null, contactId: string | null) {
  return useQuery<Tarif595ReceiptRow[]>({
    queryKey: [TARIF595_CONTACT_RECEIPTS_KEY, teamId, contactId],
    enabled: !!teamId && !!contactId,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          receiptsCol(teamId!),
          where('contact_id', '==', contactId),
          orderBy('created_at', 'desc'),
          limit(CONTACT_RECEIPTS_LIMIT)
        )
      )
      return snap.docs.map(toReceipt)
    },
  })
}

export function useInvalidateTarif595(teamId: string | null) {
  const qc = useQueryClient()
  return (contactId?: string | null) => {
    void qc.invalidateQueries({ queryKey: [TARIF595_CONFIG_KEY, teamId] })
    void qc.invalidateQueries({ queryKey: [TARIF595_RECEIPTS_KEY, teamId] })
    if (contactId) {
      void qc.invalidateQueries({ queryKey: [TARIF595_CONTACT_KEY, teamId, contactId] })
      void qc.invalidateQueries({ queryKey: [TARIF595_CONTACT_RECEIPTS_KEY, teamId, contactId] })
    } else {
      void qc.invalidateQueries({ queryKey: [TARIF595_CONTACT_RECEIPTS_KEY, teamId] })
    }
  }
}

// ─── Callables ────────────────────────────────────────────────────────────────

export const callPreviewTarif595Receipt = httpsCallable<Tarif595ReceiptRequest, Tarif595PreviewResult>(
  functions,
  'previewTarif595Receipt'
)
export const callIssueTarif595Receipt = httpsCallable<Tarif595IssueRequest, Tarif595IssueResult>(
  functions,
  'issueTarif595Receipt'
)
export const callVoidTarif595Receipt = httpsCallable<Tarif595VoidRequest, { receiptId: string; status: 'voided' }>(
  functions,
  'voidTarif595Receipt'
)
export const callDownloadTarif595Receipt = httpsCallable<Tarif595DownloadRequest, Tarif595DownloadResult>(
  functions,
  'downloadTarif595Receipt'
)
export const callEmailTarif595Receipt = httpsCallable<Tarif595EmailRequest, Tarif595EmailResult>(
  functions,
  'emailTarif595Receipt'
)

/** Turn a download result into a browser download (the ExportFinanceCsvButton shape). */
export function saveDownloadedFile(result: Tarif595DownloadResult): void {
  const binary = atob(result.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: result.contentType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = result.filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function downloadTarif595Receipt(teamId: string, receiptId: string, kind: 'pdf' | 'xml'): Promise<void> {
  const { data } = await callDownloadTarif595Receipt({ teamId, receiptId, kind })
  saveDownloadedFile(data)
}
