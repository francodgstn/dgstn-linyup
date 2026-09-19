'use client'

// Platform announcement strip. Two sources, in priority order:
//   1) An OPS-controlled message from the world-readable app_settings/public doc
//      (set from the admin console) — shows in whichever env OPS enabled it.
//   2) A built-in demo notice on the sandbox/demo build (NEXT_PUBLIC_DEMO_MODE),
//      flagging "this is a demo" with a link to the marketing site.
// No auth needed — the doc is world-readable.

import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import { Megaphone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { db } from '@/lib/firebase'
import { isDemoMode } from '@/lib/demo'
import {
  APP_SETTINGS_COLLECTION,
  PUBLIC_SETTINGS_DOC,
  type AnnouncementStyle,
  type PlatformAnnouncement,
} from '@linyup/shared'

const STYLES: Record<AnnouncementStyle, string> = {
  info: 'bg-sky-100 text-sky-900 dark:bg-sky-950/70 dark:text-sky-100',
  warning: 'bg-amber-100 text-amber-950 dark:bg-amber-950/70 dark:text-amber-100',
  success: 'bg-emerald-100 text-emerald-950 dark:bg-emerald-950/70 dark:text-emerald-100',
}

const BASE = 'flex items-center justify-center gap-2 px-4 py-2 text-center text-sm font-medium'

export function AnnouncementBar() {
  const t = useTranslations('Common')
  const { data } = useQuery<PlatformAnnouncement | null>({
    queryKey: ['platform-announcement'],
    staleTime: 60_000,
    queryFn: async () => {
      const snap = await getDoc(doc(db, APP_SETTINGS_COLLECTION, PUBLIC_SETTINGS_DOC))
      return snap.exists() ? (snap.data() as PlatformAnnouncement) : null
    },
  })

  const text = data?.announcement_text?.trim()

  // 1) OPS-configured announcement wins (lets ops override the demo copy).
  if (data?.announcement_enabled && text) {
    const style = STYLES[data.announcement_style ?? 'info'] ?? STYLES.info
    return (
      <div role="status" className={`${BASE} ${style}`}>
        <Megaphone className="h-4 w-4 shrink-0" />
        <span>{text}</span>
      </div>
    )
  }

  // 2) Sandbox/demo builds: always flag the demo + link to the marketing site.
  //    Hidden by CSS on a LEAD tenant's pages (globals.css), whose own fixed
  //    disclaimer (LeadDemoBanner) already says it is a demo by Linyup.
  if (isDemoMode()) {
    return (
      <div role="status" data-linyup-demo-strip="" className={`${BASE} ${STYLES.info}`}>
        <Megaphone className="h-4 w-4 shrink-0" />
        <span>{t('demoBanner')}</span>
        <a
          href="https://linyup.com/"
          className="font-semibold underline underline-offset-2 hover:opacity-80"
        >
          {t('demoBannerCta')}
        </a>
      </div>
    )
  }

  return null
}
