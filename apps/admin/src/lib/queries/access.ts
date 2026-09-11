import 'server-only'
import {
  APP_SETTINGS_COLLECTION,
  PUBLIC_SETTINGS_DOC,
  SIGNUP_ALLOWLIST_COLLECTION,
  type PublicAppSettings,
  type SignupAllowlistEntry,
} from '@linyup/shared'
import { adminDb } from '@/lib/firebase-admin'

export interface PublicSignupView {
  enabled: boolean
  updatedMs: number | null
  updatedBy: string | null
}

export interface AllowlistRow {
  email: string
  addedBy: string | null
  addedMs: number | null
  note: string | null
}

// Reads the world-readable signup flag (app_settings/public). Missing doc =
// closed (matches the blocking function's fail-closed default).
export async function getPublicSignupSettings(): Promise<PublicSignupView> {
  const snap = await adminDb.collection(APP_SETTINGS_COLLECTION).doc(PUBLIC_SETTINGS_DOC).get()
  if (!snap.exists) return { enabled: false, updatedMs: null, updatedBy: null }
  const d = snap.data() as PublicAppSettings
  return {
    enabled: d.public_signup_enabled === true,
    updatedMs: d.updated_at?.toMillis?.() ?? null,
    updatedBy: d.updated_by ?? null,
  }
}

/** How many allow-list entries the settings page shows. It grows with every
 *  manual authorisation and never shrinks, so it is a LOG, not config — small
 *  for a limited launch and unbounded in principle. */
export const ALLOWLIST_PAGE = 200

/** The line the page shows when the cap bit — a capped list says so. */
export const ALLOWLIST_TRUNCATED_NOTE = `Showing the ${ALLOWLIST_PAGE} most recently added addresses.`

// Lists the manually-authorized signup emails, newest first.
export async function listSignupAllowlist(): Promise<AllowlistRow[]> {
  const snap = await adminDb
    .collection(SIGNUP_ALLOWLIST_COLLECTION)
    .orderBy('added_at', 'desc')
    .limit(ALLOWLIST_PAGE)
    .get()
  return snap.docs.map((doc) => {
    const d = doc.data() as SignupAllowlistEntry
    return {
      email: d.email ?? doc.id,
      addedBy: d.added_by ?? null,
      addedMs: d.added_at?.toMillis?.() ?? null,
      note: d.note ?? null,
    }
  })
}
