'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Download, Loader2 } from 'lucide-react'
import { callFunction } from '@/lib/callFunction'

interface ExportResult {
  filename: string
  csv: string
  rowCount: number
}

/**
 * "Give me my contact book." Manager-only, server-side, and the same
 * blob-download shape as `ExportFinanceCsvButton` so the two behave alike.
 *
 * This is the studio's side of the DPA's return-of-data commitment, which is
 * why it exports EVERYTHING the studio holds — archived people and custom fields
 * included — rather than whatever the list happens to be filtered to. A button
 * that silently exported the current view would be the more intuitive one and
 * the wrong one: the studio would believe it had its data.
 */
export function ExportContactsButton({ teamId }: { teamId: string }) {
  const t = useTranslations('Contacts')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const exportCsv = async () => {
    setBusy(true)
    setError(null)
    try {
      const call = callFunction<{ teamId: string }, ExportResult>('exportContacts')
      const { data } = await call({ teamId })
      const blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = data.filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      // The server refuses rather than truncating an oversized export, so a
      // failure here is worth surfacing and worth logging — a silent no-op on
      // this button reads as "we have no data".
      console.error('[contacts] export failed:', err)
      setError(t('exportFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={exportCsv} disabled={busy}>
        {busy ? (
          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
        ) : (
          <Download className="h-4 w-4 mr-1" />
        )}
        {t('exportCsv')}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
