'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTabParam } from '@/hooks/useTabParam'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter, Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import {
  ArrowLeft, ArrowUp, ArrowDown, Trash2, Plus, ExternalLink, Download, X,
} from 'lucide-react'
import type { Form, FormField, FormFieldType, FormAccess, FormStatus } from '@linyup/shared'
import {
  useForm, useSubmissionsPage, fetchAllSubmissions, updateForm, deleteForm, setSubmissionStatus, makeField,
} from '@/plugins/custom-forms/hooks'
import { LoadMoreFooter } from '@/components/ui/load-more-footer'
import { getCustomFormsLimits } from '@/plugins/custom-forms/limits'

const FIELD_TYPES: FormFieldType[] = [
  'short_text', 'long_text', 'email', 'phone', 'number',
  'single_choice', 'multiple_choice', 'dropdown', 'checkbox', 'date',
]
const CHOICE_TYPES: FormFieldType[] = ['single_choice', 'multiple_choice', 'dropdown']

// ─── Build tab ────────────────────────────────────────────────────────────────

function FieldEditor({
  fields, onChange,
}: {
  fields: FormField[]
  onChange: (next: FormField[]) => void
}) {
  const t = useTranslations('CustomForms')
  const limits = getCustomFormsLimits()

  const update = (idx: number, patch: Partial<FormField>) => {
    onChange(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)))
  }
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= fields.length) return
    const next = [...fields]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    onChange(next.map((f, i) => ({ ...f, order: i })))
  }
  const remove = (idx: number) => {
    onChange(fields.filter((_, i) => i !== idx).map((f, i) => ({ ...f, order: i })))
  }
  const add = () => {
    if (fields.length >= limits.maxFieldsPerForm) {
      toast.error(t('maxFieldsReached', { max: limits.maxFieldsPerForm }))
      return
    }
    onChange([...fields, makeField('short_text', fields.length)])
  }

  return (
    <div className="space-y-3">
      {fields.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('noFields')}</p>
      )}
      {fields.map((field, idx) => (
        <div key={field.id} className="rounded-lg border p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={field.label}
              onChange={(e) => update(idx, { label: e.target.value })}
              placeholder={t('fieldLabelPlaceholder')}
              className="flex-1"
            />
            <Select value={field.type} onValueChange={(v) => update(idx, { type: v as FormFieldType })}>
              <SelectTrigger className="w-40 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((ft) => (
                  <SelectItem key={ft} value={ft}>{t(`fieldType_${ft}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" onClick={() => move(idx, -1)} disabled={idx === 0}>
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => move(idx, 1)} disabled={idx === fields.length - 1}>
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => remove(idx)}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>

          {CHOICE_TYPES.includes(field.type) && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('options')}</Label>
              <div className="space-y-1.5">
                {(field.options ?? []).map((opt, oi) => (
                  <div key={oi} className="flex items-center gap-2">
                    <Input
                      value={opt}
                      onChange={(e) => {
                        const next = [...(field.options ?? [])]
                        next[oi] = e.target.value
                        update(idx, { options: next })
                      }}
                      placeholder={t('optionPlaceholder', { n: oi + 1 })}
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={() =>
                        update(idx, { options: (field.options ?? []).filter((_, i) => i !== oi) })
                      }
                      aria-label={t('removeOption')}
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => update(idx, { options: [...(field.options ?? []), ''] })}
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  {t('addOption')}
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Switch
              id={`req-${field.id}`}
              checked={!!field.required}
              onCheckedChange={(v) => update(idx, { required: v })}
            />
            <Label htmlFor={`req-${field.id}`} className="text-sm">{t('required')}</Label>
          </div>
        </div>
      ))}
      <Button variant="outline" onClick={add}>
        <Plus className="mr-1.5 h-4 w-4" />
        {t('addField')}
      </Button>
    </div>
  )
}

// ─── Responses tab ────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  const s = Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function exportCsv(form: Form, submissions: { answers: Record<string, unknown>; submitterEmail?: string | null; submitted_at?: { toDate: () => Date } }[]) {
  const header = ['submitted_at', 'email', ...form.fields.map((f) => f.label)]
  const rows = submissions.map((s) => [
    s.submitted_at?.toDate ? s.submitted_at.toDate().toISOString() : '',
    s.submitterEmail ?? '',
    ...form.fields.map((f) => csvEscape(s.answers[f.id])),
  ])
  const csv = [header.map(csvEscape).join(','), ...rows.map((r) => r.join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${form.slug || 'form'}-responses.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function ResponsesTab({ form }: { form: Form }) {
  const t = useTranslations('CustomForms')
  const { rows: submissions, isLoading, hasMore, loadMore, isLoadingMore } = useSubmissionsPage(form.id)
  const queryClient = useQueryClient()
  const [exporting, setExporting] = useState(false)

  // The export reads EVERY response itself — the list is a page, and exporting
  // the page would silently ship the first fifty. One whole read, on the click.
  async function exportAll() {
    setExporting(true)
    try {
      exportCsv(form, await fetchAllSubmissions(form.id))
    } catch {
      toast.error(t('exportFailed'))
    } finally {
      setExporting(false)
    }
  }

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'reviewed' | 'archived' | 'new' }) =>
      setSubmissionStatus(form.id, id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['form-submissions', form.id] }),
  })

  if (isLoading) return <Skeleton className="h-40 w-full" />
  if (submissions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noResponses')}</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={exporting} onClick={() => void exportAll()}>
          <Download className="mr-1.5 h-4 w-4" />
          {t('exportCsv')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('submittedAt')}</TableHead>
              {form.fields.map((f) => (
                <TableHead key={f.id}>{f.label}</TableHead>
              ))}
              <TableHead>{t('status')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {submissions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {s.submitted_at?.toDate ? s.submitted_at.toDate().toLocaleString() : '—'}
                </TableCell>
                {form.fields.map((f) => {
                  const v = s.answers[f.id]
                  return (
                    <TableCell key={f.id} className="max-w-xs truncate">
                      {Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)}
                    </TableCell>
                  )
                })}
                <TableCell>
                  <Badge variant={s.status === 'reviewed' ? 'secondary' : 'outline'}>
                    {t(`subStatus_${s.status ?? 'new'}`)}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {s.status !== 'reviewed' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => statusMutation.mutate({ id: s.id, status: 'reviewed' })}
                    >
                      {t('markReviewed')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <LoadMoreFooter
          shown={submissions.length}
          hasMore={hasMore}
          loading={isLoadingMore}
          onLoadMore={loadMore}
          className="border-t"
        />
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const FORM_TABS = ['build', 'settings', 'responses'] as const

export default function FormDetailPage() {
  const [tab, setTab] = useTabParam(FORM_TABS, 'build')
  const t = useTranslations('CustomForms')
  const params = useParams()
  const formId = String(params.formId)
  const router = useRouter()
  const queryClient = useQueryClient()
  const { team } = useAuth()
  const { data: form, isLoading } = useForm(formId)

  // Local editable copy (Build + Settings).
  const [draft, setDraft] = useState<Form | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // Unpublishing takes the public form off the internet in one click: the link
  // a studio has already shared starts refusing, and any bio-link entry for it
  // stops being offered. It is REVERSIBLE and LOSSLESS — the fields, the
  // settings and every response collected so far are untouched — so it asks
  // once and says so, rather than implying deletion (UX-100).
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)
  useEffect(() => {
    if (form) setDraft(form)
  }, [form])

  const emailFields = useMemo(
    () => (draft?.fields ?? []).filter((f) => f.type === 'email'),
    [draft?.fields],
  )

  const saveMutation = useMutation({
    mutationFn: async (patch: Parameters<typeof updateForm>[1]) => updateForm(formId, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['form', formId] })
      queryClient.invalidateQueries({ queryKey: ['forms', form?.teamId] })
      toast.success(t('saved'))
    },
    onError: () => toast.error(t('saveError')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteForm(formId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms', form?.teamId] })
      router.push('/plugins/custom-forms' as Route)
    },
    onError: () => toast.error(t('deleteError')),
  })

  if (isLoading || !draft) {
    return <Skeleton className="h-96 w-full" />
  }

  const setStatus = (status: FormStatus) => saveMutation.mutate({ status })
  const teamSlug = team?.slug ?? ''
  const publicHref = `/public/${teamSlug}/forms/${draft.slug}`
  const publicUrl =
    typeof window !== 'undefined' && teamSlug ? `${window.location.origin}${publicHref}` : ''

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" onClick={() => router.push('/plugins/custom-forms' as Route)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-semibold truncate">{draft.title}</h1>
          <Badge variant="secondary">{t(`status_${draft.status}`)}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {draft.status === 'published' && teamSlug && (
            <Link
              href={publicHref as Route}
              target="_blank"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              {t('viewPublic')} <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
          {draft.status !== 'published' ? (
            <Button onClick={() => setStatus('published')}>{t('publish')}</Button>
          ) : (
            <Button variant="outline" onClick={() => setConfirmUnpublish(true)}>{t('unpublish')}</Button>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof FORM_TABS)[number])}>
        <TabsList>
          <TabsTrigger value="build">{t('tabBuild')}</TabsTrigger>
          <TabsTrigger value="settings">{t('tabSettings')}</TabsTrigger>
          <TabsTrigger value="responses">{t('tabResponses')}</TabsTrigger>
        </TabsList>

        {/* Build */}
        <TabsContent value="build" className="mt-4 space-y-4">
          <FieldEditor
            fields={draft.fields}
            onChange={(fields) => setDraft({ ...draft, fields })}
          />
          <Button
            onClick={() =>
              saveMutation.mutate({
                // Drop blank option rows (allowed while editing) before persisting.
                fields: draft.fields.map((f) =>
                  f.options
                    ? { ...f, options: f.options.map((o) => o.trim()).filter(Boolean) }
                    : f
                ),
              })
            }
            disabled={saveMutation.isPending}
          >
            {t('saveFields')}
          </Button>
        </TabsContent>

        {/* Settings */}
        <TabsContent value="settings" className="mt-4 space-y-5 max-w-xl">
          <div className="space-y-2">
            <Label htmlFor="title">{t('formTitle')}</Label>
            <Input
              id="title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="desc">{t('description')}</Label>
            <Textarea
              id="desc"
              value={draft.description ?? ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('access')}</Label>
            <Select
              value={draft.access}
              onValueChange={(v) => setDraft({ ...draft, access: v as FormAccess })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="public">{t('accessPublic')}</SelectItem>
                <SelectItem value="contacts">{t('accessContacts')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {draft.access === 'contacts' ? t('accessContactsHint') : t('accessPublicHint')}
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="createContact">{t('createContact')}</Label>
              <p className="text-xs text-muted-foreground">{t('createContactHint')}</p>
            </div>
            <Switch
              id="createContact"
              checked={draft.createContact !== false}
              onCheckedChange={(v) => setDraft({ ...draft, createContact: v })}
            />
          </div>

          {emailFields.length > 0 && (
            <div className="space-y-2">
              <Label>{t('emailField')}</Label>
              <Select
                value={draft.emailFieldId ?? ''}
                onValueChange={(v) => setDraft({ ...draft, emailFieldId: v || null })}
              >
                <SelectTrigger><SelectValue placeholder={t('emailFieldNone')} /></SelectTrigger>
                <SelectContent>
                  {emailFields.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.label || t('untitledField')}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('emailFieldHint')}</p>
            </div>
          )}

          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm font-medium">{t('notifications')}</p>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="notifyStaff" className="text-sm font-normal">{t('notifyStaff')}</Label>
              <Switch
                id="notifyStaff"
                checked={draft.notifications?.notifyStaff !== false}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, notifications: { ...draft.notifications, notifyStaff: v } })
                }
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="confirmSubmitter" className="text-sm font-normal">{t('confirmSubmitter')}</Label>
              <Switch
                id="confirmSubmitter"
                checked={!!draft.notifications?.confirmSubmitter}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, notifications: { ...draft.notifications, confirmSubmitter: v } })
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmMsg">{t('confirmationMessage')}</Label>
            <Textarea
              id="confirmMsg"
              value={draft.confirmation?.message ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, confirmation: { ...draft.confirmation, message: e.target.value } })
              }
              placeholder={t('confirmationMessagePlaceholder')}
              rows={2}
            />
          </div>

          <div className="flex items-center gap-2 pt-2">
            <Button
              onClick={() =>
                saveMutation.mutate({
                  title: draft.title,
                  description: draft.description,
                  access: draft.access,
                  createContact: draft.createContact,
                  emailFieldId: draft.emailFieldId,
                  notifications: draft.notifications,
                  confirmation: draft.confirmation,
                })
              }
              disabled={saveMutation.isPending}
            >
              {t('saveSettings')}
            </Button>
            <Button variant="ghost" className="text-destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="mr-1.5 h-4 w-4" />
              {t('delete')}
            </Button>
          </div>

          {publicUrl && (
            <p className="text-xs text-muted-foreground break-all">{t('publicUrl')}: {publicUrl}</p>
          )}
        </TabsContent>

        {/* Responses */}
        <TabsContent value="responses" className="mt-4">
          <ResponsesTab form={draft} />
        </TabsContent>
      </Tabs>

      {/* Not styled destructive: this deletes no work. An overstated warning
          trains people to click through the next one. */}
      <AlertDialog open={confirmUnpublish} onOpenChange={setConfirmUnpublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('unpublishConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('unpublishConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmUnpublish(false)
                setStatus('draft')
              }}
            >
              {t('unpublishConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
