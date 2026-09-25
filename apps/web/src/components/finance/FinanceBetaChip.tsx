'use client'

/**
 * "These numbers have not been checked by an accountant."
 *
 * The finance module computes a double-entry ledger, an account chart and
 * monthly reports, and no accountant has ever reviewed any of it (Franco,
 * 2026-08-28). That is a fine state for software to be in and a bad one for a
 * studio owner to discover at filing time, so every surface that shows a figure
 * derived from the ledger says so where the figure is.
 *
 * A CHIP, NOT AN ICON. The plugin catalog already marked finance beta — with a
 * hover-only flask glyph, which tells a reader who is already hovering something
 * they were not asking about. A caveat nobody reads is not a caveat.
 *
 * ONE definition of the word: `Plugins.statusBeta` is the same string the
 * catalog uses. The hint underneath it is the finance-specific part, and it
 * says what the reader should DO — check before filing — rather than merely
 * naming the maturity level.
 */

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'

export function FinanceBetaChip({ className }: { className?: string }) {
  const t = useTranslations('Plugins')
  const tf = useTranslations('Finance')
  return (
    <Badge
      variant="secondary"
      className={`border-blue-200 bg-blue-50 text-xs font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300 ${className ?? ''}`}
      title={tf('betaHint')}
    >
      {t('statusBeta')}
    </Badge>
  )
}
