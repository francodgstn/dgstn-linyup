'use client'

// Puts "Public pages" and its surface section inside the settings shell — rail
// on the left, section in the detail pane — so the settings section whose route
// is not under /settings/* still reads as a settings panel rather than a bare
// full page (UX-61, reported by Franco).
//
// THIS USED TO COVER THE HUB ALONE, via a `(hub)` route group. The note there
// said a layout at this level "would have wrapped those full-width management
// pages in the settings rail as well, which they are not" — and that belief was
// the defect. /public-page/space held one switch, a status dot the hub already
// draws, and two links out; stretched full-width it read as an unfinished page
// rather than a small section, which is exactly what it is.
//
// So the group is gone and the shell applies to both. The routes are unchanged
// — /public-page and /public-page/space are bookmarked and linked from the main
// nav — which is the property the route group was protecting and
// this keeps for free: a layout adds no path segment either.
//
// /public-page/shop was a third section here until 2026-09-01. It wrote nothing
// and only signposted /offer/* and the payment settings, so it was deleted and
// the hub's own Shop row (live dot, preview, price-list distinction) took over.

import { SettingsShell } from '@/components/settings/SettingsShell'

export default function PublicPagesLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>
}
