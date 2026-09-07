'use client'

/**
 * THE FEDERATION'S CALENDAR — org-scope events, which are the one time-shaped
 * thing an organisation genuinely owns.
 *
 * An org event carries `scope: 'org'` and NO `teamId` (see `docs/event-program.md`),
 * so no studio-scoped query can ever find it: a member studio's calendar simply
 * does not contain the federation's championship. That is the whole reason this
 * belongs on the org dashboard and not by inference from a studio's.
 *
 * A COUNT AND A LIST, and the count is asked separately: the list is capped at
 * five, and "the next five" printed as though it were "all of them" is how a
 * federation with twenty events booked reads its calendar as nearly empty.
 */

import { useFormatter, useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { CalendarRange } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { orgHref } from '@/lib/org-nav'
import type { OrgEventRow } from './data'

export function UpcomingEventsCard({
  orgId,
  rows,
  total,
  loading,
}: {
  orgId: string
  rows: OrgEventRow[]
  total: number | null
  loading: boolean
}) {
  const t = useTranslations('OrgDashboard')
  const format = useFormatter()
  const more = total != null ? total - rows.length : 0

  return (
    <Card size="sm">
      <CardHeader className="grid-cols-[1fr_auto]">
        <CardTitle className="text-sm">{t('eventsTitle')}</CardTitle>
        <Link
          href={orgHref(orgId, 'events') as Route}
          className="self-center text-xs font-medium text-primary hover:underline"
        >
          {t('eventsAll')}
        </Link>
      </CardHeader>
      <CardContent className="px-3">
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : rows.length === 0 ? (
          <p className="py-1 text-sm text-muted-foreground">{t('eventsNone')}</p>
        ) : (
          <>
            <ul className="divide-y">
              {rows.map((e) => (
                <li key={e.id} className="flex items-center gap-2.5 py-2 text-sm">
                  <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  {e.start && (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {format.dateTime(e.start.toDate(), { day: 'numeric', month: 'short' })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {more > 0 && (
              <p className="pt-2 text-xs text-muted-foreground">
                {t('eventsMore', { count: more })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
