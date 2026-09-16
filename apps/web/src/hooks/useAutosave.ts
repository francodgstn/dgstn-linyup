'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * AUTOSAVE — A DRAFT THAT SAVES ITSELF, WITHOUT A LOOP THAT SAVES FOREVER.
 *
 * The editor keeps its draft in React state and writes it with `save`. This
 * hook calls `save` once the edits have been quiet for `delayMs`, so "Save
 * draft" stops being something a studio owner has to remember. Publishing is
 * untouched: a saved draft is still a draft, and only Publish changes what
 * visitors see.
 *
 * `revision` is the editor's edit counter — bumped on every change. It is what
 * makes the two failure modes safe:
 *
 *   - An edit made WHILE a save is in flight must not be marked saved by that
 *     save. The editor's `save` compares the counter it started with against
 *     the current one before clearing its dirty flag, and this hook re-arms on
 *     the new revision, so the late edit gets a save of its own.
 *   - A save that FAILS must not be retried every `delayMs` for as long as the
 *     tab is open (a toast storm, and a hammered backend). A failure parks
 *     autosave on that revision; the next edit, or an explicit retry, re-arms
 *     it. `failed` tells the editor to show a retry.
 *
 * `paused` holds autosave off while something else owns the draft — a publish,
 * which saves first itself, or a save already running.
 */
export function useAutosave({
  revision,
  dirty,
  paused,
  save,
  delayMs = 1500,
}: {
  revision: number
  dirty: boolean
  paused: boolean
  save: () => Promise<boolean>
  delayMs?: number
}): { failed: boolean } {
  const [failedAt, setFailedAt] = useState<number | null>(null)
  // The timer fires after later renders; it must call THAT render's save, which
  // closes over the latest draft.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  useEffect(() => {
    if (!dirty || paused || failedAt === revision) return
    const timer = setTimeout(() => {
      void saveRef.current().then((ok) => {
        if (!ok) setFailedAt(revision)
      })
    }, delayMs)
    return () => clearTimeout(timer)
  }, [revision, dirty, paused, failedAt, delayMs])

  return { failed: dirty && failedAt === revision }
}
