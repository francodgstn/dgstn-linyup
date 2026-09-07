'use client'

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { useRouter } from '@/i18n/navigation'
import { useLocale } from 'next-intl'
import { useOrgRole } from '@/hooks/useOrgRole'
import { orgHref, orgLandingPath } from '@/lib/org-nav'

/**
 * THE ORGANISATION'S FRONT DOOR — and it opens onto a different room depending
 * on who knocked.
 *
 * An organiser lands on the dashboard; somebody from a member studio lands on
 * the summary, because the dashboard is built on precisely the reads their
 * membership does not permit (`org_teams` admits `isOrgMember(orgId) ||
 * isTeamMember(teamId)`, so listing the roster returns a sibling studio's row
 * that fails both arms and Firestore denies the whole query).
 *
 * THE REDIRECT IS WHY THE SWITCHER CAN STAY SIMPLE. Every entry point into org
 * scope — the scope switcher, a pasted link, a bookmark — comes here and lets
 * this decide. The alternative was for each of them to resolve a role per
 * organisation before it could even render a menu item.
 *
 * It waits for the role rather than guessing: sending an organiser to the
 * summary and then bouncing them to the dashboard is two navigations and a
 * visible flicker on every entry.
 */
export default function OrgPage() {
  const { orgId } = useParams<{ orgId: string }>()
  const locale = useLocale()
  const router = useRouter()
  const { role, loading } = useOrgRole(orgId)

  useEffect(() => {
    if (loading) return
    router.replace(orgHref(orgId, orgLandingPath(role)) as Parameters<typeof router.replace>[0])
  }, [orgId, locale, role, loading, router])

  return null
}
