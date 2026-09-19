'use client'

import { useState, useEffect } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { useTheme } from 'next-themes'
import { useAuth } from '@/contexts/AuthContext'
import { useRouter, usePathname } from '@/i18n/navigation'
import { persistLocale } from '@/i18n/persistLocale'
import {
  Sun,
  Moon,
  Monitor,
  Rocket,
  LogOut,
  BarChart3,
  Settings,
  FileText,
  ShieldCheck,
  Lock,
  ExternalLink,
  LifeBuoy,
} from 'lucide-react'
import { posthog } from '@/lib/posthog'
import { OPEN_SETUP_GUIDE_EVENT } from '@/components/onboarding/SetupGuide'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

function UserAvatar({ email }: { email: string | null }) {
  const initial = email?.[0]?.toUpperCase() ?? '?'
  return (
    <div className="h-7 w-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold select-none shrink-0">
      {initial}
    </div>
  )
}

/**
 * Sidebar-bottom user card: avatar + email + team name opening the account
 * dropdown (theme, language, replay tour, sign out), with a QR shortcut beside.
 */
export function UserMenu({ collapsed }: { collapsed: boolean }) {
  const t = useTranslations('TopBar')
  const tNav = useTranslations('Nav')
  const tOnb = useTranslations('Onboarding')
  const { user } = useAuth()
  const { theme, setTheme } = useTheme()
  const router = useRouter()
  const pathname = usePathname()
  const locale = useLocale()

  // Product analytics opt-out. Analytics runs under legitimate interest; this lets
  // a customer turn it off. PostHog persists + respects the choice across loads.
  const analyticsEnabled = !!process.env.NEXT_PUBLIC_POSTHOG_KEY
  const [analyticsOptedOut, setAnalyticsOptedOut] = useState(false)
  useEffect(() => {
    if (!analyticsEnabled) return
    try {
      setAnalyticsOptedOut(posthog.has_opted_out_capturing())
    } catch {
      /* posthog not ready — default to opted-in */
    }
  }, [analyticsEnabled])

  function toggleAnalytics() {
    if (analyticsOptedOut) {
      posthog.opt_in_capturing()
      setAnalyticsOptedOut(false)
    } else {
      posthog.opt_out_capturing()
      setAnalyticsOptedOut(true)
    }
  }

  async function handleSignOut() {
    const { signOut } = await import('@/lib/auth')
    await signOut()
    router.push('/login')
  }

  return (
    <>
      <div className={`flex gap-1 ${collapsed ? 'flex-col items-center' : 'items-center'}`}>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t('account')}
            title={collapsed ? (user?.email ?? t('account')) : undefined}
            className={`flex items-center gap-2.5 rounded-lg hover:bg-muted transition-colors text-left min-w-0 ${
              collapsed ? 'p-1.5 justify-center' : 'flex-1 px-2 py-1.5'
            }`}
          >
            <UserAvatar email={user?.email ?? null} />
            {!collapsed && (
              // Email only: the PLACE is named in the sidebar header, and
              // repeating it here just made two lines say one thing.
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{user?.email}</p>
              </div>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align={collapsed ? 'start' : 'end'} side="top" className="w-56">
            <DropdownMenuGroup>
              {/* THE PERSON, NOT THE PLACE. This used to add the studio name
                  under the email — which named the STUDIO even while you stood
                  in an ORGANISATION, the same wrong-scope label the header row
                  was rebuilt to remove. The place is said once, at the top of
                  the sidebar, by the control that also changes it. */}
              <DropdownMenuLabel className="font-normal">
                <span className="truncate text-xs font-medium">{user?.email}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />

            {/* THE STUDIO/ORGANISATION SWITCHER IS NOT HERE ANY MORE
                (2026-08-27). It moved to the sidebar's header row, where the
                scope is NAMED — the indicator and the control are one object
                now, because "which place am I standing in" is a question the
                scope model made constant, and answering it at one end of the
                sidebar while changing it at the other was the split this
                removes. See components/layout/ScopeSwitcher.tsx.

                What is left in this menu is the PERSON: their email, the theme,
                the language, sign-out. */}

            {/* Theme toggle — Light / Dark / System (follow OS) */}
            <div className="px-2 py-1.5">
              <div className="flex rounded-md border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setTheme('light')}
                  className={`flex-1 flex items-center justify-center gap-1 py-1 text-xs transition-colors ${
                    theme === 'light' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'
                  }`}
                >
                  <Sun className="h-3 w-3" />
                  {t('lightMode')}
                </button>
                <button
                  type="button"
                  onClick={() => setTheme('dark')}
                  className={`flex-1 flex items-center justify-center gap-1 py-1 text-xs transition-colors ${
                    theme === 'dark' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'
                  }`}
                >
                  <Moon className="h-3 w-3" />
                  {t('darkMode')}
                </button>
                <button
                  type="button"
                  onClick={() => setTheme('system')}
                  className={`flex-1 flex items-center justify-center gap-1 py-1 text-xs transition-colors ${
                    theme === 'system' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'
                  }`}
                >
                  <Monitor className="h-3 w-3" />
                  {t('systemMode')}
                </button>
              </div>
            </div>
            {/* Language switcher */}
            <div className="px-2 py-1.5">
              <Select
                value={locale}
                onValueChange={(l) => {
                  if (!l) return
                  // Persist first — an unprefixed (English) URL is otherwise
                  // re-resolved from Accept-Language. See persistLocale.
                  persistLocale(l)
                  router.replace(pathname, { locale: l })
                }}
              >
                <SelectTrigger className="h-7 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="de">Deutsch</SelectItem>
                  <SelectItem value="fr">Français</SelectItem>
                  <SelectItem value="it">Italiano</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Product analytics opt-out (only when analytics is configured) */}
            {analyticsEnabled && (
              <div className="px-2 py-1.5">
                <button
                  type="button"
                  onClick={toggleAnalytics}
                  aria-pressed={!analyticsOptedOut}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted transition-colors"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <BarChart3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-xs font-medium">{t('analytics')}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {t('analyticsHint')}
                      </span>
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      analyticsOptedOut
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {analyticsOptedOut ? t('analyticsOff') : t('analyticsOn')}
                  </span>
                </button>
              </div>
            )}
            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={() => router.push('/settings')}>
              <Settings className="h-4 w-4 mr-2" />
              {tNav('settings')}
            </DropdownMenuItem>
            {/* Was "Replay tour". The tour is gone (2026-08-23) — three steps
                over the sidebar's chrome, auto-started on day one against the
                setup guide, and never instrumented, so nobody could say whether
                it helped. The guide teaches the same thing by DOING: every step
                is a link to the page that step is about. This is the way back
                to it once it has been dismissed. */}
            <DropdownMenuItem
              onClick={() => window.dispatchEvent(new Event(OPEN_SETUP_GUIDE_EVENT))}
            >
              <Rocket className="h-4 w-4 mr-2" />
              {tOnb('setup.title')}
            </DropdownMenuItem>
            {/* The public help centre (apps/help). External for the same reason
                as the legal links below: one published copy, opened in a new tab
                so the studio keeps its place in the app. */}
            <DropdownMenuItem
              onClick={() => window.open('https://help.linyup.com', '_blank', 'noopener,noreferrer')}
            >
              <LifeBuoy className="h-4 w-4 mr-2" />
              {tNav('helpCentre')}
              <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />

            {/* THE LEGAL DOCUMENTS, and this is where people look for them: an
                account menu is the conventional home for Terms and Privacy in a
                product with no page footer, which this app shell does not have.
                They live on the marketing site (linyup.com), not in the app —
                one published copy, the same one a prospect reads and the same
                one the signup step links to — so these are external links and
                open in a new tab rather than dropping the studio out of its
                workspace. */}
            {(
              [
                { href: 'https://linyup.com/terms', icon: FileText, key: 'legalTerms' },
                { href: 'https://linyup.com/dpa', icon: ShieldCheck, key: 'legalDpa' },
                { href: 'https://linyup.com/privacy', icon: Lock, key: 'legalPrivacy' },
              ] as const
            ).map(({ href, icon: Icon, key }) => (
              <DropdownMenuItem
                key={key}
                // `window.open`, not `asChild` + <a>: this menu is base-ui and
                // does not take `asChild`, and the other items here already
                // navigate from onClick. `noopener` is not optional on a
                // target=_blank — without it the opened page gets a handle on
                // this one through `window.opener`.
                onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}
              >
                <Icon className="h-4 w-4 mr-2" />
                {tNav(key)}
                <ExternalLink className="h-3 w-3 ml-auto opacity-50" />
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={handleSignOut} variant="destructive">
              <LogOut className="h-4 w-4 mr-2" />
              {tNav('signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* The QR shortcut moved to the utility icon row at the top of the
            sidebar (components/layout/TeamQrButton.tsx): it is a STUDIO-level
            action and had no business sitting inside the account cluster. */}
      </div>
    </>
  )
}
