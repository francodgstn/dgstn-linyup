'use client'

// Settings → Email templates — split out of Settings → Emails (2026-08-27).
// This page is the AUTHORING half: the predefined + custom outreach templates
// used by automations and campaigns, and the reusable placeholder reference
// (in the editor's side panel) a studio inserts into them. The rest of what
// used to be one page — sender identity, system-email toggles, booking
// instructions, SMS sender — is CONFIGURATION and stayed at /settings/emails;
// see that page for why the split happened.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { collection, doc, getDocs, orderBy, query, updateDoc } from 'firebase/firestore'
import { FileText, Pencil, Copy, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import {  TEAMS_COLLECTION, OUTREACH_TEMPLATES_SUBCOLLECTION } from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { TemplateEditor, type OutreachTemplate } from './TemplateEditor'
import { templateDefault } from './templateDefaults'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Tip } from '@/components/ui/tip'
import { CustomVariablesCard } from './CustomVariablesCard'

export default function SettingsEmailTemplatesPage() {
  // Styled confirmation, replacing a browser `confirm()` (see confirm-dialog).
  const { confirm, confirmDialog } = useConfirm()
  const t = useTranslations('SettingsEmails')
  const ta = useTranslations('Automations')
  const tCommon = useTranslations('Common')
  const { currentTeamId, team } = useAuth()
  const qc = useQueryClient()

  const { data: templates = [], isLoading } = useQuery<OutreachTemplate[]>({
    queryKey: ['outreach_templates_all', currentTeamId],
    enabled: !!currentTeamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, TEAMS_COLLECTION, currentTeamId!, OUTREACH_TEMPLATES_SUBCOLLECTION),
          orderBy('name', 'asc')
        )
      )
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as OutreachTemplate)
    },
  })

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<OutreachTemplate | null>(null)
  const [duplicating, setDuplicating] = useState<OutreachTemplate | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['outreach_templates_all', currentTeamId] })
    qc.invalidateQueries({ queryKey: ['outreach_templates', currentTeamId] })
  }

  const { system, custom } = useMemo(() => {
    const system = templates.filter((tm) => !!tm.system_key)
    const custom = templates.filter((tm) => !tm.system_key)
    return { system, custom }
  }, [templates])

  const openEditor = (tmpl: OutreachTemplate | null) => {
    setDuplicating(null)
    setEditing(tmpl)
    setEditorOpen(true)
  }

  // A stock template is the natural thing to copy: keep the wording, change the
  // one paragraph, own the result. The copy is a plain custom template.
  const openDuplicate = (tmpl: OutreachTemplate) => {
    setEditing(null)
    setDuplicating(tmpl)
    setEditorOpen(true)
  }

  const onReset = async (tmpl: OutreachTemplate) => {
    if (!currentTeamId) return
    const def = templateDefault(tmpl.system_key, tmpl.language)
    if (!def) return
    const okReset = await confirm({
      title: t('resetConfirmTitle'),
      description: t('resetConfirm', { name: tmpl.name }),
      confirmLabel: tCommon('reset'),
    })
    if (!okReset) return
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId, OUTREACH_TEMPLATES_SUBCOLLECTION, tmpl.id), {
      name: def.name,
      subject: def.subject,
      body: def.body,
      active: true,
    })
    invalidate()
  }

  const onDeactivate = async (tmpl: OutreachTemplate) => {
    if (!currentTeamId) return
    const okDeactivate = await confirm({
      title: t('deactivateConfirmTitle'),
      description: t('deactivateConfirm', { name: tmpl.name }),
      confirmLabel: t('deactivateAction'),
    })
    if (!okDeactivate) return
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId, OUTREACH_TEMPLATES_SUBCOLLECTION, tmpl.id), {
      active: false,
    })
    invalidate()
  }

  const renderRow = (tmpl: OutreachTemplate) => {
    const def = templateDefault(tmpl.system_key, tmpl.language)
    const modified = def && (def.subject !== tmpl.subject || def.body !== tmpl.body)
    return (
      <div key={tmpl.id} className="flex items-start justify-between gap-2 border rounded-lg p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-sm truncate">{tmpl.name}</p>
            <Badge variant="outline" className="text-[10px] uppercase">
              {tmpl.language}
            </Badge>
            {modified && (
              <Badge variant="secondary" className="text-xs">
                {t('modified')}
              </Badge>
            )}
            {!tmpl.active && (
              <Badge variant="secondary" className="text-xs">
                {ta('common.inactive')}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{tmpl.subject}</p>
        </div>
        <div className="flex gap-1 shrink-0">
          <Tip label={ta('dialogs.templates.saveChanges')}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={ta('dialogs.templates.saveChanges')}
              onClick={() => openEditor(tmpl)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </Tip>
          <Tip label={tCommon('duplicate')}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={tCommon('duplicate')}
              onClick={() => openDuplicate(tmpl)}
            >
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </Tip>
          {def && (
            <Tip label={t('reset')}>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t('reset')}
                disabled={!modified}
                onClick={() => onReset(tmpl)}
              >
                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </Tip>
          )}
          {!tmpl.system_key && (
            <Tip label={t('deactivate')}>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t('deactivate')}
                onClick={() => onDeactivate(tmpl)}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </Tip>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-6 w-6" />
            {ta('dialogs.templates.title')}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t('templatesSubtitle')}</p>
        </div>
        <Button size="sm" onClick={() => openEditor(null)} className="shrink-0">
          <Plus className="h-4 w-4 mr-1.5" />
          {ta('dialogs.templates.newTemplate')}
        </Button>
      </div>

      {/* The studio's own {{variables}} come FIRST — they are what a template
          can be written with, so they read as the vocabulary above the list of
          things written in it. */}
      {currentTeamId && team && <CustomVariablesCard teamId={currentTeamId} team={team} />}

      <Card>
        <CardContent className="pt-6 space-y-5">
          {isLoading && <Skeleton className="h-20 w-full" />}

          {!isLoading && templates.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {ta('dialogs.templates.empty')}
            </p>
          )}

          {system.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('groupSystem')}
              </p>
              <p className="text-xs text-muted-foreground -mt-1">{t('groupSystemHint')}</p>
              {system.map(renderRow)}
            </div>
          )}

          {custom.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {t('groupCustom')}
              </p>
              {custom.map(renderRow)}
            </div>
          )}
        </CardContent>
      </Card>

      {currentTeamId && (
        <TemplateEditor
          key={editing?.id ?? (duplicating ? `copy-${duplicating.id}` : 'new')}
          open={editorOpen}
          onOpenChange={(v) => {
            setEditorOpen(v)
            if (!v) setDuplicating(null)
          }}
          teamId={currentTeamId}
          editing={editing}
          duplicating={duplicating}
          onSaved={invalidate}
        />
      )}
      {confirmDialog}
    </div>
  )
}
