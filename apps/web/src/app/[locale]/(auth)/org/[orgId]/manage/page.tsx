'use client'

/**
 * THE ORGANIZATION'S SETTINGS HUB — the org's answer to `/settings`.
 *
 * It exists because the rail alone was not reachable. The layout renders the
 * rail on rail ROUTES, which is a chicken and egg: standing on Studios or
 * Events there was no rail and no link to any of the seven destinations behind
 * it, so eleven tabs became four rows and seven things that had apparently
 * vanished. A studio never had that problem — `/settings` is a real place you
 * can go, and the rail comes with it.
 *
 * It also settles the phone case the design left open. A rail is a column beside
 * a detail pane on desktop and an INDEX on mobile; an index needs a route of its
 * own to be the index OF. This replaced a disclosure hack in the org layout that
 * existed only because that route did not exist yet.
 *
 * The page itself is deliberately thin: on mobile the rail IS the page (rendered
 * by the layout), and on desktop the rail sits beside this, which says what the
 * section is for rather than duplicating the list next to it.
 *
 * IT IS FOR THE PEOPLE WHO RUN THE ORGANIZATION. A member studio has no rail
 * (see the layout) and no row that leads here, so for them this was a hub with
 * nothing in it that stayed open to a typed URL and to the rail's own mobile
 * back-link. It sends them to the summary instead — navigation, not
 * enforcement: the page holds no data, and every destination behind it is
 * guarded by `firestore.rules` regardless.
 */

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import type { Route } from 'next'
import { useRouter } from '@/i18n/navigation'
import { useOrgRole } from '@/hooks/useOrgRole'
import { orgHref } from '@/lib/org-nav'

export default function OrgManagePage() {
  const t = useTranslations('Org')
  const { orgId } = useParams<{ orgId: string }>()
  const router = useRouter()
  const { role, loading } = useOrgRole(orgId)

  useEffect(() => {
    if (loading || role != null) return
    router.replace(orgHref(orgId, 'overview') as Route)
  }, [orgId, role, loading, router])

  if (loading || role == null) return null

  return (
    <div className="max-w-2xl">
      <h1 className="mb-2 text-2xl font-semibold">{t('manageTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('manageSubtitle')}</p>
    </div>
  )
}
