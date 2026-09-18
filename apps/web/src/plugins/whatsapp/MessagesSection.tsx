'use client'

// WhatsApp plugin — "Messages": the studio's OWN templates, written in Linyup
// and submitted to Meta (docs/whatsapp-outbound.md → "6b"). Deliberately
// separate from ConfigPanel's connection card: this only reads/writes
// `teams/{t}/whatsapp_templates`, which any team member can READ and only
// `outreach.manage` can WRITE (the callables enforce that) — so a manager can
// author messages even though connecting the number is owner-only. The caller
// hides this whole section when the plugin isn't installed.

import { useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2, Clock, Pencil, PauseCircle, Plus, Trash2, XCircle } from 'lucide-react'
import {
  WHATSAPP_TEMPLATE_BODY_MAX,
  WHATSAPP_TEMPLATE_LABEL_MAX,
  WHATSAPP_TEMPLATE_TOKENS,
  validateWhatsAppTemplateBody,
  type WhatsAppStudioTemplate,
  type WhatsAppTemplateCategory,
  type WhatsAppTemplateProblem,
  type WhatsAppTemplateToken,
} from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  useDeleteWhatsAppTemplate,
  useSubmitWhatsAppTemplate,
  useWhatsAppStudioTemplates,
  type SubmitWhatsAppTemplateRefusalReason,
} from './hooks'

const TOKEN_KEYS = Object.keys(WHATSAPP_TEMPLATE_TOKENS) as WhatsAppTemplateToken[]

function substituteWhatsAppSample(body: string): string {
  return (body || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, raw: string) => {
    const def = WHATSAPP_TEMPLATE_TOKENS[raw as WhatsAppTemplateToken]
    return def ? def.example : whole
  })
}

function problemMessage(t: ReturnType<typeof useTranslations>, problem: WhatsAppTemplateProblem, unknown: string[]): string {
  if (problem === 'unknown_token') return t('whatsappProblemUnknownToken', { tokens: unknown.join(', ') })
  return t(`whatsappProblem_${problem}` as Parameters<typeof t>[0])
}

// ─── List ───────────────────────────────────────────────────────────────────

export function WhatsAppMessagesSection({ teamId }: { teamId: string }) {
  const t = useTranslations('Plugins')
  const { confirm, confirmDialog } = useConfirm()
  const templatesQ = useWhatsAppStudioTemplates(teamId)
  const deleteMutation = useDeleteWhatsAppTemplate(teamId)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<WhatsAppStudioTemplate | null>(null)

  const templates = templatesQ.data ?? []

  function openNew() {
    setEditing(null)
    setEditorOpen(true)
  }
  function openEdit(tmpl: WhatsAppStudioTemplate) {
    setEditing(tmpl)
    setEditorOpen(true)
  }
  async function onDelete(tmpl: WhatsAppStudioTemplate) {
    const ok = await confirm({
      title: t('whatsappDeleteMessageTitle'),
      description: t('whatsappDeleteMessageDesc'),
      confirmLabel: t('whatsappDeleteMessageAction'),
    })
    if (!ok) return
    deleteMutation.mutate({ teamId, templateId: tmpl.id })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('whatsappMessagesTitle')}
        </p>
        <Button size="sm" variant="outline" onClick={openNew}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t('whatsappNewMessage')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-1">{t('whatsappMessagesIntro')}</p>

      {templatesQ.isLoading ? (
        <p className="text-xs text-muted-foreground">{t('loading')}</p>
      ) : templates.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('whatsappNoMessages')}</p>
      ) : (
        <ul className="space-y-1.5">
          {templates.map((tmpl) => (
            <TemplateRow key={tmpl.id} template={tmpl} onEdit={() => openEdit(tmpl)} onDelete={() => onDelete(tmpl)} />
          ))}
        </ul>
      )}

      <WhatsAppTemplateEditorDialog open={editorOpen} onOpenChange={setEditorOpen} teamId={teamId} editing={editing} />
      {confirmDialog}
    </div>
  )
}

function TemplateRow({
  template,
  onEdit,
  onDelete,
}: {
  template: WhatsAppStudioTemplate
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useTranslations('Plugins')
  const category = template.live?.category ?? template.next?.category
  const recategorized =
    (template.live?.recategorized_at && template.live.category === 'MARKETING') ||
    (template.next?.recategorized_at && template.next.category === 'MARKETING')

  return (
    <li className="rounded-md border p-2.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{template.label}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {category === 'MARKETING' ? t('whatsappCategoryMarketingShort') : t('whatsappCategoryUtilityShort')}
            </span>
            <TemplateStateBadges template={template} />
          </div>
          {recategorized && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t('whatsappRecategorizedNote')}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </li>
  )
}

function TemplateStateBadges({ template }: { template: WhatsAppStudioTemplate }) {
  const t = useTranslations('Plugins')
  const badges: { label: string; icon: React.ElementType; className: string; title?: string }[] = []

  if (template.live) {
    if (template.live.status === 'APPROVED') {
      badges.push({ label: t('whatsappStateSending'), icon: CheckCircle2, className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' })
    } else if (template.live.status === 'PAUSED' || template.live.status === 'DISABLED') {
      badges.push({ label: t('whatsappStatePaused'), icon: PauseCircle, className: '' })
    } else if (template.live.status === 'REJECTED') {
      badges.push({
        label: t('whatsappStateRejected'),
        icon: XCircle,
        className: 'bg-destructive/10 text-destructive',
        title: template.live.reason ?? undefined,
      })
    }
  }
  if (template.next) {
    if (template.next.status === 'REJECTED') {
      badges.push({
        label: t('whatsappStateEditRejected'),
        icon: XCircle,
        className: 'bg-destructive/10 text-destructive',
        title: template.next.reason ?? undefined,
      })
    } else {
      badges.push({ label: t('whatsappStateInReview'), icon: Clock, className: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200' })
    }
  }
  if (!template.live && !template.next) {
    badges.push({ label: t('whatsappStateNotSubmitted'), icon: Clock, className: '' })
  }

  return (
    <>
      {badges.map((b, i) => (
        <Badge key={i} variant="secondary" className={`text-xs ${b.className}`} title={b.title}>
          <b.icon className="h-3 w-3 mr-1" />
          {b.label}
        </Badge>
      ))}
    </>
  )
}

// ─── Editor ─────────────────────────────────────────────────────────────────

function WhatsAppTemplateEditorDialog({
  open,
  onOpenChange,
  teamId,
  editing,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  editing: WhatsAppStudioTemplate | null
}) {
  const t = useTranslations('Plugins')
  const submitMutation = useSubmitWhatsAppTemplate(teamId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const currentSubmission = editing?.next ?? editing?.live
  const [label, setLabel] = useState(editing?.label ?? '')
  const [category, setCategory] = useState<WhatsAppTemplateCategory>(currentSubmission?.category ?? 'UTILITY')
  const [body, setBody] = useState(currentSubmission?.body ?? '')
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Reset the form to match whichever template was opened, or a blank one for
  // "New message" — keyed on `open` so re-opening the same dialog on a
  // different row always starts from that row's own values.
  const resetKey = open ? (editing?.id ?? '__new') : null
  const [lastResetKey, setLastResetKey] = useState<string | null>(null)
  if (resetKey !== null && resetKey !== lastResetKey) {
    setLastResetKey(resetKey)
    setLabel(editing?.label ?? '')
    setCategory(currentSubmission?.category ?? 'UTILITY')
    setBody(currentSubmission?.body ?? '')
    setSubmitError(null)
  }

  const validation = useMemo(() => validateWhatsAppTemplateBody(body), [body])
  const isEditingApprovedLive = !!editing?.live && editing.live.status === 'APPROVED'

  function insertToken(token: WhatsAppTemplateToken) {
    const el = textareaRef.current
    const insertion = `{{${token}}}`
    if (!el) {
      setBody((b) => `${b}${insertion}`)
      return
    }
    const start = el.selectionStart ?? body.length
    const end = el.selectionEnd ?? body.length
    const next = body.slice(0, start) + insertion + body.slice(end)
    setBody(next)
    // Put the caret after the inserted token on the next tick.
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + insertion.length
      el.setSelectionRange(pos, pos)
    })
  }

  async function onSave() {
    setSubmitError(null)
    const cleanLabel = label.trim()
    if (!cleanLabel || cleanLabel.length > WHATSAPP_TEMPLATE_LABEL_MAX) {
      setSubmitError(t('whatsappErrorLabel'))
      return
    }
    if (validation.problems.length) {
      setSubmitError(problemMessage(t, validation.problems[0], validation.unknown))
      return
    }
    try {
      await submitMutation.mutateAsync({
        teamId,
        ...(editing ? { templateId: editing.id } : {}),
        label: cleanLabel,
        category,
        body: body.trim(),
      })
      onOpenChange(false)
    } catch (err) {
      const reason = (err as { details?: { reason?: SubmitWhatsAppTemplateRefusalReason; problems?: WhatsAppTemplateProblem[]; unknown?: string[] } })
        ?.details?.reason
      const details = (err as { details?: { problems?: WhatsAppTemplateProblem[]; unknown?: string[] } })?.details
      if (reason === 'label') setSubmitError(t('whatsappErrorLabel'))
      else if (reason === 'body' && details?.problems?.length)
        setSubmitError(problemMessage(t, details.problems[0], details.unknown ?? []))
      else if (reason === 'not_connected') setSubmitError(t('whatsappErrorNotConnectedForMessage'))
      else setSubmitError((err as Error)?.message || t('whatsappMessageErrorGeneric'))
    }
  }

  const previewBody = substituteWhatsAppSample(body)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[88dvh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 shrink-0 border-b">
          <DialogTitle>{editing ? editing.label : t('whatsappNewMessage')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          {/* Left: form */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
            <div>
              <Label className="text-xs">{t('whatsappMessageNameLabel')}</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={WHATSAPP_TEMPLATE_LABEL_MAX}
                placeholder={t('whatsappMessageNamePlaceholder')}
                className="mt-1"
              />
            </div>

            <div>
              <Label className="text-xs">{t('whatsappCategoryQuestion')}</Label>
              <RadioGroup value={category} onValueChange={(v) => setCategory(v as WhatsAppTemplateCategory)} className="mt-1.5">
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="UTILITY" id="wa-cat-utility" className="mt-0.5" />
                  <Label htmlFor="wa-cat-utility" className="font-normal text-sm">
                    {t('whatsappCategoryUtilityOption')}
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="MARKETING" id="wa-cat-marketing" className="mt-0.5" />
                  <Label htmlFor="wa-cat-marketing" className="font-normal text-sm">
                    {t('whatsappCategoryMarketingOption')}
                  </Label>
                </div>
              </RadioGroup>
              <p className="mt-1 text-xs text-muted-foreground">{t('whatsappCategoryMetaNote')}</p>
            </div>

            <div>
              <Label className="text-xs">{t('whatsappMessageBodyLabel')}</Label>
              <Textarea
                ref={textareaRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                maxLength={WHATSAPP_TEMPLATE_BODY_MAX + 200}
                placeholder={t('whatsappMessageBodyPlaceholder')}
                className="mt-1 text-sm"
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {TOKEN_KEYS.map((token) => (
                  <button
                    key={token}
                    type="button"
                    onClick={() => insertToken(token)}
                    className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  >
                    {t(`whatsappTokenLabel_${token}` as Parameters<typeof t>[0])}
                  </button>
                ))}
              </div>
              {validation.problems.length > 0 && body.trim() !== '' && (
                <p className="mt-1.5 text-xs text-destructive">
                  {problemMessage(t, validation.problems[0], validation.unknown)}
                </p>
              )}
            </div>

            {isEditingApprovedLive && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                {t('whatsappEditKeepsSendingNote')}
              </p>
            )}

            {submitError && <p className="text-xs text-destructive">{submitError}</p>}
          </div>

          {/* Right: chat-style preview */}
          <div className="w-[320px] shrink-0 border-l flex flex-col min-h-0 bg-muted/30">
            <div className="px-3 pt-3 pb-1 shrink-0">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('whatsappPreviewTitle')}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              <div className="rounded-lg rounded-tl-none bg-[#e7ffdb] dark:bg-emerald-900/40 px-3 py-2 text-sm text-foreground shadow-sm whitespace-pre-wrap break-words">
                {previewBody || <span className="text-muted-foreground">{t('whatsappPreviewEmpty')}</span>}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button type="button" onClick={onSave} disabled={submitMutation.isPending}>
            {submitMutation.isPending ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
