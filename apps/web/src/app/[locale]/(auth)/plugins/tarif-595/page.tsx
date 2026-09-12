'use client'

// Tarif 595 plugin home — a setup checklist (legal profile + plugin config,
// the two things `previewTarif595Receipt` refuses on) and the team's whole
// receipts log, newest first. Issuing itself never happens here: a receipt is
// always issued FROM a contact (the "Receipts" segment of their detail page,
// `ReceiptsSegment.tsx`) — this page is where a manager checks setup and
// finds/void/re-sends what has already been produced.

import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { CheckCircle2, HeartPulse } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useLegalProfile } from '@/hooks/useLegalProfile'
import { validateLegalProfile, validateTarif595Config } from '@linyup/shared'
import { formatMoneyMinor } from '@/lib/payments'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { LoadMoreFooter } from '@/components/ui/load-more-footer'
import { useTarif595Config, useTarif595Receipts, type Tarif595ReceiptRow } from '@/plugins/tarif-595/hooks'
import { ReceiptActions, ReceiptStatusBadge } from '@/plugins/tarif-595/ReceiptActions'

// The position table is not needed to answer "is the config complete enough
// to try" — every position the config could name is treated as valid here,
// the same shortcut the settings screen's own live editor cannot take.
const ALWAYS_VALID_POSITION = { positionExists: () => true }

function ChecklistRow({
  done,
  label,
  href,
  actionLabel,
}: {
  done: boolean
  label: string
  href: Route
  actionLabel: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <CheckCircle2
          className={`h-4 w-4 shrink-0 ${done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/40'}`}
        />
        <span className="truncate text-sm">{label}</span>
      </div>
      {!done && (
        <Link href={href} className="shrink-0 text-sm text-primary hover:underline">
          {actionLabel}
        </Link>
      )}
    </div>
  )
}

function fmtPeriod(period: { from: string; to: string }) {
  return `${period.from} – ${period.to}`
}

function ReceiptRowCard({ teamId, receipt, canManage }: { teamId: string; receipt: Tarif595ReceiptRow; canManage: boolean }) {
  const name = `${receipt.patient.givenname} ${receipt.patient.familyname}`.trim()
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{receipt.number}</span>
          <ReceiptStatusBadge status={receipt.status} />
        </div>
        <div className="truncate text-sm text-muted-foreground">{name || '—'}</div>
        <div className="text-xs text-muted-foreground">{fmtPeriod(receipt.period)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-sm font-medium tabular-nums">
          {formatMoneyMinor(receipt.totals.amount_minor, 'CHF')}
        </span>
        <ReceiptActions teamId={teamId} receipt={receipt} canManage={canManage} />
      </div>
    </li>
  )
}

export default function Tarif595PluginPage() {
  const t = useTranslations('Tarif595')
  const tPlugins = useTranslations('Plugins')
  const { currentTeamId, teamRole } = useAuth()
  const teamId = currentTeamId ?? null
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()
  const canManage = teamRole === 'owner' || teamRole === 'manager'

  const { data: legalProfile, isLoading: legalLoading } = useLegalProfile(teamId)
  const { data: config, isLoading: configLoading } = useTarif595Config(teamId)
  const receiptsQ = useTarif595Receipts(teamId)

  if (pluginsLoading) return <Skeleton className="m-6 h-40" />
  if (!teamId || !isInstalled('tarif-595')) {
    return (
      <div className="p-6 space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">{t('title')}</h1>
          <Badge variant="secondary">{tPlugins('statusBeta')}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t('notInstalled')}</p>
        <p className="text-sm text-muted-foreground">{t('installHint')}</p>
      </div>
    )
  }

  const legalIssues = validateLegalProfile(legalProfile)
  const configIssues = config ? validateTarif595Config(config, ALWAYS_VALID_POSITION) : [{ path: 'offerings', code: 'no_offerings' as const }]
  const legalDone = !legalLoading && legalIssues.length === 0
  const configDone = !configLoading && configIssues.length === 0

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <HeartPulse className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('title')}</h1>
        <Badge variant="secondary">{tPlugins('statusBeta')}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">{t('overviewIntro')}</p>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('checklistTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {legalLoading || configLoading ? (
              <Skeleton className="h-10" />
            ) : (
              <>
                <ChecklistRow
                  done={legalDone}
                  label={t('checklistLegalProfile')}
                  href={'/settings/team?tab=payments' as Route}
                  actionLabel={t('checklistComplete')}
                />
                <ChecklistRow
                  done={configDone}
                  label={t('checklistConfig')}
                  href={'/plugins/tarif-595/settings' as Route}
                  actionLabel={t('checklistComplete')}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('receiptsTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {receiptsQ.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : receiptsQ.rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{t('receiptsEmpty')}</p>
          ) : (
            <>
              <ul className="divide-y">
                {receiptsQ.rows.map((r) => (
                  <ReceiptRowCard key={r.id} teamId={teamId} receipt={r} canManage={canManage} />
                ))}
              </ul>
              <LoadMoreFooter
                shown={receiptsQ.rows.length}
                hasMore={receiptsQ.hasMore}
                loading={receiptsQ.isLoadingMore}
                onLoadMore={receiptsQ.loadMore}
                className="border-t"
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
