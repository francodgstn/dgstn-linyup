'use client'

import { COLOR_PRESETS } from '@/lib/colors'

// Shared fixed bottom "summary + confirm" bar for the public booking flows —
// the class BookingForm ('sessions'/'who'/'returning'/'details' steps) and the
// appointment picker ('time'/'book' steps). Extracted from BookingForm.tsx
// verbatim (same markup, animation, shadow); generalized so the caller composes
// the display strings (provider label, date/time line) and this stays
// flow-agnostic. Fixed at max-w-2xl for BOTH flows regardless of the content
// column width — the original class-flow behaviour.

// Deterministic gradient from a name — the thumbnail fallback when an activity
// has no image (appointments never do). Exported because BookingForm's activity
// cards use the same fallback.
export function activityGradient(name: string): string {
  const colors = COLOR_PRESETS
  const i = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length
  return `linear-gradient(135deg, ${colors[i]}, ${colors[(i + 2) % colors.length]})`
}

/**
 * How much vertical room the bar needs. FlowShell reserves this as bottom padding
 * on the page variant; it used to be duplicated as a local constant in both flows.
 *
 * ONE number for both breakpoints, so it has to cover the taller one: on desktop
 * the bar is padded more AND lifted off the bottom edge, which is worth ~24px
 * over the phone layout. Measured from the rendered bar, not estimated — the
 * failure it prevents is silent (the last line of a form sits under the bar and
 * only a visitor who scrolls to the very bottom ever sees it).
 */
export const STICKY_H = 124

/**
 * Where the bar anchors.
 *  - 'viewport'  — fixed to the bottom of the window (full-page flows)
 *  - 'container' — sticky inside its scroll parent (inside a dialog/sheet, where
 *                  a viewport-fixed z-[100] bar would escape the panel)
 *
 * Required on purpose: there are exactly two call sites, and a forgotten default
 * is precisely how a bar ends up floating over a modal it doesn't belong to.
 */
export type StickyBarPosition = 'viewport' | 'container'

export interface StickyBarProps {
  title: string
  /** Activity image; a name-derived gradient is used when absent. */
  imageUrl?: string | null
  /** Already-composed "with Anna Schmidt" — null hides the line. */
  providerLabel?: string | null
  /** Already-composed "Mon, 20 July · 08:00–08:30" — null hides the date/loc rows. */
  dateTimeLabel?: string | null
  location?: string | null
  accentColor?: string | null
  position: StickyBarPosition
  showConfirm: boolean
  submitting: boolean
  /**
   * Greys the Confirm without hiding it — the state the consent step needs: a
   * visitor who has not ticked yet must see the control they are working
   * towards, and must not be able to submit a booking with nothing signed.
   * Hiding it instead would read as "there is nothing more to do here".
   */
  confirmDisabled?: boolean
  confirmLabel: string
  submittingLabel: string
  onConfirm: () => void
}

export function StickyBar({
  title,
  imageUrl,
  providerLabel,
  dateTimeLabel,
  location,
  accentColor,
  position,
  showConfirm,
  submitting,
  confirmDisabled,
  confirmLabel,
  submittingLabel,
  onConfirm,
}: StickyBarProps) {
  const bg = imageUrl ? `url("${imageUrl}")` : activityGradient(title)

  // ── Docked on a phone, floating on desktop ─────────────────────────────────
  //
  // A bar welded to the bottom edge reads as part of the browser rather than
  // part of the booking, which is why it was easy to miss. On desktop it lifts
  // off the edge and rounds on all four corners, so it reads as the card it is;
  // on a phone it stays docked and full-bleed, where an inset would only cost
  // thumb reach and horizontal room the summary actually needs.
  const anchor =
    position === 'viewport'
      ? 'fixed bottom-0 sm:bottom-5 left-1/2 w-[calc(100%-1rem)] max-w-2xl z-[100] rounded-t-2xl sm:rounded-2xl border-b-0 sm:border-b'
      : // Inside a panel the bar is part of the flex column: full width, no
        // transform, and a low z so it can't paint over the dialog's own chrome.
        // The desktop margins are what hold it off the panel's own edges.
        'sticky bottom-0 w-full sm:w-auto sm:mx-4 sm:mb-4 z-10 border-x-0 sm:border-x border-b-0 sm:border-b sm:rounded-2xl'

  // The centring translate lives in the KEYFRAMES for the viewport variant, not
  // only in a class: an `animation` that sets `transform` replaces the whole
  // property while it runs, so a bar centred by `-translate-x-1/2` slid up from
  // half a panel to the right and snapped into place at the end.
  const animation = position === 'viewport' ? 'slideUpBarCentred' : 'slideUpBar'

  return (
    <div
      className={`${anchor} ${position === 'viewport' ? '-translate-x-1/2' : ''} linyup-sticky-bar flex items-center gap-3 sm:gap-4 p-3 sm:p-5 border bg-background/95 backdrop-blur-md`}
      style={{ animation: `${animation} 0.35s cubic-bezier(0.34,1.56,0.64,1)` }}
    >
      {/* The shadow lives HERE rather than in a `shadow-[…]` class: a two-part
          shadow needs a top-level comma, and Tailwind v4 does not generate an
          arbitrary value containing one — the class is simply dropped, which is
          silent and leaves the bar with no shadow at all. A media query in the
          block the keyframes already need costs nothing and cannot be dropped.

          Docked on a phone, the shadow only has to lift the bar off the content
          above it, so it points UP. Floating on desktop it is a card with air on
          every side, so the shadow surrounds it and carries more weight — this
          is most of what makes the summary read as present rather than as part
          of the window frame. */}
      <style>{`
        .linyup-sticky-bar {
          box-shadow: 0 -8px 32px rgba(0,0,0,.10), 0 -2px 8px rgba(0,0,0,.06);
        }
        @media (min-width: 640px) {
          .linyup-sticky-bar {
            box-shadow: 0 16px 48px -12px rgba(15,23,42,.28), 0 4px 12px -4px rgba(15,23,42,.12);
          }
        }
        @keyframes slideUpBar {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        @keyframes slideUpBarCentred {
          from { transform: translate(-50%, 100%); opacity: 0; }
          to   { transform: translate(-50%, 0);    opacity: 1; }
        }
      `}</style>

      {/* Thumbnail */}
      <div
        className="w-14 h-14 sm:w-[4.5rem] sm:h-[4.5rem] rounded-lg sm:rounded-xl shrink-0 bg-muted"
        style={{
          background: bg,
          backgroundSize: imageUrl ? 'cover' : '100% 100%',
          backgroundPosition: 'center',
        }}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm sm:text-base truncate">{title}</p>
        {providerLabel && (
          <p className="text-xs sm:text-sm text-muted-foreground italic">{providerLabel}</p>
        )}
        {dateTimeLabel && (
          <div className="flex flex-col gap-0.5 mt-0.5">
            <div className="flex items-center gap-1 sm:gap-1.5 text-xs sm:text-sm text-muted-foreground">
              <svg
                className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <span>{dateTimeLabel}</span>
            </div>
            {location && (
              <div className="flex items-center gap-1 sm:gap-1.5 text-xs sm:text-sm text-muted-foreground">
                <svg
                  className="h-3 w-3 sm:h-3.5 sm:w-3.5 shrink-0 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <span className="truncate">{location}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Confirm */}
      {showConfirm && (
        <button
          onClick={onConfirm}
          disabled={submitting || confirmDisabled === true}
          style={accentColor ? { backgroundColor: accentColor } : undefined}
          className="shrink-0 rounded-xl bg-primary text-primary-foreground font-semibold px-5 sm:px-6 py-2.5 sm:py-3 text-sm sm:text-base hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {submitting ? submittingLabel : confirmLabel}
        </button>
      )}
    </div>
  )
}
