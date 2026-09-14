'use client'

// Settings → API keys — the owner's door to the public API and MCP server
// (docs/public-api.md).
//
// Everything this page does goes through the two callables (`createApiKey`,
// `revokeApiKey`); `firestore.rules` denies every client write to `api_keys`
// and lets only an owner read it. So a manager who deep-links here sees the
// reason, not a list — the rail hides the row for her (`gate: 'ownerOnly'`),
// which is navigation, never enforcement.
//
// The scope switches read the SAME table the server enforces
// (`API_SCOPES` / `API_SCOPE_REQUIREMENTS` in @linyup/shared): personal
// details depend on contacts, and nothing here decides what a scope means.
// The secret exists in this component's state for one dialog and nowhere else.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { toast } from 'sonner'
import { Check, Copy, KeyRound, Plus } from 'lucide-react'
import {
  API_CONNECTORS_PLUGIN_ID,
  API_KEYS_SUBCOLLECTION,
  API_KEY_NAME_MAX,
  API_SCOPES,
  API_SCOPE_REQUIREMENTS,
  DEFAULT_API_SCOPES,
  MAX_ACTIVE_API_KEYS,
  TEAMS_COLLECTION,
  type ApiKey,
  type ApiScope,
} from '@linyup/shared'
import { db, functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import { PluginNotInstalled } from '@/components/plugins/PluginNotInstalled'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Where the API answers. Local development points this at the functions emulator. */
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.linyup.com').replace(/\/+$/, '')

/** The newest keys, revoked ones included, so an owner can see what was closed. */
const KEY_LIST_LIMIT = 50

const EXPIRY_CHOICES = ['never', '30', '90', '365'] as const
type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]

type KeyRow = ApiKey & { status: 'active' | 'revoked' | 'expired' }

interface CreateResult {
  secret: string
  key: { id: string; name: string; prefix: string; last4: string; scopes: ApiScope[]; expires_at_ms: number | null }
}

function statusOf(key: ApiKey, nowMs: number): KeyRow['status'] {
  if (key.revoked_at) return 'revoked'
  const expires = key.expires_at?.toMillis?.()
  return typeof expires === 'number' && expires <= nowMs ? 'expired' : 'active'
}

/** The stable reason code a callable put in its HttpsError details, if any. */
function reasonOf(err: unknown): string | null {
  const details = (err as { details?: { reason?: unknown } } | null)?.details
  return typeof details?.reason === 'string' ? details.reason : null
}

export default function ApiKeysSettingsPage() {
  const t = useTranslations('ApiKeys')
  const { currentTeamId, teamRole } = useAuth()
  const { isInstalled, isLoading: pluginsLoading } = useInstalledPlugins()
  const format = useTeamFormat()
  const { confirm, confirmDialog } = useConfirm()

  const isOwner = teamRole === 'owner'
  const installed = isInstalled(API_CONNECTORS_PLUGIN_ID)

  const [keys, setKeys] = useState<KeyRow[] | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [created, setCreated] = useState<CreateResult | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    if (!currentTeamId || !isOwner) return
    const q = query(
      collection(db, TEAMS_COLLECTION, currentTeamId, API_KEYS_SUBCOLLECTION),
      orderBy('created_at', 'desc'),
      limit(KEY_LIST_LIMIT)
    )
    return onSnapshot(
      q,
      (snap) => {
        const now = Date.now()
        setKeys(snap.docs.map((d) => {
          const key = { ...(d.data() as ApiKey), id: d.id }
          return { ...key, status: statusOf(key, now) }
        }))
      },
      (err) => {
        console.error('[api keys] list failed:', err)
        setKeys([])
      }
    )
  }, [currentTeamId, isOwner])

  const activeCount = keys?.filter((k) => k.status === 'active').length ?? 0
  const atLimit = activeCount >= MAX_ACTIVE_API_KEYS

  async function revoke(key: KeyRow) {
    if (!currentTeamId) return
    const ok = await confirm({
      title: t('revokeTitle', { name: key.name }),
      description: t('revokeBody'),
      confirmLabel: t('revoke'),
    })
    if (!ok) return
    setRevoking(key.id)
    try {
      await httpsCallable(functions, 'revokeApiKey')({ teamId: currentTeamId, keyId: key.id })
      toast.success(t('revokedToast', { name: key.name }))
    } catch (err) {
      console.error('[api keys] revoke failed:', err)
      toast.error(err instanceof Error ? err.message : t('errorGeneric'))
    } finally {
      setRevoking(null)
    }
  }

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('pageSubtitle')}</p>
      </div>
      {isOwner && installed && (
        <Button className="hidden sm:inline-flex" onClick={() => setCreateOpen(true)} disabled={atLimit}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t('create')}
        </Button>
      )}
    </div>
  )

  if (pluginsLoading) {
    return (
      <div className="max-w-5xl space-y-5">
        {header}
        <Skeleton className="h-24 max-w-2xl rounded-xl" />
      </div>
    )
  }

  if (!installed) {
    return (
      <div className="max-w-5xl space-y-5">
        {header}
        <PluginNotInstalled
          pluginId={API_CONNECTORS_PLUGIN_ID}
          icon={KeyRound}
          title={t('notInstalledTitle')}
          body={t('notInstalledBody')}
        />
      </div>
    )
  }

  if (!isOwner) {
    return (
      <div className="max-w-5xl space-y-5">
        {header}
        <p className="max-w-2xl rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">{t('ownerOnly')}</p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-5 pb-20 sm:pb-0">
      {header}

      <div className="max-w-2xl space-y-4">
        <ConnectCard />

        {atLimit && (
          <p className="text-xs text-muted-foreground">{t('limitNote', { max: MAX_ACTIVE_API_KEYS })}</p>
        )}

        {keys === null ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : keys.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <KeyRound className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {keys.map((key) => (
              <li
                key={key.id}
                className={`rounded-xl border bg-card p-4 ${key.status === 'active' ? '' : 'opacity-70'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-medium">{key.name}</h3>
                      {key.status === 'active' ? (
                        <Badge variant="secondary">{t('statusActive')}</Badge>
                      ) : key.status === 'expired' ? (
                        <Badge variant="outline">{t('statusExpired')}</Badge>
                      ) : (
                        <Badge variant="outline">{t('statusRevoked')}</Badge>
                      )}
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                      {key.prefix}…{key.last4}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <Badge key={scope} variant="outline" className="font-normal">
                          <ScopeName scope={scope} />
                        </Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('createdOn', { date: format.date(key.created_at.toDate()) })}
                      {' · '}
                      {key.last_used_at
                        ? t('lastUsed', { date: format.date(key.last_used_at.toDate()) })
                        : t('neverUsed')}
                      {key.status === 'active' && key.expires_at && (
                        <> {' · '}{t('expiresOn', { date: format.date(key.expires_at.toDate()) })}</>
                      )}
                    </p>
                  </div>
                  {key.status !== 'revoked' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-destructive"
                      disabled={revoking === key.id}
                      onClick={() => revoke(key)}
                    >
                      {t('revoke')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The mobile primary action, per the list-page pattern: fixed bottom-right. */}
      <Button
        className="fixed bottom-6 right-6 z-30 h-12 rounded-full px-5 shadow-lg sm:hidden"
        onClick={() => setCreateOpen(true)}
        disabled={atLimit}
      >
        <Plus className="mr-1.5 h-4 w-4" />
        {t('create')}
      </Button>

      <CreateKeyDialog
        open={createOpen}
        teamId={currentTeamId}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => {
          setCreateOpen(false)
          setCreated(result)
        }}
      />
      <RevealKeyDialog result={created} onClose={() => setCreated(null)} />
      {confirmDialog}
    </div>
  )
}

/** A scope's short name, written out per scope so every key is a literal. */
function ScopeName({ scope }: { scope: ApiScope }) {
  const t = useTranslations('ApiKeys')
  switch (scope) {
    case 'contacts:read':
      return <>{t('scopeContacts')}</>
    case 'contacts:read:pii':
      return <>{t('scopeContactsPii')}</>
    case 'schedule:read':
      return <>{t('scopeSchedule')}</>
    case 'offerings:read':
      return <>{t('scopeOfferings')}</>
    case 'subscriptions:read':
      return <>{t('scopeSubscriptions')}</>
    case 'reports:read':
      return <>{t('scopeReports')}</>
    case 'finance:read':
      return <>{t('scopeFinance')}</>
  }
}

function ScopeHint({ scope }: { scope: ApiScope }) {
  const t = useTranslations('ApiKeys')
  switch (scope) {
    case 'contacts:read':
      return <>{t('scopeContactsHint')}</>
    case 'contacts:read:pii':
      return <>{t('scopeContactsPiiHint')}</>
    case 'schedule:read':
      return <>{t('scopeScheduleHint')}</>
    case 'offerings:read':
      return <>{t('scopeOfferingsHint')}</>
    case 'subscriptions:read':
      return <>{t('scopeSubscriptionsHint')}</>
    case 'reports:read':
      return <>{t('scopeReportsHint')}</>
    case 'finance:read':
      return <>{t('scopeFinanceHint')}</>
  }
}

function ConnectCard() {
  const t = useTranslations('ApiKeys')
  return (
    <div className="space-y-2 rounded-xl border border-dashed bg-muted/30 p-4">
      <h2 className="text-sm font-semibold">{t('connectTitle')}</h2>
      <p className="text-xs text-muted-foreground">{t('connectBody')}</p>
      <p className="text-xs text-muted-foreground">
        {t('endpointLabel')} <code className="rounded bg-muted px-1 py-0.5 font-mono">{API_BASE_URL}</code>
      </p>
      <p className="text-xs text-muted-foreground">
        {t('referenceLabel')}{' '}
        <a
          href={`${API_BASE_URL}/v1/openapi.json`}
          target="_blank"
          rel="noreferrer"
          className="font-mono underline underline-offset-2"
        >
          {`${API_BASE_URL}/v1/openapi.json`}
        </a>
      </p>
      <p className="text-xs text-muted-foreground">{t('connectWebSoon')}</p>
    </div>
  )
}

function CreateKeyDialog({
  open,
  teamId,
  onClose,
  onCreated,
}: {
  open: boolean
  teamId: string | null
  onClose: () => void
  onCreated: (result: CreateResult) => void
}) {
  const t = useTranslations('ApiKeys')
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<ApiScope>>(() => new Set(DEFAULT_API_SCOPES))
  const [expiry, setExpiry] = useState<ExpiryChoice>('never')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Every opening starts from the defaults: a half-filled form from last time
  // is how a key gets a scope nobody meant to give it.
  useEffect(() => {
    if (!open) return
    setName('')
    setScopes(new Set(DEFAULT_API_SCOPES))
    setExpiry('never')
    setError(null)
  }, [open])

  function toggle(scope: ApiScope, on: boolean) {
    setScopes((prev) => {
      const next = new Set(prev)
      if (on) next.add(scope)
      else {
        next.delete(scope)
        // A scope that depends on this one goes with it (`requires` in the shared table).
        for (const s of API_SCOPES) if (API_SCOPE_REQUIREMENTS[s].requires?.includes(scope)) next.delete(s)
      }
      return next
    })
  }

  const expiryLabel = (choice: ExpiryChoice) =>
    choice === 'never' ? t('expiryNever') : t('expiryDays', { days: Number(choice) })

  const canSubmit = !!teamId && name.trim().length > 0 && scopes.size > 0 && !submitting

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || !teamId) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await httpsCallable<
        { teamId: string; name: string; scopes: ApiScope[]; expiresInDays: number | null },
        CreateResult
      >(functions, 'createApiKey')({
        teamId,
        name: name.trim(),
        scopes: API_SCOPES.filter((s) => scopes.has(s)),
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      })
      onCreated(res.data)
    } catch (err) {
      console.error('[api keys] create failed:', err)
      const reason = reasonOf(err)
      setError(
        reason === 'api_key_limit'
          ? t('limitNote', { max: MAX_ACTIVE_API_KEYS })
          : reason === 'plugin_not_installed'
            ? t('notInstalledBody')
            : err instanceof Error
              ? err.message
              : t('errorGeneric')
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t('createTitle')}</DialogTitle>
            <DialogDescription>{t('createDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="api-key-name">{t('nameLabel')}</Label>
              <Input
                id="api-key-name"
                value={name}
                maxLength={API_KEY_NAME_MAX}
                placeholder={t('namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">{t('scopesLabel')}</p>
              <ul className="divide-y rounded-lg border">
                {API_SCOPES.map((scope) => {
                  const blocked = (API_SCOPE_REQUIREMENTS[scope].requires ?? []).some((r) => !scopes.has(r))
                  return (
                    <li key={scope} className="flex items-start justify-between gap-4 p-3">
                      <div className="min-w-0">
                        <p className="text-sm">
                          <ScopeName scope={scope} />
                        </p>
                        <p className="text-xs text-muted-foreground">
                          <ScopeHint scope={scope} />
                        </p>
                      </div>
                      <Switch
                        checked={scopes.has(scope)}
                        disabled={blocked}
                        onCheckedChange={(on: boolean) => toggle(scope, on)}
                        aria-label={scope}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium">{t('expiryLabel')}</p>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as ExpiryChoice)}>
                <SelectTrigger className="h-9 w-48">
                  <span className="flex flex-1 truncate text-left text-sm">{expiryLabel(expiry)}</span>
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_CHOICES.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {expiryLabel(choice)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              <p>{t('neverShared')}</p>
              <p>{t('actsAsYou')}</p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? t('creating') : t('createSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const t = useTranslations('ApiKeys')
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border bg-muted/40 p-2 font-mono text-xs">
          {value}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={t('copy')}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}

function RevealKeyDialog({ result, onClose }: { result: CreateResult | null; onClose: () => void }) {
  const t = useTranslations('ApiKeys')
  const secret = result?.secret ?? ''
  return (
    <Dialog open={result !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('revealTitle', { name: result?.key.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('revealWarning')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <CopyLine label={t('secretLabel')} value={secret} />
          <CopyLine
            label={t('exampleClaudeCode')}
            value={`claude mcp add --transport http linyup ${API_BASE_URL}/mcp --header "Authorization: Bearer ${secret}"`}
          />
          <CopyLine
            label={t('exampleRest')}
            value={`curl -H "Authorization: Bearer ${secret}" "${API_BASE_URL}/v1/contacts?limit=5"`}
          />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
