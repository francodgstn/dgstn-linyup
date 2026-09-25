'use client'

import { useTranslations } from 'next-intl'
import { LogOut } from 'lucide-react'
import { useSpaceAuth } from './SpaceAuthProvider'
import { useSpaceTheme } from './useSpaceTheme'
import SpacePortalNav from './SpacePortalNav'
import { Tip } from '@/components/ui/tip'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'

// Portal chrome shared by every module page (home / bookings / account): themed
// background, team header + sign-in, and the module nav. The course player
// deliberately does NOT use the shell (it wants full width).
//
// IT MOUNTS NO SIGN-IN DIALOG (UX-58). The team-root layout mounts exactly one,
// `PublicContactSignIn`, for EVERY public surface — and this shell used to mount
// a second one off the same `step`, so pressing "Sign in" anywhere inside the
// portal opened two stacked modals with two focus traps and two email fields.
// The shell's copy also predated the `register` step, so it was the WORSE of the
// two: it stayed blank where the global one shows the registration form. Any
// trigger anywhere calls `openSignIn()`; the one dialog reacts.
export default function SpaceShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('Space')
  const { isRestoring, isAuthenticated, contact, logout, openSignIn } = useSpaceAuth()
  const { team, bgStyle, textMain, textMuted, accent, cardBg, cardBorder } = useSpaceTheme()

  return (
    <div className="min-h-screen w-full" style={{ background: bgStyle, color: textMain, fontFamily: 'inherit' }}>
      <div className="max-w-[640px] mx-auto px-5 pb-16">
        {/* Header */}
        <div className="pt-10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {team?.profileImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={team.profileImage} alt={team?.name ?? ''} className="h-10 w-10 rounded-full object-cover" />
            ) : (
              <div
                className="h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold text-white"
                style={{ background: accent }}
              >
                {team?.name?.[0]?.toUpperCase() ?? '?'}
              </div>
            )}
            {/* Steps down a size on a phone: the header gained a language control,
                and at 420px the studio's own name was the thing that lost —
                "Linyup Demo Stu…" is a worse header than a slightly smaller
                one that reads. */}
            <h1 className="truncate text-lg font-bold sm:text-xl" style={{ color: textMain }}>{team?.name}</h1>
          </div>

          {/* Three states, not two. While a stored session is being checked we
              do not yet know who this is, so the header offers NOTHING rather
              than a "Sign in" button to somebody who already is (UX-37). */}
          {/* Language sits with the header controls, the same place the studio's
              website puts it (WebsiteRenderer keeps it in the nav bar) rather
              than the bio-link's centered footer — this shell HAS a header, so
              the footer placement would strand it below the fold on a portal
              whose pages scroll. Outside the auth branch on purpose: choosing a
              language is not something you should have to sign in to do. */}
          <div className="flex items-center gap-2 shrink-0">
          <LocaleSwitcher
            className="shrink-0"
            triggerStyle={{ background: cardBg, borderColor: cardBorder, color: textMain }}
          />
          {isRestoring ? (
            <div className="h-8 w-16 rounded-full animate-pulse shrink-0" style={{ background: cardBg }} />
          ) : isAuthenticated && contact ? (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs hidden sm:inline" style={{ color: textMuted }}>
                {t('signedInAs', { name: `${contact.firstname} ${contact.lastname}` })}
              </span>
              <Tip label={t('signOut')}>
                <button
                  onClick={() => logout()}
                  className="h-8 w-8 rounded-full flex items-center justify-center transition-opacity hover:opacity-70"
                  style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textMain }}
                  aria-label={t('signOut')}
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </Tip>
            </div>
          ) : (
            <button
              onClick={() => openSignIn()}
              className="text-sm font-medium px-4 py-1.5 rounded-full transition-opacity hover:opacity-80 shrink-0"
              style={{ background: accent, color: '#fff' }}
            >
              {t('signIn')}
            </button>
          )}
          </div>
        </div>

        <SpacePortalNav />

        {children}
      </div>
    </div>
  )
}
