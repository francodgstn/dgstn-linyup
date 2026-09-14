'use client'

// The preview of a receipt as the server would issue it — blocking reasons
// with a "go fix it" link, warnings, the lines and the totals. Rendered by the
// contact's Receipts segment and by the create-from-payment dialog; ONE view,
// so the two never disagree about what a preview means. It computes nothing:
// every line here came back from `previewTarif595Receipt`.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import type { Route } from 'next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Tarif595BlockingCode, Tarif595PreviewResult } from '@linyup/shared'
import { formatMoneyMinor } from '@/lib/payments'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { downloadTarif595Receipt } from './hooks'

// ─── blocking-code → "go fix it" link ────────────────────────────────────
// contact_* codes are asked for on the contact's Receipts segment (AHV, sex)
// or on the Profile tab (birthdate, address) — the profile is the one link
// that covers both. Everything else that can block a preview is plugin /
// legal-profile SETUP, answered on the plugin's own settings page or the
// shared legal profile.

export function blockingLink(
  code: Tarif595BlockingCode,
  contactId: string
): { href: Route; labelKey: 'completeProfile' | 'openSettings' } | null {
  if (code.startsWith('contact_')) {
    return { href: `/contacts/${contactId}?tab=profile` as Route, labelKey: 'completeProfile' }
  }
  if (code === 'legal_profile_incomplete') {
    return { href: '/settings/team?tab=payments' as Route, labelKey: 'openSettings' }
  }
  if (code === 'plugin_config_incomplete' || code === 'offering_unmapped' || code === 'position_invalid_on_date') {
    return { href: '/plugins/tarif-595/settings' as Route, labelKey: 'openSettings' }
  }
  return null
}

export function PreviewResultView({
  preview,
  teamId,
  contactId,
}: {
  preview: Tarif595PreviewResult
  teamId: string
  contactId: string
}) {
  const t = useTranslations('Tarif595')
  const [downloading, setDownloading] = useState(false)

  async function handleDownloadExisting() {
    if (!preview.existing) return
    setDownloading(true)
    try {
      await downloadTarif595Receipt(teamId, preview.existing.receiptId, 'pdf')
    } catch (err) {
      console.error('[tarif-595] existing download failed:', err)
      toast.error(t('actions.downloadError'))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      {preview.existing && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
          <span>
            {t('issue.existingNote', {
              number: preview.existing.number,
              status: t(`status.${preview.existing.status}`),
            })}
          </span>
          <Button size="sm" variant="outline" onClick={() => void handleDownloadExisting()} disabled={downloading}>
            {downloading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t('actions.downloadPdf')}
          </Button>
        </div>
      )}

      {preview.blocking.length > 0 && (
        <ul className="space-y-1">
          {preview.blocking.map((issue, i) => {
            const link = blockingLink(issue.code, contactId)
            return (
              <li key={`${issue.code}:${i}`} className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t(`blocking.${issue.code}`)}
                  {link && (
                    <>
                      {' — '}
                      <Link href={link.href} className="underline underline-offset-2">
                        {t(`issue.${link.labelKey}`)}
                      </Link>
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {preview.warnings.length > 0 && (
        <ul className="space-y-1">
          {preview.warnings.map((w, i) => (
            <li
              key={`${w.code}:${i}`}
              className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t(`warning.${w.code}`)}</span>
            </li>
          ))}
        </ul>
      )}

      {preview.draft && (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('issue.colDate')}</TableHead>
                  <TableHead>{t('issue.colCode')}</TableHead>
                  <TableHead>{t('issue.colName')}</TableHead>
                  <TableHead className="text-right">{t('issue.colQuantity')}</TableHead>
                  <TableHead className="text-right">{t('issue.colUnit')}</TableHead>
                  <TableHead className="text-right">{t('issue.colAmount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.draft.lines.map((line) => (
                  <TableRow key={line.record_id}>
                    <TableCell>{line.date_begin}</TableCell>
                    <TableCell>{line.code}</TableCell>
                    <TableCell>{line.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{line.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyMinor(line.unit_minor, 'CHF')}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyMinor(line.amount_minor, 'CHF')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              {t('issue.totalVat')}: {formatMoneyMinor(preview.draft.totals.vat_minor, 'CHF')}
            </span>
            <span className="font-medium">
              {t('issue.totalAmount')}: {formatMoneyMinor(preview.draft.totals.amount_minor, 'CHF')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
