'use client'

import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { FileText, Pin } from 'lucide-react'
import { documentLinkOptions } from '@linyup/shared'
import type { DocumentLinkAttrs } from './DocumentLink'

/** One linkable document, as the picker needs it. */
export interface DocumentLinkOption {
  id: string
  title: string
  /** The document's latest published version, or null if it has none. */
  version?: number | null
  /** False for a draft / unshared document — offered, but flagged. */
  isPublic?: boolean
}

/**
 * Strings come from the caller, which has `useTranslations`. RichTextEditor
 * itself is i18n-agnostic (every other label in it is a plain prop or a
 * hardcoded toolbar tooltip), and threading a namespace through it just to
 * reach this dialog would be the odd one out.
 */
export interface DocumentLinkLabels {
  insertTitle: string
  insertDescription: string
  search: string
  empty: string
  noResults: string
  pinLabel: string
  pinHint: string
  unpublished: string
  latest: string
  version: (n: number) => string
  cancel: string
  insert: string
}

export function DocumentLinkPicker({
  open,
  onOpenChange,
  documents,
  currentDocumentId,
  labels,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  documents: DocumentLinkOption[]
  currentDocumentId: string
  labels: DocumentLinkLabels
  onPick: (attrs: DocumentLinkAttrs, label: string) => void
}) {
  const [search, setSearch] = useState('')
  const [pinned, setPinned] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Through the shared helper, so the document being edited can never be
  // offered — the same rule the insert command enforces on the other side.
  const options = useMemo(
    () => documentLinkOptions(documents, currentDocumentId),
    [documents, currentDocumentId],
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? options.filter((d) => d.title.toLowerCase().includes(q)) : options
  }, [options, search])

  const selected = filtered.find((d) => d.id === selectedId) ?? null
  // Pinning needs a version to pin TO. A target that has never been published
  // has none, so the toggle is offered but cannot bind.
  const pinnable = selected?.version != null

  function reset() {
    setSearch('')
    setPinned(false)
    setSelectedId(null)
  }

  function confirm() {
    if (!selected) return
    onPick(
      { documentId: selected.id, version: pinned && pinnable ? selected.version! : null },
      selected.title,
    )
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{labels.insertTitle}</DialogTitle>
          <DialogDescription>{labels.insertDescription}</DialogDescription>
        </DialogHeader>

        {options.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          <>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={labels.search}
              autoFocus
            />

            <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{labels.noResults}</p>
              ) : (
                filtered.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setSelectedId(d.id)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                      selectedId === d.id ? 'bg-accent' : 'hover:bg-accent/50'
                    }`}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{d.title}</span>
                    {d.isPublic === false && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {labels.unpublished}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>

            <label
              className={`flex items-start gap-2 rounded-md border p-2.5 text-sm ${
                pinnable ? 'cursor-pointer' : 'opacity-50'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={pinned && pinnable}
                disabled={!pinnable}
                onChange={(e) => setPinned(e.target.checked)}
              />
              <span className="space-y-0.5">
                <span className="flex items-center gap-1.5 font-medium">
                  <Pin className="h-3.5 w-3.5" />
                  {labels.pinLabel}
                  {selected?.version != null && (
                    <span className="text-muted-foreground font-normal">
                      {labels.version(selected.version)}
                    </span>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">{labels.pinHint}</span>
              </span>
            </label>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {labels.cancel}
              </Button>
              <Button type="button" disabled={!selected} onClick={confirm}>
                {labels.insert}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
