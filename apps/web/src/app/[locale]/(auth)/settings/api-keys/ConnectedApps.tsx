'use client'

// Connected apps — the OAuth grants members made from Claude, ChatGPT or another
// client (docs/public-api.md → "OAuth"). Rendered on Settings → API keys, which
// only an owner reaches, and the rules let an owner read every grant.
// Disconnecting goes through the `revokeOAuthGrant` callable; the principal
// resolver reads the grant on every request, so the app is refused on its next call.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { toast } from 'sonner'
import { PlugZap } from 'lucide-react'
import { OAUTH_GRANTS_SUBCOLLECTION, TEAMS_COLLECTION, type OAuthGrant } from '@linyup/shared'
import { db, functions } from '@/lib/firebase'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { ApiScopeName } from '@/components/api/ApiScopeText'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

const GRANT_LIST_LIMIT = 50

export function ConnectedApps({ teamId }: { teamId: string }) {
  const t = useTranslations('ApiKeys')
  const format = useTeamFormat()
  const { confirm, confirmDialog } = useConfirm()
  const [grants, setGrants] = useState<OAuthGrant[] | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    const q = query(
      collection(db, TEAMS_COLLECTION, teamId, OAUTH_GRANTS_SUBCOLLECTION),
      orderBy('created_at', 'desc'),
      limit(GRANT_LIST_LIMIT)
    )
    return onSnapshot(
      q,
      (snap) => setGrants(snap.docs.map((d) => ({ ...(d.data() as OAuthGrant), id: d.id }))),
      (err) => {
        console.error('[connected apps] list failed:', err)
        setGrants([])
      }
    )
  }, [teamId])

  async function disconnect(grant: OAuthGrant) {
    const ok = await confirm({
      title: t('disconnectTitle', { name: grant.client_name }),
      description: t('disconnectBody'),
      confirmLabel: t('disconnect'),
    })
    if (!ok) return
    setPending(grant.id)
    try {
      await httpsCallable(functions, 'revokeOAuthGrant')({ teamId, grantId: grant.id })
      toast.success(t('disconnectedToast', { name: grant.client_name }))
    } catch (err) {
      console.error('[connected apps] disconnect failed:', err)
      toast.error(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="space-y-3 pt-2">
      <div>
        <h2 className="text-base font-semibold">{t('connectedTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('connectedBody')}</p>
      </div>
      {grants === null ? (
        <Skeleton className="h-20 rounded-xl" />
      ) : grants.length === 0 ? (
        <div className="rounded-xl border bg-card p-5 text-center">
          <PlugZap className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{t('connectedEmpty')}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {grants.map((grant) => {
            const active = !grant.revoked_at
            return (
              <li key={grant.id} className={`rounded-xl border bg-card p-4 ${active ? '' : 'opacity-70'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-medium">{grant.client_name}</h3>
                      <Badge variant={active ? 'secondary' : 'outline'}>
                        {active ? t('statusActive') : t('statusDisconnected')}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('connectedVia', { host: grant.redirect_host })}</p>
                    <div className="flex flex-wrap gap-1">
                      {grant.scopes.map((scope) => (
                        <Badge key={scope} variant="outline" className="font-normal">
                          <ApiScopeName scope={scope} />
                        </Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('connectedOn', { date: format.date(grant.created_at.toDate()) })}
                      {' · '}
                      {grant.last_used_at
                        ? t('lastUsed', { date: format.date(grant.last_used_at.toDate()) })
                        : t('neverUsed')}
                    </p>
                  </div>
                  {active && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-destructive"
                      disabled={pending === grant.id}
                      onClick={() => disconnect(grant)}
                    >
                      {t('disconnect')}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {confirmDialog}
    </section>
  )
}
