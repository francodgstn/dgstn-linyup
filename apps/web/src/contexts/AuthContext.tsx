'use client'

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocale } from 'next-intl'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore'
import { auth } from '@/lib/firebase-auth'
import { db } from '@/lib/firebase'
import { usePathname, useRouter } from '@/i18n/navigation'
import { LOCALE_COOKIE, persistLocale } from '@/i18n/persistLocale'
import type { UserProfile, Team, TeamRole, Capability, DataScope } from '@linyup/shared'
import { ORGANIZATIONS_COLLECTION, ORG_MEMBERS_SUBCOLLECTION, TEAMS_COLLECTION, TEAM_MEMBERS_SUBCOLLECTION, USERS_COLLECTION } from '@linyup/shared'

// ─── UI language: the browser decides, the profile remembers ─────────────────
//
// Two facts that are easy to fuse and must not be:
//
//   Team.language      the language the STUDIO writes to its MEMBERS in.
//   UserProfile.locale the language THIS PERSON reads the dashboard in.
//
// The `NEXT_LOCALE` cookie stays the authority for the browser the user is
// sitting at — it is what next-intl resolves against, and it is written both by
// `persistLocale` (the language switchers, the signup wizard) and by next-intl's
// own middleware whenever the URL disagrees with the browser's Accept-Language.
// `UserProfile.locale` is a MIRROR of that choice, and its only job is to carry
// it to a browser that has no cookie yet (a new device, a fresh profile). Hence
// the adopt/record directions below, which are exclusive by construction: with
// no cookie we adopt the stored value, with a cookie we record it. Making the
// profile authoritative instead would bounce a user straight back every time
// they used the switcher.

const UI_LOCALES = ['en', 'de', 'fr', 'it'] as const
type UiLocale = (typeof UI_LOCALES)[number]

/** Has THIS browser ever been told a language explicitly? */
function hasExplicitLocaleChoice(): boolean {
  if (typeof document === 'undefined') return false
  return document.cookie.split('; ').some((c) => c.startsWith(`${LOCALE_COOKIE}=`))
}

/** Surfaces whose locale belongs to the link that reached them, not to whoever
 *  happens to be signed in — a studio owner opening their own booking page in
 *  French must see what a French member sees. */
function honoursItsOwnLocale(pathname: string): boolean {
  return pathname.startsWith('/public/') || pathname.startsWith('/embed/') || pathname.startsWith('/auth/')
}

interface AuthContextValue {
  user: User | null
  profile: UserProfile | null
  team: Team | null
  teamRole: TeamRole | null
  // Effective capabilities + data scope denormalized on the member doc. Null until
  // resolved / for members written before denormalization existed — useCapabilities
  // falls back to the role-derived defaults in that case.
  teamCapabilities: Capability[] | null
  teamScope: DataScope | null
  loading: boolean
  currentTeamId: string | null
  isOrgAdmin: boolean
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  profile: null,
  team: null,
  teamRole: null,
  teamCapabilities: null,
  teamScope: null,
  loading: true,
  currentTeamId: null,
  isOrgAdmin: false,
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(true)
  const [isOrgAdmin, setIsOrgAdmin] = useState(false)
  const [teamRole, setTeamRole] = useState<TeamRole | null>(null)
  const [teamCapabilities, setTeamCapabilities] = useState<Capability[] | null>(null)
  const [teamScope, setTeamScope] = useState<DataScope | null>(null)

  useEffect(() => {
    let profileUnsub: (() => void) | null = null

    const authUnsub = onAuthStateChanged(auth, (firebaseUser) => {
      profileUnsub?.()
      profileUnsub = null

      setUser(firebaseUser)

      if (!firebaseUser) {
        setProfile(null)
        setTeam(null)
        setTeamRole(null)
        setTeamCapabilities(null)
        setTeamScope(null)
        setLoading(false)
        return
      }

      // Keep profile in sync — handles the case where the doc is created after
      // auth (e.g. new user completing signup wizard after magic-link sign-in).
      profileUnsub = onSnapshot(doc(db, USERS_COLLECTION, firebaseUser.uid), (snap) => {
        setProfile(snap.exists() ? ({ id: snap.id, ...snap.data() } as UserProfile) : null)
        setLoading(false)
      })
    })

    return () => {
      authUnsub()
      profileUnsub?.()
    }
  }, [])

  // Keep the UI language and the stored preference in step. See the note above
  // the helpers for why the cookie — not the profile — is authoritative.
  const activeLocale = useLocale()
  const pathname = usePathname()
  const router = useRouter()
  const adoptedStoredLocale = useRef(false)

  useEffect(() => {
    if (!user || !profile) return
    if (honoursItsOwnLocale(pathname)) return

    const stored = profile.locale
    if (!hasExplicitLocaleChoice()) {
      // No choice in this browser — adopt the one the user made elsewhere, once
      // per mount so a redirect that does not stick cannot loop. `persistLocale`
      // must run BEFORE the navigation: English is the UNPREFIXED path, so a
      // switch to 'en' would otherwise be re-resolved from Accept-Language.
      if (stored && stored !== activeLocale && !adoptedStoredLocale.current) {
        adoptedStoredLocale.current = true
        persistLocale(stored)
        // `usePathname()` is the PATH ONLY. Re-navigating to it verbatim drops
        // the query string and hash, and the pages this can fire on read them:
        // the Stripe checkout return lands on `settings/billing?checkout=…`.
        const search = typeof window === 'undefined' ? '' : window.location.search + window.location.hash
        router.replace(`${pathname}${search}`, { locale: stored })
      }
      return
    }

    if (UI_LOCALES.includes(activeLocale as UiLocale) && activeLocale !== stored) {
      // Best-effort mirror of an explicit choice. `firestore.rules` already lets
      // a user write their own doc, so this needs no callable.
      setDoc(doc(db, USERS_COLLECTION, user.uid), { locale: activeLocale }, { merge: true }).catch(() => {})
    }
  }, [user, profile, activeLocale, pathname, router])

  // Subscribe to the team document whenever currentTeamId changes
  const currentTeamId = profile?.currentTeam ?? null
  useEffect(() => {
    if (!currentTeamId) {
      setTeam(null)
      setTeamRole(null)
      setTeamCapabilities(null)
      setTeamScope(null)
      return
    }
    const unsub = onSnapshot(doc(db, TEAMS_COLLECTION, currentTeamId), (snap) => {
      if (snap.exists()) {
        const teamData = { id: snap.id, ...snap.data() } as Team
        setTeam(teamData)
        const orgId = (teamData as unknown as { org_id?: string }).org_id
        const uid = user?.uid
        if (uid) {
          getDoc(doc(db, TEAMS_COLLECTION, currentTeamId, TEAM_MEMBERS_SUBCOLLECTION, uid))
            .then((m) => {
              const data = m.exists() ? m.data() : null
              setTeamRole((data?.role as TeamRole) ?? null)
              setTeamCapabilities((data?.capabilities as Capability[] | undefined) ?? null)
              setTeamScope((data?.scope as DataScope | undefined) ?? null)
            })
            .catch(() => {
              setTeamRole(null)
              setTeamCapabilities(null)
              setTeamScope(null)
            })
          if (orgId) {
            getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId, ORG_MEMBERS_SUBCOLLECTION, uid))
              .then((m) => setIsOrgAdmin(m.exists() && m.data()?.role === 'org_admin'))
              .catch(() => setIsOrgAdmin(false))
          } else {
            setIsOrgAdmin(false)
          }
        }
      } else {
        setTeam(null)
        setTeamRole(null)
        setTeamCapabilities(null)
        setTeamScope(null)
        setIsOrgAdmin(false)
      }
    })
    return unsub
  }, [currentTeamId])

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        team,
        teamRole,
        teamCapabilities,
        teamScope,
        loading,
        currentTeamId,
        isOrgAdmin,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
