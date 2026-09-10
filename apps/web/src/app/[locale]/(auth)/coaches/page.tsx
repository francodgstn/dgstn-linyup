'use client'

// Coaches — a simple roster of the team's coaches with invite + remove. Studio/org
// only (the coach plan is single-person). Every team member may VIEW the list;
// managing (invite/remove) is gated by the `coaches.manage` capability (owner +
// manager by default, assignable to the coach role but off by default). Removal
// additionally requires outranking the target (canManageRole), so a coach can
// invite peers but not remove them.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { collection, query, where, orderBy, getDocs, doc, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { usePlan } from '@/hooks/usePlan'
import { PlanUpgradeNotice } from '@/components/plan/PlanUpgradeNotice'
import { useCapabilities } from '@/hooks/useCapabilities'
import {
  TEAMS_COLLECTION,
  TEAM_INVITATIONS_SUBCOLLECTION,
  canManageRole,
  nameInitials,
} from '@linyup/shared'
import type { TeamRole } from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { QueryErrorState } from '@/components/ui/query-error'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { UserCog, UserPlus, Trash2, Mail, Clock, X } from 'lucide-react'
import { toast } from 'sonner'
import { Tip } from '@/components/ui/tip'

type Member = { userId: string; role: TeamRole; displayName?: string; email?: string; isCoach?: boolean }
type Invite = { id: string; email: string; role: string }

function errorMessage(err: unknown): string | null {
  if (err instanceof Error && err.message) return err.message
  return null
}

export default function CoachesPage() {
  const t = useTranslations('Coaches')
  const { currentTeamId, user, team, teamRole } = useAuth()
  const { isAtLeast, isLoading: planLoading } = usePlan()
  const { can } = useCapabilities()
  const qc = useQueryClient()

  const [inviteOpen, setInviteOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)
  const [orgToggling, setOrgToggling] = useState(false)

  const studioPlus = isAtLeast('studio')
  const canManage = can('coaches.manage')

  // Publishing the roster is a team-doc write (Firestore rules require the
  // owner role), and only meaningful for teams that belong to an organization
  // (the org website is the only public surface that aggregates coaches).
  async function toggleOrgListing(checked: boolean) {
    if (!currentTeamId || orgToggling) return
    setOrgToggling(true)
    try {
      await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId), { public_coaches_enabled: checked })
    } catch {
      toast.error(t('errorGeneric'))
    } finally {
      setOrgToggling(false)
    }
  }

  const {
    data: members = [],
    isLoading: membersLoading,
    isError: membersErrored,
    error: membersError,
    refetch: refetchMembers,
  } = useQuery<Member[]>({
    queryKey: ['team-members', currentTeamId],
    enabled: !!currentTeamId && studioPlus,
    queryFn: async () => {
      const res = await httpsCallable(functions, 'listTeamMembers')({ teamId: currentTeamId })
      return (res.data as { members?: Member[] }).members ?? []
    },
  })
  const myRole = members.find((m) => m.userId === user?.uid)?.role ?? null
  // Coach roster = every member flagged as a coach (any role — owners/managers can
  // coach too), per the per-member `isCoach` flag. Absent ⇒ coach by default.
  const coaches = members.filter((m) => m.isCoach !== false)

  const { data: invites = [] } = useQuery<Invite[]>({
    queryKey: ['team-invitations', currentTeamId, 'coach'],
    enabled: !!currentTeamId && studioPlus && canManage,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, currentTeamId!, TEAM_INVITATIONS_SUBCOLLECTION),
          where('status', 'in', ['pending', 'sent']),
          orderBy('created', 'desc'),
        ),
      )
      return snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as { email: string; role: string }) }))
        .filter((i) => i.role === 'coach')
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      await httpsCallable(functions, 'manageTeamMember')({ teamId: currentTeamId, userId, action: 'remove' })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-members', currentTeamId] })
      setRemoveTarget(null)
      toast.success(t('removed'))
    },
    onError: () => toast.error(t('errorGeneric')),
  })

  const cancelInviteMutation = useMutation({
    mutationFn: async (invitationId: string) => {
      await httpsCallable(functions, 'manageTeamInvitation')({ teamId: currentTeamId, invitationId, action: 'cancel' })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-invitations', currentTeamId, 'coach'] }),
    onError: () => toast.error(t('errorGeneric')),
  })

  // ── Plan gate (the nav hides this on free/coach; guard the page too) ──
  if (!planLoading && !studioPlus) {
    // Was a dead-end refusal: upsell prose with nothing to click, which is
    // failure mode 2 in PlanUpgradeNotice's header. Same tier, same feature and
    // same sentence as the members invite it depends on — inviting a coach here
    // calls the very callable that gate protects.
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <PlanUpgradeNotice minPlan="studio" feature="multiple_managers" description={t('planGate')} />
      </div>
    )
  }

  const canRemove = (m: Member) => canManage && !!myRole && canManageRole(myRole, m.role)

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canManage && (
          <Button onClick={() => setInviteOpen(true)} className="shrink-0">
            <UserPlus className="h-4 w-4" />
            {t('invite')}
          </Button>
        )}
      </div>

      {/* Organization listing opt-in — only relevant for teams that belong to an
          org (the org website's Coaches block is the only public aggregator),
          and only the team owner can flip it (matches the teams/{teamId} write rule). */}
      {team?.org_id && teamRole === 'owner' && (
        <label className="flex items-start justify-between gap-4 rounded-xl border bg-card p-4">
          <span>
            <span className="block text-sm font-medium">{t('orgListingLabel')}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('orgListingHint')}</span>
          </span>
          <Switch
            checked={team.public_coaches_enabled ?? false}
            onCheckedChange={toggleOrgListing}
            disabled={orgToggling}
            className="mt-0.5 shrink-0"
          />
        </label>
      )}

      {/* Coaches list */}
      {membersErrored ? (
        <QueryErrorState onRetry={() => refetchMembers()} detail={errorMessage(membersError)} />
      ) : membersLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      ) : coaches.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <UserCog className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {coaches.map((m) => (
            <div key={m.userId} className="flex items-center gap-3 rounded-xl border bg-card p-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {nameInitials(m.displayName || m.email)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.displayName || m.email || m.userId}</p>
                {m.email && <p className="truncate text-xs text-muted-foreground">{m.email}</p>}
              </div>
              <Badge variant="secondary" className="shrink-0">{t('roleCoach')}</Badge>
              {canRemove(m) && (
                <Tip label={t('remove')}>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setRemoveTarget(m)}
                    aria-label={t('remove')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </Tip>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pending invitations */}
      {canManage && invites.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('pendingTitle')}
          </h2>
          {invites.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 rounded-xl border border-dashed p-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                <Mail className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{inv.email}</p>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" /> {t('pending')}
                </p>
              </div>
              <Tip label={t('cancelInvite')}>
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => cancelInviteMutation.mutate(inv.id)}
                  disabled={cancelInviteMutation.isPending}
                  aria-label={t('cancelInvite')}
                >
                  <X className="h-4 w-4" />
                </Button>
              </Tip>
            </div>
          ))}
        </div>
      )}

      <InviteCoachDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        teamId={currentTeamId}
        onInvited={() => qc.invalidateQueries({ queryKey: ['team-invitations', currentTeamId, 'coach'] })}
      />

      {/* Remove confirmation */}
      <Dialog open={!!removeTarget} onOpenChange={(v) => { if (!v) setRemoveTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('removeTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('removeConfirm', { name: removeTarget?.displayName || removeTarget?.email || '' })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>{t('cancel')}</Button>
            <Button
              variant="destructive"
              onClick={() => removeTarget && removeMutation.mutate(removeTarget.userId)}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? t('removing') : t('remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function InviteCoachDialog({
  open, onClose, teamId, onInvited,
}: {
  open: boolean
  onClose: () => void
  teamId: string | null
  onInvited: () => void
}) {
  const t = useTranslations('Coaches')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const reset = () => { setEmail(''); setError(null); setErrorDetail(null); setSending(false) }

  async function submit() {
    const value = email.trim()
    if (!value || !teamId || sending) return
    setSending(true)
    setError(null)
    setErrorDetail(null)
    try {
      await httpsCallable(functions, 'sendTeamInvitation')({ teamId, email: value, role: 'coach' })
      toast.success(t('inviteSent'))
      onInvited()
      reset()
      onClose()
    } catch (err) {
      // Deliberately does NOT call reset(): the email stays filled and the
      // dialog stays open so the user can retry instead of retyping.
      setError(t('inviteError'))
      setErrorDetail(errorMessage(err))
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { reset(); onClose() } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('inviteTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('inviteDesc')}</p>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('invitePlaceholder')}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
          {error && (
            <div className="space-y-0.5">
              <p className="text-sm text-destructive">{error}</p>
              {errorDetail && (
                <p className="truncate text-xs text-muted-foreground" title={errorDetail}>{errorDetail}</p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose() }}>{t('cancel')}</Button>
          <Button onClick={submit} disabled={!email.trim() || sending}>
            {sending ? t('inviteSending') : t('invite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
