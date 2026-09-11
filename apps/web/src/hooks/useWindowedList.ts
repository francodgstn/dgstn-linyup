'use client'

// DOM WINDOWING for a long list on a page the WINDOW scrolls — the contacts
// roster, the affiliation tables. Only the rows near the viewport are mounted;
// two spacers hold the rest of the height so the scrollbar and the anchors
// stay honest.
//
// WHY THIS EXISTS. The roster pages are client-side by design: filter presets,
// dynamic groups, the attention sort and search all run over the loaded list,
// and that is the right design up to a size (docs/scalability-2026-09.md §18).
// Past a couple of thousand rows the READ was never the cost — the RENDER was:
// every filter keystroke re-mounted thousands of rows. Windowing removes that
// cost without touching the read or the derivations, which is what makes it a
// Phase 2 change and not a rewrite.
//
// BELOW THE THRESHOLD IT DOES NOTHING. A list of eighty rows renders exactly
// as before — same DOM, no spacers, no measurement — so the common case has no
// new behaviour to get wrong, and `last:` border tricks keep working.
//
// HOW TO MOUNT IT. `listRef` goes on the element that CONTAINS the rows (a
// `<div>`, or a `<tbody>`), and nothing else may sit inside it: the spacers
// are computed from that element's top. Rows that vary in height get
// `data-index={index}` + `ref={measure}` on their outermost element; uniform
// rows (a table) can skip measuring and live off `estimateSize`.

import { useCallback, useLayoutEffect, useRef, useState, type Key } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'

/** Lists at or under this many rows render plainly. */
export const WINDOW_THRESHOLD = 120

/** Distance from the top of the document — `offsetTop` alone is relative to
 *  the nearest positioned ancestor, which a card with `relative` on it is. */
function documentOffsetTop(el: HTMLElement): number {
  let top = 0
  let node: HTMLElement | null = el
  while (node) {
    top += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return top
}

export interface WindowedRow<T> {
  item: T
  index: number
  key: Key
}

export interface WindowedList<T> {
  /** Callback ref for the element that holds the rows and nothing else. */
  listRef: (el: HTMLElement | null) => void
  /** False under the threshold — every row is in `rows` and the spacers are 0. */
  windowed: boolean
  rows: WindowedRow<T>[]
  /** Height (px) of the rows above the first mounted one. */
  before: number
  /** Height (px) of the rows below the last mounted one. */
  after: number
  /** Attach to a row's outermost element (with `data-index`) when heights vary. */
  measure: ((el: HTMLElement | null) => void) | undefined
}

export function useWindowedList<T>(
  items: readonly T[],
  opts: {
    /** A typical row height in px. Measured rows correct it; unmeasured rows live on it. */
    estimateSize: number
    overscan?: number
    getKey?: (item: T, index: number) => Key
  }
): WindowedList<T> {
  const el = useRef<HTMLElement | null>(null)
  const listRef = useCallback((node: HTMLElement | null) => {
    el.current = node
  }, [])
  const [scrollMargin, setScrollMargin] = useState(0)
  const windowed = items.length > WINDOW_THRESHOLD

  // Re-measured whenever the document changes height: whatever sits above the
  // list (a filter panel opening, a banner, a shorter list) moves it, and a
  // stale margin renders blank rows. A ResizeObserver on the body sees every
  // such shift; the functional update makes an unchanged margin a no-op.
  useLayoutEffect(() => {
    if (!windowed) return
    const update = () => {
      const node = el.current
      if (!node) return
      const next = documentOffsetTop(node)
      setScrollMargin((prev) => (prev === next ? prev : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(document.body)
    return () => observer.disconnect()
  }, [windowed])

  const { getKey, estimateSize } = opts
  const virtualizer = useWindowVirtualizer({
    count: windowed ? items.length : 0,
    estimateSize: () => estimateSize,
    overscan: opts.overscan ?? 12,
    scrollMargin,
    getItemKey: getKey ? (index) => getKey(items[index]!, index) : undefined,
  })

  if (!windowed) {
    return {
      listRef,
      windowed: false,
      rows: items.map((item, index) => ({ item, index, key: getKey ? getKey(item, index) : index })),
      before: 0,
      after: 0,
      measure: undefined,
    }
  }

  const virtualRows = virtualizer.getVirtualItems()
  const first = virtualRows[0]
  const last = virtualRows[virtualRows.length - 1]
  return {
    listRef,
    windowed: true,
    rows: virtualRows.map((v) => ({ item: items[v.index]!, index: v.index, key: v.key })),
    before: first ? first.start - scrollMargin : 0,
    after: last ? virtualizer.getTotalSize() - (last.end - scrollMargin) : 0,
    measure: virtualizer.measureElement,
  }
}
