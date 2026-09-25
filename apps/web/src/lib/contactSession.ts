// ─── The persisted public CONTACT session ────────────────────────────────────
//
// One browser, one stored contact session. The key and the shape are a
// CONTRACT, not an implementation detail: whatever writes it must be readable by
// `PublicContactAuthProvider`, which is what every public surface asks "am I
// signed in?".
//
// THIS MODULE IS THE ONLY HOLDER (since 2026-08-18, UX-88).
// `app/[locale]/(public)/public/[slug]/PublicContactAuthProvider.tsx` — the
// provider every public surface asks "am I signed in?" — imports load/save/clear
// from here rather than inlining its own against the same key, and takes its
// `PublicContact` type from `StoredPublicContact` below. Anything else that
// needs to read or drop the session imports it too; never re-inline
// `localStorage.getItem(CONTACT_SESSION_KEY)` at a call site.
//
// The Firebase custom token is the AUTHORITY, never this record: the provider
// re-reads `contactId` + `teamId` off the id token before it trusts anything
// stored here. What is persisted is the cached display data plus the fact that
// there is a session worth waiting for.

/** Kept stable from the 'space' era so existing sessions survive. */
export const CONTACT_SESSION_KEY = 'linyup:space:session'

export interface StoredPublicContact {
  id: string
  firstname: string
  lastname: string
  /** The plan types held at sign-in — the contact's `held_plan_type_ids`
   *  mirror, frozen for the session. Only ever a floor for a failed live read of
   *  the contact's own record; see `usePublicContactRecord`. */
  held_plan_type_ids?: string[]
  /** `| null` because that is what `buildContactSession` actually returns for a
   *  contact with no address — an explicit null, not a missing key. */
  email?: string | null
}

export interface PersistedContactSession {
  contactId: string
  /** ISO string. The provider drops the record once this is in the past. */
  sessionExpires: string
  contact: StoredPublicContact
}

export function loadContactSession(): PersistedContactSession | null {
  try {
    const raw = localStorage.getItem(CONTACT_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedContactSession
    if (new Date(parsed.sessionExpires) < new Date()) {
      localStorage.removeItem(CONTACT_SESSION_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function saveContactSession(data: PersistedContactSession): void {
  try {
    localStorage.setItem(CONTACT_SESSION_KEY, JSON.stringify(data))
  } catch {
    // Private mode / storage disabled. The Firebase session still stands; the
    // surfaces simply fall back to asking for a sign-in.
  }
}

export function clearContactSession(): void {
  try {
    localStorage.removeItem(CONTACT_SESSION_KEY)
  } catch {
    // ignore
  }
}
