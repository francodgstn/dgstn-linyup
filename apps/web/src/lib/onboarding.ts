import { arrayUnion, doc, setDoc, updateDoc, serverTimestamp, deleteField } from 'firebase/firestore'
import { db } from './firebase'
import { TEAMS_COLLECTION, USERS_COLLECTION, type UserProfile } from '@linyup/shared'

/**
 * Helpers for reading/writing per-user onboarding progress
 * (`users/{uid}.onboarding`). Read the state from `useAuth().profile.onboarding`;
 * use these to mutate it. All writes are merge-writes so they never clobber the
 * rest of the profile.
 *
 * The product tour that called markTourDone / resetTour was removed on
 * 2026-08-23 — see the note on the user menu's setup entry. Those two helpers
 * went with it; `users/{uid}.onboarding.tourDone` survives on existing profiles
 * as inert data, which is cheaper to leave than to migrate away.
 *
 * The per-page section-intro popovers were removed in 2026-08, and the How-to
 * page that replaced them in 2026-09, when the guides moved to the public help
 * centre (help.linyup.com).
 */

/**
 * THE setup-checklist dismissal (UX-45). One flag, on the team doc, written
 * only here: `teams/{teamId}.setup_dismissed`. It is team-wide on purpose — a
 * studio finishes setting up once, not once per manager per browser.
 *
 * Writing it needs the `team.settings` capability (owner), which the callers
 * check; a manager's dismissal is local to their session and the card is back
 * on the next load. Reversible: the user menu's setup entry reopens the guide,
 * which clears the flag (SetupGuide's OPEN_SETUP_GUIDE_EVENT listener).
 */
export async function setSetupDismissed(teamId: string, dismissed: boolean): Promise<void> {
  await updateDoc(doc(db, TEAMS_COLLECTION, teamId), { setup_dismissed: dismissed })
}

/**
 * Close a setup step as "not needed", or reopen it.
 *
 * DELIBERATELY NOT the same as done. A cash-only club that closes the payments
 * step has not set up payments and the guide does not claim they have — the
 * step is drawn as acknowledged, not completed. The distinction is what keeps
 * this from being a "mark everything green" button.
 *
 * Reopening deletes the key rather than storing false, so `setup_ack` only ever
 * holds decisions somebody actually made.
 */
export async function setSetupStepAcknowledged(
  teamId: string,
  key: string,
  acknowledged: boolean
): Promise<void> {
  await updateDoc(doc(db, TEAMS_COLLECTION, teamId), {
    [`setup_ack.${key}`]: acknowledged ? serverTimestamp() : deleteField(),
  })
}

/**
 * ── HAS THIS PERSON MET THIS PANEL BEFORE? ──────────────────────────────────
 *
 * "The first time the app is accessed" is a fact about a PERSON, not about a
 * device, so it lives on the user profile and not in localStorage: a studio
 * owner who signs in on a laptop and then a phone has already seen the intro,
 * and being shown it twice would say otherwise.
 *
 * THE ABSENT VALUE MEANS "NEVER SEEN IT", never "they chose to fold it away".
 * That inversion was the bug: the setup guide read a missing localStorage key
 * as a preference for the collapsed pill, so the one moment the panel is worth
 * opening — the first — was the one moment it stayed shut. A "not right now"
 * (the minimize control) is a different fact, still per-browser, and the two
 * must not be read off one key.
 *
 * Stored in `users/{uid}.onboarding.seenIntros` — the list the profile already
 * declares for exactly this ("panels the user has already seen, keyed by
 * section"), so no new field and no migration. The write is a merge-set so it
 * creates nothing else and clobbers nothing else, and callers treat a failure
 * as "seen": showing the panel again is a smaller harm than a render that
 * depends on a write having succeeded.
 */
export const SETUP_GUIDE_INTRO = 'setup-guide'

/**
 * The param the checklist's "view all your QR codes" step arrives with, and
 * which `/public-page` honours by opening its QR dialog.
 *
 * It lives here rather than at either end because both ends need the same
 * spelling and neither owns the other: the step is a URL string in
 * `useSetupChecklist`, the reader is a page. Same convention as the `?new=1`
 * quick actions (`lib/quickActions.ts`), with its own name because this opens a
 * viewer rather than a create form.
 */
export const PUBLIC_PAGE_QR_PARAM = 'qr'

export function hasSeenIntro(profile: UserProfile | null | undefined, key: string): boolean {
  return !!profile?.onboarding?.seenIntros?.includes(key)
}

export async function markIntroSeen(uid: string, key: string): Promise<void> {
  await setDoc(
    doc(db, USERS_COLLECTION, uid),
    { onboarding: { seenIntros: arrayUnion(key) } },
    { merge: true }
  )
}
