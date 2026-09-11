'use client'

// NOTE ON THIS DIRECTORY'S NAME: `src/plugins/documents/` is historical.
// Documents stopped being a plugin — there is no manifest, no marketplace card
// and no install gate — but the module namespace was left where it is, because
// moving it renames a dozen import paths and changes nothing. The ROUTE did
// move: the pages live at `/documents`, with a redirect shim at the old
// `/plugins/documents`.

import { useQuery } from '@tanstack/react-query'
import {
  collection, doc, getDoc, getDocs, query, where, orderBy,
  setDoc, updateDoc, deleteDoc, serverTimestamp, getCountFromServer, writeBatch,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import {
  DOCUMENTS_COLLECTION,
  DOCUMENTS_SETTINGS_DOC_ID,
  DOCUMENT_VERSIONS_SUBCOLLECTION,
  INSTALLED_PLUGINS_SUBCOLLECTION,
  TEAMS_COLLECTION,
  TEAM_SETTINGS_SUBCOLLECTION,
  resolveSignupDocumentIds,
} from '@linyup/shared'
import type {
  StudioDocument,
  DocumentKind,
  DocumentSource,
  DocumentStatus,
  DocumentVersion,
  PublishOutcome,
  WaiverConfig,
} from '@linyup/shared'

/** The plugin's id — the doc id under `installed_plugins`, not a collection path. */
const DOCUMENTS_PLUGIN_ID = 'documents'

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
  return `${base || 'document'}-${suffix}`
}

// Firestore rejects `undefined` field values; drop them before writing.
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>
}

function documentsCol() {
  return collection(db, DOCUMENTS_COLLECTION)
}

// ─── Queries ────────────────────────────────────────────────────────────────

export function useDocuments(teamId: string | null) {
  return useQuery<StudioDocument[]>({
    queryKey: ['documents', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(documentsCol(), where('teamId', '==', teamId), orderBy('created_at', 'desc')),
      )
      return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StudioDocument, 'id'>) }))
    },
  })
}

export function useDocument(id: string | null) {
  return useQuery<StudioDocument | null>({
    queryKey: ['document', id],
    enabled: !!id,
    queryFn: async () => {
      const d = await getDoc(doc(documentsCol(), id!))
      return d.exists() ? ({ id: d.id, ...(d.data() as Omit<StudioDocument, 'id'>) }) : null
    },
  })
}

/**
 * The document's immutable published snapshots, newest first.
 *
 * This is a direct client read, and it is the one the rules grant on purpose:
 * `documents/{id}/versions/{v}` is `allow read: if isAuthed() && isTeamMember(…)`
 * so the studio's own version history is a plain list. The no-client-reads rule
 * that covers acceptances and signer rows is about the PUBLIC
 * surfaces, where the reader is a visitor with no membership and every answer has
 * to come from a callable.
 *
 * Ordered by document id rather than by `published_at`: version ids are
 * zero-padded (`v0001`), so id order IS chronological and no index is needed.
 */
export function useDocumentVersions(documentId: string | null) {
  return useQuery<DocumentVersion[]>({
    queryKey: ['document-versions', documentId],
    enabled: !!documentId,
    queryFn: async () => {
      const snap = await getDocs(
        collection(doc(documentsCol(), documentId!), DOCUMENT_VERSIONS_SUBCOLLECTION),
      )
      return snap.docs
        .map((d) => d.data() as DocumentVersion)
        .sort((a, b) => b.version - a.version)
    },
  })
}

// ─── Signup-consent settings (teams/{teamId}/settings/documents) ─────────────
// Documents is no longer a plugin, so this config moved out of
// `installed_plugins/documents.config`. Reads are DUAL and go through the shared
// resolveSignupDocumentIds so this panel and syncTeamPublicProfile cannot
// disagree about which location wins; writes only ever go to the new home.

export function useSignupDocumentIds(teamId: string | null) {
  return useQuery<string[]>({
    queryKey: ['documents-settings', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const [settings, legacy] = await Promise.all([
        getDoc(doc(db, TEAMS_COLLECTION, teamId!, TEAM_SETTINGS_SUBCOLLECTION, DOCUMENTS_SETTINGS_DOC_ID)),
        getDoc(doc(db, TEAMS_COLLECTION, teamId!, INSTALLED_PLUGINS_SUBCOLLECTION, DOCUMENTS_PLUGIN_ID)),
      ])
      return resolveSignupDocumentIds({
        settings: settings.data() as { signupDocumentIds?: string[] } | undefined,
        legacyPluginConfig: legacy.data()?.config as { signupDocumentIds?: unknown } | undefined,
      })
    },
  })
}

/**
 * Saves the selection AND nudges the team doc, in one batch.
 *
 * The nudge is not optional. `TeamPublicProfile.signup_documents` — the ONLY
 * thing the public signup form reads — is computed by `syncTeamPublicProfile`,
 * which triggers on writes to `teams/{teamId}`. Nothing triggers on
 * `teams/{teamId}/settings/{settingId}`, so a save that touched only the
 * settings doc left the mirror exactly as it was: empty for a studio
 * configuring consent for the first time. The form then rendered its fallback
 * sentence with no link to the Terms, and because it echoes back only what it
 * displayed, `recordSignupConsent` received an empty echo and wrote ZERO
 * acceptance rows — a studio believing it collects consent, with no record of
 * any of it, and no error anywhere.
 *
 * This regressed when the config moved out of `installed_plugins/documents`:
 * that path fires `onInstalledPluginStatusChange`, which touches the team on
 * every write. `surfaces_updated_at` is the same nudge the server-side
 * `touchTeamForSurfaceRecompute` writes, and the waiver policy stamps it inside
 * its own transaction (waivers/publish.ts) for exactly this reason.
 *
 * Batched so the two cannot diverge: both writes are owner-only, so anyone
 * allowed to make the selection is allowed to nudge the team.
 */
export async function saveSignupDocumentIds(teamId: string, ids: string[]): Promise<void> {
  const batch = writeBatch(db)
  batch.set(
    doc(db, TEAMS_COLLECTION, teamId, TEAM_SETTINGS_SUBCOLLECTION, DOCUMENTS_SETTINGS_DOC_ID),
    { signupDocumentIds: ids, updated_at: serverTimestamp() },
    { merge: true },
  )
  batch.set(
    doc(db, TEAMS_COLLECTION, teamId),
    { surfaces_updated_at: serverTimestamp() },
    { merge: true },
  )
  await batch.commit()
}

// ─── Mutations (plain async helpers; call from useMutation in components) ──

export async function createDocument(input: {
  teamId: string
  userId: string
  title: string
  kind: DocumentKind
  source: DocumentSource
}): Promise<string> {
  const ref = doc(documentsCol())
  const payload = {
    teamId: input.teamId,
    title: input.title,
    slug: slugify(input.title),
    kind: input.kind,
    source: input.source,
    status: 'draft' as const,
    isPublic: false,
    order: 0,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
    createdBy: input.userId,
  }
  await setDoc(ref, payload)
  return ref.id
}

/**
 * Copy a document. Goes through `createDocument` — the same path "New document"
 * takes — then patches the copy with the source's content, so a document's first
 * state has one writer.
 *
 * NOT inherited, on purpose:
 *   • the SLUG — re-minted by `createDocument` (random suffix); it is the public
 *     URL of a shared document.
 *   • the PUBLISHED state and `isPublic` — a copy starts as an unshared DRAFT.
 *     Text a studio has not read again is not text it has agreed to publish.
 *   • the VERSION history (`current_version`, `min_valid_version`, the immutable
 *     `versions/*` snapshots) and any acceptances — those are facts about the
 *     document that was published and the people who accepted it, and they are
 *     server-written besides.
 *
 * WAIVERS ARE EXCLUDED, and not as an oversight: `firestore.rules` denies client
 * create/update/delete on `kind: 'waiver'` in every direction, so a waiver can
 * only be minted by the `createWaiver` callable. Copying one needs a server
 * change, not a client one.
 */
export async function duplicateDocument(input: {
  source: StudioDocument
  userId: string
  title: string
}): Promise<string> {
  const { source, userId, title } = input
  if (source.kind === 'waiver') throw new Error('WAIVER_NOT_DUPLICABLE')
  const documentId = await createDocument({
    teamId: source.teamId,
    userId,
    title,
    kind: source.kind,
    source: source.source,
  })
  await updateDocument(documentId, {
    body: source.body,
    externalUrl: source.externalUrl,
    summary: source.summary,
  })
  return documentId
}

export async function updateDocument(
  id: string,
  // `status` is deliberately absent — see setDocumentStatus / publishDocument.
  patch: Partial<
    Pick<
      StudioDocument,
      | 'title'
      | 'kind'
      | 'source'
      | 'body'
      | 'externalUrl'
      | 'summary'
      | 'isPublic'
      | 'order'
      | 'archived_at'
    >
  >,
): Promise<void> {
  await updateDoc(doc(documentsCol(), id), {
    ...stripUndefined(patch),
    updated_at: serverTimestamp(),
  })
}

/**
 * Unpublish / archive. Publishing is NOT here: it mints an immutable version
 * snapshot, which only the server can do, and `firestore.rules` denies a client
 * transition into 'published' so this signature is enforced rather than merely
 * documented.
 */
export async function setDocumentStatus(
  id: string,
  status: Exclude<DocumentStatus, 'published'>,
): Promise<void> {
  await updateDoc(doc(documentsCol(), id), {
    status,
    // isPublic can only be true while published — leaving 'published' forces it off.
    isPublic: false,
    updated_at: serverTimestamp(),
  })
}

export interface PublishResult {
  version: number
  bodyHash: string
}

/**
 * THE publish path, for every document kind. Mints `versions/v{NNNN}` from the
 * sanitized body, moves `current_version`, and — for a `require_resign` outcome —
 * the supersession floor, all in one transaction.
 */
export async function publishDocument(
  documentId: string,
  outcome: PublishOutcome,
): Promise<PublishResult> {
  const fn = httpsCallable<{ documentId: string; outcome: PublishOutcome }, PublishResult>(
    functions,
    'publishDocumentVersion',
  )
  return (await fn({ documentId, outcome })).data
}

export async function deleteDocument(id: string): Promise<void> {
  await deleteDoc(doc(documentsCol(), id))
}

// ─── Waivers — CALLABLE-ONLY ────────────────────────────────────────────────
// `firestore.rules` denies a client create, update AND delete on a
// `kind: 'waiver'` document: its content is somebody's evidence and its
// required-ness is an authorization fact. So every write below goes through a
// callable, and the editor routes its Save through `updateWaiver` for this kind
// while keeping its direct client write for every other.
//
// The wrappers are `createWaiver`, `updateWaiverContent`, `updateWaiverSettings`
// (both onto `updateWaiver`), `setWaiverRequirement` and `archiveWaiver`;
// publishing goes through `publishDocument` above, which is universal rather
// than waiver-only. The census of the callables themselves lives in the module
// header of `packages/functions/src/waivers/publish.ts`.

export async function createWaiver(input: {
  teamId: string
  title: string
  source: DocumentSource
}): Promise<string> {
  const fn = httpsCallable<typeof input, { documentId: string }>(functions, 'createWaiver')
  return (await fn(input)).data.documentId
}

/** Title / body / summary / source / externalUrl. The PAID half: text edits are
 *  authoring, and a downgraded studio cannot do them. */
export async function updateWaiverContent(
  documentId: string,
  patch: {
    title?: string
    summary?: string
    body?: string
    source?: DocumentSource
    externalUrl?: string
  },
): Promise<void> {
  const fn = httpsCallable(functions, 'updateWaiver')
  await fn({ documentId, ...patch })
}

/** `mayIncludeMinors`, `validityMonths` and `scope`. UNGATED on purpose — a
 *  downgraded studio must still be able to narrow a scope or flag a waiver for
 *  minors. `required` is deliberately NOT here: it may only be written where
 *  the policy entry is patched in the same transaction, and `updateWaiver`
 *  refuses the key outright rather than dropping it silently. */
export async function updateWaiverSettings(
  documentId: string,
  patch: Partial<Pick<WaiverConfig, 'mayIncludeMinors' | 'validityMonths' | 'scope'>>,
): Promise<void> {
  const fn = httpsCallable(functions, 'updateWaiver')
  await fn({ documentId, ...patch })
}

/** ASYMMETRIC: turning it ON calls `requirePlan`, turning it OFF never does. */
export async function setWaiverRequirement(documentId: string, required: boolean): Promise<void> {
  const fn = httpsCallable(functions, 'setWaiverRequirement')
  await fn({ documentId, required })
}

/** No plan gate at all — retiring is not creating. */
export async function archiveWaiver(documentId: string): Promise<void> {
  const fn = httpsCallable(functions, 'archiveWaiver')
  await fn({ documentId })
}

/**
 * Every refusal a studio can ACT ON, mapped to copy — the `details.reason`
 * values raised by `createWaiver`, `updateWaiver`, `publishDocumentVersion`,
 * `setWaiverRequirement` and `archiveWaiver`.
 *
 * A studio told only "could not save" will not find the empty body, the plan
 * gate or the version cap — and this docblock claimed all three while the switch
 * mapped only the plan gate, so two of the three examples it named fell through
 * to the generic string. Each named case now has an arm.
 *
 * `plan_required` and `plan_inactive` carry `requirePlan`'s English billing
 * prose, which is written for a coach and must never be rendered raw even here.
 *
 * DELIBERATELY UNMAPPED, so `default` is a decision rather than a gap:
 * `document_not_found` and `not_a_waiver`, plus the argument validators that
 * carry no `reason` at all ("title is required", "required must be a boolean").
 * All of those are client bugs — nothing a studio types produces them, and
 * inventing copy would tell a manager to fix something that is not theirs.
 *
 * `PublishDialog` keeps its OWN map, because it shows the message inline in the
 * dialog with publish-specific wording rather than as a toast. Every reason that
 * map handles is handled here too; the wording differs deliberately.
 */
export function waiverCallableError(
  err: unknown,
  t: (key: string) => string,
): string {
  const reason = (err as { details?: { reason?: string } })?.details?.reason
  switch (reason) {
    case 'plan_required':
    case 'plan_inactive':
      return t('errorPlanRequired')
    case 'waiver_limit_reached':
      return t('errorLimitReached')
    case 'waiver_not_published':
      return t('errorNotPublished')
    case 'waiver_unavailable':
      return t('errorUnavailable')
    case 'document_archived':
      return t('errorArchived')
    case 'invalid_external_url':
      return t('errorExternalUrl')
    case 'document_body_empty':
      return t('errorBodyEmpty')
    case 'version_limit_reached':
      return t('errorVersionLimit')
    case 'version_exists':
      return t('errorVersionExists')
    case 'waiver_required_limit_reached':
      return t('errorRequiredLimit')
    case 'publish_outcome_unavailable':
      return t('errorPublishOutcome')
    case 'required_not_writable_here':
      // A client bug rather than a studio mistake, but it still has to say
      // something true rather than nothing.
      return t('errorRequiredElsewhere')
    default:
      return t('errorGeneric')
  }
}

// Live document count for the team — used to enforce the per-team cap even
// when the cached list query is stale.
export async function countDocuments(teamId: string): Promise<number> {
  const snap = await getCountFromServer(
    query(documentsCol(), where('teamId', '==', teamId)),
  )
  return snap.data().count
}
