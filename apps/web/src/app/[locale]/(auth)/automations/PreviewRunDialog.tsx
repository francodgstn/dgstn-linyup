'use client'

/**
 * "Who does this hit, and what will they get?" — asked BEFORE an automation
 * sends anything, in one dialog.
 *
 * The `previewAutomationRule` callable has existed since the port and had ZERO
 * callers in the app until this file: the studio could arm a rule that emails
 * every contact, or press "Run now", and find out who it reached from the
 * `automation_logs` afterwards. This is that answer, moved in front of the send.
 *
 * TWO MODES, one component, because they are the same question:
 *  · 'preview' — read-only, reachable from the rule menu at any time (including
 *    while the rule is PAUSED, which is exactly the moment before arming it).
 *  · 'run'     — the same body plus the confirmation for "Run now", whose
 *    primary button states the consequence in numbers.
 *
 * WHAT "Run now" ACTUALLY DOES (`triggerAutomationRule` → `runRule` with
 * `force: true`, server-side and not overridable by this client): it bypasses
 * the per-contact dedup window — 7 days for event-triggered rules, 30 for
 * scheduled ones — so a contact who already received this rule's email gets it
 * AGAIN. That is why the copy says so rather than saying "send".
 *
 * One honest gap, deliberately left rather than papered over: for a rule with a
 * `bio_link_booking_no_show` condition the preview skips bookings already marked
 * `noShowOutreachSentAt`, while the forced run does not. The count is therefore
 * a LOWER BOUND on that one rule shape — which is the same direction the re-send
 * warning already points, and the alternative (teaching the preview to ignore
 * the marker) would change what the callable means everywhere else.
 */

import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { QueryErrorState } from '@/components/ui/query-error'
import { AlertTriangle, MessageCircleOff, Users } from 'lucide-react'

/** One row of `previewAutomationRule`'s `contacts` array. */
interface PreviewContact {
  id: string
  firstname: string
  lastname: string
  email: string
  acquisition_stage: string | null
  /** Present only for a rule with a `send_whatsapp` action — whether THIS
   *  message would reach this contact, or why not (packages/functions/src/
   *  automation/previewAutomationRule.ts). Absent for every other rule. */
  whatsapp?: 'ok' | 'no_phone' | 'no_consent' | 'no_marketing_consent'
}

function whatsappMarkerKey(reason: Exclude<PreviewContact['whatsapp'], 'ok' | undefined>) {
  return `preview.whatsappReason.${reason}` as const
}

/** How many matches are rendered before the list is summarised. A studio with
 *  800 matching contacts needs the NUMBER and a sense of who, not 800 rows. */
const MAX_LISTED = 50

export interface PreviewRunDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string
  ruleId: string
  ruleName: string
  /** Whether the rule is armed. `triggerAutomationRule` refuses an inactive
   *  rule ('failed-precondition'), so the run button says why instead of
   *  handing the studio a raw error. */
  ruleActive: boolean
  /** 'preview' = read-only. 'run' = the "Run now" confirmation. */
  mode: 'preview' | 'run'
  /** One line per action the rule performs — already summarised by the caller
   *  (it holds the templates), so this dialog never re-derives that copy. */
  actionLabels: string[]
  /** Performs the run. Resolves when the callable has returned. */
  onRun: () => Promise<void>
}

export function PreviewRunDialog({
  open,
  onOpenChange,
  teamId,
  ruleId,
  ruleName,
  ruleActive,
  mode,
  actionLabels,
  onRun,
}: PreviewRunDialogProps) {
  const t = useTranslations('Automations')
  const [running, setRunning] = useState(false)

  // `gcTime: 0` so closing the dialog drops the result: a preview is a claim
  // about RIGHT NOW, and showing a cached count from ten minutes ago next to a
  // "Send to N contacts" button is the exact failure this dialog exists to stop.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['automation_preview', teamId, ruleId],
    enabled: open,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const fn = httpsCallable<
        { teamId: string; ruleId: string },
        { contacts: PreviewContact[]; count: number }
      >(functions, 'previewAutomationRule')
      const res = await fn({ teamId, ruleId })
      return res.data
    },
  })

  const count = data?.count ?? 0
  const contacts = data?.contacts ?? []
  // Deliberately NOT disabled at count 0: for the no-show rule shape the preview
  // is a lower bound (see the header), so "nobody matches" is not proof that a
  // forced run sends nothing. The button says "Run anyway" there instead of
  // promising a number it can't stand behind.
  const canRun = mode === 'run' && ruleActive && !isLoading && !isError

  async function handleRun() {
    setRunning(true)
    try {
      await onRun()
      onOpenChange(false)
    } catch {
      // The caller has already surfaced it (toast). Staying open is the point:
      // a closed dialog after a failed run reads as "sent".
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'run' ? t('preview.runTitle') : t('preview.title')}
          </DialogTitle>
          <DialogDescription>{ruleName}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* WHAT will be sent — the second half of the question, and the half a
              bare count can't answer. */}
          {actionLabels.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('preview.willSend')}
              </p>
              <ul className="space-y-1">
                {actionLabels.map((label, i) => (
                  <li key={i} className="text-sm">
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* WHO matches. */}
          <div className="space-y-2">
            {isLoading ? (
              <>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-16 w-full" />
              </>
            ) : isError ? (
              <QueryErrorState
                onRetry={() => void refetch()}
                title={t('preview.failed')}
                detail={error instanceof Error ? error.message : null}
              />
            ) : count === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-4 text-center">
                <p className="text-sm font-medium">{t('preview.noneTitle')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('preview.noneBody')}</p>
              </div>
            ) : (
              <>
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  {t('preview.count', { count })}
                </p>
                <ul className="divide-y rounded-lg border">
                  {contacts.slice(0, MAX_LISTED).map((c) => (
                    <li key={c.id} className="px-3 py-2">
                      <p className="truncate text-sm">
                        {`${c.firstname} ${c.lastname}`.trim() || c.email}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                      {/* A rule with a WhatsApp action also reaches contacts with
                          no email, so "will they get the message" is a second
                          question this dialog has to answer per contact. */}
                      {c.whatsapp && c.whatsapp !== 'ok' && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                          <MessageCircleOff className="h-3 w-3 shrink-0" />
                          {t(whatsappMarkerKey(c.whatsapp))}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {count > MAX_LISTED && (
                  <p className="text-xs text-muted-foreground">
                    {t('preview.moreCount', { count: count - MAX_LISTED })}
                  </p>
                )}
              </>
            )}
            <p className="text-xs text-muted-foreground">{t('preview.excludedNote')}</p>
          </div>

          {/* The consequence, stated before the button that causes it. */}
          {mode === 'run' && count > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>{t('preview.resendWarning')}</span>
            </p>
          )}
          {mode === 'run' && !ruleActive && (
            <p className="text-xs text-muted-foreground">{t('preview.inactiveNote')}</p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            {mode === 'run' ? t('common.cancel') : t('preview.close')}
          </Button>
          {mode === 'run' && (
            <Button onClick={handleRun} disabled={!canRun || running}>
              {running ? t('preview.sending') : t('preview.confirmSend', { count })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
