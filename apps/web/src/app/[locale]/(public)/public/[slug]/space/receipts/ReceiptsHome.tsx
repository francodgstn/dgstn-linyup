'use client'

// The member's own health-insurance receipts (Tarif 595): what was issued,
// for which period, and the PDF + XML to hand to the insurer. Read through
// `listMyTarif595Receipts` (the session decides who); downloaded through the
// contact door of `downloadTarif595Receipt`, which serves a receipt only when
// its `contact_id` is the session's own.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Download, FileText, HeartPulse, Loader2 } from 'lucide-react'
import type { Tarif595MyReceipt } from '@linyup/shared'
import { formatCurrency } from '@/lib/format'
import { QueryErrorState } from '@/components/ui/query-error'
import { loadFailureDetail, reportPublicLoadFailure } from '@/lib/publicQueryError'
import { callDownloadTarif595Receipt, saveDownloadedFile } from '@/plugins/tarif-595/hooks'
import SpaceSignInWall from '../SpaceSignInWall'
import { useSpaceAuth } from '../SpaceAuthProvider'
import { useSpaceTheme } from '../useSpaceTheme'
import { useSpaceReceipts } from '../useSpaceReceipts'
import { usePublicFormat } from '../../usePublicFormat'

export default function ReceiptsHome() {
  const t = useTranslations('Space')
  const { isAuthenticated, teamId } = useSpaceAuth()
  const { accent, textMain, textMuted, cardBg, cardBorder } = useSpaceTheme()
  const fmt = usePublicFormat()
  const { data, isLoading, isError, error, refetch } = useSpaceReceipts()
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const cardStyle = { background: cardBg, border: `1px solid ${cardBorder}` }

  if (!isAuthenticated) {
    return <SpaceSignInWall prompt={t('accountSignInPrompt')} />
  }

  async function download(r: Tarif595MyReceipt, kind: 'pdf' | 'xml') {
    if (!teamId) return
    const key = `${r.id}:${kind}`
    setDownloading(key)
    setDownloadError(null)
    try {
      const { data: file } = await callDownloadTarif595Receipt({ teamId, receiptId: r.id, kind })
      saveDownloadedFile(file)
    } catch (err: unknown) {
      reportPublicLoadFailure('space/receipt-download', err)
      setDownloadError(r.id)
    } finally {
      setDownloading(null)
    }
  }

  const receipts = data?.receipts ?? []

  return (
    <div className="mt-6 space-y-4">
      <section className="rounded-2xl p-4" style={cardStyle}>
        <div className="mb-3 flex items-center gap-2">
          <HeartPulse className="h-4 w-4" style={{ color: accent }} />
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
            {t('receiptsTitle')}
          </h2>
        </div>
        <p className="mb-3 text-xs" style={{ color: textMuted }}>
          {t('receiptsIntro')}
        </p>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-2" style={{ borderColor: accent, borderTopColor: 'transparent' }} />
          </div>
        ) : isError ? (
          <QueryErrorState
            onRetry={() => void refetch()}
            title={t('receiptsLoadFailed')}
            detail={loadFailureDetail(error)}
            theme={{ textMain, textMuted, accent, border: cardBorder }}
          />
        ) : receipts.length === 0 ? (
          <p className="py-4 text-sm" style={{ color: textMuted }}>
            {t('receiptsEmpty')}
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: cardBorder }}>
            {receipts.map((r) => {
              const voided = r.status === 'voided'
              return (
                <li key={r.id} className="space-y-2 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" style={{ color: textMain, textDecoration: voided ? 'line-through' : undefined }}>
                        {r.number}
                      </p>
                      <p className="text-xs" style={{ color: textMuted }}>
                        {r.period.from} – {r.period.to}
                        {r.issuedAt ? ` · ${t('receiptIssuedOn', { date: fmt.date(r.issuedAt) })}` : ''}
                        {r.replacesNumber ? ` · ${t('receiptReplaces', { number: r.replacesNumber })}` : ''}
                      </p>
                      {voided && (
                        <p className="text-[0.6875rem]" style={{ color: '#dc2626' }}>
                          {t('receiptVoided')}
                        </p>
                      )}
                    </div>
                    <p className="shrink-0 text-sm font-medium" style={{ color: textMain }}>
                      {formatCurrency(r.totals.amount_minor / 100, 'CHF')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(['pdf', 'xml'] as const).map((kind) => {
                      const key = `${r.id}:${kind}`
                      const Icon = kind === 'pdf' ? Download : FileText
                      return (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => void download(r, kind)}
                          disabled={downloading !== null}
                          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-60"
                          style={{ background: `${accent}14`, color: textMain }}
                        >
                          {downloading === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" style={{ color: accent }} />}
                          {kind === 'pdf' ? t('receiptDownloadPdf') : t('receiptDownloadXml')}
                        </button>
                      )
                    })}
                    {downloadError === r.id && (
                      <span className="text-xs" style={{ color: '#dc2626' }}>
                        {t('receiptDownloadFailed')}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
