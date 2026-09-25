'use client'

// ─── ONE SAVE PER PAGE, AT THE BOTTOM, ONLY WHEN THERE IS SOMETHING TO SAVE ──
//
// `SettingsSaveBar` settled WHERE a section's Save sits. It left one Save per
// section, so Settings → General alone carried three: identity, region, and
// engagement bands. The studio then has to remember which box it typed in,
// and "did that save?" is a question asked three times per page.
//
// This is the page-level answer (Cloudflare / Shopify admin pattern). Every
// editable section on a page REGISTERS with the provider. It says whether it is
// dirty and valid, and how to save and reset itself. The provider shows one
// floating bar — "Unsaved changes · Discard · Save" — while any section is
// dirty, and nothing at all while none is. The bar is the page's only Save.
//
// ── WHAT A SECTION KEEPS ────────────────────────────────────────────────────
// Its own draft, its own validation, its own write. Nothing about a section's
// data moves into the provider, so a section can be lifted onto another page by
// moving one component. `save()` resolves `true` on success; on failure the
// section reports its own error (it knows the words) and resolves `false`,
// which keeps the bar up.
//
// ── WHY THE BAR SITS IN THE DOCK'S `page-bar` LANE ──────────────────────────
// A fixed bar positioned by hand is how the setup pill ended up covering the
// Save it was meant to leave room for (see FloatingDock). The lane owns the
// geometry, and the pill shape matches the contacts bulk-selection bar, so a
// floating bar means the same kind of thing everywhere.
//
// ── LEAVING WITH UNSAVED EDITS ──────────────────────────────────────────────
// `beforeunload` covers reloads, closing the tab and external links. In-app
// navigation is not intercepted: the App Router exposes no hook for it, and a
// half-working guard is worse than an honest bar that stays in sight.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Check, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { FloatingSlot } from '@/components/layout/FloatingDock'
import { Button } from '@/components/ui/button'

export type SaveBarSection = {
  dirty: boolean
  /** `false` blocks Save for the whole page. The section shows its own error. */
  valid: boolean
  /** Resolve `true` on success. On failure report the error and resolve `false`. */
  save: () => Promise<boolean>
  /** Put the draft back to the stored values. */
  reset: () => void
}

type Registry = {
  update: (id: string, state: { dirty: boolean; valid: boolean }) => void
  remove: (id: string) => void
  handlers: React.MutableRefObject<Map<string, Pick<SaveBarSection, 'save' | 'reset'>>>
}

const SaveBarContext = createContext<Registry | null>(null)

export function SaveBarProvider({
  children,
  disabled = false,
}: {
  children: ReactNode
  /** Read-only viewers (a manager on an owner-only page): the bar never shows. */
  disabled?: boolean
}) {
  const t = useTranslations('Common')
  const [states, setStates] = useState<Record<string, { dirty: boolean; valid: boolean }>>({})
  const handlers = useRef(new Map<string, Pick<SaveBarSection, 'save' | 'reset'>>())
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const update = useCallback((id: string, next: { dirty: boolean; valid: boolean }) => {
    setStates((prev) => {
      const cur = prev[id]
      if (cur && cur.dirty === next.dirty && cur.valid === next.valid) return prev
      return { ...prev, [id]: next }
    })
  }, [])

  const remove = useCallback((id: string) => {
    handlers.current.delete(id)
    setStates((prev) => {
      if (!(id in prev)) return prev
      const rest = { ...prev }
      delete rest[id]
      return rest
    })
  }, [])

  const registry = useMemo<Registry>(() => ({ update, remove, handlers }), [update, remove])

  const dirtyIds = Object.keys(states).filter((id) => states[id].dirty)
  const dirty = !disabled && dirtyIds.length > 0
  const valid = dirtyIds.every((id) => states[id].valid)

  const saveAll = useCallback(async () => {
    if (saving || !valid) return
    setSaving(true)
    try {
      // In parallel. Each section writes its own fields, so no ordering between
      // them means anything, and one section failing must not hold up the rest.
      const results = await Promise.all(
        dirtyIds.map((id) => handlers.current.get(id)?.save() ?? Promise.resolve(true))
      )
      if (results.every(Boolean)) {
        setJustSaved(true)
        setTimeout(() => setJustSaved(false), 2000)
      }
    } finally {
      setSaving(false)
    }
  }, [saving, valid, dirtyIds])

  function discardAll() {
    for (const id of dirtyIds) handlers.current.get(id)?.reset()
  }

  // Ctrl/⌘+S saves the page instead of opening the browser's "Save page as".
  // Only intercepted while there is something to save.
  useEffect(() => {
    if (!dirty) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveAll()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, saveAll])

  useEffect(() => {
    if (!dirty) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  return (
    <SaveBarContext.Provider value={registry}>
      {children}
      {(dirty || justSaved) && (
        <FloatingSlot lane="page-bar">
          <div
            role="region"
            aria-label={t('unsavedChanges')}
            className="flex items-center gap-3 rounded-full border bg-card py-1.5 pl-4 pr-1.5 shadow-lg animate-in fade-in-0 slide-in-from-bottom-4 duration-200"
          >
            {dirty ? (
              <>
                <span className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
                  {/* The Linyup violet, and the one spot of colour on the bar:
                      it says "something here is yours and not stored yet". */}
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                  </span>
                  {valid ? t('unsavedChanges') : t('unsavedChangesInvalid')}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="rounded-full"
                    disabled={saving}
                    onClick={discardAll}
                  >
                    {t('discard')}
                  </Button>
                  <Button
                    size="sm"
                    className="rounded-full"
                    disabled={saving || !valid}
                    onClick={() => void saveAll()}
                  >
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                    {saving ? t('saving') : t('save')}
                  </Button>
                </div>
              </>
            ) : (
              <span
                className="flex items-center gap-2 py-1 pr-3 text-sm font-medium"
                aria-live="polite"
              >
                <Check className="h-4 w-4 text-primary" />
                {t('saved')}
              </span>
            )}
          </div>
        </FloatingSlot>
      )}
    </SaveBarContext.Provider>
  )
}

/**
 * Register one editable section with the page's save bar. Call it on every
 * render: the latest `save`/`reset` closures are what the bar runs.
 */
export function useSaveBarSection(id: string, section: SaveBarSection) {
  const registry = useContext(SaveBarContext)
  const { dirty, valid, save, reset } = section

  // No deps: the closures change every render and the bar must run the latest.
  useEffect(() => {
    registry?.handlers.current.set(id, { save, reset })
  })

  useEffect(() => {
    registry?.update(id, { dirty, valid })
  }, [registry, id, dirty, valid])

  useEffect(() => {
    if (!registry) return
    return () => registry.remove(id)
  }, [registry, id])

  return { inSaveBar: !!registry }
}
