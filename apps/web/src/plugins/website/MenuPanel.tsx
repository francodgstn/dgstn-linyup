'use client'

// ─── THE MENU EDITOR ─────────────────────────────────────────────────────────
//
// The header menu used to be TWO derived lists that could not interleave:
// section anchors (from `showInNav`, in section order) and cross-surface links
// (Shop / My space / Documents, derived from what is live and ordered only
// among themselves). They rendered as two runs, so "Shop" could never sit
// between two sections however either list was ordered — which is why the
// system links read as fixed, and why their settings had washed up in the
// appearance panel: there was nowhere else for them to live.
//
// This edits ONE stored tree instead. See `SiteMenuItem` for why an absent menu
// still derives the old layout, so no live site changes until the first save.
//
// ── DRAG TO ORDER, BUTTONS TO NEST ──────────────────────────────────────────
// The sections list beside this one is already drag-sorted, so ordering by drag
// is the gesture a studio arrives here expecting.
//
// But ONLY ordering. Each sibling group is its OWN sortable context, so a drag
// can reorder within a parent and can never silently reparent — which is the
// part of nested drag-and-drop that goes wrong: a three-way drop target
// (before / after / inside) is fiddly with a pointer, close to unusable on
// touch, and needs a keyboard path of its own regardless.
//
// Changing a parent stays two explicit buttons, indent and outdent, where the
// result is one press and visible. Together that is the same four verbs as
// before with the one that suits a mouse handed to the mouse.
//
// The tree operations are pure and unit-tested in @linyup/shared — every edge
// (the first child that cannot indent, the root that cannot outdent, the
// subtree that would breach the depth cap, the drag that would leave its group)
// is pinned there rather than discovered by clicking.
//
// A disabled button is left in place rather than hidden: a control that vanishes
// makes the row beside it jump under the cursor.

import { useTranslations } from 'next-intl'
import {
  GripVertical,
  IndentIncrease,
  IndentDecrease,
  Link2,
  Trash2,
  Plus,
  FileText,
  File,
  Globe,
  Folder,
} from 'lucide-react'

import {
  SITE_MENU_MAX_DEPTH,
  findSiteMenuPath,
  flattenSiteMenu,
  indentSiteMenuItem,
  outdentSiteMenuItem,
  removeSiteMenuItem,
  reorderSiteMenuSiblings,
  siteMenuDepth,
  type PublicSurface,
  type SiteMenuItem,
  type WebsiteSection,
  type OrgSiteSection,
} from '@linyup/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { SortableList, SortableItem } from '@/components/ui/sortable'
import { Tip } from '@/components/ui/tip'

export function MenuPanel({
  menu,
  sections,
  pages,
  surfaces,
  surfaceLabel,
  sectionLabel,
  onChange,
}: {
  menu: SiteMenuItem[]
  /** Team OR org sections — the panel reads only `id` and `type`, so it is
   *  tenant-agnostic in exactly the way `siteMenu.ts`'s tree operations and
   *  `RenderableSite` already are. */
  sections: (WebsiteSection | OrgSiteSection)[]
  /** The site's other pages (home excluded — a `page` target always names ONE
   *  of these). Absent ⇒ no page items offered, which is exactly the org
   *  builder today: org sites have no pages yet. */
  pages?: { id: string; label: string }[]
  /** Surfaces that are actually live — the only ones worth offering. */
  surfaces: readonly PublicSurface[]
  surfaceLabel: (s: PublicSurface) => string
  sectionLabel: (s: WebsiteSection | OrgSiteSection) => string
  onChange: (menu: SiteMenuItem[]) => void
}) {
  const t = useTranslations('Website')
  const rows = flattenSiteMenu(menu)
  const depth = siteMenuDepth(menu)

  const sectionById = new Map(sections.map((s) => [s.id, s]))
  const pageById = new Map((pages ?? []).map((p) => [p.id, p] as const))

  /** What a row says when the studio has not written its own label. */
  function derivedLabel(item: SiteMenuItem): string {
    switch (item.target.kind) {
      case 'section': {
        const s = sectionById.get(item.target.sectionId)
        return s ? sectionLabel(s) : t('menuMissingSection')
      }
      case 'page': {
        const p = pageById.get(item.target.pageId)
        return p ? p.label : t('menuMissingPage')
      }
      case 'surface':
        return surfaceLabel(item.target.surface)
      case 'url':
        return item.target.url || t('menuLinkUntitled')
      case 'none':
        return t('menuGroupUntitled')
    }
  }

  function add(target: SiteMenuItem['target']) {
    onChange([...menu, { id: `m${Date.now().toString(36)}`, target }])
  }

  const iconFor = (item: SiteMenuItem) =>
    item.target.kind === 'section'
      ? FileText
      : item.target.kind === 'page'
        ? File
        : item.target.kind === 'surface'
          ? Globe
          : item.target.kind === 'url'
            ? Link2
            : Folder

  /** One sibling group: its own sortable context, so a drag can reorder inside
   *  this parent and nowhere else. Children recurse into their own group. */
  function Branch({
    items,
    parentId,
    depth: level,
  }: {
    items: SiteMenuItem[]
    parentId: string | null
    depth: number
  }) {
    return (
      <SortableList
        ids={items.map((i) => i.id)}
        onReorder={(from, to) => onChange(reorderSiteMenuSiblings(menu, parentId, from, to))}
      >
        {items.map((item) => {
          const Icon = iconFor(item)
          const path = findSiteMenuPath(menu, item.id) ?? []
          const indexInParent = path[path.length - 1] ?? 0
          // Same rule the pure helper enforces — read here only to disable the
          // button, never to make the decision.
          const canIndent =
            indexInParent > 0 && path.length + siteMenuDepth([item]) <= SITE_MENU_MAX_DEPTH
          return (
            <SortableItem key={item.id} id={item.id}>
              {({ setNodeRef, style, attributes, listeners, isDragging }) => (
                <div ref={setNodeRef} style={style} className={cn(isDragging && 'opacity-50')}>
                  <div
                    className="flex items-center gap-1.5 border-b p-2 last:border-b-0"
                    style={{ paddingLeft: `${0.5 + (level - 1) * 1.25}rem` }}
                  >
                    {/* The handle carries the drag listeners, not the row: the
                        label is a text input, and a row-wide drag would fight
                        every attempt to select what is written in it. */}
                    <Tip label={t('menuReorder')}>
                      <button
                        type="button"
                        {...attributes}
                        {...listeners}
                        aria-label={t('menuReorder')}
                        className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <Input
                      value={item.label ?? ''}
                      placeholder={derivedLabel(item)}
                      onChange={(e) => setLabel(item.id, e.target.value)}
                      className="h-8 min-w-0 flex-1 text-sm"
                    />
                    <div className="flex shrink-0 items-center">
                      {(
                        [
                          [IndentIncrease, t('menuIndent'), () => onChange(indentSiteMenuItem(menu, item.id)), canIndent],
                          [IndentDecrease, t('menuOutdent'), () => onChange(outdentSiteMenuItem(menu, item.id)), level > 1],
                        ] as const
                      ).map(([Ico, label, run, enabled], i) => (
                        <Tip key={i} label={label}>
                          <button
                            type="button"
                            onClick={run}
                            disabled={!enabled}
                            aria-label={label}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                          >
                            <Ico className="h-3.5 w-3.5" />
                          </button>
                        </Tip>
                      ))}
                      <Tip label={t('menuRemove')}>
                        <button
                          type="button"
                          onClick={() => onChange(removeSiteMenuItem(menu, item.id))}
                          aria-label={t('menuRemove')}
                          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </Tip>
                    </div>
                  </div>
                  {item.children?.length ? (
                    <Branch items={item.children} parentId={item.id} depth={level + 1} />
                  ) : null}
                </div>
              )}
            </SortableItem>
          )
        })}
      </SortableList>
    )
  }

  /** Write a row's label, anywhere in the tree. */
  function setLabel(id: string, label: string) {
    const apply = (list: SiteMenuItem[]): SiteMenuItem[] =>
      list.map((n) =>
        n.id === id
          ? { ...n, label: label || undefined }
          : { ...n, children: n.children ? apply(n.children) : undefined },
      )
    onChange(apply(menu))
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('menuHint')}</p>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('menuEmpty')}
        </div>
      ) : (
        <div className="rounded-lg border">
          <Branch items={menu} parentId={null} depth={1} />
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm">
                <Plus className="h-4 w-4" />
                {t('menuAdd')}
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            {/* Sections the studio has, whether or not they are already in the
                menu: the same section can legitimately appear twice (once under
                a group, once at root), and refusing that would be a rule nobody
                asked for. */}
            {sections
              .filter((s) => s.type !== 'hero')
              .map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onClick={() => add({ kind: 'section', sectionId: s.id })}
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {sectionLabel(s)}
                </DropdownMenuItem>
              ))}
            {/* The site's other pages — home has no target of its own (it's
                where the menu lives), so `pages` never includes it. */}
            {(pages ?? []).map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => add({ kind: 'page', pageId: p.id })}>
                <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                {p.label}
              </DropdownMenuItem>
            ))}
            {surfaces.map((s) => (
              <DropdownMenuItem key={s} onClick={() => add({ kind: 'surface', surface: s })}>
                <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                {surfaceLabel(s)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={() => add({ kind: 'url', url: '' })}>
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t('menuAddLink')}
            </DropdownMenuItem>
            {/* A parent with no destination — the only way to build a submenu
                whose top row is not itself a page. */}
            <DropdownMenuItem onClick={() => add({ kind: 'none' })}>
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              {t('menuAddGroup')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <p className={cn('text-xs', depth >= SITE_MENU_MAX_DEPTH ? 'text-amber-600' : 'text-muted-foreground')}>
          {t('menuDepth', { depth, max: SITE_MENU_MAX_DEPTH })}
        </p>
      </div>

      {/* URL rows need a second field, and giving every row one would make the
          list unreadable for the four-in-five rows that do not. */}
      {rows.some((r) => r.item.target.kind === 'url') && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs font-medium">{t('menuLinkTargets')}</p>
          {rows
            .filter((r) => r.item.target.kind === 'url')
            .map(({ item }) => (
              <div key={item.id} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                  {item.label || t('menuLinkUntitled')}
                </span>
                <Input
                  value={item.target.kind === 'url' ? item.target.url : ''}
                  placeholder="https://…"
                  onChange={(e) => {
                    const url = e.target.value
                    const apply = (list: SiteMenuItem[]): SiteMenuItem[] =>
                      list.map((n) =>
                        n.id === item.id
                          ? { ...n, target: { kind: 'url' as const, url } }
                          : { ...n, children: n.children ? apply(n.children) : undefined },
                      )
                    onChange(apply(menu))
                  }}
                  className="h-8 flex-1 font-mono text-xs"
                />
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
