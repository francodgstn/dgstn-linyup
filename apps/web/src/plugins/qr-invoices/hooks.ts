'use client'

// QR-bill invoices — client data access. Pattern: plugins/tarif-595/hooks.ts.
// Settings are written by the client (manager+); invoices are FUNCTIONS-ONLY
// and reached through the typed callables below.

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
  INVOICES_SUBCOLLECTION,
  INVOICE_SETTINGS_DOC,
  INVOICE_SETTINGS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  type CreateInvoiceRequest,
  type CreateInvoiceResult,
  type DocumentDownloadResult,
  type EmailInvoiceRequest,
  type InvoiceDoc,
  type InvoiceRefRequest,
  type InvoiceSettings,
  type MarkInvoicePaidRequest,
  type MarkInvoicePaidResult,
  type VoidInvoiceRequest,
} from '@linyup/shared'
import { db, functions } from '@/lib/firebase'
import { usePagedQuery } from '@/hooks/usePagedQuery'
import { saveDownloadedFile } from '@/plugins/tarif-595/hooks'

export const INVOICE_SETTINGS_KEY = 'invoice-settings'
export const INVOICES_KEY = 'invoices'
export const CONTACT_INVOICES_KEY = 'contact-invoices'
export const INVOICES_PAGE_SIZE = 25

function settingsRef(teamId: string) {
  return doc(db, TEAMS_COLLECTION, teamId, INVOICE_SETTINGS_SUBCOLLECTION, INVOICE_SETTINGS_DOC)
}

export function useInvoiceSettings(teamId: string | null) {
  return useQuery<InvoiceSettings | null>({
    queryKey: [INVOICE_SETTINGS_KEY, teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDoc(settingsRef(teamId!))
      return snap.exists() ? (snap.data() as InvoiceSettings) : null
    },
  })
}

export async function saveInvoiceSettings(
  teamId: string,
  uid: string | null,
  settings: Omit<InvoiceSettings, 'updated_at' | 'updated_by'>
): Promise<void> {
  await setDoc(settingsRef(teamId), { ...settings, updated_at: serverTimestamp(), updated_by: uid ?? null }, { merge: true })
}

export type InvoiceRow = InvoiceDoc & { id: string }

function invoicesCol(teamId: string) {
  return collection(db, TEAMS_COLLECTION, teamId, INVOICES_SUBCOLLECTION)
}

function toInvoice(d: QueryDocumentSnapshot<DocumentData>): InvoiceRow {
  return { ...(d.data() as InvoiceDoc), id: d.id }
}

/** The team's invoices, newest first, paged (LOG collection — bounded by the hook). */
export function useInvoices(teamId: string | null, pageSize = INVOICES_PAGE_SIZE) {
  return usePagedQuery<InvoiceRow>({
    queryKey: [INVOICES_KEY, teamId],
    enabled: !!teamId,
    pageSize,
    base: () => query(invoicesCol(teamId!), orderBy('created_at', 'desc')),
    map: toInvoice,
  })
}

const CONTACT_INVOICES_LIMIT = 100

/** One contact's invoices, newest first. Bounded: a person gets a few a year. */
export function useContactInvoices(teamId: string | null, contactId: string | null) {
  return useQuery<InvoiceRow[]>({
    queryKey: [CONTACT_INVOICES_KEY, teamId, contactId],
    enabled: !!teamId && !!contactId,
    queryFn: async () => {
      const snap = await getDocs(
        query(invoicesCol(teamId!), where('contact_id', '==', contactId), orderBy('created_at', 'desc'), limit(CONTACT_INVOICES_LIMIT))
      )
      return snap.docs.map(toInvoice)
    },
  })
}

export function useInvalidateInvoices(teamId: string | null) {
  const qc = useQueryClient()
  return (contactId?: string | null) => {
    void qc.invalidateQueries({ queryKey: [INVOICE_SETTINGS_KEY, teamId] })
    void qc.invalidateQueries({ queryKey: [INVOICES_KEY, teamId] })
    void qc.invalidateQueries({ queryKey: contactId ? [CONTACT_INVOICES_KEY, teamId, contactId] : [CONTACT_INVOICES_KEY, teamId] })
    // A paid invoice wrote a payment_events row — the payments surfaces re-read.
    void qc.invalidateQueries({ queryKey: ['payment-events'] })
    void qc.invalidateQueries({ queryKey: ['contact-payments'] })
  }
}

// ─── Callables ────────────────────────────────────────────────────────────────

export const callCreateInvoice = httpsCallable<CreateInvoiceRequest, CreateInvoiceResult>(functions, 'createInvoice')
export const callVoidInvoice = httpsCallable<VoidInvoiceRequest, { invoiceId: string; status: 'void' }>(functions, 'voidInvoice')
export const callDownloadInvoice = httpsCallable<InvoiceRefRequest, DocumentDownloadResult>(functions, 'downloadInvoice')
export const callEmailInvoice = httpsCallable<EmailInvoiceRequest, { sent: boolean; send_count: number }>(functions, 'emailInvoice')
export const callMarkInvoicePaid = httpsCallable<MarkInvoicePaidRequest, MarkInvoicePaidResult>(functions, 'markInvoicePaid')

export async function downloadInvoice(teamId: string, invoiceId: string): Promise<void> {
  const { data } = await callDownloadInvoice({ teamId, invoiceId })
  saveDownloadedFile(data)
}

/** A per-attempt key: the same dialog submission retried lands on the same invoice. */
export function newInvoiceRequestKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
