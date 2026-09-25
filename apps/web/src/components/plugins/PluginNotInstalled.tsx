'use client'

/**
 * The state a plugin page shows when its plugin is not installed.
 *
 * IT IS A WAY IN, NOT A DEAD END. The asset register shipped with a bare gray
 * sentence, which was both a dead end and — because the page's copy had been
 * copied from Finance's namespace — named the WRONG plugin. A page that tells
 * you something is missing and leaves you to find the marketplace yourself is
 * the version of this that gets reported as a bug.
 *
 * The CTA deep-links to `/plugins?plugin={id}`, which opens that
 * plugin's detail card directly — the same prompt the sidebar's recommended
 * rows open, so discovering a plugin looks the same wherever you meet it.
 * `installableManifests()` is what that deep link resolves against, so a bundle
 * MEMBER id would open nothing; every current caller passes a standalone id.
 *
 * Shape lifted from the kiosk page's hand-rolled version, which was the one
 * that read best. `plugins/kiosk`, `plugins/custom-forms` and `gamification`
 * still carry their own copies of it and could adopt this; they are left alone
 * here rather than refactored in a change about the asset register.
 */

import type { Route } from 'next'
import type { LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function PluginNotInstalled({
  pluginId,
  icon: Icon,
  title,
  body,
}: {
  /** Opens this plugin's card in the marketplace. */
  pluginId: string
  icon: LucideIcon
  title: string
  body: string
}) {
  const t = useTranslations('Plugins')
  return (
    <div className="mx-auto mt-10 max-w-md rounded-xl border bg-muted/30 p-10 text-center">
      <Icon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      {/* A Link wearing the button's styles: this Button is a base-ui primitive
          with no `asChild`, so `buttonVariants` is how the codebase dresses a
          navigation as a button. */}
      <Link
        href={`/plugins?plugin=${pluginId}` as Route}
        className={cn(buttonVariants({ size: 'sm' }), 'mt-4')}
      >
        {t('install')}
      </Link>
    </div>
  )
}
