'use client'

/**
 * DELETE THIS STUDIO — Settings → Team, at the bottom, owner only.
 *
 * The product had no way for a studio to leave: `purgeTeam` was a shell script
 * an operator ran by hand, so a GDPR request had to be answered by email. The
 * shape here is the one Franco chose on 2026-08-23 — force-stop the billing
 * now, erase after thirty days — and `packages/functions/src/teams/deleteAccount.ts`
 * holds the reasoning for why not the two alternatives.
 *
 * ── WHAT THIS SCREEN OWES THE READER ───────────────────────────────────────
 * Three facts, stated before the button and not after it:
 *   • the members' subscriptions stop IMMEDIATELY, and canceling the deletion
 *     does not bring them back — Stripe cannot un-cancel a subscription;
 *   • the data is erased in thirty days, and until then nothing changes;
 *   • the studio's own Stripe account, its money and its payment history are
 *     NOT deleted. They are the studio's, and the other side of transactions
 *     with real people.
 *
 * The typed confirmation is the studio's own name, and the server checks it
 * too: this is the one callable in the product whose success is measured in
 * deleted data.
 */

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { Team } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { callFunction } from '@/lib/callFunction'

export function DeleteAccountCard({
  teamId,
  team,
  canEdit,
}: {
  teamId: string
  team: Team
  /** Owner-only. Anyone else sees nothing at all — a disabled danger zone
   *  invites the question "who can, then?" on a screen that should not raise it. */
  canEdit: boolean
}) {
  const t = useTranslations('DeleteAccount')
  const qc = useQueryClient()
  const [typed, setTyped] = useState('')
  const [open, setOpen] = useState(false)

  const scheduledMs = team.deletion_scheduled_for?.toMillis?.() ?? null

  const request = useMutation({
    mutationFn: async () => {
      const fn = callFunction<
        { teamId: string; confirm: string },
        { scheduledFor: number; subscriptionsStopped: number }
      >('requestTeamDeletion')
      return (await fn({ teamId, confirm: typed.trim() })).data
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      setOpen(false)
      setTyped('')
      toast.success(
        t('scheduledToast', { date: new Date(data.scheduledFor).toLocaleDateString() })
      )
    },
    onError: (err: unknown) => {
      toast.error((err as { message?: string })?.message || t('errorGeneric'))
    },
  })

  const cancel = useMutation({
    mutationFn: async () => {
      const fn = callFunction<{ teamId: string }, { ok: boolean }>('cancelTeamDeletion')
      return (await fn({ teamId })).data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      toast.success(t('cancelledToast'))
    },
    onError: () => toast.error(t('errorGeneric')),
  })

  if (!canEdit) return null

  // ── Already scheduled ──────────────────────────────────────────────────────
  if (scheduledMs !== null) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="space-y-3 pt-6">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <p className="text-sm font-medium text-destructive">{t('pendingTitle')}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('pendingBody', { date: new Date(scheduledMs).toLocaleDateString() })}
          </p>
          {/* Said here rather than only in the request dialog: this is the
              screen somebody reads when they are changing their mind. */}
          <p className="text-xs text-muted-foreground">{t('pendingBillingNote')}</p>
          <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t('cancelAction')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-destructive/30">
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm font-medium">{t('title')}</p>
        <p className="text-sm text-muted-foreground">{t('body')}</p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{t('pointBilling')}</li>
          <li>{t('pointWindow')}</li>
          <li>{t('pointStripe')}</li>
        </ul>

        {open ? (
          <div className="space-y-2 rounded-lg border border-destructive/30 p-3">
            <Label htmlFor="confirm-name" className="text-xs">
              {t('confirmLabel', { name: team.name })}
            </Label>
            <Input
              id="confirm-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={team.name}
              autoComplete="off"
            />
            <div className="flex gap-2">
              <Button
                variant="destructive"
                disabled={typed.trim() !== team.name.trim() || request.isPending}
                onClick={() => request.mutate()}
              >
                {request.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {t('confirmAction')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false)
                  setTyped('')
                }}
              >
                {t('back')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
            {t('startAction')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
