'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Globe, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { EVENTS_COLLECTION } from '@linyup/shared'
import type { Event } from '@linyup/shared'

// Events are PRIVATE by default. Publishing is a deliberate act — this toggle
// writes Event.publicVisibility, which gates syncEventPublicProfile; flipping it
// off deletes the public mirror, so the page 404s immediately.

export function EventPublishCard({
  event,
  publicUrl,
  canEdit,
}: {
  event: Event
  /** Where the published event is shown. The caller knows its own public
   *  surface (a studio's slug, or an organization's). Null while unknown. */
  publicUrl?: string | null
  canEdit: boolean
}) {
  const t = useTranslations('EventProgram')
  const qc = useQueryClient()
  const [saving, setSaving] = useState(false)

  const isPublic = event.publicVisibility === 'public'
  const url = publicUrl ?? null

  async function toggle(next: boolean) {
    setSaving(true)
    try {
      await updateDoc(doc(db, EVENTS_COLLECTION, event.id), {
        publicVisibility: next ? 'public' : 'hidden',
      })
      qc.invalidateQueries({ queryKey: ['event', event.id] })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            {isPublic ? (
              <Globe className="h-4 w-4 text-primary" />
            ) : (
              <Lock className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-sm font-medium">{t('publishTitle')}</span>
            <Badge variant={isPublic ? 'default' : 'secondary'}>
              {isPublic ? t('publishPublic') : t('publishHidden')}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{t('publishHint')}</p>
          {isPublic && url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-xs text-primary underline underline-offset-2"
            >
              {t('publicUrl')}
            </a>
          )}
        </div>

        {canEdit && (
          <Switch
            checked={isPublic}
            onCheckedChange={toggle}
            disabled={saving}
            aria-label={isPublic ? t('unpublishAction') : t('publishAction')}
          />
        )}
      </div>
    </div>
  )
}
