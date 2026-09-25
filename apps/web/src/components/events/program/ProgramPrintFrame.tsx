'use client'

import { useEffect, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Printer } from 'lucide-react'
import type { Route } from 'next'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'

/**
 * The page around a printable program — public and staff alike.
 *
 * The controls sit above the sheet and never print (`no-print` for the auth
 * layout's print stylesheet, `print:hidden` for the public one). "Save as PDF"
 * is the browser's own print destination, which is why the button says both:
 * a member looking for a PDF download should find it here.
 */
export function ProgramPrintFrame({
  documentTitle,
  backHref,
  backLabel,
  controls,
  children,
}: {
  /** Becomes the tab title, which browsers use as the PDF's file name. */
  documentTitle?: string | null
  backHref?: string | null
  backLabel?: string
  /** Extra screen-only controls, e.g. the staff "include internal notes". */
  controls?: ReactNode
  children: ReactNode
}) {
  const t = useTranslations('EventProgram')

  useEffect(() => {
    if (documentTitle) document.title = documentTitle
  }, [documentTitle])

  return (
    <div className="program-print mx-auto max-w-4xl space-y-4 px-4 py-6 sm:px-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3 print:hidden">
        {backHref ? (
          <Link
            href={backHref as Route}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {backLabel}
          </Link>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-3">
          {controls}
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="mr-1.5 h-3.5 w-3.5" />
            {t('printOrPdf')}
          </Button>
        </div>
        <p className="w-full text-xs text-muted-foreground">{t('printPdfHint')}</p>
      </div>

      <div className="rounded-sm border border-neutral-200 shadow-sm print:rounded-none print:border-0 print:shadow-none">
        {children}
      </div>
    </div>
  )
}
