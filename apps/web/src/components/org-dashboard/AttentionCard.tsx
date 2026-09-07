'use client'

/**
 * WHAT IS WAITING ON A HUMAN — the organisation's queue.
 *
 * A studio's queue is full of things that arrive by themselves: a booking to
 * confirm, a payment with nobody attached, a trial that ends today. An
 * organisation's is almost entirely INVITATIONS AND REQUESTS — a federation's
 * work is admitting people and studios to it — so this list is short by nature,
 * and pretending otherwise with a scroll region would be dressing.
 *
 * That is why it is a plain card and not a second accent panel. The roster is
 * this page's one primary object (see `StudiosPanel`); giving the queue the same
 * frame would restate the studio dashboard's paired-panel hierarchy on a page
 * whose subject is not paired.
 *
 * EVERY ROW IS A LINK TO WHERE IT IS ANSWERED. A queue that tells you about work
 * without taking you to it is a notification, and this product already has one
 * of those.
 *
 * `null` means the read did not answer — an `org_viewer` cannot read access
 * requests or member invitations at all — and a row that could not be counted is
 * OMITTED rather than shown as zero. "Nothing waiting" said on the strength of a
 * denial is the one wrong answer here.
 */

import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { Building2, CheckCircle2, KeyRound, UserPlus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { orgHref } from '@/lib/org-nav'

export function AttentionCard({
  orgId,
  invitedStudios,
  accessRequests,
  memberInvitations,
  loading,
}: {
  orgId: string
  invitedStudios: number
  accessRequests: number | null
  memberInvitations: number | null
  loading: boolean
}) {
  const t = useTranslations('OrgDashboard')

  const items: { key: string; icon: LucideIcon; label: string; count: number; href: string }[] = []
  if (invitedStudios > 0) {
    items.push({
      key: 'invited',
      icon: Building2,
      label: t('attentionInvitedStudios', { count: invitedStudios }),
      count: invitedStudios,
      href: orgHref(orgId, 'teams'),
    })
  }
  if (accessRequests != null && accessRequests > 0) {
    items.push({
      key: 'access',
      icon: KeyRound,
      label: t('attentionAccessRequests', { count: accessRequests }),
      count: accessRequests,
      href: orgHref(orgId, 'teams'),
    })
  }
  if (memberInvitations != null && memberInvitations > 0) {
    items.push({
      key: 'invites',
      icon: UserPlus,
      label: t('attentionMemberInvitations', { count: memberInvitations }),
      count: memberInvitations,
      href: orgHref(orgId, 'members'),
    })
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{t('attentionTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="px-3">
        {loading ? (
          <Skeleton className="h-10 w-full" />
        ) : items.length === 0 ? (
          <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground/50" />
            {t('attentionNone')}
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((item) => {
              const Icon = item.icon
              return (
                <li key={item.key}>
                  <Link
                    href={item.href as Route}
                    className="-mx-1 flex items-center gap-2.5 rounded-md px-1 py-2 text-sm transition-colors hover:bg-accent/50"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-primary/70" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {item.count}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
