'use client'

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { onAuthStateChanged, signInWithCustomToken, signOut } from 'firebase/auth'
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { CONTACTS_COLLECTION } from '@linyup/shared'
import { db } from '@/lib/firebase'
import { auth } from '@/lib/firebase-auth'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import {
  loadContactSession,
  saveContactSession,
  clearContactSession,
  type PersistedContactSession,
  type StoredPublicContact,
} from '@/lib/contactSession'
import { usePublicTeam } from './PublicTeamProvider'
import { callFunction } from '@/lib/callFunction'

// The passwordless CONTACT-SESSION auth, lifted from Space to the team root so it
// wraps EVERY public surface (bio-link, booking, signup, documents, shop, space).
// The Firebase custom-token session was already global; this makes the React
// context + sign-in flow available everywhere, so any surface can show login state,
// offer sign-in, and read the signed-in contact. Space consumes it via a back-compat
// shim (space/SpaceAuthProvider re-exports usePublicContactAuth as useSpaceAuth).

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The signed-in contact, as the surfaces read it.
 *
 * ONE SHAPE, DEFINED WITH THE STORAGE CONTRACT (`lib/contactSession.ts`) — this
 * is an alias, not a copy. It has to be the persisted shape: the whole of it is
 * written to localStorage on sign-in and read back on restore, so a field the
 * two disagreed about would survive one hop and vanish on the next.
 *
 * On `email`, which is the field that has caught people out: it is the
 * CONTACT's address, not the mailbox that authenticated (a parent can verify
 * with theirs and select a child), it may be absent on a session persisted by
 * an older build, and it is `| null` because `buildContactSession` returns
 * `contactEmail ?? contactData.email ?? null` — an explicit null, not a missing
 * key. Surfaces that name it ("sent to …") must handle both.
 */
export type PublicContact = StoredPublicContact

export interface MatchedContact {
  id: string
  firstname: string
  lastname: string
}

type LoginResult =
  | { requiresSignup: true; email: string }
  | { requiresContactSelection: true; email: string; matchedContacts: MatchedContact[] }
  | { customToken: string; sessionExpires: string; contact: PublicContact }

export type PublicContactAuthStep =
  | 'idle'
  | 'email'
  | 'code'
  | 'selectContact'
  | 'register'
  | 'authenticated'

interface PublicContactAuthContextValue {
  slug: string
  teamId: string
  step: PublicContactAuthStep
  contact: PublicContact | null
  isAuthenticated: boolean
  /**
   * A session IS persisted and we have not finished checking it yet.
   *
   * Restoring takes two async hops — `onAuthStateChanged` (an IndexedDB read)
   * and then `getIdTokenResult` (which hits the network whenever the token
   * needs refreshing) — and for the whole of that window `isAuthenticated` is
   * false. Every gate that read it alone therefore GREETED A SIGNED-IN MEMBER
   * WITH "you are not signed in", on every single load of her own portal
   * (UX-37). It is not "signed out"; it is "not known yet", and the two must
   * render differently: a wall states a fact, and the fact was wrong.
   *
   * False for a first-time visitor — there is nothing to restore, so the
   * anonymous surfaces are never made to wait, and the sign-in prompt they
   * SHOULD show appears immediately.
   */
  isRestoring: boolean
  matchedContacts: MatchedContact[]
  requiresSignup: boolean
  signupEmail: string
  /** Whether this sign-in flow may CREATE a minimal contact for an unknown email
   *  (login-first checkout). Off by default — Space & co. keep the signup link. */
  allowRegistration: boolean
  error: string | null
  /** Call to initiate the sign-in flow */
  openSignIn: (options?: { allowRegistration?: boolean }) => void
  /** Cancel an in-progress sign-in flow (no-op once authenticated). */
  closeSignIn: () => void
  sendCode: (email: string) => Promise<void>
  verifyCode: (code: string) => Promise<void>
  selectContact: (contactId: string) => Promise<void>
  /** Register a minimal new contact for the OTP-verified email (register step). */
  registerContact: (firstname: string, lastname: string) => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

// ─── Context ──────────────────────────────────────────────────────────────────

const PublicContactAuthContext = createContext<PublicContactAuthContextValue | null>(null)

export function usePublicContactAuth() {
  const ctx = useContext(PublicContactAuthContext)
  if (!ctx) throw new Error('usePublicContactAuth must be used inside PublicContactAuthProvider')
  return ctx
}

// ─── Storage ─────────────────────────────────────────────────────────────────
//
// ONE HOLDER: `@/lib/contactSession` owns the key, the shape and load/save/clear
// (UX-88). This file used to inline its own copies against the same key, which
// made a two-file contract out of something that has to be exact — without a
// stored record a perfectly valid Firebase session is ignored by every public
// surface, so a drift in either direction signs a member out for no reason.
//
// The one deliberate behaviour change of pointing here: `saveContactSession`
// SWALLOWS a storage failure (private mode, storage disabled) where the inlined
// copy threw. Throwing landed in the sign-in catch below and showed "could not
// sign in" to someone who had in fact just signed in — the Firebase session was
// live, only the cache was refused. Now the sign-in completes and only the
// restore-on-reload is lost, which is the honest consequence.
//
// Aliased to the old local names so the flow below reads unchanged.
const loadSession = loadContactSession
const saveSession = saveContactSession
const clearSession = clearContactSession
type PersistedSession = PersistedContactSession

// ─── Provider ────────────────────────────────────────────────────────────────

// Mounted once at the team root (inside PublicTeamProvider), so slug + teamId come
// from there rather than props.
export function PublicContactAuthProvider({ children }: { children: ReactNode }) {
  const { slug, teamId } = usePublicTeam()

  const [step, setStep] = useState<PublicContactAuthStep>('idle')
  const [contact, setContact] = useState<PublicContact | null>(null)
  const [matchedContacts, setMatchedContacts] = useState<MatchedContact[]>([])
  const [requiresSignup, setRequiresSignup] = useState(false)
  const [signupEmail, setSignupEmail] = useState('')
  const [allowRegistration, setAllowRegistration] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [codeId, setCodeId] = useState('')
  const [pendingCode, setPendingCode] = useState('')
  // Seeded SYNCHRONOUSLY from storage, so the first paint already knows whether
  // there is anything to wait for. An effect could not do this: the paint that
  // shows the wrong wall happens before it runs. The `window` guard is belt and
  // braces — PublicTeamProvider renders a spinner until it has resolved the team
  // client-side, so this provider never mounts on the server.
  // LAST SEEN. The mobile app has always stamped this on foreground
  // (apps/mobile/src/services/firestore.ts); the web never did, even though the
  // contact self-write rule has always admitted it — `affectedKeys().hasOnly([
  // 'weight', 'last_seen_at', 'mobile_app'])`, and a subset passes. The cost of
  // that gap is silent: any "active members" figure means active MOBILE members,
  // and a member who only ever opens the Space reads as never having shown up.
  //
  // Keyed on the contact id rather than hung off each sign-in path, so restoring
  // a stored session counts too and the four `setContact` call sites do not each
  // have to remember. Failures are swallowed: this is telemetry, and it must
  // never be the reason a member cannot see their bookings.
  useEffect(() => {
    const contactId = contact?.id
    if (!contactId) return
    void updateDoc(doc(db, CONTACTS_COLLECTION, contactId), {
      last_seen_at: serverTimestamp(),
    }).catch(() => undefined)
  }, [contact?.id])

  const [restoring, setRestoring] = useState<boolean>(
    () => typeof window !== 'undefined' && loadSession() !== null
  )

  // Restore session on mount — but only once the UNDERLYING Firebase session is
  // confirmed. The localStorage flag alone used to flip the UI to "signed in"
  // even when the Firebase user was gone (e.g. an emulator restart wiped auth
  // state, or the browser's IndexedDB was cleared while localStorage survived),
  // and the mismatch only surfaced mid-checkout as a forced re-OTP. Verify the
  // Firebase user exists AND its contact claim matches the persisted session;
  // otherwise show signed-out so the user signs in BEFORE starting a purchase.
  useEffect(() => {
    const session = loadSession()
    if (!session) {
      setRestoring(false)
      return
    }
    // A BOUNDED WAIT. Everything below is asynchronous and one hop of it
    // (`getIdTokenResult`) can go to the network, where "slow" and "never" look
    // the same. Without a deadline a hung refresh leaves the portal spinning
    // with no way out; with one, the worst case is the OLD behaviour — the
    // sign-in prompt — arriving a few seconds later. Waiting is only ever
    // allowed to delay the answer, never to replace it.
    const deadline = setTimeout(() => setRestoring(false), 8000)
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe()
      if (!user) {
        clearSession()
        clearTimeout(deadline)
        setRestoring(false)
        return
      }
      void user
        .getIdTokenResult()
        .then((token) => {
          // BOTH halves of the identity, and the TOKEN is the authority for both.
          //
          // The storage key is global (one browser, one stored session), so a
          // contact signed in at studio A carries that session onto studio B's
          // public pages. Checking only `contactId` let the restore succeed
          // there: the surfaces then read `isAuthenticated`, suppress the guest
          // form, and act for a contact who belongs to a different tenant — up
          // to and including sending them mail from a studio they never joined.
          //
          // Gating on the CLAIM rather than on anything persisted also fixes
          // every session already in a browser: sessions predating this carry no
          // team of their own, and the claim has always been there.
          const sameContact = token.claims.contactId === session.contactId
          const sameTeam = token.claims.teamId === teamId
          if (sameContact && sameTeam) {
            setContact(session.contact)
            setStep('authenticated')
          } else {
            // Only drop the stored session when the CONTACT is wrong. A session
            // that is simply for another studio is still valid where it came
            // from, and clearing it here would sign the visitor out of their own
            // studio for having glanced at someone else's page.
            if (!sameContact) clearSession()
          }
        })
        .catch((err: unknown) => {
          // Token refresh failed (revoked/stale session) — treat as signed out.
          // Logged because "it keeps signing me out" is otherwise a report with
          // nothing behind it: this is the only place that decides it.
          reportPublicLoadFailure('contact-auth/token-refresh', err)
          clearSession()
        })
        // Whatever the answer, the WAITING is over — a `finally` rather than a
        // line in each branch, because a branch added later without one would
        // leave the portal spinning for a member with no way back.
        .finally(() => {
          clearTimeout(deadline)
          setRestoring(false)
        })
    })
    return () => {
      clearTimeout(deadline)
      unsubscribe()
    }
    // `teamId` is load-bearing here, not incidental: it is half of the identity
    // check above, and the provider is remounted per team by the route.
  }, [teamId])

  const openSignIn = useCallback((options?: { allowRegistration?: boolean }) => {
    setError(null)
    setRequiresSignup(false)
    setMatchedContacts([])
    setAllowRegistration(options?.allowRegistration === true)
    setStep('email')
  }, [])

  const sendCode = useCallback(
    async (email: string) => {
      setError(null)
      if (!teamId) {
        setError('Team not loaded yet. Please try again.')
        return
      }
      try {
        const fn = callFunction<{ email: string; teamId: string }, { codeId: string }>(
          'sendContactVerificationCode'
        )
        const result = await fn({ email, teamId })
        setCodeId(result.data.codeId)
        setPendingCode('')
        setStep('code')
      } catch (err: unknown) {
        const e = err as { message?: string }
        setError(e.message ?? 'Failed to send code.')
      }
    },
    [teamId]
  )

  const verifyCode = useCallback(
    async (code: string) => {
      setError(null)
      try {
        const fn = callFunction<{ codeId: string; code: string }, LoginResult>(
          'loginContactWithCode'
        )
        const result = await fn({ codeId, code })
        const data = result.data

        if ('requiresSignup' in data && data.requiresSignup) {
          setSignupEmail(data.email)
          setRequiresSignup(true)
          // Keep the verified code around: the register step re-submits it together
          // with the minimal profile (same second-call pattern as selectContact).
          setPendingCode(code)
          if (allowRegistration) setStep('register')
          return
        }

        if ('requiresContactSelection' in data && data.requiresContactSelection) {
          setMatchedContacts(data.matchedContacts)
          setPendingCode(code)
          setStep('selectContact')
          return
        }

        if ('customToken' in data) {
          await signInWithCustomToken(auth, data.customToken)
          const session: PersistedSession = {
            contactId: data.contact.id,
            sessionExpires: data.sessionExpires,
            contact: data.contact,
          }
          saveSession(session)
          setContact(data.contact)
          setStep('authenticated')
        }
      } catch (err: unknown) {
        const e = err as { message?: string }
        setError(e.message ?? 'Incorrect code.')
      }
    },
    [codeId, allowRegistration]
  )

  const selectContact = useCallback(
    async (contactId: string) => {
      setError(null)
      try {
        const fn = callFunction<
          { codeId: string; code: string; selectedContactId: string },
          LoginResult
        >('loginContactWithCode')
        const result = await fn({ codeId, code: pendingCode, selectedContactId: contactId })
        const data = result.data

        if ('customToken' in data) {
          await signInWithCustomToken(auth, data.customToken)
          const session: PersistedSession = {
            contactId: data.contact.id,
            sessionExpires: data.sessionExpires,
            contact: data.contact,
          }
          saveSession(session)
          setContact(data.contact)
          setStep('authenticated')
        }
      } catch (err: unknown) {
        const e = err as { message?: string }
        setError(e.message ?? 'Could not sign in.')
      }
    },
    [codeId, pendingCode]
  )

  // Login-first shop registration: the OTP already proved email ownership; submit
  // the SAME verified code again with the minimal profile — the callable creates a
  // provisional contact and mints the session in one step.
  const registerContact = useCallback(
    async (firstname: string, lastname: string) => {
      setError(null)
      try {
        const fn = callFunction<
          { codeId: string; code: string; newContact: { firstname: string; lastname: string } },
          LoginResult
        >('loginContactWithCode')
        const result = await fn({
          codeId,
          code: pendingCode,
          newContact: { firstname: firstname.trim(), lastname: lastname.trim() },
        })
        const data = result.data

        if ('customToken' in data) {
          await signInWithCustomToken(auth, data.customToken)
          const session: PersistedSession = {
            contactId: data.contact.id,
            sessionExpires: data.sessionExpires,
            contact: data.contact,
          }
          saveSession(session)
          setContact(data.contact)
          setRequiresSignup(false)
          setStep('authenticated')
        }
      } catch (err: unknown) {
        // Surfaces the server copy (cap blocked / registration budget / expired code).
        const e = err as { message?: string }
        setError(e.message ?? 'Could not create your account.')
      }
    },
    [codeId, pendingCode]
  )

  const logout = useCallback(async () => {
    clearSession()
    setRestoring(false)
    setContact(null)
    setStep('idle')
    setMatchedContacts([])
    setRequiresSignup(false)
    setError(null)
    try {
      await signOut(auth)
    } catch {
      // ignore
    }
  }, [])

  const closeSignIn = useCallback(() => {
    // Reset the transient sign-in flow without signing an authenticated user out.
    setStep((s) => (s === 'authenticated' ? s : 'idle'))
    setMatchedContacts([])
    setRequiresSignup(false)
    setAllowRegistration(false)
    setError(null)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  const value: PublicContactAuthContextValue = {
    slug,
    teamId,
    step,
    contact,
    isAuthenticated: step === 'authenticated' && contact !== null,
    // Never both: once the session has landed there is nothing left to wait for,
    // so a consumer can read the two as an ordered pair (restoring → then the
    // answer) without having to know how the flag is cleared.
    isRestoring: restoring && step !== 'authenticated',
    matchedContacts,
    requiresSignup,
    signupEmail,
    allowRegistration,
    error,
    openSignIn,
    closeSignIn,
    sendCode,
    verifyCode,
    selectContact,
    registerContact,
    logout,
    clearError,
  }

  return <PublicContactAuthContext.Provider value={value}>{children}</PublicContactAuthContext.Provider>
}
