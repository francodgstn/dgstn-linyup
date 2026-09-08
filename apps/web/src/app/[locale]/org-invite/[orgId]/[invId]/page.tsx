'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import { useParams } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Building2, CheckCircle2, Info, XCircle } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'

interface InvitationDetails {
  orgId: string
  orgName: string
  teamId: string | null
  teamName: string | null
  inviteeEmail: string
  expiresAt: string
}

interface UserTeam {
  id: string
  name: string
}

export default function OrgInvitePage() {
  const params = useParams<{ orgId: string; invId: string }>()
  const t = useTranslations('OrgInvite')
  const { user, profile } = useAuth()

  const [invitation, setInvitation] = useState<InvitationDetails | null>(null)
  const [loadingInvite, setLoadingInvite] = useState(true)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const [userTeams, setUserTeams] = useState<UserTeam[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<string>('')

  const [status, setStatus] = useState<'idle' | 'accepted' | 'declined'>('idle')
  const [actionLoading, setActionLoading] = useState(false)

  // Load invitation details
  useEffect(() => {
    async function load() {
      try {
        const fn = httpsCallable<
          { invitationId: string; orgId: string },
          InvitationDetails
        >(functions, 'getOrgInvitationDetails')
        const result = await fn({ invitationId: params.invId, orgId: params.orgId })
        setInvitation(result.data)
        // Pre-select teamId if invitation targets a specific team
        if (result.data.teamId) setSelectedTeamId(result.data.teamId)
      } catch (err: unknown) {
        setInviteError(err instanceof Error ? err.message : 'not-found')
      } finally {
        setLoadingInvite(false)
      }
    }
    load()
  }, [params.invId, params.orgId])

  // Load teams where user is owner (for team selection)
  useEffect(() => {
    if (!user || !profile) return

    async function loadTeams() {
      try {
        const { getDocs, collection, query, where } = await import('firebase/firestore')
        const { db } = await import('@/lib/firebase')

        const membersSnap = await getDocs(
          query(
            collection(db, 'teams', profile!.currentTeam ?? '__none__', 'team_members'),
            where('userId', '==', user!.uid),
            where('role', '==', 'owner')
          )
        )

        // Get all teams where the user is owner via collectionGroup
        const ownerSnap = await getDocs(
          query(
            (await import('firebase/firestore')).collectionGroup(db, 'team_members'),
            where('userId', '==', user!.uid),
            where('role', '==', 'owner')
          )
        )

        const teams: UserTeam[] = []
        for (const memberDoc of ownerSnap.docs) {
          const teamId = memberDoc.ref.parent.parent?.id
          if (!teamId) continue
          const teamDoc = await (await import('firebase/firestore')).getDoc(
            (await import('firebase/firestore')).doc(db, 'teams', teamId)
          )
          if (teamDoc.exists()) {
            teams.push({ id: teamId, name: teamDoc.data().name })
          }
        }
        setUserTeams(teams)
        void membersSnap // silence unused warning
      } catch {
        // ignore errors — user just won't see teams
      }
    }
    loadTeams()
  }, [user, profile])

  async function handleAccept() {
    if (!selectedTeamId) return
    setActionLoading(true)
    try {
      const fn = httpsCallable(functions, 'acceptOrgInvitation')
      await fn({ invitationId: params.invId, teamId: selectedTeamId })
      setStatus('accepted')
    } catch (err: unknown) {
      setInviteError(err instanceof Error ? err.message : 'Error')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleDecline() {
    setActionLoading(true)
    try {
      const fn = httpsCallable(functions, 'declineOrgInvitation')
      await fn({ invitationId: params.invId, orgId: params.orgId })
      setStatus('declined')
    } catch (err: unknown) {
      setInviteError(err instanceof Error ? err.message : 'Error')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-3">
            <Building2 className="h-10 w-10 text-primary" />
          </div>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingInvite ? (
            <div className="space-y-3">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-9 w-full mt-4" />
            </div>
          ) : inviteError ? (
            <div className="text-center space-y-3">
              <XCircle className="h-8 w-8 text-destructive mx-auto" />
              <p className="text-sm text-muted-foreground">{t('notFound')}</p>
              <Link href={'/dashboard' as Route} className="text-sm text-primary hover:underline">
                Go to dashboard
              </Link>
            </div>
          ) : status === 'accepted' ? (
            <div className="text-center space-y-3">
              <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto" />
              <p className="text-sm font-medium">{t('accepted')}</p>
              <Link href={'/dashboard' as Route} className="text-sm text-primary hover:underline">
                Go to dashboard
              </Link>
            </div>
          ) : status === 'declined' ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-muted-foreground">{t('declined')}</p>
              <Link href={'/dashboard' as Route} className="text-sm text-primary hover:underline">
                Go to dashboard
              </Link>
            </div>
          ) : invitation ? (
            <>
              <p className="text-sm text-center text-muted-foreground">
                {t('invitedBy')}{' '}
                <span className="font-semibold text-foreground">{invitation.orgName}</span>
              </p>

              {invitation.teamName && (
                <div className="flex justify-between text-sm py-2 border-y">
                  <span className="text-muted-foreground">{t('teamLabel')}</span>
                  <span className="font-medium">{invitation.teamName}</span>
                </div>
              )}

              {!user ? (
                <div className="pt-2 space-y-3">
                  <p className="text-sm text-center text-muted-foreground">{t('loginRequired')}</p>
                  <Link
                    href={`/login?redirect=/org-invite/${params.orgId}/${params.invId}` as Route}
                    className="block w-full text-center"
                  >
                    <Button className="w-full">Sign in to continue</Button>
                  </Link>
                </div>
              ) : (
                <>
                  {/* Team selection — only shown when invitation doesn't target a specific team */}
                  {!invitation.teamId && userTeams.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">{t('selectTeam')}</label>
                      <Select value={selectedTeamId} onValueChange={(v) => { if (v) setSelectedTeamId(v) }}>
                        <SelectTrigger>
                          <SelectValue placeholder={t('selectTeam')} />
                        </SelectTrigger>
                        <SelectContent>
                          {userTeams.map((team) => (
                            <SelectItem key={team.id} value={team.id}>
                              {team.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                    </div>
                  )}

                  {/* WHAT ACCEPTING CHANGES — stated at the point of decision.
                      Accepting hands `isOrgAdminOfTeam` read over the chosen
                      team's contacts to every admin of the organisation and
                      moves that team onto the org plan (`org_id` IS the grant,
                      UX-35), and only an org admin can unlink it afterwards
                      (`removeTeamFromOrg` asserts org admin; there is no
                      team-side leave). None of that was said anywhere, while
                      the select above lists EVERY studio the caller owns — so
                      an owner who also runs a studio of their own could hand
                      over its whole contact book by picking the wrong line of a
                      dropdown, with the page framing it as a free upgrade.
                      See docs/studio-independent-contacts.md. */}
                  <div className="rounded-md border bg-muted/40 p-3 space-y-2">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <Info className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      {t('changesTitle')}
                    </p>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      <li>{t('changesData', { org: invitation.orgName })}</li>
                      <li>{t('changesBilling', { org: invitation.orgName })}</li>
                      <li>{t('changesUndo', { org: invitation.orgName })}</li>
                    </ul>
                    {!invitation.teamId && userTeams.length > 1 && (
                      <p className="text-sm font-medium">
                        {t('changesChooseTeam', { org: invitation.orgName })}
                      </p>
                    )}
                  </div>

                  {inviteError && (
                    <p className="text-sm text-destructive">{inviteError}</p>
                  )}

                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={handleDecline}
                      disabled={actionLoading}
                    >
                      {t('declineButton')}
                    </Button>
                    <Button
                      className="flex-1"
                      onClick={handleAccept}
                      disabled={actionLoading || !selectedTeamId}
                    >
                      {actionLoading ? t('processing') : t('acceptButton')}
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
