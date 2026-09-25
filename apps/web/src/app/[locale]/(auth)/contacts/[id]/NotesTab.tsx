'use client'

import { useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useTeamFormat } from '@/hooks/useTeamFormat'
import {
  collection, query, orderBy, getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION, CONTACT_NOTES_SUBCOLLECTION } from '@linyup/shared'
import type { Contact } from '@linyup/shared'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold, Italic, Strikethrough, Code, Heading2, Heading3,
  List, ListOrdered, Quote, Plus, Pencil, Trash2, X, Check,
} from 'lucide-react'
import { Tip } from '@/components/ui/tip'

// ─── types ────────────────────────────────────────────────────────────────────

export interface ContactNote {
  id: string
  content: string
  /** The colour TAG's name — never a hex value. See NOTE_COLORS. Absent = the
   *  plain card, which stays the default. */
  color?: NoteColor
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * Post-it colour tags for notes (UX-96) — a SMALL FIXED PALETTE, not a colour
 * picker, and the stored value is the NAME.
 *
 * A hex chosen against a white card is unreadable on a dark one, and once it is
 * in Firestore it cannot be re-themed: every note ever written would keep a
 * literal colour from whatever the app looked like the day it was typed. A name
 * resolves per theme, here, in one map — which is also what keeps the set small
 * enough to mean something at a glance. Grouping is the whole point; a
 * free-form picker produces forty near-identical yellows and groups nothing.
 */
export const NOTE_COLORS = ['none', 'yellow', 'green', 'blue', 'pink', 'purple'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

/** name → the classes it resolves to, light and dark. The ONE place a colour
 *  name becomes pixels; a surface that renders a note reads it from here. */
export const NOTE_COLOR_CLASSES: Record<NoteColor, { card: string; swatch: string }> = {
  none: { card: 'bg-card border-border', swatch: 'bg-muted border-border' },
  yellow: {
    card: 'bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-900',
    swatch: 'bg-amber-200 border-amber-300 dark:bg-amber-800 dark:border-amber-700',
  },
  green: {
    card: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900',
    swatch: 'bg-emerald-200 border-emerald-300 dark:bg-emerald-800 dark:border-emerald-700',
  },
  blue: {
    card: 'bg-sky-50 border-sky-200 dark:bg-sky-950/40 dark:border-sky-900',
    swatch: 'bg-sky-200 border-sky-300 dark:bg-sky-800 dark:border-sky-700',
  },
  pink: {
    card: 'bg-pink-50 border-pink-200 dark:bg-pink-950/40 dark:border-pink-900',
    swatch: 'bg-pink-200 border-pink-300 dark:bg-pink-800 dark:border-pink-700',
  },
  purple: {
    card: 'bg-violet-50 border-violet-200 dark:bg-violet-950/40 dark:border-violet-900',
    swatch: 'bg-violet-200 border-violet-300 dark:bg-violet-800 dark:border-violet-700',
  },
}

/** Tolerant read: an unknown or absent name falls back to the plain card rather
 *  than rendering nothing — a note must never disappear over a colour. */
export function noteColorClasses(color: string | null | undefined): { card: string; swatch: string } {
  return NOTE_COLOR_CLASSES[(color ?? 'none') as NoteColor] ?? NOTE_COLOR_CLASSES.none
}

// ─── data ─────────────────────────────────────────────────────────────────────
// Shared fetcher + query key so the list view and the header badge read the same
// cache entry — adding/deleting a note in the panel keeps the badge count live.

async function fetchContactNotes(contactId: string): Promise<ContactNote[]> {
  const snap = await getDocs(
    query(
      collection(db, CONTACTS_COLLECTION, contactId, CONTACT_NOTES_SUBCOLLECTION),
      orderBy('created_at', 'desc')
    )
  )
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }) as ContactNote)
}

export function useContactNotesCount(contactId: string) {
  return useQuery({
    queryKey: ['contact-notes', contactId],
    queryFn: () => fetchContactNotes(contactId),
    select: (notes) => notes.length,
  })
}

// Shared list hook — the header sheet and the profile-column glance read the same
// cache entry, so add/edit/delete in the panel keeps the glance cards live.
export function useContactNotes(contactId: string) {
  return useQuery<ContactNote[]>({
    queryKey: ['contact-notes', contactId],
    queryFn: () => fetchContactNotes(contactId),
  })
}

// ─── toolbar ──────────────────────────────────────────────────────────────────

function ToolbarButton({
  active, disabled, onClick, children, title,
}: {
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  title: string
}) {
  // Icon-only, like every button in this toolbar — see RichTextEditor.
  return (
    <Tip label={title}>
      <button
        type="button"
        aria-label={title}
        disabled={disabled}
        onClick={onClick}
        className={`p-1.5 rounded transition-colors ${
          active
            ? 'bg-foreground/10 text-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
        } disabled:opacity-40`}
      >
        {children}
      </button>
    </Tip>
  )
}

function Toolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null
  return (
    <div className="flex items-center gap-0.5 flex-wrap px-2 py-1.5 border-b">
      <ToolbarButton title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code className="h-3.5 w-3.5" />
      </ToolbarButton>

      <div className="w-px h-4 bg-border mx-1" />

      <ToolbarButton title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 className="h-3.5 w-3.5" />
      </ToolbarButton>

      <div className="w-px h-4 bg-border mx-1" />

      <ToolbarButton title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Ordered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton title="Blockquote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>
    </div>
  )
}

// ─── editor ───────────────────────────────────────────────────────────────────

function NoteEditor({
  initialContent,
  initialColor,
  onSave,
  onCancel,
  saving,
}: {
  initialContent?: string
  initialColor?: NoteColor
  onSave: (html: string, color: NoteColor) => Promise<void>
  onCancel: () => void
  saving: boolean
}) {
  const t = useTranslations('Contacts')
  const [editorEmpty, setEditorEmpty] = useState(!initialContent)
  const [color, setColor] = useState<NoteColor>(initialColor ?? 'none')

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialContent ?? '',
    autofocus: true,
    onUpdate: ({ editor }) => setEditorEmpty(editor.isEmpty),
    onCreate: ({ editor }) => setEditorEmpty(editor.isEmpty),
    editorProps: {
      attributes: {
        class: 'prose-notes min-h-[120px] px-3 py-2.5 text-sm outline-none',
      },
    },
  })

  const handleSave = useCallback(async () => {
    if (!editor || editor.isEmpty) return
    await onSave(editor.getHTML(), color)
  }, [editor, onSave, color])

  return (
    <div className={`rounded-lg border overflow-hidden ${noteColorClasses(color).card}`}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t bg-muted/30">
        {/* The palette. Six swatches, no picker — see NOTE_COLORS. */}
        <div className="flex items-center gap-1.5">
          {NOTE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-pressed={color === c}
              aria-label={t(`noteColor_${c}` as 'noteColor_none')}
              title={t(`noteColor_${c}` as 'noteColor_none')}
              className={`h-4 w-4 rounded-full border transition-transform ${
                noteColorClasses(c).swatch
              } ${color === c ? 'ring-2 ring-foreground/40 scale-110' : 'hover:scale-110'}`}
            />
          ))}
        </div>
        <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
          {t('cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || editorEmpty}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          {saving ? '…' : t('save')}
        </button>
        </div>
      </div>
    </div>
  )
}

// ─── note card ────────────────────────────────────────────────────────────────

function NoteCard({
  note,
  onEdit,
  onDelete,
}: {
  note: ContactNote
  onEdit: (note: ContactNote) => void
  onDelete: (id: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  const fmt = useTeamFormat()
  const dateLabel = fmt.custom(note.updated_at, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  return (
    <div className={`group rounded-lg border ${noteColorClasses(note.color).card}`}>
      {/* Header row */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-xs text-muted-foreground">{dateLabel}</span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {confirmDelete ? (
            <>
              <span className="text-xs text-destructive mr-1">Delete?</span>
              <button
                onClick={() => onDelete(note.id)}
                className="p-1 rounded text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="p-1 rounded text-muted-foreground hover:bg-muted transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onEdit(note)}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
      {/* Content */}
      <div
        className="prose-notes px-3 pb-3 text-sm"
        dangerouslySetInnerHTML={{ __html: note.content }}
      />
    </div>
  )
}

// ─── main tab ─────────────────────────────────────────────────────────────────

export function NotesTab({ contact }: { contact: Contact }) {
  const t = useTranslations('Contacts')
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editingNote, setEditingNote] = useState<ContactNote | null>(null)
  const [saving, setSaving] = useState(false)

  const notesRef = collection(db, CONTACTS_COLLECTION, contact.id, CONTACT_NOTES_SUBCOLLECTION)

  const { data: notes = [], isLoading } = useQuery<ContactNote[]>({
    queryKey: ['contact-notes', contact.id],
    queryFn: () => fetchContactNotes(contact.id),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['contact-notes', contact.id] })

  const handleAdd = async (html: string, color: NoteColor) => {
    setSaving(true)
    try {
      await addDoc(notesRef, {
        content: html,
        // The NAME, and only when it says something — an uncoloured note stores
        // no colour field at all.
        ...(color !== 'none' ? { color } : {}),
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      })
      setAdding(false)
      await invalidate()
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = async (html: string, color: NoteColor) => {
    if (!editingNote) return
    setSaving(true)
    try {
      await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id, CONTACT_NOTES_SUBCOLLECTION, editingNote.id), {
        content: html,
        // Written unconditionally on an edit: clearing a colour has to be
        // expressible, and an omitted key on an update leaves the old one.
        color: color === 'none' ? null : color,
        updated_at: serverTimestamp(),
      })
      setEditingNote(null)
      await invalidate()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    await deleteDoc(doc(db, CONTACTS_COLLECTION, contact.id, CONTACT_NOTES_SUBCOLLECTION, id))
    await invalidate()
  }

  if (isLoading) {
    return (
      <div className="space-y-2 pt-1">
        {[1, 2].map(i => <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />)}
      </div>
    )
  }

  return (
    <div className="space-y-3 pt-1">
      {/* Add note button / inline editor */}
      {adding ? (
        <NoteEditor
          onSave={handleAdd}
          onCancel={() => setAdding(false)}
          saving={saving}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg border border-dashed text-sm text-muted-foreground hover:text-foreground hover:border-border transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('notesAddNote')}
        </button>
      )}

      {/* Notes list */}
      {notes.length === 0 && !adding && (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('noNotes')}</p>
      )}

      {notes.map(note => (
        editingNote?.id === note.id ? (
          <NoteEditor
            key={note.id}
            initialContent={note.content}
            initialColor={note.color}
            onSave={handleUpdate}
            onCancel={() => setEditingNote(null)}
            saving={saving}
          />
        ) : (
          <NoteCard
            key={note.id}
            note={note}
            onEdit={setEditingNote}
            onDelete={handleDelete}
          />
        )
      ))}
    </div>
  )
}
