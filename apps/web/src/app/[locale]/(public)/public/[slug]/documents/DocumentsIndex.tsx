'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { collectionGroup, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { FileText, Link2, ChevronRight } from 'lucide-react'
import type { DocumentPublicProfile } from '@linyup/shared'
import { QueryErrorState } from '@/components/ui/query-error'
import { loadFailureDetail, reportPublicLoadFailure } from '@/lib/publicQueryError'
import { usePublicTeam } from '../PublicTeamProvider'
import { PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'

// World-readable summaries only — collection-group query over
// documents/{id}/public_profile/{id}, never the root `documents` collection.
function usePublicDocuments(teamId: string) {
  const [state, setState] = useState<{
    loading: boolean
    docs: DocumentPublicProfile[]
    error: unknown
  }>({ loading: true, docs: [], error: null })
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(
          query(
            collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
            where('teamId', '==', teamId),
            where('type', '==', 'document'),
          ),
        )
        if (cancelled) return
        const docs = snap.docs
          .map((d) => d.data() as DocumentPublicProfile)
          .sort((a, b) => a.title.localeCompare(b.title))
        setState({ loading: false, docs, error: null })
      } catch (err: unknown) {
        // These are a studio's terms, policies and waivers. "This studio has
        // published no documents" is a statement about their legal posture —
        // never make it on the strength of a query that failed.
        if (cancelled) return
        reportPublicLoadFailure('documents/index', err)
        setState({ loading: false, docs: [], error: err })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, retryKey])

  return {
    ...state,
    retry: () => {
      setState((s) => ({ ...s, loading: true, error: null }))
      setRetryKey((k) => k + 1)
    },
  }
}

export function DocumentsIndex() {
  const t = useTranslations('Documents')
  const { slug, teamId, team } = usePublicTeam()
  const { loading, docs, error, retry } = usePublicDocuments(teamId)

  return (
    <div className="mx-auto max-w-xl py-8 px-4 space-y-5">
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{team.name}</p>
        <h1 className="text-2xl font-semibold">{t('publicIndexTitle')}</h1>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 rounded-lg border bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : error != null ? (
        <QueryErrorState onRetry={retry} detail={loadFailureDetail(error)} />
      ) : docs.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center">
          <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t('publicIndexEmpty')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => {
            const SourceIcon = d.source === 'external_link' ? Link2 : FileText
            return (
              <li key={d.slug}>
                <Link
                  href={`/public/${slug}/documents/${d.slug}` as Route}
                  className="flex items-center gap-3 rounded-lg border bg-card p-4 hover:border-primary/40 hover:shadow-sm transition-all"
                >
                  <SourceIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{d.title}</p>
                    {d.summary && (
                      <p className="text-xs text-muted-foreground truncate">{d.summary}</p>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
