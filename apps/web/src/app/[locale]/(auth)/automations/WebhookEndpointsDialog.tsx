'use client'

// Manages inbound webhook endpoints for a team.
// Each endpoint has a unique secret URL; external systems POST to it to trigger
// automation rules with trigger.type === 'inbound_webhook'.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, orderBy, query, serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {  TEAMS_COLLECTION, WEBHOOK_ENDPOINTS_SUBCOLLECTION } from '@linyup/shared'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Plus, Trash2, Copy, Check, Webhook, ExternalLink } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookEndpoint {
  id: string
  name: string
  secret_key: string
  active: boolean
  last_triggered_at?: { toDate(): Date } | null
  trigger_count?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the base URL for the inboundWebhook Cloud Function.
 * In emulator mode: http://127.0.0.1:5001/{projectId}/europe-west6/inboundWebhook
 * In production: value of NEXT_PUBLIC_INBOUND_WEBHOOK_URL env var.
 */
export function getWebhookBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_USE_EMULATORS === 'true') {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'demo-linyup'
    return `http://127.0.0.1:5001/${projectId}/europe-west6/inboundWebhook`
  }
  return process.env.NEXT_PUBLIC_INBOUND_WEBHOOK_URL ?? ''
}

export function getWebhookUrl(secretKey: string): string {
  return `${getWebhookBaseUrl()}/${secretKey}`
}

// ---------------------------------------------------------------------------
// CopyButton — small inline copy-to-clipboard button
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      title="Copy URL"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// WebhookEndpointsDialog
// ---------------------------------------------------------------------------

export function WebhookEndpointsDialog({
  open, onOpenChange, teamId,
}: { open: boolean; onOpenChange: (v: boolean) => void; teamId: string }) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const endpointsRef = () => collection(db, TEAMS_COLLECTION, teamId, WEBHOOK_ENDPOINTS_SUBCOLLECTION)

  const { data: endpoints = [], isLoading } = useQuery<WebhookEndpoint[]>({
    queryKey: ['webhook_endpoints', teamId],
    enabled: open && !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(endpointsRef(), orderBy('name', 'asc'))
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as WebhookEndpoint)
    },
  })

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['webhook_endpoints', teamId] })
  }

  async function handleCreate() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      await addDoc(endpointsRef(), {
        name: newName.trim(),
        secret_key: crypto.randomUUID(),
        active: true,
        trigger_count: 0,
        last_triggered_at: null,
        created_at: serverTimestamp(),
      })
      setNewName('')
      invalidate()
    } finally {
      setCreating(false)
    }
  }

  async function handleToggle(ep: WebhookEndpoint) {
    await updateDoc(doc(endpointsRef(), ep.id), { active: !ep.active })
    invalidate()
  }

  async function handleDelete(ep: WebhookEndpoint) {
    await deleteDoc(doc(endpointsRef(), ep.id))
    invalidate()
  }

  const baseUrl = getWebhookBaseUrl()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Webhook className="h-4 w-4" />
            Inbound Webhooks
          </DialogTitle>
        </DialogHeader>

        {/* No footer here — the body scrolls so the title and close button stay put. */}
        <DialogBody className="flex flex-col gap-6">
        <p className="text-xs text-muted-foreground">
          Each endpoint has a unique secret URL. POST JSON with an{' '}
          <code className="bg-muted px-1 rounded text-[11px]">email</code> field to trigger
          automation rules linked to that endpoint.
        </p>

        {!baseUrl && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-700 dark:text-amber-400">
            Inbound webhooks aren&apos;t available in this environment yet. You can still
            create endpoints — their full URLs will appear here once webhooks are enabled.
          </div>
        )}

        {/* Existing endpoints */}
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-16 rounded-lg border bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No endpoints yet — create one below.
          </p>
        ) : (
          <div className="space-y-2">
            {endpoints.map((ep) => {
              const url = getWebhookUrl(ep.secret_key)
              return (
                <div key={ep.id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Switch
                        checked={ep.active}
                        onCheckedChange={() => handleToggle(ep)}
                        className="shrink-0"
                      />
                      <span className="font-medium text-sm truncate">{ep.name}</span>
                      {!ep.active && (
                        <Badge variant="secondary" className="text-xs shrink-0">Paused</Badge>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(ep)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  {baseUrl ? (
                    <div className="flex items-center gap-2 min-w-0">
                      {/* min-w-0 is required for truncate to engage: a flex item
                          defaults to min-width:auto and won't shrink below its
                          content, so a long Cloud Functions URL would otherwise
                          force the whole dialog to overflow horizontally. */}
                      <code className="min-w-0 flex-1 text-[10px] bg-muted rounded px-2 py-1 truncate font-mono">
                        POST {url}
                      </code>
                      <CopyButton text={url} />
                    </div>
                  ) : (
                    <code className="text-[10px] text-muted-foreground font-mono">
                      …/{ep.secret_key}
                    </code>
                  )}

                  {ep.trigger_count != null && ep.trigger_count > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      Triggered {ep.trigger_count}×
                      {ep.last_triggered_at && ` · last ${ep.last_triggered_at.toDate().toLocaleDateString()}`}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <Separator />

        {/* Create new endpoint */}
        <div className="space-y-2">
          <Label className="text-xs font-medium">New endpoint</Label>
          <div className="flex gap-2">
            <Input
              className="h-8 text-xs"
              placeholder="Name (e.g. Typeform signup, Calendly booking)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate() } }}
            />
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0"
              disabled={!newName.trim() || creating}
              onClick={handleCreate}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {creating ? 'Creating…' : 'Add'}
            </Button>
          </div>
        </div>

        {/* Docs hint */}
        <div className="text-[11px] text-muted-foreground space-y-1 pt-1">
          <p className="font-medium">Payload format</p>
          <pre className="bg-muted rounded p-2 text-[10px] font-mono overflow-x-auto">{`POST {url}
Content-Type: application/json

{ "email": "jane@example.com", "firstname": "Jane" }`}</pre>
          <p>
            The contact is looked up by email. If found, any active automation rule with{' '}
            <em>Inbound webhook</em> trigger linked to this endpoint will fire.
          </p>
        </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
