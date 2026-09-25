'use client'

// The master-detail shell every settings section renders inside: the rail on the
// left, the section on the right, and on mobile the classic list ⇆ detail split.
//
// It lives in components/ rather than in the /settings route folder because it is
// used by TWO layouts: (auth)/settings/layout.tsx, and (auth)/public-page/layout.tsx.
// "Public pages" is a settings section whose route is /public-page — bookmarked,
// and sibling to /public-page/space, so the path cannot move — and it was the one
// section that rendered as a bare full page instead of a settings panel (UX-61).
// Sharing the shell is what makes it look like the others without moving a route.
// Its surface section shares it too; see the note on that layout for why it was
// excluded at first.
//
// Behavior:
//   desktop → rail (left) + detail (right), always both; /settings shows an overview.
//   mobile  → /settings shows just the rail (the list); a section shows just the
//             detail with a "back to Settings" link.

import { usePathname, Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { ChevronLeft } from 'lucide-react'
import { SettingsRail } from './SettingsRail'

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('Nav')
  const pathname = usePathname()
  // The rail IS the mobile page at /settings and nowhere else — a section reached
  // by any other path (including /public-page) is always a detail view.
  const isRoot = pathname === '/settings'

  return (
    <div className="md:flex md:gap-8">
      <aside className={`md:w-60 md:shrink-0 ${isRoot ? 'block' : 'hidden md:block'}`}>
        <div className="md:sticky md:top-6">
          <SettingsRail />
        </div>
      </aside>

      <div className={`min-w-0 flex-1 ${isRoot ? 'hidden md:block' : 'block'}`}>
        {!isRoot && (
          <Link
            href={'/settings' as Route}
            className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('settingsHubTitle')}
          </Link>
        )}
        {children}
      </div>
    </div>
  )
}
