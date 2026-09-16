'use client'

import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { publicHref } from '@/lib/publicRoutes'
import { PublicBackBar } from './PublicBackBar'

interface BioLinkShellProps {
  teamName: string
  slug: string
  accentColor?: string | null
  children: React.ReactNode
  wide?: boolean
  stickyBarHeight?: number // px of bottom padding to reserve for sticky bar
  /** Free-plan bio-links carry a "Powered by Linyup" footer (public_profile.showBranding). */
  showBranding?: boolean
  /**
   * Where the top-left arrow goes. Callers that know where the visitor came
   * from (`?from=`) resolve it with `returnHref` and pass it here, so "back"
   * returns to the surface they actually arrived from.
   *
   * Omitted → the team root. That root then CLIENT-redirects to the team's
   * default surface, which costs a spinner and a second hop — so pass this
   * whenever the caller holds `team`.
   *
   * `label` defaults to the team name: every return target belongs to this
   * team, so the studio's name reads better in the header than the surface's.
   */
  backTo?: { href: Route; label?: string }
}

export function BioLinkShell({
  teamName,
  slug,
  accentColor,
  children,
  wide,
  stickyBarHeight,
  showBranding,
  backTo,
}: BioLinkShellProps) {
  return (
    <div className="min-h-screen bg-background">
      {/* Top nav */}
      <PublicBackBar href={backTo?.href ?? publicHref(slug)} label={backTo?.label ?? teamName} />

      {/* Content */}
      <div
        className={`mx-auto px-5 py-8 space-y-6 ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        style={stickyBarHeight ? { paddingBottom: `${stickyBarHeight + 32}px` } : undefined}
      >
        {children}
        {showBranding === true && (
          <p className="pt-4 text-center text-xs text-muted-foreground">
            Powered by{' '}
            <Link href="/" className="hover:underline font-medium">
              Linyup
            </Link>
          </p>
        )}
      </div>

      {/* Accent color injected as custom property for CTA buttons */}
      {accentColor && <style>{`:root { --bio-link-accent: ${accentColor}; }`}</style>}
    </div>
  )
}

/** Primary CTA button styled with the bio-link's accent color */
export function BioLinkButton({
  children,
  disabled,
  type = 'button',
  onClick,
  accentColor,
}: {
  children: React.ReactNode
  disabled?: boolean
  type?: 'button' | 'submit'
  onClick?: () => void
  accentColor?: string | null
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={accentColor ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}
      className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 text-sm"
    >
      {children}
    </button>
  )
}
