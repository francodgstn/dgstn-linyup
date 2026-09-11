'use client'

// The line under a paged list, and the one control that extends it.
//
// HONEST TRUNCATION (docs/scalability-2026-09.md §19): a capped list says so.
// A bare `limit` that hides rows without saying which is the one shape the
// plan forbids — so every paged list ends in this footer, which states what is
// shown (and of how many, when the caller has a count) and offers the rest.
// It renders nothing when the list is complete and the count agrees, because
// "Showing 12 of 12" is noise.

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

export function LoadMoreFooter({
  shown,
  total,
  hasMore,
  loading,
  onLoadMore,
  className = '',
}: {
  shown: number
  /** From a count aggregation, when the surface has one. */
  total?: number
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  className?: string
}) {
  const t = useTranslations('Common')
  const complete = !hasMore && (total === undefined || shown >= total)
  if (complete) return null
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground ${className}`}
    >
      <span>
        {total !== undefined ? t('showingOf', { shown, total }) : t('showingCount', { count: shown })}
      </span>
      {hasMore && (
        <Button size="sm" variant="outline" disabled={loading} onClick={onLoadMore}>
          {loading ? t('loading') : t('loadMore')}
        </Button>
      )}
    </div>
  )
}
