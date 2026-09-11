'use client'

// ─── THE SITE PREVIEW, AS AN OVERLAY ─────────────────────────────────────────
//
// The preview used to be a sticky 420px column pinned beside the editor. That
// column cost more than it gave:
//
//   • 420px is not a preview of this site. The published header collapses its
//     nav below a breakpoint the column was permanently under, so the studio was
//     always looking at the narrow layout and never at the one most visitors
//     get. A "preview" that cannot show the desktop rendering is showing the
//     wrong thing confidently.
//   • it took a third of the editor's width permanently, for something read in
//     glances — and the menu editor needs that width for a tree with four
//     levels of indent.
//
// So it opens on demand, at a width the studio picks. DESKTOP IS THE DEFAULT
// because it is the one the old column could never show; mobile is a click away
// and renders at a real phone width rather than at whatever the column happened
// to be.
//
// The frame is a plain width-constrained div, NOT an iframe: `WebsiteRenderer`
// is `@container`-based, so it responds to the element it is in, and an iframe
// would cost a second React tree, a second copy of the fonts and a message
// channel to keep the draft in sync. The width switch just changes a max-width.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Monitor, Smartphone } from 'lucide-react'

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import WebsiteRenderer, { type RenderableSite } from '@/components/site/WebsiteRenderer'
import type { PublicSurface, OrgSiteTeamRef } from '@linyup/shared'

/** Phone width the mobile view renders at — the narrow end of what visitors use,
 *  so a layout that survives here survives the rest. */
const MOBILE_WIDTH = 390

export function PreviewOverlay({
  open,
  onOpenChange,
  site,
  surfaceLinks,
  orgId,
  orgTeams,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  site: RenderableSite
  /** Without these the renderer cannot resolve a `surface` menu item and DROPS
   *  it — so a studio who just added Shop to the menu would watch it vanish
   *  from the preview and reasonably conclude the feature is broken. */
  surfaceLinks?: { surface?: PublicSurface; href: string; label: string }[]
  /** ORG SITES ONLY. The clubs, locations and coaches blocks are aggregates over
   *  an organisation's member studios; without these they render empty, and a
   *  preview that silently drops three of the seven section types is worse than
   *  no preview. A team site passes neither. */
  orgId?: string
  orgTeams?: OrgSiteTeamRef[]
}) {
  const t = useTranslations('Website')
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fixed height, not max — the site inside changes height as the studio
          edits, and a dialog that resized with it would move the width switch
          under the cursor. Same rule as the contact pickers. */}
      <DialogContent className="sm:max-w-6xl h-[calc(100dvh-2rem)] p-0 gap-0">
        <DialogHeader className="flex-row items-center justify-between gap-4 border-b px-4 py-3 pr-12">
          <DialogTitle className="text-base">{t('preview')}</DialogTitle>
          {/* Hidden below sm: the switch offers a desktop view, and on a phone
              there is no width to render it at — the choice would be a lie. */}
          <div className="hidden shrink-0 items-center gap-1 rounded-lg border p-0.5 sm:flex">
            {(
              [
                ['desktop', Monitor, t('previewDesktop')],
                ['mobile', Smartphone, t('previewMobile')],
              ] as const
            ).map(([key, Icon, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setWidth(key)}
                aria-pressed={width === key}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  width === key
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </div>
        </DialogHeader>

        {/* The muted surround is what makes the mobile view read as a device
            rather than as a site that failed to fill the window. */}
        <DialogBody className="bg-muted/40 p-4 mr-0">
          <div
            // NO transition on max-width, deliberately. It animates a
            // percentage to a length, which forces a full layout of the whole
            // rendered site on every frame — and buys nothing: switching
            // desktop/mobile is a mode change, not a movement. It also stalls
            // outright anywhere the page is not compositing, leaving the frame
            // pinned at its start width.
            className="mx-auto h-full overflow-hidden rounded-xl border bg-background shadow-sm"
            style={{ maxWidth: width === 'mobile' ? MOBILE_WIDTH : '100%' }}
          >
            <div className="h-full overflow-y-auto">
              <WebsiteRenderer
                site={site}
                preview
                surfaceLinks={surfaceLinks}
                orgId={orgId}
                orgTeams={orgTeams}
              />
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
