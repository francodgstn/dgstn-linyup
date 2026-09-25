'use client'

import type { Route } from 'next'
import { useTranslations } from 'next-intl'
import { ArrowUpRight, Puzzle } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { buttonVariants } from '@/components/ui/button'

/**
 * A STOP INSIDE SETTINGS, not a door straight out of it (Franco, 2026-09-25).
 *
 * The rail's Plugins row used to link to /plugins directly, so one click in a
 * settings list took the studio out of the settings area without warning — the
 * rail vanished and the page it had been reading was gone. The catalog stays
 * a full page (see the redirect note in ./page.tsx for why), but the rail row
 * lands HERE first: a heading, one line saying what the catalog is, and one
 * button. The extra click is the point — it is the studio choosing to leave.
 */
export function PluginsPlaceholder() {
  const t = useTranslations('Plugins')
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="flex flex-col items-start gap-4 border-y py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <Puzzle className="h-5 w-5" />
          </span>
          <p className="text-sm text-muted-foreground">{t('settingsPlaceholderBody')}</p>
        </div>
        <Link href={'/plugins' as Route} className={buttonVariants({ size: 'sm' })}>
          {t('settingsPlaceholderCta')}
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  )
}
