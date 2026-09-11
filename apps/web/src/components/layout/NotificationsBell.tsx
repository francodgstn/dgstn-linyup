'use client'

/**
 * THE STUDIO'S INBOX, ALWAYS ON.
 *
 * Until now `teams/{teamId}/notifications` had exactly one surface — a banner
 * on the dashboard (`TeamNotificationsBanner`) — so anything that arrived while
 * a manager was anywhere else in the app was invisible until their next visit
 * to `/dashboard`. This is the persistent answer: a bell that lives in the
 * sidebar chrome itself, mounted in TWO places by the same component rather
 * than two copies of its logic —
 *
 *   1. the utility tray's resting slot (`layout.tsx`'s `UtilityTray`), beside
 *      the QR button, visible without hover/pin;
 *   2. the identity block when the sidebar is COLLAPSED (`layout.tsx`'s
 *      `SidebarContent`), where the tray itself does not render at all — a
 *      w-14 rail has no row for it to expand into.
 *
 * Both mounts render this component with no props: the icon-only shape
 * (`showLabel` unset) is already the 32px box both slots need, matching
 * `TeamQrButton` and `UtilityIconLink` deliberately — the row reads as one
 * cluster of same-sized controls, and this being a button that opens a sheet
 * rather than a link is an implementation detail, not something to telegraph.
 *
 * SELF-GATING ON ROLE, not just on the Firestore rules. `useTeamNotifications`
 * disables its query for anyone who is not manager/owner, and this component
 * renders nothing at all in that case — a coach or viewer never sees a bell
 * that would open onto a permanently-empty sheet.
 *
 * A PULSING DOT, NOT A COUNT — there is no count-badge pattern anywhere in this
 * sidebar; the one established live indicator on shell chrome is the feedback
 * launcher's dot (`FeedbackLauncher.tsx`), matched here rather than invented
 * fresh.
 *
 * THE PANEL IS A `Sheet side="right"`, not a `DropdownMenu`. The dropdown
 * pattern in this sidebar (`ScopeSwitcher`, `UserMenu`) is for a short, fixed
 * list of destinations read in one glance. A notification list is unbounded,
 * needs to scroll, and carries three lines of content per row (title, body,
 * relative time) plus a dismiss action — exactly what `FeedbackLauncher`
 * already reaches for the same shape for, so this reuses it rather than
 * inventing a third panel style.
 */

import { useState } from 'react'
import { useTranslations, useFormatter } from 'next-intl'
import { Bell, Inbox, X } from 'lucide-react'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { useTeamNotifications, UNREAD_NOTIFICATIONS_LIMIT } from '@/hooks/useTeamNotifications'
import { LEDGER_RETENTION_DAYS, type TeamNotification } from '@linyup/shared'

export function NotificationsBell({ showLabel }: { showLabel?: boolean }) {
  const t = useTranslations('Notifications')
  const [open, setOpen] = useState(false)
  const { canRead, unread, truncated, isLoading, markRead } = useTeamNotifications()

  // No role, no bell — see the module header. Hooks above still ran
  // unconditionally, so this early return is safe.
  if (!canRead) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('bellTitle')}
        aria-label={t('bellTitle')}
        className={`relative flex h-8 shrink-0 items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
          showLabel ? 'w-full gap-2 px-2 text-sm' : 'w-8 justify-center'
        }`}
      >
        <Bell className="h-4 w-4 shrink-0" />
        {showLabel && <span className="truncate">{t('bellTitle')}</span>}
        {unread.length > 0 && (
          <span
            aria-hidden
            className={`absolute h-2.5 w-2.5 animate-pulse rounded-full bg-red-500 ring-2 ring-background ${
              showLabel ? 'left-2 top-1' : '-right-0.5 -top-0.5'
            }`}
          />
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-md!">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              {t('panelTitle')}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {t('unreadCount', { count: unread.length })}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {isLoading ? null : unread.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
                <Inbox className="h-8 w-8" />
                <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
                <p className="text-xs">{t('emptyBody')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {unread.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    onDismiss={() => markRead(n.id)}
                    onNavigate={() => setOpen(false)}
                  />
                ))}
                {/* HONEST TRUNCATION — the page is capped, and a full page
                    means there may be older unread items behind it. Dismissing
                    these pulls the next ones forward; the rest age out. */}
                {truncated && (
                  <p className="pt-2 text-xs text-muted-foreground">
                    {t('showingLatest', {
                      count: UNREAD_NOTIFICATIONS_LIMIT,
                      days: LEDGER_RETENTION_DAYS.notifications,
                    })}
                  </p>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function NotificationRow({
  notification,
  onDismiss,
  onNavigate,
}: {
  notification: TeamNotification
  onDismiss: () => void
  onNavigate: () => void
}) {
  const t = useTranslations('Notifications')
  const format = useFormatter()
  const when = notification.created_at ? format.relativeTime(notification.created_at.toDate()) : ''

  // The dismiss button is a SIBLING of the link, never nested inside its <a>:
  // an interactive element inside another is invalid HTML and would make the
  // dismiss click also navigate.
  const content = (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium">{notification.title}</p>
      {notification.body && (
        <p className="mt-0.5 text-sm text-muted-foreground">{notification.body}</p>
      )}
      {when && <p className="mt-1 text-xs text-muted-foreground/70">{when}</p>}
    </div>
  )

  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5">
      {notification.link ? (
        <Link
          href={notification.link as Route}
          onClick={onNavigate}
          className="min-w-0 flex-1 rounded-md transition-colors hover:text-primary"
        >
          {content}
        </Link>
      ) : (
        content
      )}
      <button
        type="button"
        aria-label={t('dismiss')}
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
