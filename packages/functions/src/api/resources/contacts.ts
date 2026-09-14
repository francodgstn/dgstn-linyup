// ─── Contacts — list and read, through the shared predicates only ────────────
//
// Lifecycle is `isLiveContact` / `isRosterContact` / `contactLifecycle`; every
// filter is `matchesFilter`; visibility is `principalSeesContact`. This module
// adds bounded reads and pagination around them, and nothing else.

import * as admin from 'firebase-admin'
import { FieldPath } from 'firebase-admin/firestore'
import {
  CONTACTS_COLLECTION,
  apiTimeMs,
  contactLifecycle,
  isLiveContact,
  isRosterContact,
  matchesFilter,
  normalizeContactFilter,
  projectContact,
  type AcquisitionStage,
  type ApiContact,
  type Contact,
  type EngagementBand,
} from '@linyup/shared'
import { principalSeesContact, type ApiPrincipal } from '../auth/principal'
import { requireScope, type ListPage } from '../access'
import { projectionContext, type TeamReadContext } from '../context'
import { cursorFingerprint, decodeCursor, encodeCursor } from '../cursor'
import { notFound } from '../errors'

/** Documents read per Firestore page. */
const PAGE = 200
/** Documents one list request may read while filtering in memory. */
export const CONTACT_SCAN_BUDGET = 1000
/** An own-scoped coach's whole book is read at once; this bounds it. */
const OWN_SET_CAP = 2000

export type ContactLifecycleView = 'live' | 'roster' | 'external' | 'leads'

export interface ContactListInput {
  limit: number
  cursor?: string | null
  lifecycle: ContactLifecycleView
  query?: string | null
  engagement?: EngagementBand[]
  tags?: string[]
  coachId?: string | null
  stages?: AcquisitionStage[]
  inactiveDays?: number | null
  hasPlan?: boolean
  needsAttention?: boolean
  /** Drop contacts who never attended — "gone quiet" rather than "never came". */
  excludeNeverAttended?: boolean
}

type SortKey = [string, string, string]

function sortKey(c: Pick<Contact, 'lastname' | 'firstname' | 'id'>): SortKey {
  return [c.lastname ?? '', c.firstname ?? '', c.id]
}

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

function inView(contact: Contact, view: ContactLifecycleView): boolean {
  switch (view) {
    case 'live':
      return isLiveContact(contact)
    case 'roster':
      return isRosterContact(contact)
    case 'external':
      return contactLifecycle(contact) === 'external'
    case 'leads':
      return contactLifecycle(contact) === 'provisional'
  }
}

export async function listContacts(
  principal: ApiPrincipal,
  team: TeamReadContext,
  input: ContactListInput,
  nowMs: number
): Promise<ListPage<ApiContact>> {
  requireScope(principal, 'contacts:read')
  const projection = projectionContext(principal, team, nowMs)

  const filter = normalizeContactFilter({
    search: input.query ?? '',
    engagement: input.engagement ?? [],
    tags: input.tags ?? [],
    coaches: input.coachId ? [input.coachId] : [],
    stages: input.stages ?? [],
    needsAttention: input.needsAttention === true,
    inactivity: input.inactiveDays ? `${input.inactiveDays}d` : null,
  })
  const matchCtx = { nowMs, engagementThresholds: team.engagementThresholds }
  const fingerprint = cursorFingerprint({
    lifecycle: input.lifecycle,
    filter: JSON.stringify(filter),
    hasPlan: input.hasPlan,
    excludeNever: input.excludeNeverAttended,
    pii: projection.pii,
  })
  const after = decodeCursor(input.cursor, fingerprint)?.key as SortKey | undefined

  const accept = (contact: Contact): ApiContact | null => {
    if (!inView(contact, input.lifecycle)) return null
    if (!principalSeesContact(principal, contact)) return null
    // Search reads email and phone too. Without the PII scope, the subject the
    // resolver sees has neither, so a search can never confirm an address.
    const subject = projection.pii ? contact : { ...contact, email: undefined, phone: undefined }
    if (!matchesFilter(subject, filter, matchCtx)) return null
    if (input.hasPlan && !(Array.isArray(contact.held_plans) && contact.held_plans.length > 0)) return null
    if (input.excludeNeverAttended && apiTimeMs(contact.last_session_at) === null) return null
    return projectContact(contact, projection)
  }

  const ownOnly = principal.dataScope === 'own' && !principal.capabilities.has('contacts.view.all')
  return ownOnly
    ? listOwnContacts(principal, input.limit, after, fingerprint, accept)
    : listTeamContacts(principal.teamId, input.limit, after, fingerprint, accept)
}

async function listTeamContacts(
  teamId: string,
  limit: number,
  after: SortKey | undefined,
  fingerprint: string,
  accept: (c: Contact) => ApiContact | null
): Promise<ListPage<ApiContact>> {
  const db = admin.firestore()
  const data: ApiContact[] = []
  let position = after
  let scanned = 0
  let reachedEnd = false

  pages: while (scanned < CONTACT_SCAN_BUDGET) {
    // `deleted_at` and `archived_at` are always written (null when clear), so
    // `== null` is the live set — apps/web/src/lib/liveContacts.ts says why.
    let query = db
      .collection(CONTACTS_COLLECTION)
      .where('teamId', '==', teamId)
      .where('deleted_at', '==', null)
      .where('archived_at', '==', null)
      .orderBy('lastname')
      .orderBy('firstname')
      .orderBy(FieldPath.documentId())
      .limit(PAGE)
    if (position) query = query.startAfter(...position)
    const snap = await query.get()

    for (let i = 0; i < snap.docs.length; i++) {
      const contact = { ...(snap.docs[i].data() as Contact), id: snap.docs[i].id }
      scanned += 1
      position = sortKey(contact)
      const projected = accept(contact)
      if (projected) data.push(projected)
      if (data.length >= limit) {
        reachedEnd = snap.docs.length < PAGE && i === snap.docs.length - 1
        break pages
      }
    }
    if (snap.docs.length < PAGE) {
      reachedEnd = true
      break
    }
  }

  const hasMore = !reachedEnd
  return {
    object: 'list',
    data,
    has_more: hasMore,
    next_cursor: hasMore && position ? encodeCursor({ key: position, fingerprint }) : null,
    scanned,
    scan_exhausted: hasMore && data.length < limit,
  }
}

async function listOwnContacts(
  principal: ApiPrincipal,
  limit: number,
  after: SortKey | undefined,
  fingerprint: string,
  accept: (c: Contact) => ApiContact | null
): Promise<ListPage<ApiContact>> {
  const col = admin.firestore().collection(CONTACTS_COLLECTION).where('teamId', '==', principal.teamId)
  // The rules' `callerOwnsContact` is an OR, which Firestore cannot express as
  // one query: assigned to the coach, or created by them.
  const [assigned, created] = await Promise.all([
    col.where('assigned_coach_ids', 'array-contains', principal.uid).limit(OWN_SET_CAP).get(),
    col.where('createdBy', '==', principal.uid).limit(OWN_SET_CAP).get(),
  ])
  const byId = new Map<string, Contact>()
  for (const doc of [...assigned.docs, ...created.docs]) byId.set(doc.id, { ...(doc.data() as Contact), id: doc.id })
  const sorted = [...byId.values()].sort((a, b) => compareKeys(sortKey(a), sortKey(b)))

  const data: ApiContact[] = []
  let position = after
  let index = after ? sorted.findIndex((c) => compareKeys(sortKey(c), after) > 0) : 0
  if (index === -1) index = sorted.length
  for (; index < sorted.length && data.length < limit; index++) {
    position = sortKey(sorted[index])
    const projected = accept(sorted[index])
    if (projected) data.push(projected)
  }
  const hasMore = index < sorted.length
  return {
    object: 'list',
    data,
    has_more: hasMore,
    next_cursor: hasMore && position ? encodeCursor({ key: position, fingerprint }) : null,
  }
}

/** One contact. The same 404 for missing, another team's, out of scope, deleted. */
export async function getContact(
  principal: ApiPrincipal,
  team: TeamReadContext,
  contactId: string,
  nowMs: number
): Promise<ApiContact> {
  requireScope(principal, 'contacts:read')
  const snap = await admin.firestore().collection(CONTACTS_COLLECTION).doc(contactId).get()
  if (!snap.exists) throw notFound('contact')
  const contact = { ...(snap.data() as Contact), id: snap.id }
  if (contact.teamId !== principal.teamId || !principalSeesContact(principal, contact)) throw notFound('contact')
  const projected = projectContact(contact, projectionContext(principal, team, nowMs))
  if (!projected) throw notFound('contact')
  return projected
}
