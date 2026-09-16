'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Info, TriangleAlert } from 'lucide-react'
import type { PublishOutcome, StudioDocument } from '@linyup/shared'

// ─── The publish chooser ─────────────────────────────────────────────────────
//
// This is where the evidential trade is actually made, so the control is built
// to a few rules rather than to taste:
//
//  1. Each option is named by WHAT HAPPENS, never by severity. "Minor / material"
//     was rejected: it asks a studio to make a judgement it has no way to make,
//     and the answer it gets wrong is the one that matters.
//  2. Each option states what it COSTS EVIDENTIALLY, in one line, in the studio's
//     own language — at the moment of choosing, not when somebody needs the
//     document. Click-wrap is already the lightest signature this product offers;
//     a studio should see what it is giving up while it can still choose
//     otherwise.
//  3. `require_resign` is preselected for a waiver (a studio that does not read
//     the options lands on the defensible one) and `silent` for every other kind,
//     where a version bump is ordinary housekeeping.
//
// TWO OUTCOMES, NOT THREE. "Notify signers" — carry the signatures forward but
// email everyone, with a per-recipient deliverability record — is deferred. It is
// deliberately not offered as a disabled third option: a greyed-out control that
// never becomes available is worse than one that does not exist. The server
// refuses `notify` BY NAME rather than downgrading it to `silent`, so an old
// client can never tell a studio its members were notified when nobody was.

export interface PublishDialogProps {
  open: boolean
  onClose: () => void
  document: StudioDocument
  /** Rejects with a FunctionsError carrying `details.reason`. */
  onPublish: (outcome: PublishOutcome) => Promise<void>
}

const OUTCOMES: PublishOutcome[] = ['silent', 'require_resign']

export function PublishDialog({ open, onClose, document, onPublish }: PublishDialogProps) {
  const t = useTranslations('Documents')
  const isWaiver = document.kind === 'waiver'
  const nextVersion = (document.current_version ?? 0) + 1
  const isFirstVersion = document.current_version == null

  const [outcome, setOutcome] = useState<PublishOutcome>(isWaiver ? 'require_resign' : 'silent')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    setOutcome(isWaiver ? 'require_resign' : 'silent')
    setError(null)
  }, [open, isWaiver])

  // The version snapshot freezes the HTML, not the images it references: the file
  // behind an <img> can be replaced afterwards, changing what a reader sees while
  // the stored hash still matches. Warn where it is decided, not in a help page.
  const hasImage = useMemo(
    () => document.source === 'rich_text' && /<img\b/i.test(document.body ?? ''),
    [document.source, document.body],
  )

  async function submit() {
    setPending(true)
    setError(null)
    try {
      await onPublish(outcome)
      onClose()
    } catch (err) {
      const reason = (err as { details?: { reason?: string } })?.details?.reason
      const map: Record<string, string> = {
        document_body_empty: t('publishErrorBodyEmpty'),
        invalid_external_url: t('publishErrorExternalUrl'),
        document_archived: t('publishErrorArchived'),
        version_limit_reached: t('publishErrorVersionLimit'),
        version_exists: t('publishErrorConcurrent'),
        publish_outcome_unavailable: t('publishErrorOutcomeUnavailable'),
        plan_required: t('publishErrorPlan'),
        plan_inactive: t('publishErrorPlan'),
      }
      setError((reason && map[reason]) || t('publishErrorGeneric'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-baseline justify-between gap-3">
            <span className="truncate">{t('publishTitle', { title: document.title })}</span>
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              {t('versionN', { version: nextVersion })}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {OUTCOMES.map((o) => {
            const selected = outcome === o
            return (
              <button
                key={o}
                type="button"
                onClick={() => setOutcome(o)}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-4 w-4 shrink-0 rounded-full border ${
                      selected ? 'border-primary border-[5px]' : 'border-muted-foreground/40'
                    }`}
                    aria-hidden
                  />
                  <span className="font-medium">
                    {o === 'silent' ? t('outcomeSilent') : t('outcomeRequireResign')}
                  </span>
                  {isWaiver && o === 'require_resign' && (
                    <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                      {t('recommended')}
                    </span>
                  )}
                </span>
                <span className="mt-1.5 block pl-6 text-sm text-muted-foreground">
                  {o === 'silent' ? t('outcomeSilentBody') : t('outcomeRequireResignBody')}
                </span>
                {/* The evidential cost, one line, beside the choice. */}
                <span className="mt-1 block pl-6 text-xs text-muted-foreground/90">
                  {o === 'silent' ? t('outcomeSilentEvidence') : t('outcomeRequireResignEvidence')}
                </span>
              </button>
            )
          })}

          {isFirstVersion && (
            <p className="text-xs text-muted-foreground">{t('publishFirstVersionNote')}</p>
          )}

          {isWaiver && (
            <p className="flex gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('publishEvidenceNote')}</span>
            </p>
          )}

          {hasImage && (
            <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('publishImageWarning')}</span>
            </p>
          )}

          {document.source === 'external_link' && (
            <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('publishExternalWarning')}</span>
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? t('publishing') : t('publishAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
