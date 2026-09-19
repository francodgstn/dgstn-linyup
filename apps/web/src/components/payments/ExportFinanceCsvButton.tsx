'use client'

// Monthly finance CSV export (the "hand this to your accountant" file).
// Rendered only when the finance plugin is installed — the callable enforces
// the same gate server-side (assertFinancePluginActive). Schema:
// docs/finance-reports.md.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Download, Loader2 } from 'lucide-react'
import { monthKey } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { callFunction } from '@/lib/callFunction'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface ExportResult {
  filename: string
  csv: string
  rowCount: number
  month: string
}

/** The last 12 month keys (current first), in the finance timezone. */
function recentMonths(): string[] {
  const months: string[] = []
  const now = new Date()
  for (let i = 0; i < 12; i += 1) {
    months.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 15)))
  }
  return months
}

export function ExportFinanceCsvButton({ teamId }: { teamId: string }) {
  const t = useTranslations('Finance')
  const months = useMemo(recentMonths, [])
  const [month, setMonth] = useState(months[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const exportCsv = async () => {
    setBusy(true)
    setError(null)
    try {
      const call = callFunction<{ teamId: string; month: string }, ExportResult>(
        'exportFinanceReport'
      )
      const { data } = await call({ teamId, month })
      const blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = data.filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[finance] export failed:', err)
      setError(t('exportFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Select value={month} onValueChange={(v) => v && setMonth(v)}>
        <SelectTrigger size="sm" className="w-[110px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {months.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" onClick={exportCsv} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
        {t('exportCsv')}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
