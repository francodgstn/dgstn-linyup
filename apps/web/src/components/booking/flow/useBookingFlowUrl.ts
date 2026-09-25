'use client'

import { useEffect, useRef } from 'react'
import { useStepUrl } from '@/hooks/useStepUrl'

// THE URL IS A FUNCTION OF THE STEP. One effect owns the whole mapping, rather
// than a push at each transition: between them the two public funnels change
// step in more than a dozen places, and a push forgotten at any one of them
// breaks Back for that branch only, silently, and on the branch nobody
// clicked through.
//
// `useStepUrl` (hooks/useStepUrl.ts) owns the history mechanics: raw
// `pushState` so the loaded activities/coaches survive Back with no refetch,
// the marker that tells this app's entries from the locale redirect's, and the
// restore counter. THIS owns the decision the two funnels had each written out
// for themselves, down to the same four refs and the same early returns.
//
// Three rules live here, and each of them was a bug first.
//
// **A restore writes nothing.** popstate has already put the URL where it
// belongs; writing back would add a duplicate entry Back then has to walk
// twice. The run that follows a restore is recognized by the COUNTER moving,
// never by a flag on a timer: an `isRestoring` flag cleared in
// requestAnimationFrame never clears in a backgrounded tab, and every later
// step then stops updating the URL with nothing on screen to say so.
//
// **Only a real step transition pushes.** Refinements inside a step (paging
// the calendar, picking another length) REWRITE, or Back walks day by day
// before it ever leaves the step.
//
// **A terminal step rewrites too.** Back must never re-enter the screen that
// submitted something, or the visitor books the same thing twice. The step
// list is the caller's, because only the flow knows which of its screens are
// endings.
//
// Nothing is returned on purpose. Both funnels used `stepUrl` only from inside
// this effect, and a caller holding `push` again is a caller that can put the
// URL somewhere the step machine does not agree with.

export interface BookingFlowUrlOptions<S extends string> {
  /** The step the flow is showing. */
  step: S
  /**
   * The canonical query for that step. All steps of a funnel stay on ONE
   * pathname: pushing a different path turns popstate into a real route
   * transition, which remounts the wizard and refetches everything.
   */
  query: Record<string, string | number | undefined>
  /**
   * False while the flow's own data is still loading. Nothing is written
   * before it is true. The step shown during a load is not a step the visitor
   * chose.
   */
  ready: boolean
  /** Screens Back must never re-enter. They rewrite instead of pushing. */
  terminalSteps?: readonly S[]
  /** Re-derive the step from these params. Do NOT set state that pushes. */
  onRestore: (params: URLSearchParams) => void
  /** Params that ride on every entry: `from`, `referral`. */
  sticky?: Record<string, string | number | undefined>
  /** The flow is running somewhere that owns its own history (an overlay). */
  disabled?: boolean
}

export function useBookingFlowUrl<S extends string>({
  step,
  query,
  ready,
  terminalSteps,
  onRestore,
  sticky,
  disabled,
}: BookingFlowUrlOptions<S>): void {
  const stepUrl = useStepUrl({ onRestore, sticky, disabled })

  const syncedQueryRef = useRef<string | null>(null)
  const prevStepRef = useRef<S | null>(null)
  const seenRestoreRef = useRef(0)

  // The serialized query IS the dependency. Both funnels listed the fields
  // they thought it was built from, and both lists had already drifted from
  // the query beside them (the picker's omitted the place an offer is taught
  // at, which two entries of one activity differ by). Comparing the whole
  // thing cannot drift, and costs one JSON.stringify of a handful of keys.
  const key = JSON.stringify(query)
  const isTerminal = terminalSteps?.includes(step) === true

  useEffect(() => {
    if (!ready) return
    // This run is the restore's own re-render. Record what it landed on and
    // write nothing.
    if (stepUrl.restoreCount() !== seenRestoreRef.current) {
      seenRestoreRef.current = stepUrl.restoreCount()
      syncedQueryRef.current = key
      prevStepRef.current = step
      return
    }
    if (syncedQueryRef.current === key) return
    const isFirst = syncedQueryRef.current === null
    const stepChanged = prevStepRef.current !== step
    syncedQueryRef.current = key
    prevStepRef.current = step
    if (isFirst || !stepChanged || isTerminal) stepUrl.replace(query)
    else stepUrl.push(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, step, ready, isTerminal])
}
