'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { collectionGroup, getDocs, limit, query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import { Link } from '@/i18n/navigation'
import type { Route } from 'next'
import { RichTextContent } from '@/components/RichTextEditor'
import { useDocumentLinkTargets } from '@/hooks/useDocumentLinkTargets'
import { ChevronLeft, ExternalLink, FileText, History } from 'lucide-react'
import {  parseDocumentLinkVersion, type DocumentPublicProfile, PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'
import { usePublicTeam } from '../../PublicTeamProvider'

type LoadState =
  | { status: 'loading' }
  | { status: 'notfound' }
  | { status: 'ready'; profile: DocumentPublicProfile; documentId: string }

function usePublicDocument(teamId: string, documentSlug: string): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(
          query(
            collectionGroup(db, PUBLIC_PROFILE_SUBCOLLECTION),
            where('teamId', '==', teamId),
            where('type', '==', 'document'),
            where('slug', '==', documentSlug),
            limit(1),
          ),
        )
        if (cancelled) return
        if (snap.empty) {
          setState({ status: 'notfound' })
          return
        }
        setState({
          status: 'ready',
          profile: snap.docs[0].data() as DocumentPublicProfile,
          // The mirror's doc id IS the document id — what a pinned link needs
          // to ask for an older version.
          documentId: snap.docs[0].id,
        })
      } catch (err: unknown) {
        reportPublicLoadFailure('documents/detail', err)
        if (!cancelled) setState({ status: 'notfound' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId, documentSlug])

  return state
}

/** The frozen text of a PINNED version, or null while unpinned/loading/refused. */
function usePinnedVersion(documentId: string | null, version: number | null) {
  const [pinned, setPinned] = useState<{ title: string; bodyHtml: string } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setPinned(null)
    setFailed(false)
    if (!documentId || version == null) return
    let cancelled = false
    ;(async () => {
      try {
        const call = httpsCallable<
          { documentId: string; version: number },
          { title: string; bodyHtml: string }
        >(functions, 'getPublicDocumentVersion')
        const res = await call({ documentId, version })
        if (!cancelled) setPinned({ title: res.data.title, bodyHtml: res.data.bodyHtml })
      } catch (err: unknown) {
        // A pinned version that cannot be served falls back to the latest —
        // reported, never silent, because "the link says v2 and you are reading
        // v5" is exactly the kind of thing that must not pass unnoticed.
        reportPublicLoadFailure('documents/pinned-version', err)
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [documentId, version])

  return { pinned, failed }
}

export function DocumentDetail() {
  const t = useTranslations('Documents')
  const params = useParams()
  const searchParams = useSearchParams()
  const documentSlug = String(params.documentSlug)
  const { slug, teamId, team } = usePublicTeam()
  const state = usePublicDocument(teamId, documentSlug)

  // `?v=` — set only by a PINNED document link. Anything that is not a positive
  // integer reads as unpinned, the same rule the stored attribute follows.
  const requestedVersion = parseDocumentLinkVersion(searchParams.get('v'))
  const documentId = state.status === 'ready' ? state.documentId : null
  const latestVersion = state.status === 'ready' ? (state.profile.version ?? null) : null
  // Asking for the version the mirror already serves is not a pin worth a
  // round-trip.
  const needsPinned = requestedVersion != null && requestedVersion !== latestVersion
  const { pinned, failed } = usePinnedVersion(needsPinned ? documentId : null, requestedVersion)

  const targets = useDocumentLinkTargets(teamId)
  const linkContext = useMemo(
    () => ({
      teamSlug: slug,
      targets,
      versionLabel: (n: number) => t('linkVersion', { version: n }),
    }),
    [slug, targets, t],
  )

  const backLink = (
    <Link
      href={`/public/${slug}/documents` as Route}
      className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
    >
      <ChevronLeft className="h-4 w-4" />
      {t('backToDocuments')}
    </Link>
  )

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-2xl py-8 px-4 space-y-4">
        {backLink}
        <div className="h-8 w-64 rounded bg-muted/40 animate-pulse" />
        <div className="h-40 rounded-lg bg-muted/40 animate-pulse" />
      </div>
    )
  }

  if (state.status === 'notfound') {
    return (
      <div className="mx-auto max-w-2xl py-8 px-4 space-y-4">
        {backLink}
        <div className="rounded-lg border border-dashed py-16 text-center">
          <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t('documentNotFound')}</p>
        </div>
      </div>
    )
  }

  const { profile } = state
  const showingPinned = pinned != null
  // Still fetching a pinned version: showing the latest first and swapping it
  // under the reader would be worse than waiting.
  const awaitingPinned = needsPinned && !pinned && !failed

  return (
    <div className="mx-auto max-w-2xl py-8 px-4 space-y-5">
      {backLink}

      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{team.name}</p>
        <h1 className="text-2xl font-semibold">{pinned?.title ?? profile.title}</h1>
        {profile.summary && <p className="text-muted-foreground">{profile.summary}</p>}
      </div>

      {/* A reader following a pinned link is NOT looking at the current text.
          Saying so is the whole point of the pin — silently serving an old
          version is how somebody quotes a superseded policy back at a studio. */}
      {showingPinned && requestedVersion != null && (
        <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <History className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p>{t('viewingVersion', { version: requestedVersion })}</p>
            <Link
              href={`/public/${slug}/documents/${documentSlug}` as Route}
              className="text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground"
            >
              {t('viewLatestVersion')}
            </Link>
          </div>
        </div>
      )}

      {profile.source === 'external_link' ? (
        <div className="rounded-lg border bg-card p-6 text-center space-y-4">
          <p className="text-sm text-muted-foreground">{t('externalLinkBody')}</p>
          <a
            href={profile.externalUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('openDocument')}
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-6">
          {awaitingPinned ? (
            <div className="h-40 rounded bg-muted/40 animate-pulse" />
          ) : (
            <RichTextContent
              html={pinned?.bodyHtml ?? profile.bodyHtml ?? ''}
              className="prose-relaxed max-w-none"
              documentLinks={linkContext}
            />
          )}
        </div>
      )}
    </div>
  )
}
