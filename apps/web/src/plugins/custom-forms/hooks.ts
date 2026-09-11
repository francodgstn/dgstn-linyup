'use client'

import { useQuery } from '@tanstack/react-query'
import {
  collection, doc, getDoc, getDocs, query, where, orderBy,
  setDoc, updateDoc, deleteDoc, serverTimestamp, getCountFromServer,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { usePagedQuery } from '@/hooks/usePagedQuery'
import { FORMS_COLLECTION, FORM_SUBMISSIONS_SUBCOLLECTION } from '@linyup/shared'
import type { Form, FormField, FormSubmission, FormSubmissionStatus } from '@linyup/shared'

// ─── Helpers ────────────────────────────────────────────────────────────────

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 48)
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${base || 'form'}-${suffix}`
}

function formsCol() {
  return collection(db, FORMS_COLLECTION)
}
function submissionsCol(formId: string) {
  return collection(db, FORMS_COLLECTION, formId, FORM_SUBMISSIONS_SUBCOLLECTION)
}

// ─── Queries ────────────────────────────────────────────────────────────────

export function useForms(teamId: string | null) {
  return useQuery<Form[]>({
    queryKey: ['forms', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(formsCol(), where('teamId', '==', teamId), orderBy('created_at', 'desc')),
      )
      return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Form, 'id'>) }))
    },
  })
}

export function useForm(formId: string | null) {
  return useQuery<Form | null>({
    queryKey: ['form', formId],
    enabled: !!formId,
    queryFn: async () => {
      const d = await getDoc(doc(formsCol(), formId!))
      return d.exists() ? ({ id: d.id, ...(d.data() as Omit<Form, 'id'>) }) : null
    },
  })
}

/** The Responses tab's page. A lead form fills at a rate a studio never
 *  predicts, so the list is walked a page at a time
 *  (docs/scalability-2026-09.md §17 B5). */
export const SUBMISSIONS_PAGE_SIZE = 50

function submissionsQuery(formId: string) {
  return query(submissionsCol(formId), orderBy('submitted_at', 'desc'))
}

function toSubmission(d: { id: string; data: () => unknown }): FormSubmission {
  return { id: d.id, ...(d.data() as Omit<FormSubmission, 'id'>) }
}

/** Newest responses first, a page at a time. The query key keeps the
 *  `['form-submissions', formId]` prefix the status mutation invalidates. */
export function useSubmissionsPage(formId: string | null, pageSize = SUBMISSIONS_PAGE_SIZE) {
  return usePagedQuery<FormSubmission>({
    queryKey: ['form-submissions', formId],
    enabled: !!formId,
    pageSize,
    base: () => submissionsQuery(formId!),
    map: toSubmission,
  })
}

/** EVERY response, for the CSV export — its own read, made when the studio
 *  clicks Export, never on a page load. The list is paged, so exporting what
 *  the list holds would silently ship the first page (§18); an export reads
 *  the whole set by definition, and one explicit read per export is the cost. */
export async function fetchAllSubmissions(formId: string): Promise<FormSubmission[]> {
  const snap = await getDocs(submissionsQuery(formId))
  return snap.docs.map(toSubmission)
}

// ─── Mutations (plain async helpers; call from useMutation in components) ──────

export async function createForm(input: {
  teamId: string
  userId: string
  title: string
}): Promise<string> {
  const ref = doc(formsCol())
  const payload: Omit<Form, 'id' | 'created_at' | 'updated_at'> & {
    created_at: ReturnType<typeof serverTimestamp>
    updated_at: ReturnType<typeof serverTimestamp>
  } = {
    teamId: input.teamId,
    title: input.title,
    slug: slugify(input.title),
    status: 'draft',
    access: 'public',
    fields: [],
    createContact: true,
    emailFieldId: null,
    notifications: { notifyStaff: true, confirmSubmitter: false },
    submissionCount: 0,
    createdBy: input.userId,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  }
  await setDoc(ref, payload)
  return ref.id
}

/**
 * Copy a form. Goes through `createForm` — the SAME create path the "New form"
 * button uses — and then patches the copy with what the source said, so there is
 * only ever one writer of a form's first state.
 *
 * What a copy deliberately does NOT inherit:
 *   • the SLUG — `createForm` mints a fresh one (`slugify` adds a random
 *     suffix). It is the form's public URL; two forms answering the same link is
 *     the one unrecoverable mistake available here.
 *   • the PUBLISHED state — a copy starts as a `draft`, so it is not live the
 *     instant it is created.
 *   • the SUBMISSIONS and their count — they belong to the form that was filled
 *     in, and are a subcollection besides.
 *   • `archived_at`, `createdBy`, `created_at` — all minted for the new doc.
 *
 * Field IDs ARE kept: they key the answers of a form that has no answers yet,
 * and are scoped to their own document.
 */
export async function duplicateForm(input: {
  source: Form
  userId: string
  title: string
}): Promise<string> {
  const { source, userId, title } = input
  const formId = await createForm({ teamId: source.teamId, userId, title })
  await updateForm(formId, {
    description: source.description,
    access: source.access,
    fields: source.fields ?? [],
    createContact: source.createContact,
    emailFieldId: source.emailFieldId,
    notifications: source.notifications,
    confirmation: source.confirmation,
  })
  return formId
}

export type FormPatch = Partial<
  Pick<
    Form,
    | 'title'
    | 'description'
    | 'status'
    | 'access'
    | 'fields'
    | 'createContact'
    | 'emailFieldId'
    | 'notifications'
    | 'confirmation'
    | 'archived_at'
  >
>

export async function updateForm(formId: string, patch: FormPatch): Promise<void> {
  await updateDoc(doc(formsCol(), formId), {
    ...stripUndefined(patch as Record<string, unknown>),
    updated_at: serverTimestamp(),
  })
}

export async function deleteForm(formId: string): Promise<void> {
  // Submissions are a subcollection; Firestore doesn't cascade. Delete them first.
  // A whole read, on an explicit destructive action rather than a page load.
  const subs = await getDocs(submissionsCol(formId))
  await Promise.all(subs.docs.map((d) => deleteDoc(d.ref)))
  await deleteDoc(doc(formsCol(), formId))
}

export async function setSubmissionStatus(
  formId: string,
  submissionId: string,
  status: FormSubmissionStatus,
): Promise<void> {
  await updateDoc(doc(submissionsCol(formId), submissionId), { status })
}

// Live form count for the team — used to enforce MAX_FORMS_PER_TEAM even when the
// cached list query is stale.
export async function countForms(teamId: string): Promise<number> {
  const snap = await getCountFromServer(query(formsCol(), where('teamId', '==', teamId)))
  return snap.data().count
}

// A blank field with a fresh stable id, for the Build tab.
export function makeField(type: FormField['type'], order: number): FormField {
  const id = `f_${Math.random().toString(36).slice(2, 10)}`
  return { id, type, label: '', required: false, order, options: [] }
}

// Firestore rejects `undefined` field values; drop them before writing.
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}
