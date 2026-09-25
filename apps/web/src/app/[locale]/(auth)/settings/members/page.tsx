'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInvalidateSetupChecklist } from '@/hooks/useSetupChecklist'
import { collection, getDocs, query, where, orderBy } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useTranslations } from 'next-intl'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import type { RegionalFormatter } from '@linyup/shared'
import {
  MoreHorizontal,
  UserPlus,
  Mail,
  Shield,
  Crown,
  Eye,
  Dumbbell,
  Clock,
  CheckCircle2,
  X,
  Copy,
  Check,
} from 'lucide-react'
import { usePlan } from '@/hooks/usePlan'
import { useCapabilities } from '@/hooks/useCapabilities'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  MULTIPLE_USERS_PLAN_REFUSAL,
  TEAMS_COLLECTION,
  TEAM_INVITATIONS_SUBCOLLECTION,
} from '@linyup/shared'
import type { TeamInvitation, TeamRole } from '@linyup/shared'
import { PlanUpgradeNotice } from '@/components/plan/PlanUpgradeNotice'
import { Tip } from '@/components/ui/tip'
import { callFunction } from '@/lib/callFunction'

// ----- types ----------------------------------------------------------------

// MemberDoc is shaped by the listTeamMembers callable response.
// `joined` is an ISO string (or null) — the callable serializes Timestamps.
interface MemberDoc {
  id: string
  userId: string
  teamId?: string
  role: TeamRole
  joined: string | null | undefined
  addedBy?: string | null
  email?: string | null
  displayName?: string | null
  isCoach: boolean
}

interface InvitationDoc extends TeamInvitation {
  id: string
  status?: string
}

// ----- helpers --------------------------------------------------------------

// Accepts an ISO string (from listTeamMembers), a Firestore Timestamp-like
// object (legacy direct Firestore reads), or a plain Date / null.
function formatDate(
  fmt: RegionalFormatter,
  ts: string | { seconds: number } | Date | null | undefined
): string {
  if (!ts) return ''
  if (typeof ts === 'string') return fmt.custom(new Date(ts), { year: 'numeric', month: 'short', day: 'numeric' })
  const d = ts instanceof Date ? ts : new Date((ts as { seconds: number }).seconds * 1000)
  return fmt.custom(d, { year: 'numeric', month: 'short', day: 'numeric' })
}

function roleIcon(role: TeamRole) {
  if (role === 'owner') return <Crown className="h-3.5 w-3.5" />
  if (role === 'manager') return <Shield className="h-3.5 w-3.5" />
  if (role === 'coach') return <Dumbbell className="h-3.5 w-3.5" />
  return <Eye className="h-3.5 w-3.5" />
}

function roleBadgeVariant(role: TeamRole): 'default' | 'secondary' | 'outline' {
  if (role === 'owner') return 'default'
  if (role === 'manager') return 'secondary'
  return 'outline'
}

// ----- InviteDialog ---------------------------------------------------------

interface InviteDialogProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

function InviteDialog({ open, onClose, onSuccess }: InviteDialogProps) {
  const t = useTranslations('TeamMembers')
  const { currentTeamId: teamId } = useAuth()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<TeamRole>('manager')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!teamId || !email.trim()) return
    setLoading(true)
    setError(null)
    try {
      const fn = callFunction('sendTeamInvitation')
      await fn({ teamId, email: email.trim(), role })
      setEmail('')
      setRole('manager')
      onSuccess()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      // Backstop for the server-side gate (stable error code → localized copy).
      // The dialog is not reachable below the tier, so this fires only when the
      // plan changed under an open dialog — or when the client gate is bypassed,
      // which is exactly why the server has one (utils/teams.requireExtraUserPlan).
      setError(msg.includes(MULTIPLE_USERS_PLAN_REFUSAL) ? t('inviteLockedBody') : msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('inviteTitle')}</DialogTitle>
          <DialogDescription>{t('inviteDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">{t('inviteEmail')}</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">{t('inviteRole')}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as TeamRole)}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manager">{t('role_manager')}</SelectItem>
                <SelectItem value="coach">{t('role_coach')}</SelectItem>
                <SelectItem value="viewer">{t('role_viewer')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(`roleHint_${role}`)}</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={loading || !email.trim()}>
              {loading ? t('sending') : t('inviteSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ----- ConfirmDialog --------------------------------------------------------

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
  onClose: () => void
  loading?: boolean
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  destructive,
  onConfirm,
  onClose,
  loading,
}: ConfirmDialogProps) {
  const t = useTranslations('TeamMembers')
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {t('cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? t('processing') : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----- ChangeRoleDialog -----------------------------------------------------

interface ChangeRoleDialogProps {
  open: boolean
  member: MemberDoc | null
  onClose: () => void
  onSuccess: () => void
  /** Only an owner may grant ownership — the server enforces it, this hides it. */
  canAssignOwner: boolean
}

/**
 * OWNER IS ASSIGNABLE, and only by an owner.
 *
 * `manageTeamMember` has always accepted it ("Only team owners can manage
 * owner/manager roles" — the check is on the CALLER, not on the role being
 * granted); this dialog simply never offered it, so the one way to hand a studio
 * over was to ask support. An owner who is stepping back, a co-founder pair, a
 * club handing over at the AGM: all of them are ordinary, and none of them had a
 * button.
 *
 * IT DOES NOT DEMOTE THE CALLER. The server refuses a self-role-change outright
 * ("You cannot change your own role"), so this promotes rather than transfers,
 * and the team has two owners afterwards. That is a real state, not a
 * workaround: `VALID_ROLES` includes owner and the rules are written for it. The
 * outgoing owner is then demoted BY THE NEW ONE, which is the safe ordering —
 * the alternative, a single call that swaps both, can leave a studio with no
 * owner if it half-fails.
 */
function ChangeRoleDialog({ open, member, canAssignOwner, onClose, onSuccess }: ChangeRoleDialogProps) {
  const t = useTranslations('TeamMembers')
  const { currentTeamId: teamId } = useAuth()
  const [role, setRole] = useState<TeamRole>(member?.role ?? 'manager')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!teamId || !member) return
    setLoading(true)
    setError(null)
    try {
      const fn = callFunction('manageTeamMember')
      await fn({ teamId, userId: member.userId, action: 'updateRole', role })
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('changeRole')}</DialogTitle>
          <DialogDescription>
            {member?.displayName || member?.email || member?.userId}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <Select value={role} onValueChange={(v) => setRole(v as TeamRole)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {canAssignOwner && <SelectItem value="owner">{t('role_owner')}</SelectItem>}
              <SelectItem value="manager">{t('role_manager')}</SelectItem>
              <SelectItem value="coach">{t('role_coach')}</SelectItem>
              <SelectItem value="viewer">{t('role_viewer')}</SelectItem>
            </SelectContent>
          </Select>
          {/* Said BEFORE the button, not in a confirm step after it. What the
              reader needs is what "Owner" means and that they keep their own
              role — a second dialog asking "are you sure" adds a click and
              answers neither. */}
          {role === 'owner' && member?.role !== 'owner' && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-muted-foreground">
              {t('makeOwnerNote')}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? t('processing') : t('saveRole')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ----- Toast helper ---------------------------------------------------------

interface Toast {
  id: number
  message: string
  type: 'success' | 'error'
}

// ----- MemberEmail (with copy button) ---------------------------------------

function MemberEmail({ email }: { email: string }) {
  const t = useTranslations('TeamMembers')
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="truncate">{email}</span>
      <Tip label={copied ? t('copied') : t('copyEmail')}>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(email).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
          aria-label={t('copyEmail')}
          className="shrink-0 rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
        </button>
      </Tip>
    </div>
  )
}

// ----- Main page ------------------------------------------------------------

export default function TeamMembersPage() {
  const t = useTranslations('TeamMembers')
  const fmt = useTeamFormat()
  const { currentTeamId: teamId, user } = useAuth()
  const { can } = useCapabilities()
  const { hasFeature, minimumPlanFor, isLoading: planLoading } = usePlan()
  const qc = useQueryClient()
  const invalidateSetupChecklist = useInvalidateSetupChecklist()

  // A SECOND USER IS A STUDIO FEATURE (UX-42, decided 2026-08-18).
  //
  // `multiple_managers` has always been flagged at Studio in PLAN_FEATURES while
  // this page unlocked invites at Coach; the flag was the true one, so the gate
  // moved to it — and it now READS the flag rather than restating a tier, so the
  // two can never disagree again.
  //
  // THE GATE IS ON ADDING, NOT ON BEING. Nothing here (and nothing in
  // downgradeTeamToFree) touches team_members: a team that already has a second
  // person keeps them, with their role and capabilities intact, and every member
  // action below stays available. Only the invite goes.
  //
  // `hasFeature` answers false while the team doc is still loading, which would
  // flash a refusal at a studio that has the feature — so neither side of the
  // gate renders until the plan is known.
  const canInvite = hasFeature('multiple_managers')
  const inviteGateKnown = !planLoading
  const invitePlan = minimumPlanFor('multiple_managers')

  // toast
  const [toasts, setToasts] = useState<Toast[]>([])
  const addToast = (message: string, type: Toast['type'] = 'success') => {
    const id = Date.now()
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500)
  }

  // dialogs
  const [inviteOpen, setInviteOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<MemberDoc | null>(null)
  const [changeRoleTarget, setChangeRoleTarget] = useState<MemberDoc | null>(null)
  const [cancelInviteTarget, setCancelInviteTarget] = useState<InvitationDoc | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [coachSaving, setCoachSaving] = useState<string | null>(null)

  // data — members (via callable so displayName + email are resolved server-side)
  const { data: members, isLoading: membersLoading } = useQuery<MemberDoc[]>({
    queryKey: ['team-members', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const fn = callFunction<{ teamId: string }, { members: Array<{
        userId: string
        role: TeamRole
        joined: string | null
        addedBy: string | null
        displayName: string | null
        email: string | null
        isCoach: boolean
      }> }>('listTeamMembers')
      const result = await fn({ teamId: teamId! })
      return result.data.members.map((m) => ({
        id: m.userId,
        userId: m.userId,
        role: m.role,
        joined: m.joined,
        addedBy: m.addedBy,
        displayName: m.displayName,
        email: m.email,
        isCoach: m.isCoach,
      } as MemberDoc))
    },
  })

  // data — pending invitations
  const { data: invitations, isLoading: invitesLoading } = useQuery<InvitationDoc[]>({
    queryKey: ['team-invitations', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, teamId!, TEAM_INVITATIONS_SUBCOLLECTION),
          where('status', 'in', ['pending', 'sent']),
          orderBy('created', 'desc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id } as InvitationDoc))
    },
  })

  // current user's role
  const myRole = members?.find((m) => m.userId === user?.uid)?.role
  const isOwner = myRole === 'owner'
  // Capability-gated (owner + manager hold members.manage); rank still decides WHO
  // each of them may act on (see the per-row guards below).
  const canManage = can('members.manage')

  // role labels lookup (avoids dynamic key that TypeScript can't type-check)
  const roleLabel: Record<TeamRole, string> = {
    owner: t('role_owner'),
    manager: t('role_manager'),
    coach: t('role_coach'),
    viewer: t('role_viewer'),
  }

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['team-members', teamId] })
    qc.invalidateQueries({ queryKey: ['team-invitations', teamId] })
    // Removing a member can take the team back to one person, which reopens the
    // setup checklist's "invite your coaches" step. (Accepting an invitation is
    // a write this browser does not make — that one is the poll's job.)
    void invalidateSetupChecklist()
  }

  // remove member
  async function handleRemoveMember() {
    if (!removeTarget || !teamId) return
    setActionLoading(true)
    try {
      const fn = callFunction('manageTeamMember')
      await fn({ teamId, userId: removeTarget.userId, action: 'remove' })
      addToast(t('removedSuccess'))
      invalidate()
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Error', 'error')
    } finally {
      setActionLoading(false)
      setRemoveTarget(null)
    }
  }

  // cancel invitation
  async function handleCancelInvite() {
    if (!cancelInviteTarget || !teamId) return
    setActionLoading(true)
    try {
      const fn = callFunction('manageTeamInvitation')
      await fn({ teamId, invitationId: cancelInviteTarget.id, action: 'cancel' })
      addToast(t('inviteCancelledSuccess'))
      invalidate()
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Error', 'error')
    } finally {
      setActionLoading(false)
      setCancelInviteTarget(null)
    }
  }

  // toggle a member's coach-roster membership (optimistic; reverts on error)
  async function setCoach(m: MemberDoc, isCoach: boolean) {
    if (!teamId) return
    setCoachSaving(m.userId)
    qc.setQueryData<MemberDoc[]>(['team-members', teamId], (prev) =>
      prev?.map((x) => (x.userId === m.userId ? { ...x, isCoach } : x)),
    )
    try {
      const fn = callFunction('manageTeamMember')
      await fn({ teamId, userId: m.userId, action: 'setCoach', isCoach })
      qc.invalidateQueries({ queryKey: ['team-coaches-roster', teamId] })
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Error', 'error')
      qc.setQueryData<MemberDoc[]>(['team-members', teamId], (prev) =>
        prev?.map((x) => (x.userId === m.userId ? { ...x, isCoach: !isCoach } : x)),
      )
    } finally {
      setCoachSaving(null)
    }
  }

  const isLoading = membersLoading || invitesLoading

  // sort: owner first, then managers, then viewers
  const roleOrder: Record<TeamRole, number> = { owner: 0, manager: 1, coach: 2, viewer: 3 }
  const sortedMembers = [...(members ?? [])].sort(
    (a, b) => roleOrder[a.role] - roleOrder[b.role]
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
        </div>
        {canManage && inviteGateKnown && canInvite && (
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="h-4 w-4 mr-2" />
            {t('inviteButton')}
          </Button>
        )}
      </div>

      {/* A BEHAVIOR REMOVAL, so it speaks in the ONE shape UX-42 standardized:
          it names the tier and carries the control that changes the answer. The
          lock button it replaces did neither — it opened the upgrade modal
          without ever saying which plan, which is a refusal the reader cannot
          act on until after they click. */}
      {canManage && inviteGateKnown && !canInvite && (
        <PlanUpgradeNotice
          minPlan={invitePlan}
          feature="multiple_managers"
          title={t('inviteLockedTitle')}
          description={t('inviteLockedBody')}
        />
      )}

      {/* Said only when it is TRUE of this team: somebody is already here who
          could not be invited today. Without it the notice above reads as a
          threat to the people on the list. */}
      {canManage && inviteGateKnown && !canInvite && sortedMembers.length > 1 && (
        <p className="text-xs text-muted-foreground">{t('existingMembersKeepAccess')}</p>
      )}

      {/* Members list */}
      <div className="rounded-md border">
        <div className="p-4 border-b bg-muted/40">
          <h2 className="font-semibold text-sm">
            {t('membersTitle')} ({sortedMembers.length})
          </h2>
        </div>
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="space-y-1 flex-1">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : sortedMembers.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            {t('noMembers')}
          </div>
        ) : (
          <ul className="divide-y">
            {sortedMembers.map((m) => {
              const isSelf = m.userId === user?.uid
              return (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                  {/* Avatar placeholder */}
                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
                    {(m.displayName ?? m.email ?? m.userId).charAt(0).toUpperCase()}
                  </div>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {m.displayName ?? m.email ?? m.userId}
                      </span>
                      {isSelf && (
                        <span className="text-xs text-muted-foreground">({t('you')})</span>
                      )}
                    </div>
                    {m.email && <MemberEmail email={m.email} />}
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {t('joinedOn', { date: formatDate(fmt, m.joined) })}
                    </div>
                  </div>
                  {/* Role badge */}
                  <Badge variant={roleBadgeVariant(m.role)} className="flex items-center gap-1 shrink-0">
                    {roleIcon(m.role)}
                    {roleLabel[m.role]}
                  </Badge>
                  {/* THE COACH CONTROL, IN WORDS.
                      It was a dumbbell icon and a bare switch, sitting right
                      next to the ROLE badge — so the obvious reading was "this
                      switch changes the role to Coach", which it does not. It is
                      a separate fact about the person: they teach, so they can
                      be picked as a session's instructor and assigned to a
                      contact. Somebody can be a Manager AND a coach, which is
                      exactly the case an icon cannot express.
                      The label says it, and a coach-ROLE member reads as locked
                      on rather than as a switch that ignores clicks. */}
                  {canManage ? (
                    <label
                      className={`flex shrink-0 items-center gap-2 ${m.role === 'coach' ? 'cursor-default' : 'cursor-pointer'}`}
                      title={t('coachToggleHint')}
                    >
                      <span className="text-xs text-muted-foreground">
                        {m.role === 'coach' ? t('coachAlways') : t('coachToggle')}
                      </span>
                      <Switch
                        checked={m.role === 'coach' || m.isCoach}
                        disabled={m.role === 'coach' || coachSaving === m.userId}
                        onCheckedChange={(v) => setCoach(m, v)}
                        aria-label={t('coachToggle')}
                      />
                    </label>
                  ) : (m.role === 'coach' || m.isCoach) ? (
                    <Badge variant="outline" className="shrink-0 flex items-center gap-1">
                      <Dumbbell className="h-3 w-3" />
                      {t('coachBadge')}
                    </Badge>
                  ) : null}
                  {/* Actions */}
                  {/* AN OWNER ROW HAS ACTIONS TOO — for another owner. It was
                      hidden for every caller, which was right while ownership
                      could not be granted (there was only ever one owner, and
                      it was you) and wrong the moment it can: a studio that has
                      just handed over needs the previous owner demotable, and
                      the server already allows exactly that. `isSelf` still
                      guards the caller's own row; the server refuses it anyway. */}
                  {canManage && !isSelf && (m.role !== 'owner' || isOwner) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-accent">
                        <MoreHorizontal className="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setChangeRoleTarget(m)}>
                          <Shield className="h-4 w-4 mr-2" />
                          {t('changeRole')}
                        </DropdownMenuItem>
                        {isOwner && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setRemoveTarget(m)}
                            >
                              <X className="h-4 w-4 mr-2" />
                              {t('removeMember')}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Pending invitations */}
      {((invitations && invitations.length > 0) || invitesLoading) && (
        <div className="rounded-md border">
          <div className="p-4 border-b bg-muted/40">
            <h2 className="font-semibold text-sm flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              {t('pendingTitle')} ({invitations?.length ?? 0})
            </h2>
          </div>
          {invitesLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ul className="divide-y">
              {(invitations ?? []).map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{inv.email}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {t('invitedOn', { date: formatDate(fmt, inv.created as Parameters<typeof formatDate>[1]) })}
                    </div>
                  </div>
                  <Badge variant={roleBadgeVariant(inv.role)} className="flex items-center gap-1 shrink-0">
                    {roleIcon(inv.role)}
                    {roleLabel[inv.role]}
                  </Badge>
                  <div className="flex items-center gap-1 shrink-0">
                    <Badge variant="outline" className="text-xs">
                      <Clock className="h-3 w-3 mr-1" />
                      {t('statusPending')}
                    </Badge>
                    {canManage && (
                      <Tip label={t('cancelInvite')}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setCancelInviteTarget(inv)}
                          aria-label={t('cancelInvite')}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </Tip>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Dialogs */}
      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSuccess={() => {
          invalidate()
          addToast(t('inviteSentSuccess'))
        }}
      />

      <ChangeRoleDialog
        open={!!changeRoleTarget}
        member={changeRoleTarget}
        canAssignOwner={isOwner}
        onClose={() => setChangeRoleTarget(null)}
        onSuccess={() => {
          invalidate()
          addToast(t('roleUpdatedSuccess'))
        }}
      />

      <ConfirmDialog
        open={!!removeTarget}
        title={t('confirmRemoveTitle')}
        message={t('confirmRemoveMessage', {
          name: removeTarget?.displayName ?? removeTarget?.email ?? removeTarget?.userId ?? '',
        })}
        confirmLabel={t('removeMember')}
        destructive
        onConfirm={handleRemoveMember}
        onClose={() => setRemoveTarget(null)}
        loading={actionLoading}
      />

      <ConfirmDialog
        open={!!cancelInviteTarget}
        title={t('confirmCancelInviteTitle')}
        message={t('confirmCancelInviteMessage', {
          email: cancelInviteTarget?.email ?? '',
        })}
        confirmLabel={t('cancelInvite')}
        onConfirm={handleCancelInvite}
        onClose={() => setCancelInviteTarget(null)}
        loading={actionLoading}
      />

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 space-y-2 z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white ${
              toast.type === 'error' ? 'bg-destructive' : 'bg-green-600'
            }`}
          >
            {toast.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <X className="h-4 w-4 shrink-0" />
            )}
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  )
}
