'use client'

import { memo, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table'
import { DragHandle } from '@tiptap/extension-drag-handle-react'
import {
  Bold, Italic, Strikethrough, Type, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks, Quote, Code, Minus, ImageIcon, GripVertical,
  Table as TableIcon, Trash2, Link2, Link as LinkIcon, Pin, PinOff, Unlink,
} from 'lucide-react'
import { SlashCommand } from './editor/SlashCommand'
import { SlashCommandList, type SlashItem, type SlashCommandListRef } from './editor/SlashCommandList'
import { ResizableImage } from './editor/ResizableImage'
import { DocumentLink } from './editor/DocumentLink'
import { LinkDialog, type LinkDialogLabels } from './editor/LinkDialog'
import {
  DocumentLinkPicker,
  type DocumentLinkLabels,
  type DocumentLinkOption,
} from './editor/DocumentLinkPicker'
import {
  DOCUMENT_LINK_ID_ATTR,
  DOCUMENT_LINK_VERSION_ATTR,
  parseDocumentLinkVersion,
  resolveDocumentLink,
  type DocumentLinkTarget,
} from '@linyup/shared'
import { Tip } from '@/components/ui/tip'

type Range = { from: number; to: number }

/** Everything the editor needs to offer, pin and unpin document links. */
export interface DocumentLinksConfig {
  /** Every document that could be linked — the current one is filtered out. */
  options: DocumentLinkOption[]
  /** The document being edited; it can never link to itself. */
  currentDocumentId: string
  labels: DocumentLinkLabels & { toolbar: string; slashTitle: string; unlink: string; repin: string }
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function ToolbarButton({
  active, onClick, children, title,
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  title: string
}) {
  // EVERY BUTTON IN THIS TOOLBAR IS AN ICON, so `title` was not extra detail
  // about a visible label — it WAS the label, and the browser's version of it
  // never reaches a touch user and takes a second to reach anyone else.
  return (
    <Tip label={title}>
      <button
        type="button"
        aria-label={title}
        onClick={onClick}
        className={`p-1.5 rounded transition-colors ${
          active
            ? 'bg-foreground/10 text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
        }`}
      >
        {children}
      </button>
    </Tip>
  )
}

function Toolbar({
  editor,
  onImage,
  onDocumentLink,
  onWebLink,
  documentLinks,
  webLinks,
}: {
  editor: Editor | null
  onImage?: () => void
  onDocumentLink?: () => void
  onWebLink?: () => void
  documentLinks?: DocumentLinksConfig
  webLinks?: { labels: LinkDialogLabels & { toolbar: string; slashTitle: string } }
}) {
  if (!editor) return null
  // Start a fresh chain on every click — a cached chain captures a stale state
  // and throws "Applying a mismatched transaction" on the second use.
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) =>
    fn(editor.chain().focus()).run()
  return (
    <div className="flex items-center gap-0.5 flex-wrap px-2 py-1.5 border-b">
      <ToolbarButton title="Bold" active={editor.isActive('bold')} onClick={() => run((c) => c.toggleBold())}>
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Italic" active={editor.isActive('italic')} onClick={() => run((c) => c.toggleItalic())}>
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => run((c) => c.toggleStrike())}>
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarButton>

      <div className="w-px h-4 bg-border mx-1" />

      <ToolbarButton title="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => run((c) => c.toggleHeading({ level: 1 }))}>
        <Heading1 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => run((c) => c.toggleHeading({ level: 2 }))}>
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => run((c) => c.toggleHeading({ level: 3 }))}>
        <Heading3 className="h-3.5 w-3.5" />
      </ToolbarButton>

      <div className="w-px h-4 bg-border mx-1" />

      <ToolbarButton title="Bullet list" active={editor.isActive('bulletList')} onClick={() => run((c) => c.toggleBulletList())}>
        <List className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Numbered list" active={editor.isActive('orderedList')} onClick={() => run((c) => c.toggleOrderedList())}>
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="To-do list" active={editor.isActive('taskList')} onClick={() => run((c) => c.toggleTaskList())}>
        <ListChecks className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Quote" active={editor.isActive('blockquote')} onClick={() => run((c) => c.toggleBlockquote())}>
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Code block" active={editor.isActive('codeBlock')} onClick={() => run((c) => c.toggleCodeBlock())}>
        <Code className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Divider" onClick={() => run((c) => c.setHorizontalRule())}>
        <Minus className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Insert table"
        active={editor.isActive('table')}
        onClick={() => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
      >
        <TableIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      {onImage && (
        <ToolbarButton title="Image" onClick={onImage}>
          <ImageIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
      )}
      {onWebLink && (
        <ToolbarButton
          title={webLinks?.labels.toolbar ?? 'Link'}
          active={editor.isActive('link')}
          onClick={onWebLink}
        >
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
      )}
      {onDocumentLink && (
        <ToolbarButton
          title={documentLinks?.labels.toolbar ?? 'Link to document'}
          active={editor.isActive('documentLink')}
          onClick={onDocumentLink}
        >
          <Link2 className="h-3.5 w-3.5" />
        </ToolbarButton>
      )}

      {/* Pin controls — only while the cursor is inside a document link, which
          is the only moment "latest vs this version" means anything. Without a
          visible control the choice made at insert time is invisible and
          unchangeable, and a pin is exactly the kind of thing an author needs
          to see to trust. */}
      {documentLinks && editor.isActive('documentLink') && (
        <>
          <div className="w-px h-4 bg-border mx-1" />
          {(() => {
            const attrs = editor.getAttributes('documentLink') as {
              documentId?: string
              version?: number | null
            }
            const target = documentLinks.options.find((d) => d.id === attrs.documentId)
            const isPinned = attrs.version != null
            const latest = target?.version ?? null
            return (
              <>
                <ToolbarButton
                  title={
                    isPinned
                      ? `${documentLinks.labels.version(attrs.version!)} — ${documentLinks.labels.repin}`
                      : documentLinks.labels.pinLabel
                  }
                  active={isPinned}
                  // Unpin returns to "latest"; pin binds to the target's
                  // current latest, which is the only version an author can
                  // mean by "this one".
                  onClick={() =>
                    editor
                      .chain()
                      .focus()
                      .setDocumentLinkVersion(isPinned ? null : latest)
                      .run()
                  }
                >
                  {isPinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
                </ToolbarButton>
                <span className="px-1 text-[0.625rem] text-muted-foreground">
                  {isPinned
                    ? documentLinks.labels.version(attrs.version!)
                    : documentLinks.labels.latest}
                </span>
                <ToolbarButton
                  title={documentLinks.labels.unlink}
                  onClick={() => editor.chain().focus().unsetDocumentLink().run()}
                >
                  <Unlink className="h-3.5 w-3.5" />
                </ToolbarButton>
              </>
            )
          })()}
        </>
      )}

      {/* Table editing controls — only while the cursor is inside a table */}
      {editor.isActive('table') && (
        <>
          <div className="w-px h-4 bg-border mx-1" />
          <ToolbarButton title="Add column" onClick={() => run((c) => c.addColumnAfter())}>
            <span className="text-[0.625rem] font-semibold px-0.5">+Col</span>
          </ToolbarButton>
          <ToolbarButton title="Add row" onClick={() => run((c) => c.addRowAfter())}>
            <span className="text-[0.625rem] font-semibold px-0.5">+Row</span>
          </ToolbarButton>
          <ToolbarButton title="Delete column" onClick={() => run((c) => c.deleteColumn())}>
            <span className="text-[0.625rem] font-semibold px-0.5">−Col</span>
          </ToolbarButton>
          <ToolbarButton title="Delete row" onClick={() => run((c) => c.deleteRow())}>
            <span className="text-[0.625rem] font-semibold px-0.5">−Row</span>
          </ToolbarButton>
          <ToolbarButton title="Delete table" onClick={() => run((c) => c.deleteTable())}>
            <Trash2 className="h-3.5 w-3.5" />
          </ToolbarButton>
        </>
      )}
    </div>
  )
}

// ─── Slash command items + popup wiring ─────────────────────────────────────────

function buildSlashItems(opts: {
  placeholderText?: string
  requestImage?: () => void
  requestDocumentLink?: () => void
  documentLinkTitle?: string
  requestWebLink?: () => void
  webLinkTitle?: string
}): SlashItem[] {
  const items: SlashItem[] = [
    { title: 'Text', icon: Type, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).setNode('paragraph').run() },
    { title: 'Heading 1', icon: Heading1, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).toggleHeading({ level: 1 }).run() },
    { title: 'Heading 2', icon: Heading2, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).toggleHeading({ level: 2 }).run() },
    { title: 'Heading 3', icon: Heading3, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).toggleHeading({ level: 3 }).run() },
    { title: 'Bullet list', icon: List, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).toggleBulletList().run() },
    { title: 'Numbered list', icon: ListOrdered, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).toggleOrderedList().run() },
    { title: 'To-do list', icon: ListChecks, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).toggleTaskList().run() },
    { title: 'Quote', icon: Quote, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).toggleBlockquote().run() },
    { title: 'Code block', icon: Code, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).toggleCodeBlock().run() },
    { title: 'Divider', icon: Minus, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).setHorizontalRule().run() },
    { title: 'Table', icon: TableIcon, command: ({ editor, range }) => (editor as Editor).chain().focus().deleteRange(range as Range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ]
  if (opts.requestImage) {
    items.push({
      title: 'Image',
      icon: ImageIcon,
      command: ({ editor, range }) => {
        (editor as Editor).chain().focus().deleteRange(range as Range).run()
        opts.requestImage!()
      },
    })
  }
  if (opts.requestWebLink) {
    items.push({
      title: opts.webLinkTitle ?? 'Link',
      icon: LinkIcon,
      command: ({ editor, range }) => {
        (editor as Editor).chain().focus().deleteRange(range as Range).run()
        opts.requestWebLink!()
      },
    })
  }
  if (opts.requestDocumentLink) {
    items.push({
      title: opts.documentLinkTitle ?? 'Link to document',
      icon: Link2,
      command: ({ editor, range }) => {
        // Clear the "/query" first: the picker inserts a mark over text it adds
        // itself, and leaving the query in place would put the link inside it.
        (editor as Editor).chain().focus().deleteRange(range as Range).run()
        opts.requestDocumentLink!()
      },
    })
  }
  return items
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeSlashRenderer() {
  let component: ReactRenderer<SlashCommandListRef> | null = null
  let el: HTMLDivElement | null = null

  function place(rect: DOMRect | null | undefined) {
    if (!el || !rect) return
    el.style.position = 'fixed'
    el.style.left = `${rect.left}px`
    el.style.top = `${rect.bottom + 6}px`
    el.style.zIndex = '60'
  }

  return {
    onStart: (props: any) => {
      component = new ReactRenderer(SlashCommandList, { props, editor: props.editor })
      el = document.createElement('div')
      el.appendChild(component.element)
      document.body.appendChild(el)
      place(props.clientRect?.())
    },
    onUpdate: (props: any) => {
      component?.updateProps(props)
      place(props.clientRect?.())
    },
    onKeyDown: (props: any) => {
      if (props.event.key === 'Escape') return true
      return component?.ref?.onKeyDown(props) ?? false
    },
    onExit: () => {
      el?.remove()
      component?.destroy()
      el = null
      component = null
    },
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Editor ─────────────────────────────────────────────────────────────────

export const RichTextEditor = memo(function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight = 220,
  onUploadImage,
  documentLinks,
  webLinks,
}: {
  /** Initial HTML. Editor is uncontrolled after mount — remount via `key` to reset. */
  value: string
  onChange: (html: string) => void
  placeholder?: string
  minHeight?: number
  /** When provided, enables image insertion (slash + toolbar) that uploads via this fn. */
  onUploadImage?: (file: File) => Promise<string>
  /** When provided, enables linking to another document (slash + toolbar + pin). */
  documentLinks?: DocumentLinksConfig
  /** When provided, enables ordinary web links (slash + toolbar). */
  webLinks?: { labels: LinkDialogLabels & { toolbar: string; slashTitle: string } }
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  // DragHandle touches the DOM/floating-ui — only mount it client-side.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const requestImage = onUploadImage ? () => fileRef.current?.click() : undefined
  const requestDocumentLink = documentLinks ? () => setPickerOpen(true) : undefined
  const requestWebLink = webLinks ? () => setLinkOpen(true) : undefined

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: placeholder ?? 'Write something, or press “/” for commands…',
      }),
      ResizableImage,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      DocumentLink,
      SlashCommand.configure({
        suggestion: {
          char: '/',
          command: ({ editor, range, props }: { editor: unknown; range: unknown; props: SlashItem }) =>
            props.command({ editor, range }),
          items: ({ query }: { query: string }) =>
            buildSlashItems({
              requestImage,
              requestDocumentLink,
              documentLinkTitle: documentLinks?.labels.slashTitle,
              requestWebLink,
              webLinkTitle: webLinks?.labels.slashTitle,
            }).filter((i) => i.title.toLowerCase().includes(query.toLowerCase())),
          render: makeSlashRenderer,
        },
      }),
    ],
    content: value ?? '',
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class: 'prose-notes px-3 py-2.5 text-sm outline-none',
        style: `min-height:${minHeight}px`,
      },
    },
  })

  async function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !editor || !onUploadImage) return
    try {
      const url = await onUploadImage(file)
      editor.chain().focus().setImage({ src: url }).run()
    } catch {
      // onUploadImage surfaces its own error (e.g. file too large); abort insert.
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  /**
   * Insert the link, using the target's title as the anchor text when nothing
   * is selected. With a selection, the author's own words are marked instead —
   * "see our <house rules>" reads better than a title dropped mid-sentence.
   */
  function insertDocumentLink(attrs: { documentId: string; version: number | null }, title: string) {
    if (!editor) return
    const { empty } = editor.state.selection
    const chain = editor.chain().focus()
    if (empty) chain.insertContent(title).setTextSelection({
      from: editor.state.selection.from,
      to: editor.state.selection.from + title.length,
    })
    chain.setDocumentLink(attrs).run()
  }

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <Toolbar
        editor={editor}
        onImage={requestImage}
        onDocumentLink={requestDocumentLink}
        onWebLink={requestWebLink}
        documentLinks={documentLinks}
        webLinks={webLinks}
      />
      <div className="relative">
        {mounted && editor && (
          <DragHandle editor={editor}>
            <div className="flex h-5 w-4 items-center justify-center rounded text-muted-foreground/50 hover:bg-accent cursor-grab active:cursor-grabbing">
              <GripVertical className="h-4 w-4" />
            </div>
          </DragHandle>
        )}
        <EditorContent editor={editor} />
      </div>
      {onUploadImage && (
        <input ref={fileRef} type="file" accept="image/*" onChange={handleImageFile} className="hidden" />
      )}
      {webLinks && editor && (
        <LinkDialog
          open={linkOpen}
          onOpenChange={setLinkOpen}
          labels={webLinks.labels}
          editing={editor.isActive('link')}
          initialUrl={(editor.getAttributes('link').href as string | undefined) ?? ''}
          // Seed with the selected words when there are any, so "select text →
          // link it" works the way it does everywhere else.
          initialText={editor.state.doc.textBetween(
            editor.state.selection.from,
            editor.state.selection.to
          )}
          onRemove={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
          onSubmit={(url, text) => {
            const chain = editor.chain().focus()
            // An existing link: replace its whole extent, so editing the text of
            // a link does not leave half of the old words behind.
            if (editor.isActive('link')) chain.extendMarkRange('link')
            chain
              .insertContent({
                type: 'text',
                text,
                marks: [{ type: 'link', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' } }],
              })
              .run()
          }}
        />
      )}
      {documentLinks && (
        <DocumentLinkPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          documents={documentLinks.options}
          currentDocumentId={documentLinks.currentDocumentId}
          labels={documentLinks.labels}
          onPick={insertDocumentLink}
        />
      )}
    </div>
  )
})

/** What a renderer needs to turn stored document-link references into real links. */
export interface DocumentLinkRenderContext {
  /** The tenant whose public routes the links point into. */
  teamSlug: string
  /** documentId → its public mirror summary. A missing id means "not linkable". */
  targets: Map<string, DocumentLinkTarget>
  /**
   * Wraps the unprefixed public path — the caller owns locale prefixing, so
   * this never has to know about next-intl.
   */
  hrefFor?: (path: string) => string
  /** Appended to a pinned link's tooltip, e.g. "Version 3". */
  versionLabel?: (n: number) => string
}

export function RichTextContent({
  html,
  className,
  documentLinks,
}: {
  html: string
  className?: string
  /** Omit and document links render as plain text — the deliberate baseline. */
  documentLinks?: DocumentLinkRenderContext
}) {
  const ref = useRef<HTMLDivElement>(null)

  /**
   * Hydration happens on the DOM, not by rewriting the HTML string.
   *
   * The stored anchor carries no href on purpose (see shared/documentLink.ts),
   * so the un-hydrated baseline is the author's words as plain text rather than
   * a dead link. Setting the attribute here — rather than splicing strings into
   * `dangerouslySetInnerHTML` — means the sanitized markup is never re-parsed by
   * hand, and a target that has gone away simply stays plain text.
   */
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const anchors = root.querySelectorAll<HTMLAnchorElement>(`a[${DOCUMENT_LINK_ID_ATTR}]`)
    for (const a of anchors) {
      const documentId = a.getAttribute(DOCUMENT_LINK_ID_ATTR)
      if (!documentId) continue
      const version = parseDocumentLinkVersion(a.getAttribute(DOCUMENT_LINK_VERSION_ATTR))
      const resolved = documentLinks
        ? resolveDocumentLink(
            { documentId, version, label: a.textContent ?? '' },
            documentLinks.targets.get(documentId) ?? null,
            documentLinks.teamSlug,
          )
        : ({ kind: 'unavailable' as const, label: a.textContent ?? '' })

      if (resolved.kind === 'link') {
        a.setAttribute('href', documentLinks!.hrefFor?.(resolved.path) ?? resolved.path)
        a.classList.add('underline', 'underline-offset-2')
        if (resolved.pinned && resolved.version != null && documentLinks!.versionLabel) {
          a.setAttribute('title', documentLinks!.versionLabel(resolved.version))
        }
      } else {
        // Explicitly REMOVE rather than leave whatever was there: this effect
        // re-runs when the targets arrive, and a link that has since gone away
        // must lose its href, not keep a stale one.
        a.removeAttribute('href')
        a.removeAttribute('title')
        a.classList.remove('underline', 'underline-offset-2')
      }
    }
  }, [html, documentLinks])

  return (
    <div
      ref={ref}
      className={`prose-notes text-sm ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
