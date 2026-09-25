'use client'

/**
 * FloatingDock — the ONE owner of where floating controls sit.
 *
 * The problem (UX-9). The shell mounts its overlays after `<main>` (the AI
 * assistant launcher, the feedback tab); a page mounts its primary action
 * inside it (a "New …" FAB, the floating Save on a dirty form). Both used to
 * hardcode the bottom-right corner at the same z-layer, so the shell's button
 * painted over the page's Save and swallowed the tap — a manager tapping Save
 * on an edited contact opened the AI chat, and backing out lost her edits.
 * Holding the two apart with an offset (the interim `bottom-24`) works only
 * until somebody adds a third control, because the offset is invisible from
 * both ends: neither component can see the other's number.
 *
 * The fix. A control declares a LANE; the dock owns the geometry. The bottom
 * lanes are separate DOM children of ONE flex column in a fixed order, so they
 * cannot land on the same pixel — the separation is structural and there is no
 * number for a new control to have to know. A page mounts its primary action
 * without knowing what the shell has mounted, and vice versa.
 *
 * Bottom column, from the corner upwards:
 *   'page-bar'      full-width centered bar (bulk-selection / renew bars)
 *   'page-primary'  the page's ONE primary floating action (FAB, floating Save)
 *   'shell'         shell-level overlays (the AI assistant launcher)
 * Its own region, deliberately outside that column:
 *   'shell-edge'    right edge at mid height (the feedback tab)
 *
 * An empty lane collapses (`empty:hidden`), so a page with no primary action
 * leaves no hole and the shell overlay simply sits in the corner.
 *
 * Adding a floating control means adding a `<FloatingSlot lane="…">` — never a
 * `fixed bottom-*` class, and never an offset tuned against another component.
 *
 * Layering. The dock owns a single z-index for everything in it, which sits
 * below the dialog/sheet layer (z-50) on purpose. The hand-rolled success
 * toasts scattered across the app also sit at z-50 and are NOT dock lanes yet,
 * so a toast can still paint over a lane; giving them a `'notice'` lane here is
 * the fix, and belongs with the finding that owns those toasts.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

export type FloatingLane = 'page-bar' | 'page-primary' | 'shell' | 'shell-edge'

/** Region geometry — the only `fixed` positions in the floating layer. */
const REGION = {
  bottom:
    'pointer-events-none fixed inset-x-0 bottom-6 z-40 flex flex-col-reverse items-end gap-3 px-6',
  edge:
    'pointer-events-none fixed right-0 top-1/2 z-40 flex -translate-y-1/2 flex-col items-end gap-2',
} as const

/**
 * Lane node: how occupants of one lane arrange among themselves. A lane
 * normally holds one control, but it stacks rather than overlaps if it holds
 * two — `flex-col-reverse` throughout, so the first one mounted stays nearest
 * the corner. `empty:hidden` collapses an unoccupied lane so it contributes no
 * gap to the region above it.
 */
const LANE_NODE: Record<FloatingLane, string> = {
  'page-bar': 'empty:hidden flex w-full flex-col-reverse items-center gap-2',
  'page-primary': 'empty:hidden flex flex-col-reverse items-end gap-3',
  shell: 'empty:hidden flex flex-col-reverse items-end gap-3',
  'shell-edge': 'empty:hidden flex flex-col-reverse items-end gap-2',
}

const LANE_REGION: Record<FloatingLane, keyof typeof REGION> = {
  'page-bar': 'bottom',
  'page-primary': 'bottom',
  shell: 'bottom',
  'shell-edge': 'edge',
}

type LaneNodes = Record<FloatingLane, HTMLDivElement | null>

const NO_NODES: LaneNodes = {
  'page-bar': null,
  'page-primary': null,
  shell: null,
  'shell-edge': null,
}

const FloatingDockContext = createContext<LaneNodes | null>(null)

/**
 * Mount once, wrapping everything that may contribute a floating control — the
 * page tree AND the shell's own overlays.
 */
export function FloatingDock({ children }: { children?: ReactNode }) {
  const [nodes, setNodes] = useState<LaneNodes>(NO_NODES)

  const setNode = useCallback((lane: FloatingLane, el: HTMLDivElement | null) => {
    setNodes((prev) => (prev[lane] === el ? prev : { ...prev, [lane]: el }))
  }, [])

  // Stable ref callbacks — a fresh identity each render would make React
  // detach/reattach (and so re-setState) on every pass.
  const refs = useMemo(
    () => ({
      'page-bar': (el: HTMLDivElement | null) => setNode('page-bar', el),
      'page-primary': (el: HTMLDivElement | null) => setNode('page-primary', el),
      shell: (el: HTMLDivElement | null) => setNode('shell', el),
      'shell-edge': (el: HTMLDivElement | null) => setNode('shell-edge', el),
    }),
    [setNode],
  )

  return (
    <FloatingDockContext.Provider value={nodes}>
      {children}
      {/* DOM order here IS the stacking order: first child sits at the corner. */}
      <div className={REGION.bottom} data-floating-region="bottom">
        <div ref={refs['page-bar']} className={LANE_NODE['page-bar']} />
        <div ref={refs['page-primary']} className={LANE_NODE['page-primary']} />
        <div ref={refs.shell} className={LANE_NODE.shell} />
      </div>
      <div className={REGION.edge} data-floating-region="edge">
        <div ref={refs['shell-edge']} className={LANE_NODE['shell-edge']} />
      </div>
    </FloatingDockContext.Provider>
  )
}

/**
 * Put a floating control in a lane. `className` styles the slot wrapper — use
 * it for responsive gating (`sm:hidden`), never for position.
 *
 * A `<button type="submit">` moved here leaves its `<form>` in the DOM, so give
 * the form an `id` and the button a matching `form={id}`.
 */
export function FloatingSlot({
  lane,
  className,
  children,
}: {
  lane: FloatingLane
  className?: string
  children: ReactNode
}) {
  const nodes = useContext(FloatingDockContext)
  const content = <div className={cn('pointer-events-auto', className)}>{children}</div>

  // No dock in this tree (a public route, say): render the lane standalone so
  // the control still shows. Nothing can collide with it there — the shell
  // overlays are what mount the dock in the first place.
  if (!nodes) {
    return (
      <div className={REGION[LANE_REGION[lane]]}>
        <div className={LANE_NODE[lane]}>{content}</div>
      </div>
    )
  }

  const node = nodes[lane]
  if (!node) return null // dock is still mounting; the slot lands next paint
  return createPortal(content, node)
}
