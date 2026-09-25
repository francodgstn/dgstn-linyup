'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { storage } from '@/lib/firebase'
import { Link, useRouter } from '@/i18n/navigation'
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { RichTextEditor } from '@/components/RichTextEditor'
import { toast } from 'sonner'
import { ChevronLeft, Trash2, Archive, QrCode, FileText, Link2, Upload } from 'lucide-react'
import type { PublishOutcome, StudioDocument, DocumentKind, DocumentSource } from '@linyup/shared'
import {
  useDocument, useDocuments, updateDocument, deleteDocument, setDocumentStatus, publishDocument,
  updateWaiverContent, archiveWaiver, waiverCallableError,
} from '@/plugins/documents/hooks'
import { getDocumentsLimits } from '@/plugins/documents/limits'
import { DocumentShareDialog } from '@/plugins/documents/DocumentShareDialog'
import { PublishDialog } from '@/plugins/documents/PublishDialog'
import { VersionHistory } from '@/plugins/documents/VersionHistory'
import { WaiverSettings } from '@/plugins/documents/WaiverSettings'
import { WaiverSigners } from '@/plugins/documents/WaiverSigners'

// A waiver's KIND cannot be changed away from `waiver` (or an ordinary document
// changed into one): the rules deny a client write on the kind in either
// direction, and the callable that owns waivers does not take a kind at all. So
// the kind control is read-only on a waiver rather than a live select that would
// always fail.
const KIND_OPTIONS: DocumentKind[] = ['terms', 'privacy', 'regulation', 'other']

async function uploadFile(file: File, path: string): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const sRef = storageRef(storage, `${path}.${ext}`)
  await uploadBytes(sRef, file)
  return getDownloadURL(sRef)
}

// Rejects javascript:/data: and other dangerous protocols — same guard as the
// bio-link editor's custom-link URL schema.
function isSafeHttpUrl(value: string): boolean {
  return /^https?:\/\/.+/.test(value.trim())
}

export default function DocumentDetailPage() {
  const t = useTranslations('Documents')
  const params = useParams()
  const documentId = String(params.documentId)
  const router = useRouter()
  const queryClient = useQueryClient()
  const { team, currentTeamId } = useAuth()
  const { data: document, isLoading } = useDocument(documentId)
  const { data: allDocuments } = useDocuments(currentTeamId)
  const limits = getDocumentsLimits()

  const tWaivers = useTranslations('Waivers')
  const [draft, setDraft] = useState<StudioDocument | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  // Taking a document off its public page is REVERSIBLE and LOSSLESS — the
  // stored draft, every published version and every signature against them
  // survive — but it is still "take it off the internet in one click", and it
  // also flips `active_public_surfaces.documents`, which is what removes the
  // bio-link entry (UX-49's mechanism, from the writing side). So it asks, and
  // the copy names both halves rather than implying destruction (UX-100).
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)

  useEffect(() => {
    if (document) setDraft(document)
  }, [document])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['document', documentId] })
    queryClient.invalidateQueries({ queryKey: ['documents', document?.teamId] })
  }

  // A WAIVER IS CLIENT-UNWRITABLE. `firestore.rules` denies a client create,
  // update and delete on `kind: 'waiver'`, so the editor's ordinary direct write
  // would fail with a permission error — and without a callable behind the
  // button a studio could mint "Liability release", type the text, hit Save and
  // never be able to author a v1. Every other kind keeps the direct write.
  const isWaiver = document?.kind === 'waiver'
  const saveMutation = useMutation({
    mutationFn: async (patch: Parameters<typeof updateDocument>[1]) =>
      isWaiver
        ? updateWaiverContent(documentId, {
            title: patch.title,
            summary: patch.summary,
            body: patch.body,
            source: patch.source,
            externalUrl: patch.externalUrl,
          })
        : updateDocument(documentId, patch),
    onSuccess: () => {
      invalidate()
      toast.success(t('saved'))
    },
    // The callable's refusals are named — the plan gate above all, because a
    // downgraded studio editing a waiver's TEXT is refused while its settings
    // stay editable, and "could not save" would make that read as a bug.
    onError: (err) => toast.error(isWaiver ? waiverCallableError(err, tWaivers) : t('saveError')),
  })

  const statusMutation = useMutation({
    mutationFn: async (status: 'draft' | 'archived') =>
      // Archiving a waiver clears its `required` flag and REMOVES its policy
      // entry in the same transaction, so the gate never points at a retired
      // document. A plain status write could not do that, and the rules deny it
      // anyway.
      isWaiver && status === 'archived'
        ? archiveWaiver(documentId)
        : setDocumentStatus(documentId, status),
    onSuccess: () => {
      invalidate()
      toast.success(t('saved'))
    },
    onError: () => toast.error(t('saveError')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteDocument(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', document?.teamId] })
      router.push('/documents' as Route)
    },
    // A published document — or one that has ever been published — cannot be
    // deleted at all: `firestore.rules` refuses, because its text may be
    // somebody's evidence. The button is hidden in that case, so this is the
    // fallback for a race, not the normal path.
    onError: () => toast.error(t('deleteError')),
  })

  // Image uploads for the rich-text body. Stable identity so the memoized
  // RichTextEditor doesn't re-render (and steal focus) on other state changes.
  const uploadBodyImage = useCallback(
    async (file: File) => {
      if (file.size > limits.maxImageSizeMB * 1024 * 1024) {
        toast.error(t('limitImageSize', { max: limits.maxImageSizeMB }))
        throw new Error('IMAGE_TOO_LARGE')
      }
      return uploadFile(file, `teams/${currentTeamId}/documents/${documentId}/images/${Date.now()}`)
    },
    [currentTeamId, documentId, limits.maxImageSizeMB, t],
  )

  // Everything this document could link to. Stable identity for the same reason
  // as uploadBodyImage — RichTextEditor is memoized and remounting it mid-edit
  // steals focus.
  const linkOptions = useMemo(
    () =>
      (allDocuments ?? []).map((d) => ({
        id: d.id,
        title: d.title,
        version: d.current_version ?? null,
        isPublic: d.status === 'published' && d.isPublic,
      })),
    [allDocuments],
  )
  const documentLinks = useMemo(
    () => ({
      options: linkOptions,
      currentDocumentId: documentId,
      labels: {
        toolbar: t('linkToolbar'),
        slashTitle: t('linkSlashTitle'),
        insertTitle: t('linkInsertTitle'),
        insertDescription: t('linkInsertDescription'),
        search: t('linkSearch'),
        empty: t('linkEmpty'),
        noResults: t('linkNoResults'),
        pinLabel: t('linkPinLabel'),
        pinHint: t('linkPinHint'),
        unpublished: t('linkUnpublished'),
        latest: t('linkLatest'),
        version: (n: number) => t('linkVersion', { version: n }),
        unlink: t('linkUnlink'),
        repin: t('linkRepin'),
        cancel: t('cancel'),
        insert: t('linkInsert'),
      },
    }),
    [linkOptions, documentId, t],
  )

  // Ordinary web links — separate from document links: this one stores the URL
  // the author typed, which is right for an external address and wrong for
  // another Linyup document (whose URL is rebuilt from a reference at render).
  const webLinks = useMemo(
    () => ({
      labels: {
        toolbar: t('webLinkToolbar'),
        slashTitle: t('webLinkSlashTitle'),
        title: t('webLinkTitle'),
        description: t('webLinkDescription'),
        urlLabel: t('webLinkUrlLabel'),
        urlPlaceholder: t('webLinkUrlPlaceholder'),
        textLabel: t('webLinkTextLabel'),
        textPlaceholder: t('webLinkTextPlaceholder'),
        invalidUrl: t('webLinkInvalidUrl'),
        cancel: t('cancel'),
        submit: t('webLinkSubmit'),
        remove: t('webLinkRemove'),
      },
    }),
    [t],
  )

  if (isLoading || !draft) {
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    )
  }

  if (!document) {
    return (
      <div className="max-w-3xl space-y-4">
        <Link href={'/documents' as Route} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ChevronLeft className="h-4 w-4" />{t('backToDocuments')}
        </Link>
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
      </div>
    )
  }

  const teamSlug = team?.slug ?? ''
  const publicHref = `/public/${teamSlug}/documents/${draft.slug}`
  const publicUrl =
    typeof window !== 'undefined' && teamSlug ? `${window.location.origin}${publicHref}` : ''
  const canShare = draft.status === 'published' && draft.isPublic && !!teamSlug

  const urlInvalid = draft.source === 'external_link' && !!draft.externalUrl && !isSafeHttpUrl(draft.externalUrl)
  // Whether the editor holds anything the server does not. Drives the bar's
  // one-line status, so "Save" is never a button a studio presses to find out.
  const dirty =
    draft.title !== document.title ||
    draft.kind !== document.kind ||
    draft.source !== document.source ||
    (draft.summary ?? '') !== (document.summary ?? '') ||
    (draft.body ?? '') !== (document.body ?? '') ||
    (draft.externalUrl ?? '') !== (document.externalUrl ?? '')
  // BOTH SOURCES, and `archived_at` is not belt-and-braces here. `archiveWaiver`
  // now writes `status` as well — it did not, which left an archived waiver
  // showing the Published badge over a Publish button the callable refuses by
  // name — and reading the timestamp too means a waiver archived before that fix
  // (a seeded tenant, an emulator snapshot) renders as what it is rather than as
  // a live document whose only control is an error.
  const isArchived = draft.status === 'archived' || draft.archived_at != null
  const isPublished = draft.status === 'published' && !isArchived
  const hasEverPublished = draft.status === 'published' || draft.current_version != null

  function handleSave() {
    if (!draft) return
    saveMutation.mutate({
      title: draft.title.trim(),
      kind: draft.kind,
      source: draft.source,
      body: draft.source === 'rich_text' ? (draft.body ?? '') : undefined,
      externalUrl: draft.source === 'external_link' ? (draft.externalUrl ?? '').trim() : undefined,
      summary: draft.summary ?? '',
    })
  }

  // PUBLISHING IS A SERVER OPERATION. It mints the immutable version snapshot
  // that every acceptance pins its hash to, so it cannot be a client status flip
  // — and the rules deny one, which is what leaves exactly one publisher.
  //
  // The stored draft is written first, and unconditionally. The snapshot is
  // frozen from the body the SERVER holds, so publishing what is on screen means
  // storing it beforehand — otherwise a studio edits the risk clause, publishes,
  // and freezes the previous wording under the new version number, which is
  // exactly the kind of quiet mismatch the hash exists to make impossible. The
  // alternative (refuse to publish while the editor is dirty) was rejected: a
  // rich-text editor that re-serialises its own input on mount would leave the
  // button permanently dead.
  async function onPublish(outcome: PublishOutcome) {
    if (!draft) return
    if (isWaiver) {
      await updateWaiverContent(documentId, {
        title: draft.title.trim(),
        source: draft.source,
        body: draft.source === 'rich_text' ? (draft.body ?? '') : undefined,
        externalUrl: draft.source === 'external_link' ? (draft.externalUrl ?? '').trim() : undefined,
        summary: draft.summary ?? '',
      })
    } else {
      await updateDocument(documentId, {
        title: draft.title.trim(),
        kind: draft.kind,
        source: draft.source,
        body: draft.source === 'rich_text' ? (draft.body ?? '') : undefined,
        externalUrl: draft.source === 'external_link' ? (draft.externalUrl ?? '').trim() : undefined,
        summary: draft.summary ?? '',
      })
    }
    const res = await publishDocument(documentId, outcome)
    invalidate()
    queryClient.invalidateQueries({ queryKey: ['document-versions', documentId] })
    toast.success(t('publishedVersion', { version: res.version }))
  }

  function toggleIsPublic(value: boolean) {
    if (!draft) return
    setDraft({ ...draft, isPublic: value })
    saveMutation.mutate({ isPublic: value })
  }

  return (
    <div className="max-w-3xl space-y-5">
      <Link href={'/documents' as Route} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ChevronLeft className="h-4 w-4" />{t('backToDocuments')}
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {draft.source === 'external_link' ? (
            <Link2 className="h-5 w-5 text-muted-foreground shrink-0" />
          ) : (
            <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
          )}
          <h1 className="text-xl font-semibold truncate">{draft.title}</h1>
          {/* The DERIVED state, never the raw field: an archived document must
              not wear a Published badge because one writer forgot a key. */}
          <Badge variant="secondary">
            {t(isArchived ? 'status_archived' : isPublished ? 'status_published' : 'status_draft')}
          </Badge>
          {draft.current_version != null && (
            <Badge variant="outline">{t('versionN', { version: draft.current_version })}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canShare && (
            <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
              <QrCode className="mr-1.5 h-4 w-4" />
              {t('shareQr')}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-5">
        {/* Title / kind / summary */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="doc-title">{t('fieldTitle')}</Label>
            <Input
              id="doc-title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldKind')}</Label>
            {isWaiver ? (
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {t('kind_waiver')}
                <span className="block text-xs text-muted-foreground">
                  {tWaivers('kindLockedHint')}
                </span>
              </p>
            ) : (
              <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as DocumentKind })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((k) => (
                    <SelectItem key={k} value={k}>{t(`kind_${k}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="doc-summary">{t('fieldSummary')}</Label>
          <Textarea
            id="doc-summary"
            rows={2}
            value={draft.summary ?? ''}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            placeholder={t('summaryPlaceholder')}
          />
        </div>

        {/* Source segmented control */}
        <div className="space-y-2">
          <Label>{t('fieldSource')}</Label>
          <div className="flex rounded-lg border overflow-hidden w-fit">
            {(['rich_text', 'external_link'] as DocumentSource[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setDraft({ ...draft, source: s })}
                className={`px-4 py-1.5 text-sm transition-colors ${
                  draft.source === s
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted text-muted-foreground'
                }`}
              >
                {t(s === 'rich_text' ? 'sourceRichText' : 'sourceExternalLink')}
              </button>
            ))}
          </div>
        </div>

        {draft.source === 'rich_text' ? (
          <div className="space-y-1.5">
            <Label>{t('fieldContent')}</Label>
            <RichTextEditor
              key={documentId}
              value={document.body ?? ''}
              onChange={(html) => setDraft((prev) => (prev ? { ...prev, body: html } : prev))}
              minHeight={320}
              placeholder={t('contentPlaceholder')}
              onUploadImage={uploadBodyImage}
              documentLinks={documentLinks}
              webLinks={webLinks}
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="doc-url">{t('fieldExternalUrl')}</Label>
            <Input
              id="doc-url"
              value={draft.externalUrl ?? ''}
              onChange={(e) => setDraft({ ...draft, externalUrl: e.target.value })}
              placeholder="https://…"
            />
            {urlInvalid && <p className="text-xs text-destructive">{t('externalUrlInvalid')}</p>}
          </div>
        )}

        {/* Publish + public toggle. Saving edits the DRAFT; publishing freezes a
            version of it. Two separate acts, and the copy says which is which —
            a studio that edits and never publishes has changed nothing a visitor
            or a signer can see. */}
        <div className="rounded-lg border p-4 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <Label>{t('fieldPublishing')}</Label>
              <p className="text-xs text-muted-foreground">
                {isArchived
                  ? t('archivedHint')
                  : isPublished
                    ? t('publishUpdateHint')
                    : t('publishFirstHint')}
              </p>
            </div>
            {/* THE PUBLISH CONTROL ITSELF LIVES IN THE STICKY BAR at the foot of
                the page (UX-93) — a long document used to push it off-screen,
                and a control you have to go looking for is one a studio stops
                using. There is exactly ONE of it: a second copy here would be
                two buttons minting immutable versions, which is the accident
                the sticky bar was not supposed to introduce.
                A WAIVER HAS NO RESTORE — `status` is not part of a waiver's
                vocabulary (no callable writes it, the rules deny a client
                write), so archiving one is deliberate and terminal; its text and
                every signature against it survive, and the export still finds
                them. A studio that wants to ask again authors a new one, which
                is also the honest record: a re-opened document would claim
                continuity the ledger cannot support. */}
            {isArchived && isWaiver && (
              <p className="max-w-xs text-xs text-muted-foreground">
                {tWaivers('archivedTerminalHint')}
              </p>
            )}
          </div>

          {/* A WAIVER IS NOT SERVED FROM ITS PUBLIC PAGE. The consent step gets
              the frozen text from `resolveWaiverRequirement`, and the mirror was
              deliberately NOT widened for this kind: `public_profile` is served
              by an unauthenticated collection-group read, so publishing a
              liability release there would make every studio's text — and the
              settings beside it, including whether the studio runs programs
              for minors — world-readable and enumerable. */}
          {isPublished && !isWaiver && (
            <div className="flex items-center justify-between gap-4 border-t pt-4">
              <div>
                <Label htmlFor="doc-public">{t('fieldIsPublic')}</Label>
                <p className="text-xs text-muted-foreground">{t('isPublicHint')}</p>
              </div>
              <Switch
                id="doc-public"
                checked={draft.isPublic}
                onCheckedChange={toggleIsPublic}
              />
            </div>
          )}

          {publicUrl && draft.isPublic && isPublished && (
            <p className="text-xs text-muted-foreground break-all">{t('publicUrl')}: {publicUrl}</p>
          )}

          {/* Unpublishing is not a waiver's lever either — the way to stop
              asking for a signature is the Required switch below, which removes
              the policy entry in the same transaction. Unpublishing would leave
              the gate pointing at text nobody can serve, which is the one state
              `waiver_unavailable` exists to refuse. */}
          {isPublished && !isWaiver && (
            <div className="border-t pt-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmUnpublish(true)}
                disabled={statusMutation.isPending}
              >
                {t('unpublish')}
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">{t('unpublishHint')}</p>
            </div>
          )}
        </div>

        {/* The waiver settings block. Its "participants may be minors" control
            renders INLINE here — not behind an "advanced" disclosure, not
            collapsed — because that visibility IS the guard: the flag is OFF by
            default, and the failure mode of that default is a kids' club taking
            signatures with no prompt to check anybody at the door and nobody
            finding out until it matters. See WaiverSettings' own header. */}
        {isWaiver && <WaiverSettings document={document} />}

        {/* Version history — read-only, forever. */}
        <VersionHistory documentId={documentId} />

        {/* Who has signed, and how good the evidence is. */}
        {isWaiver && <WaiverSigners document={document} />}

        {/* Danger zone */}
        <div className="border-t pt-4 flex gap-2">
          {!isArchived && (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setArchiveOpen(true)}>
              <Archive className="mr-1.5 h-4 w-4" />
              {t('archive')}
            </Button>
          )}
          {/* Deletion disappears the moment a document has ever been published:
              the rules refuse it, so offering the button would be a live control
              that always errors. Archiving is the retire path. */}
          {/* Deletion is denied for a waiver in EVERY state, published or not:
              the rules make the kind callable-only and no callable deletes one.
              Archiving is the retire path. */}
          {!hasEverPublished && !isWaiver && (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="mr-1.5 h-4 w-4" />
              {t('delete')}
            </Button>
          )}
        </div>
        {hasEverPublished && (
          <p className="text-xs text-muted-foreground">{t('deleteBlockedHint')}</p>
        )}
      </div>

      {/* ── The action bar (UX-93) ───────────────────────────────────────────
          Save and Publish are the two acts this page exists for, and on a long
          document both used to be somewhere above the fold you had already
          scrolled past. This is UX-74's dialog rule at page scale: the body
          scrolls, the controls do not.

          EASIER TO REACH IS NOT EASIER TO HIT BY ACCIDENT. Publishing mints an
          IMMUTABLE version (`publishDocumentVersion`) that acceptances pin their
          hash to, so the always-visible control is deliberately the SECOND
          button, styled quieter than Save, and it still opens the publish
          chooser rather than publishing on click. Nothing here publishes in one
          press, and there is only one publish control on the page. */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6">
        <p className="text-xs text-muted-foreground">
          {dirty ? t('unsavedChanges') : t('noUnsavedChanges')}
        </p>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending || !dirty || !draft.title.trim() || urlInvalid}
          >
            {saveMutation.isPending ? t('saving') : t('save')}
          </Button>
          {/* An archived document offers RESTORE, not publish: the publish
              callable refuses an archived document by name, so a Publish button
              there would be a live control that always errors. A waiver has
              neither (see the hint in the publishing card). */}
          {isArchived ? (
            !isWaiver && (
              <Button
                variant="outline"
                onClick={() => statusMutation.mutate('draft')}
                disabled={statusMutation.isPending}
              >
                {t('restore')}
              </Button>
            )
          ) : (
            <Button variant="outline" onClick={() => setPublishOpen(true)} disabled={urlInvalid}>
              <Upload className="mr-1.5 h-4 w-4" />
              {isPublished ? t('publishNewVersion') : t('publishAction')}
            </Button>
          )}
        </div>
      </div>

      {/* Unpublish confirmation. Says the consequence in the visitor's terms —
          the public page goes now, and the bio-link stops offering Documents —
          and then says, equally plainly, that nothing is lost. NOT styled
          destructive: this deletes no work, and an overstated warning trains
          people to click through the next one. */}
      <AlertDialog open={confirmUnpublish} onOpenChange={setConfirmUnpublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('unpublishConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('unpublishConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusMutation.isPending}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={statusMutation.isPending}
              onClick={() => {
                setConfirmUnpublish(false)
                statusMutation.mutate('draft')
              }}
            >
              {t('unpublishConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive confirm */}
      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('archiveConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('archiveConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                statusMutation.mutate('archived')
                setArchiveOpen(false)
              }}
            >
              {t('archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
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

      {/* The publish chooser — where the evidential trade is made. */}
      <PublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        document={draft}
        onPublish={onPublish}
      />

      {/* Share / QR */}
      <DocumentShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        url={publicUrl}
        title={draft.title}
        teamName={team?.name}
      />
    </div>
  )
}
