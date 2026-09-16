'use client'

import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import type { Route } from 'next'
import { Home, CalendarClock, Flag, User, Receipt, Trophy, HeartPulse } from 'lucide-react'
import { useSpaceAuth } from './SpaceAuthProvider'
import { useSpaceTheme } from './useSpaceTheme'
import { useSpacePayments } from './useSpacePayments'
import { useSpaceReceipts } from './useSpaceReceipts'
import { usePublicTeam } from '../PublicTeamProvider'

// Portal module tabs — the whole portal is a signed-in, personal area (home is the
// member dashboard, not a public course library), so the tabs only render once
// there's a session. Payments is conditional: shown only when the contact has any
// payment history OR a Stripe billing account (hidden for cash / other payers).
// Receipts (Tarif 595) likewise: shown once the member has been issued one.
export default function SpacePortalNav() {
  const t = useTranslations('Space')
  const { slug, isAuthenticated, isRestoring } = useSpaceAuth()
  const { accent, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const pathname = usePathname()
  const { data: paymentsData, isError: paymentsFailed } = useSpacePayments()
  const { data: receiptsData, isError: receiptsFailed } = useSpaceReceipts()
  const { team } = usePublicTeam()

  // While a stored session is still being checked, keep the tab bar's SPACE
  // rather than deleting it: the nav vanishing and reappearing on every load of
  // her own portal is the same "you are not signed in" flicker as the wall
  // below it (UX-37), just told with layout instead of words.
  if (isRestoring) {
    return (
      <div className="pt-6">
        <div
          className="h-[58px] rounded-3xl animate-pulse"
          style={{ background: cardBg, border: `1px solid ${cardBorder}` }}
        />
      </div>
    )
  }
  if (!isAuthenticated) return null

  // On FAILURE the tab stays. Hiding it would delete the only surface that can
  // explain the failure, and the deletion itself reads as an answer: "you have no
  // payments here". An empty RESULT hides the tab; an unknown one must not.
  const hasPayments =
    paymentsFailed ||
    (paymentsData?.payments.length ?? 0) > 0 ||
    paymentsData?.billingAvailable === true
  // Same rule for receipts: a failed read keeps the tab (the page says so and
  // offers a retry); only an EMPTY answer hides it.
  const hasReceipts = receiptsFailed || (receiptsData?.receipts.length ?? 0) > 0

  const base = `/public/${slug}/space`
  const items = [
    { href: base, label: t('navHome'), icon: Home, exact: true },
    { href: `${base}/bookings`, label: t('navBookings'), icon: CalendarClock },
    // Base capability on every plan (`goals` is in PLAN_FEATURES for free
    // through organization), same as Bookings/Account — no conditional gate.
    { href: `${base}/coaching`, label: t('navCoaching'), icon: Flag },
    // Gated on the mirrored plugin flag (Space cannot read `installed_plugins`
    // directly — see TeamPublicProfile.gamificationEnabled).
    ...(team?.gamificationEnabled
      ? [{ href: `${base}/gamification`, label: t('navGamification'), icon: Trophy }]
      : []),
    ...(hasPayments ? [{ href: `${base}/payments`, label: t('navPayments'), icon: Receipt }] : []),
    ...(hasReceipts ? [{ href: `${base}/receipts`, label: t('navReceipts'), icon: HeartPulse }] : []),
    { href: `${base}/account`, label: t('navAccount'), icon: User },
  ]

  return (
    <nav className="pt-6">
      <div className="flex gap-1 rounded-3xl p-1" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
        {items.map((it) => {
          const active = it.exact ? pathname === it.href : pathname.startsWith(it.href)
          const Icon = it.icon
          return (
            <Link
              key={it.href}
              href={it.href as Route}
              className="flex-1 inline-flex min-w-0 flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2 text-xs font-medium leading-none transition-opacity hover:opacity-90"
              style={active ? { background: accent, color: '#fff' } : { color: textMuted }}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="w-full truncate text-center">{it.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
