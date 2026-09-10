'use client'

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { resolveAffiliationTerm } from '@linyup/shared'
import { orgIdFromPath } from '@/contexts/ScopeContext'
import { usePathname } from '@/i18n/navigation'
import { useLocale } from 'next-intl'

/**
 * The organisation's own word for an affiliation — "Affiliation", "Lizenz",
 * "Club membership" — for the current locale, defaulting to "Affiliation".
 *
 * ── WHICH ORGANISATION, WHICH IS THE WHOLE PROBLEM ──────────────────────────
 * There are two ways to be looking at one, and they disagree:
 *
 *   inside `OrgProvider`  — an org page's children. `useOrg()` has the answer.
 *   everywhere else       — the STUDIO sidebar, which is a SIBLING of the org
 *                           route's children, so `OrgProvider` does not wrap it
 *                           and `useOrg()` returns the module default.
 *
 * The second case used to fall back to the CURRENT TEAM's `org_id`, and on an
 * `/org/{X}` route where X is not that team's organisation the sidebar quietly
 * rendered a DIFFERENT organisation's word — no error, no empty state, just the
 * wrong noun (recorded 2026-08-27, fixed 2026-08-28).
 *
 * The fix is not to widen `OrgProvider`. The scope is already resolved from the
 * URL, so this reads the ROUTE's org id and only falls back to the team's when
 * the URL names no organisation at all. Order matters: the route is the more
 * specific fact, and the team's `org_id` is a default for pages that are not
 * about an organisation.
 */
export function useAffiliationTerm(): string {
  const { org, affiliationTerm: orgContextTerm } = useOrg()
  const { team } = useAuth()
  const pathname = usePathname()
  const locale = useLocale()

  // THE ROUTE WINS. `useOrg()` is authoritative when it has an org, because it
  // has already resolved and cached the document; outside the provider the URL
  // is the only honest source, and the team's own org is the last resort.
  const routeOrgId = orgIdFromPath(pathname)
  const fallbackOrgId = org ? null : (routeOrgId ?? team?.org_id ?? null)

  const { data: termFromFallbackOrg } = useQuery<string>({
    queryKey: ['org-membership-term', fallbackOrgId, locale],
    enabled: !!fallbackOrgId,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      if (!fallbackOrgId) return 'Affiliation'
      const snap = await getDoc(doc(db, 'organizations', fallbackOrgId))
      if (!snap.exists()) return 'Affiliation'
      const data = snap.data() as { affiliation_term?: Partial<Record<string, string>> }
      return resolveAffiliationTerm(data.affiliation_term, locale)
    },
  })

  if (org) return orgContextTerm
  if (termFromFallbackOrg) return termFromFallbackOrg
  return 'Affiliation'
}
