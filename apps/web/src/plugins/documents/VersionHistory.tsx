'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { RichTextContent } from '@/components/RichTextEditor'
import { History } from 'lucide-react'
import type { DocumentVersion } from '@linyup/shared'
import { useDocumentVersions } from '@/plugins/documents/hooks'

// Read-only, forever. Every published version of a document, newest first, with
// the outcome it was published under — because "which changes was this member
// never asked about" is answered by reading down this list, and a `silent`
// publish is invisible everywhere else.
//
// A version minted by scripts/backfill-document-versions.ts is labelled
// RETROACTIVE. Somebody who signed a terms document before versioning existed
// signed text that was captured afterwards; printing that as an ordinary publish
// would assert more than happened.

function formatWhen(v: DocumentVersion): string {
  const ms = (v.published_at as unknown as { toMillis?: () => number })?.toMillis?.()
  return ms ? new Date(ms).toLocaleString() : '—'
}

export function VersionHistory({ documentId }: { documentId: string }) {
  const t = useTranslations('Documents')
  const { data: versions, isLoading } = useDocumentVersions(documentId)
  const [viewing, setViewing] = useState<DocumentVersion | null>(null)

  if (isLoading) return <Skeleton className="h-20 w-full" />

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">{t('versionHistory')}</h2>
      </div>

      {!versions || versions.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('versionHistoryEmpty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
              <span className="font-medium">{t('versionN', { version: v.version })}</span>
              <span className="text-xs text-muted-foreground">{formatWhen(v)}</span>
              <span className="text-xs text-muted-foreground">{v.published_by_name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                {v.publish_outcome === 'require_resign'
                  ? t('outcomeRequireResign')
                  : t('outcomeSilent')}
              </span>
              {v.backfilled_at && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.6875rem] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  {t('versionBackfilled')}
                </span>
              )}
              <button
                type="button"
                onClick={() => setViewing(v)}
                className="ml-auto text-xs text-primary hover:underline"
              >
                {t('viewText')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {viewing ? t('versionN', { version: viewing.version }) : ''} — {viewing?.title}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {viewing?.externalUrl ? (
              <p className="text-sm break-all text-muted-foreground">{viewing.externalUrl}</p>
            ) : (
              <RichTextContent html={viewing?.bodyHtml ?? ''} className="prose-relaxed max-w-none" />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}
