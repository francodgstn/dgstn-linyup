'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { parsePublicFrom } from '@linyup/shared'
import { publicHref } from '@/lib/publicRoutes'
import { Link, usePathname } from '@/i18n/navigation'
import type { Route } from 'next'
import { CircleUser, LogIn, LogOut } from 'lucide-react'
import { usePublicContactAuth } from './PublicContactAuthProvider'
import { useSpaceTheme } from './space/useSpaceTheme'
import SignInDialog from './space/SignInDialog'
import { Tip } from '@/components/ui/tip'

// Shared sign-in control for public surfaces that lack their own auth chrome
// (bio-link, booking, signup, documents, shop, appointments …). Space has its own
// header control and the full website (/site) has its own design, so both opt out.
// The entrance-tablet kiosk (/kiosk) is a fixed, low-chrome surface with no contact
// auth at all (it uses a separate device-pairing session — see kiosk/KioskLock.tsx),
// so it opts out too. Backed by the lifted contact-session context, so a login
// persists across surfaces.
/**
 * The sign-in DIALOG, mounted for every public surface unconditionally.
 *
 * Split out from the pill below because the surfaces that opt out of the pill
 * still need to be able to OPEN sign-in from their own chrome — the website
 * (/site) draws its own palette-styled control and calls `openSignIn()`. One
 * dialog instance, one `step` source from PublicContactAuthProvider.
 */
export function PublicContactSignIn() {
  const { slug, step, closeSignIn } = usePublicContactAuth()

  const signInOpen =
    step === 'email' || step === 'code' || step === 'selectContact' || step === 'register'
  const onSignInOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeSignIn()
    },
    [closeSignIn]
  )

  return <SignInDialog open={signInOpen} onOpenChange={onSignInOpenChange} slug={slug} />
}

/** Surfaces this bar can sit on, longest-first so `appointments/cancel` is not
 *  matched as `appointments`. Only surfaces a visitor can meaningfully return
 *  to — the bar does not render on the others. */
const PUBLIC_FROM_CANDIDATES = [
  'appointments',
  'documents',
  'events',
  'booking',
  'signup',
  'shop',
]

export function PublicContactBar() {
  const t = useTranslations('Space')
  const pathname = usePathname()
  const { slug, isAuthenticated, isRestoring, contact, openSignIn, logout } = usePublicContactAuth()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()

  // Precise segment match (so a slug like "spacegym" isn't mistaken for /space).
  const onSurface = (s: string) => pathname.endsWith(`/${s}`) || pathname.includes(`/${s}/`)
  if (onSurface('space') || onSurface('site') || onSurface('kiosk')) return null

  // Stamp the surface the visitor is standing on, so the portal's return bar
  // sends them BACK here rather than to the team's default surface. The bar
  // never renders on /site (the website draws its own control, which stamps
  // `from: 'site'` itself), so the tenant root resolves to the bio-link.
  const currentSurface = parsePublicFrom(
    PUBLIC_FROM_CANDIDATES.find((s) => onSurface(s))
  ) ?? 'bio-link'
  const spaceHref = publicHref(slug, 'space', { from: currentSurface })
  // A returning member's session is still being checked — show nothing rather
  // than a "Sign in" pill she is about to be told she does not need (UX-37).
  // Nothing, not a skeleton: this control floats over the page, and a pulsing
  // placeholder in the corner of every load is worse than a half-second gap.
  if (isRestoring) return null

  return (
    <>
      <div className="fixed right-3 top-3 z-40 print:hidden">
        {isAuthenticated && contact ? (
          <div
            className="flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1 text-xs font-medium shadow-sm"
            style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textMain }}
          >
            {/* Name links to the contact's personal Space (their portal home) */}
            <Link
              href={spaceHref}
              title={t('openSpace')}
              className="flex min-w-0 items-center gap-1 transition-opacity hover:opacity-70"
            >
              <CircleUser className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
              <span className="max-w-[120px] truncate underline-offset-2 hover:underline">
                {contact.firstname}
              </span>
            </Link>
            <Tip label={t('signOut')}>
              <button
                type="button"
                onClick={() => logout()}
                aria-label={t('signOut')}
                className="flex h-6 w-6 items-center justify-center rounded-full transition-opacity hover:opacity-70"
                style={{ color: textMuted }}
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => openSignIn()}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow-sm transition-opacity hover:opacity-80"
            style={{ background: accent, color: '#fff' }}
          >
            <LogIn className="h-3.5 w-3.5" />
            {t('signIn')}
          </button>
        )}
      </div>
    </>
  )
}
