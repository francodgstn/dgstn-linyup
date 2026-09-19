'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Trash2, EyeOff, House, FileText, Newspaper } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Segmented } from '@/components/ui/segmented'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { SiteMenuItem, SiteMeta, SitePageRef } from '@linyup/shared'
import { normalizeSitePagePath, isValidSitePagePath, SITE_PAGE_LIMITS } from '@linyup/shared'
import { toDateInputValue } from '@/lib/format'
import { ImageField, type SiteEditorTenant } from '@/components/website/SiteSectionFields'
import { PAGE_STARTERS, type PageStarter } from '@/plugins/website/defaults'

/** Removes every menu item (at any depth) whose target names the given page —
 *  used when deleting a page, so a dangling `{kind:'page'}` link never
 *  survives it. Children go with a removed item: a `page` target names ONE
 *  page, so a subtree hung off a link to a since-deleted page has nothing
 *  left to point at either. */
export function removeMenuItemsTargetingPage(items: SiteMenuItem[], pageId: string): SiteMenuItem[] {
  return items
    .filter((item) => !(item.target.kind === 'page' && item.target.pageId === pageId))
    .map((item) =>
      item.children ? { ...item, children: removeMenuItemsTargetingPage(item.children, pageId) } : item
    )
}

/** The header button, without its destination when that was the given page —
 *  used alongside `removeMenuItemsTargetingPage` when deleting a page. The
 *  whole button goes, label included: it was named for that page, and the
 *  publish would otherwise fall back to a destination nobody chose. */
export function removeHeaderButtonTargetingPage(meta: SiteMeta, pageId: string): SiteMeta {
  if (meta.header.ctaAction !== 'page' || meta.header.ctaPageId !== pageId) return meta
  const header = { ...meta.header }
  delete header.ctaLabel
  delete header.ctaAction
  delete header.ctaPageId
  return { ...meta, header }
}

/**
 * The home page's settings. Every other page opens the page-settings dialog; home
 * has no path, no menu label, nothing to hide and nothing to delete, so what is
 * left is the search listing — but it opens from the SAME button, because "the
 * page I am looking at" is the only mental model a studio should need here.
 */
export function HomeSettingsDialog({
  open,
  onOpenChange,
  meta,
  onChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  meta: SiteMeta
  onChange: (patch: Partial<SiteMeta>) => void
}) {
  const t = useTranslations('Website')
  const setSeo = (patch: Partial<NonNullable<SiteMeta['seo']>>) =>
    onChange({ seo: { ...meta.seo, ...patch } })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('pagesHomeSettingsTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('pagesSeoHint')}</p>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('pagesSeoTitleField')}</Label>
            <Input
              value={meta.seo?.title ?? ''}
              onChange={(e) => setSeo({ title: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('pagesSeoDescriptionField')}</Label>
            <Input
              value={meta.seo?.description ?? ''}
              onChange={(e) => setSeo({ description: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t('pagesDone')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── the current-page param ─────────────────────────────────────────────────
//
// `useTabParam` reads its param ONCE at mount and keeps the URL in sync from
// then on — see its own header for why. That works for `?tab=` because the
// valid ids (sections/appearance/embed) are known at compile time. A page id
// is not: the draft loads asynchronously, so at the moment this component
// first mounts `draft.pages` is still null, and validating against an empty
// list would strand every reload back on Home — exactly the bug this whole
// selector exists to avoid.
//
// So this reads the raw `?page=` value at mount, unvalidated, and only
// corrects it once the real page list is known (the effect below): a stale or
// forged id falls back to Home, same as an unknown `?tab=` would.
export function useCurrentPageParam(pageIds: string[] | null): [string, (id: string) => void] {
  const searchParams = useSearchParams()
  const [pageId, setPageId] = useState(() => searchParams.get('page') || 'home')

  useEffect(() => {
    if (pageId === 'home' || !pageIds) return
    if (!pageIds.includes(pageId)) setPageId('home')
  }, [pageId, pageIds])

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const current = p.get('page')
    if (pageId === 'home') {
      if (current === null) return
      p.delete('page')
    } else {
      if (current === pageId) return
      p.set('page', pageId)
    }
    const qs = p.toString()
    window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname)
  }, [pageId])

  return [pageId, setPageId]
}

// ─── add-page dialog ────────────────────────────────────────────────────────

export function AddPageDialog({
  open,
  onOpenChange,
  existingPaths,
  pagesFull,
  postsFull,
  pathPrefix = '/site/',
  starters = PAGE_STARTERS,
  onCreate,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** See PageSettingsDialog.pathPrefix. */
  pathPrefix?: string
  /** The shapes a new page may start from — a site offers the ones that make
   *  sense for it. The first is the default. */
  starters?: readonly PageStarter[]
  /** Every OTHER page's path — the new one must not collide. */
  existingPaths: string[]
  /** Whether each kind's own cap (SITE_PAGE_LIMITS.maxPages / maxPosts) is
   *  already reached — checked at creation, against whichever kind is chosen. */
  pagesFull: boolean
  postsFull: boolean
  onCreate: (page: {
    title: string
    path: string
    kind: 'page' | 'post'
    publishedOn?: string
    starter: PageStarter
  }) => void
}) {
  const t = useTranslations('Website')
  const tCommon = useTranslations('Common')
  const [kind, setKind] = useState<'page' | 'post'>('page')
  // 'simple' by default: a hero carrying the page's own title and a text block
  // under it is what most second pages are, and it is never the wrong start —
  // deleting two sections is easier than facing an empty page.
  const [starter, setStarter] = useState<PageStarter>(starters[0] ?? 'empty')
  const [title, setTitle] = useState('')
  const [path, setPath] = useState('')
  // Once the studio has edited the path by hand, typing in Title (or switching
  // Page ↔ Post) stops overwriting it — the same "don't fight the last thing
  // they touched" rule `normalizeSitePagePath` itself follows on blur.
  const [pathTouched, setPathTouched] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) return
    setKind('page')
    setStarter(starters[0] ?? 'empty')
    setTitle('')
    setPath('')
    setPathTouched(false)
    setPathOpen(false)
    setError(null)
    // Resets only when the dialog closes; `starters` is a prop that does not
    // change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** A post's suggested path lives under 'blog/' — a suffix, not a rename: the
   *  title itself is untouched, only where a fresh path is offered from it. */
  function suggestPath(nextKind: 'page' | 'post', nextTitle: string): string {
    if (!nextTitle) return ''
    return nextKind === 'post' ? normalizeSitePagePath(`blog/${nextTitle}`) : normalizeSitePagePath(nextTitle)
  }

  function handleCreate() {
    if (!title.trim()) {
      setError(t('pagesTitleRequired'))
      return
    }
    const normalized = normalizeSitePagePath(path)
    if (!normalized || !isValidSitePagePath(normalized)) {
      setError(t('pagesPathInvalid'))
      return
    }
    if (existingPaths.includes(normalized)) {
      setError(t('pagesPathTaken'))
      return
    }
    if (kind === 'post' && postsFull) {
      setError(t('pagesPostsLimitReached', { max: SITE_PAGE_LIMITS.maxPosts }))
      return
    }
    if (kind === 'page' && pagesFull) {
      setError(t('pagesLimitReached', { max: SITE_PAGE_LIMITS.maxPages }))
      return
    }
    onCreate({
      title: title.trim(),
      path: normalized,
      kind,
      publishedOn: kind === 'post' ? toDateInputValue(new Date()) : undefined,
      starter,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{kind === 'post' ? t('pagesNewPostTitle') : t('pagesNewTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('pagesKindField')}</Label>
            <Segmented
              ariaLabel={t('pagesKindField')}
              options={[
                { value: 'page' as const, label: t('pagesKindPage') },
                { value: 'post' as const, label: t('pagesKindPost') },
              ]}
              value={kind}
              onChange={(v) => {
                setKind(v)
                if (!pathTouched) setPath(suggestPath(v, title))
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t('pagesTitleField')}</Label>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                if (!pathTouched) setPath(suggestPath(kind, e.target.value))
              }}
              placeholder={t('pagesTitlePlaceholder')}
              className="h-9"
              autoFocus
            />
          </div>
          {/* A page picks its starting shape; a post always starts as a text
              block to write in, so it is not asked. */}
          {kind === 'page' && starters.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('pagesStarterField')}</Label>
              <div role="radiogroup" aria-label={t('pagesStarterField')} className="grid gap-2">
                {starters.map((option) => {
                  const selected = starter === option
                  const copy = {
                    simple: [t('pagesStarterSimple'), t('pagesStarterSimpleDesc')],
                    offer: [t('pagesStarterOffer'), t('pagesStarterOfferDesc')],
                    empty: [t('pagesStarterEmpty'), t('pagesStarterEmptyDesc')],
                  }[option]
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setStarter(option)}
                      className={`rounded-lg border p-2.5 text-left transition-colors ${
                        selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:border-primary/50'
                      }`}
                    >
                      <span className="block text-sm font-medium">{copy[0]}</span>
                      <span className="block text-xs text-muted-foreground">{copy[1]}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {/* THE ADDRESS IS A CONSEQUENCE OF THE TITLE, NOT A QUESTION.
              A studio owner writing "Unsere Werte" has no opinion about
              "unsere-werte" and should not be asked to form one — so the
              derived address is shown as a fact, and only a studio that WANTS
              to change it opens the field. */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('pagesPathField')}</Label>
            {pathOpen ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 text-xs text-muted-foreground">{pathPrefix}</span>
                  <Input
                    value={path}
                    onChange={(e) => {
                      setPathTouched(true)
                      setPath(e.target.value)
                    }}
                    onBlur={() => setPath((p) => normalizeSitePagePath(p))}
                    className="h-9 font-mono text-xs"
                    autoFocus
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t('pagesPathHint')}</p>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {pathPrefix}{path || <span className="italic">…</span>}
                </span>
                <button
                  type="button"
                  onClick={() => setPathOpen(true)}
                  className="shrink-0 text-xs font-medium text-primary hover:underline"
                >
                  {t('pagesPathEdit')}
                </button>
              </div>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon('cancel')}
          </Button>
          <Button type="button" onClick={handleCreate}>
            {kind === 'post' ? t('pagesCreatePostAction') : t('pagesCreateAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A POST'S HEADLINE, DATE, COVER AND TEASER ARE THE POST — NOT ITS SETTINGS.
 *
 * They were in the settings dialog, one button away from the article they
 * belong to, next to SEO and the delete button. An author writing a post has
 * to think about all four of them and about none of the things they were
 * filed with, so they sit here, above the body, in the order a blog card
 * shows them. What stays behind the Settings button is what a post shares
 * with every other page: its address, its menu label, whether it is hidden,
 * and SEO.
 */
export function PostHeaderCard({
  page,
  tenant,
  onChange,
}: {
  page: SitePageRef
  /** Whose site this is — where the post's cover image is uploaded to. */
  tenant: SiteEditorTenant
  onChange: (patch: Partial<SitePageRef>) => void
}) {
  const t = useTranslations('Website')
  const excerptLength = (page.excerpt ?? '').length
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{t('pagesPostTitleField')}</Label>
        <Input
          value={page.title}
          onChange={(e) => onChange({ title: e.target.value })}
          className="h-10 text-base font-semibold"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('pagesPostDateField')}</Label>
          <Input
            type="date"
            value={page.publishedOn ?? ''}
            onChange={(e) => onChange({ publishedOn: e.target.value })}
            className="h-9"
          />
        </div>
        <ImageField
          label={t('pagesPostCoverField')}
          url={page.coverImageUrl}
          tenant={tenant}
          sectionId={page.id}
          onChange={(u) => onChange({ coverImageUrl: u })}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t('pagesPostExcerptField')}</Label>
        <Textarea
          value={page.excerpt ?? ''}
          onChange={(e) => onChange({ excerpt: e.target.value.slice(0, 400) })}
          rows={2}
        />
        <p className="text-xs text-muted-foreground">
          {t('pagesPostExcerptHint', { count: excerptLength, max: 400 })}
        </p>
      </div>
    </div>
  )
}

// ─── page settings dialog ───────────────────────────────────────────────────

export function PageSettingsDialog({
  open,
  onOpenChange,
  page,
  pathPrefix = '/site/',
  existingPaths,
  onChange,
  onDelete,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  page: SitePageRef
  /** What precedes a page's path in its address — '/site/' on a team site,
   *  '/' on an organisation's, whose pages sit directly under its slug. */
  pathPrefix?: string
  /** Every OTHER page's path — this page's own path may stay unchanged. */
  existingPaths: string[]
  onChange: (patch: Partial<SitePageRef>) => void
  onDelete: () => void
}) {
  const t = useTranslations('Website')
  const tCommon = useTranslations('Common')
  const [path, setPath] = useState(page.path)
  const [pathError, setPathError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isPost = page.kind === 'post'

  // Re-seed the local path draft whenever the dialog opens on a (possibly
  // different) page — the path field has its own commit-on-blur step, so it
  // cannot just read `page.path` directly like every other field here does.
  useEffect(() => {
    if (!open) return
    setPath(page.path)
    setPathError(null)
  }, [open, page.id, page.path])

  function commitPath() {
    const normalized = normalizeSitePagePath(path)
    if (!normalized || !isValidSitePagePath(normalized)) {
      setPathError(t('pagesPathInvalid'))
      return
    }
    if (existingPaths.includes(normalized)) {
      setPathError(t('pagesPathTaken'))
      return
    }
    setPathError(null)
    setPath(normalized)
    if (normalized !== page.path) onChange({ path: normalized })
  }

  const setSeo = (patch: Partial<NonNullable<SitePageRef['seo']>>) =>
    onChange({ seo: { ...page.seo, ...patch } })


  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('pagesSettingsTitle')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {!isPost && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('pagesTitleField')}</Label>
                <Input
                  value={page.title}
                  onChange={(e) => onChange({ title: e.target.value })}
                  className="h-9"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('pagesKindField')}</Label>
              <Segmented
                ariaLabel={t('pagesKindField')}
                options={[
                  { value: 'page' as const, label: t('pagesKindPage') },
                  { value: 'post' as const, label: t('pagesKindPost') },
                ]}
                value={isPost ? 'post' : 'page'}
                onChange={(v) =>
                  onChange({
                    kind: v === 'post' ? 'post' : undefined,
                    // A page turning into a post needs SOME date to sort and
                    // display by; a post turning back into a page keeps
                    // whatever it had, since the field is simply unread until
                    // it becomes a post again.
                    publishedOn: v === 'post' ? page.publishedOn || toDateInputValue(new Date()) : page.publishedOn,
                  })
                }
              />
            </div>
            {/* A post's headline, date, cover and teaser are NOT here — they
                are the post, and they are edited beside it (PostHeaderCard).
                Said out loud, because a Title field that disappears the moment
                you switch Type to Post looks like a field that was taken away. */}
            {isPost && (
              <p className="rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground">
                {t('pagesPostFieldsMovedHint')}
              </p>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('pagesPathField')}</Label>
              <div className="flex items-center gap-1.5">
                <span className="shrink-0 text-xs text-muted-foreground">{pathPrefix}</span>
                <Input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onBlur={commitPath}
                  className="h-9 font-mono text-xs"
                />
              </div>
              {pathError && <p className="text-xs text-destructive">{pathError}</p>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('pagesNavLabelField')}</Label>
              <Input
                value={page.navLabel ?? ''}
                onChange={(e) => onChange({ navLabel: e.target.value || undefined })}
                placeholder={page.title}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">{t('pagesNavLabelHint')}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <label className="flex items-center justify-between">
                <span className="text-sm">{t('pagesHiddenField')}</span>
                <Switch checked={!!page.hidden} onCheckedChange={(v) => onChange({ hidden: v })} />
              </label>
              <p className="mt-1 text-xs text-muted-foreground">{t('pagesHiddenHint')}</p>
            </div>
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-xs font-medium text-muted-foreground">SEO</p>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('pagesSeoTitleField')}</Label>
                <Input
                  value={page.seo?.title ?? ''}
                  onChange={(e) => setSeo({ title: e.target.value })}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('pagesSeoDescriptionField')}</Label>
                <Input
                  value={page.seo?.description ?? ''}
                  onChange={(e) => setSeo({ description: e.target.value })}
                  className="h-9"
                />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="mr-auto text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('pagesDelete')}
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              {t('pagesDone')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pagesDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('pagesDeleteBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false)
                onOpenChange(false)
                onDelete()
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('pagesDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ─── the page rail ──────────────────────────────────────────────────────────

/**
 * THE PAGE RAIL — "MY WEBSITE HAS THESE PAGES", ALWAYS ON SCREEN.
 *
 * Pages used to be a dropdown inside the Sections tab, so the one thing a
 * studio owner thinks of a website as — a set of pages — had no place of its
 * own: you had to already be in Sections, notice the grey strip, and open a
 * select to see what existed. The rail is the Wix/Squarespace answer: the list
 * is permanent, beside every tab, and picking a page opens it.
 *
 * Design and Embed are site-wide, so choosing a page from either of them
 * switches to Sections — the only tab a page changes. Below lg there is no
 * room for a column, and the compact page switcher above the sections is used
 * instead; both drive the same ?page= param.
 *
 * Posts are listed apart, newest first, in their own scroll: a studio with
 * sixty posts should still see its pages without scrolling past them.
 */
export function PagesRail({
  currentPageId,
  pages,
  posts,
  onSelect,
  onAdd,
  addDisabled,
  addDisabledReason,
}: {
  currentPageId: string
  pages: SitePageRef[]
  posts: SitePageRef[]
  onSelect: (id: string) => void
  onAdd: () => void
  addDisabled: boolean
  addDisabledReason?: string
}) {
  const t = useTranslations('Website')
  const row = (id: string, icon: React.ReactNode, title: string, sub?: string, hidden?: boolean) => {
    const active = id === currentPageId
    return (
      <button
        key={id}
        type="button"
        onClick={() => onSelect(id)}
        aria-current={active ? 'page' : undefined}
        className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
          active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        }${hidden ? ' opacity-60' : ''}`}
      >
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{title}</span>
          {sub && <span className="block truncate text-xs font-normal text-muted-foreground">{sub}</span>}
        </span>
        {hidden && <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-label={t('pagesHiddenField')} />}
      </button>
    )
  }
  return (
    <nav
      aria-label={t('pagesGroupLabel')}
      className="hidden space-y-3 rounded-lg border bg-card p-2 lg:sticky lg:top-4 lg:block lg:w-60 lg:shrink-0"
    >
      <div className="flex items-center justify-between px-2 pt-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('pagesGroupLabel')}
        </span>
        <span className="text-xs text-muted-foreground">
          {pages.length + 1}/{SITE_PAGE_LIMITS.maxPages}
        </span>
      </div>
      <div className="space-y-0.5">
        {row('home', <House className="h-4 w-4" />, t('pagesHome'), '/')}
        {pages.map((p) => row(p.id, <FileText className="h-4 w-4" />, p.title, `/${p.path}`, p.hidden))}
      </div>
      {posts.length > 0 && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between px-2 pt-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('pagesPostsGroup')}
            </span>
            <span className="text-xs text-muted-foreground">{posts.length}</span>
          </div>
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {posts.map((p) => row(p.id, <Newspaper className="h-4 w-4" />, p.title, p.publishedOn, p.hidden))}
          </div>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={addDisabled}
        title={addDisabled ? addDisabledReason : undefined}
        onClick={onAdd}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('pagesAdd')}
      </Button>
    </nav>
  )
}
