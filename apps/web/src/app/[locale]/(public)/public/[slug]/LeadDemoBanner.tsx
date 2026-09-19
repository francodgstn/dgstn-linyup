'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { leadDemoUrlLabel } from '@linyup/shared'
import { usePublicTeam } from './PublicTeamProvider'

// The lead-demo disclaimer (Team.lead_demo). A lead tenant mirrors a REAL
// studio's public content, so a visitor who lands on it by mistake could take it
// for the studio's own site. On every public surface of such a tenant this bar
// says, in the visitor's language, that it is a demo by Linyup and not the
// official website — and links the real one when the profile names it.
//
// FIXED TO THE BOTTOM and never dismissable: it cannot be scrolled away. The
// bottom because the top is taken — the website's header is sticky at top-0 and
// the sign-in pill floats top-right. A spacer of the same height at the end of
// the page flow keeps it from covering the last content. It sits BELOW dialogs
// (z-40, dialogs are z-50), so a booking sheet's buttons are never under it.
//
// It carries `data-lead-demo-banner`: while it is on the page, the generic
// "live demo of Linyup" strip of the sandbox build (AnnouncementBar) hides
// itself through CSS (globals.css), so a lead page says it once, and says the
// part that matters.
export function LeadDemoBanner() {
  const t = useTranslations('LeadDemo')
  const { team } = usePublicTeam()
  const marker = team.lead_demo
  if (!marker) return null
  const url = marker.official_url

  // Loud on purpose — it is public-facing and must not read as part of the
  // studio's own design: a warm gradient every studio palette clashes with, and
  // a black/amber hazard stripe along the edge that faces the page. Near-black
  // text on the amber-to-orange range keeps AA contrast in both themes (the bar
  // does not follow dark mode: a warning should look the same everywhere).
  const content = (
    <>
      <div
        aria-hidden
        className="h-1.5 w-full"
        style={{
          backgroundImage: 'repeating-linear-gradient(135deg, #0a0a0a 0 10px, #fbbf24 10px 20px)',
        }}
      />
      <p className="px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-center text-xs font-semibold leading-snug sm:text-sm">
        <TriangleAlert className="mr-1.5 inline h-4 w-4 -translate-y-px align-middle" aria-hidden />
        {t('notOfficial', { name: team.name })}
        {url ? (
          <>
            {' '}
            <a
              href={url}
              rel="noopener"
              className="ml-1 inline-block rounded-full bg-neutral-950 px-2.5 py-0.5 text-amber-300 hover:underline"
            >
              {t('officialSite', { site: leadDemoUrlLabel(url) })}
            </a>
          </>
        ) : null}
      </p>
    </>
  )

  return (
    <>
      {/* The spacer IS the same content, invisible and in the page flow, so it
          is exactly as tall as the fixed bar at every width and wrap. */}
      <div aria-hidden className="invisible">
        {content}
      </div>
      <div
        role="note"
        data-lead-demo-banner=""
        className="fixed inset-x-0 bottom-0 z-40 bg-gradient-to-r from-amber-300 via-orange-400 to-amber-300 text-neutral-950 shadow-[0_-4px_16px_rgba(0,0,0,0.25)]"
      >
        {content}
      </div>
    </>
  )
}
