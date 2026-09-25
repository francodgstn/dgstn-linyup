'use client'

// Shared "this failed to load" block — the counterpart to the empty-state pattern
// used across list/manager surfaces (icon + message + optional hint), but for a
// FAILED fetch rather than a genuine zero-results state. Failure must never render
// as an empty state: a coach who sees "No coaches yet" after a permission error
// concludes they misconfigured something; they should see this instead, with a
// way to retry.

import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

const MAX_DETAIL_LENGTH = 160

function truncateDetail(detail: string): string {
  return detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…` : detail
}

/**
 * Tenant palette, for the TEAM-BRANDED public surfaces (Space, shop).
 *
 * Those surfaces paint themselves from the studio's bio-link theme, so the app's
 * own `foreground` / `muted-foreground` / `destructive` tokens are simply not the
 * colors in play: a studio running a dark bio-link theme gets near-black text on
 * a near-black card — invisible in exactly the situation this component exists to
 * make visible. Pass the host surface's own values (`useSpaceTheme`, or
 * ShopHome's locals) and the block is legible on any tenant theme.
 *
 * Omit it on the app-token surfaces (the authenticated app, the documents index,
 * the appointment picker, the course player) — there the tokens ARE correct.
 */
export interface QueryErrorTheme {
  /** Title color — the surface's primary text. */
  textMain: string
  /** Detail-line color — the surface's secondary text. */
  textMuted: string
  /** The studio's accent. Used as a WASH BEHIND the retry control, never as its
   *  text color — an arbitrary tenant hue as 14px text is a contrast failure
   *  waiting to happen (see the button below). */
  accent: string
  /** Retry-control outline — the surface's card border. */
  border: string
}

/**
 * The one mark that cannot come from either palette: it has to read on a white
 * card AND on a near-black one, and both the app's `destructive` token and the
 * studio's accent (which may be any hue, green included) fail one of those.
 * red-500 clears 3:1 against both ends.
 */
const THEMED_ICON_COLOR = '#ef4444'

export function QueryErrorState({
  onRetry,
  title,
  detail,
  className,
  theme,
}: {
  /** Re-run the failed query/load. */
  onRetry: () => void
  /** Overrides the default "Couldn't load this" copy. */
  title?: string
  /** The underlying error's message, if any — shown truncated as a detail line. */
  detail?: string | null
  className?: string
  /** Set on team-branded surfaces — see `QueryErrorTheme`. */
  theme?: QueryErrorTheme
}) {
  const t = useTranslations('Common')
  return (
    <div
      className={`flex flex-col items-center gap-3 py-10 text-center${className ? ` ${className}` : ''}`}
      role="alert"
    >
      <AlertTriangle
        className={`h-8 w-8${theme ? '' : ' text-destructive/70'}`}
        style={theme ? { color: THEMED_ICON_COLOR } : undefined}
      />
      <div className="space-y-1">
        <p
          className={`font-medium${theme ? '' : ' text-foreground'}`}
          style={theme ? { color: theme.textMain } : undefined}
        >
          {title ?? t('errorLoadTitle')}
        </p>
        {detail && (
          <p
            className={`max-w-sm truncate text-sm${theme ? '' : ' text-muted-foreground'}`}
            style={theme ? { color: theme.textMuted } : undefined}
            title={detail}
          >
            {truncateDetail(detail)}
          </p>
        )}
      </div>
      {theme ? (
        // The label takes the surface's OWN primary text color — the same color
        // as the title two lines above, which every tenant theme already commits
        // to being readable on this card. The studio's accent was doing that job
        // and failing it: measured against the tenant card backgrounds it came out
        // at 4.47:1 on the light theme and 3.21:1 on the dark one, both under the
        // 4.5:1 AA floor for 14px text — on the ONE control that makes this block
        // more than an apology. The accent keeps the button branded from behind
        // (a wash + the card's outline), where the bar is 3:1 for non-text and a
        // washed-out result costs legibility nothing. The `1f` alpha suffix is the
        // same 6-digit-hex convention the Space and shop already paint tints with;
        // a stored accent that isn't one drops the wash and leaves the outlined
        // button, which is exactly the failure mode you want from a decoration.
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full px-4 py-1.5 text-sm font-medium transition-opacity hover:opacity-80"
          style={{
            border: `1px solid ${theme.border}`,
            background: `${theme.accent}1f`,
            color: theme.textMain,
          }}
        >
          {t('errorRetry')}
        </button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('errorRetry')}
        </Button>
      )}
    </div>
  )
}
