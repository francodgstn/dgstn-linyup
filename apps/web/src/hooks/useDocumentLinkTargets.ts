'use client'

import { useEffect, useState } from 'react'
import { collectionGroup, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { reportPublicLoadFailure } from '@/lib/publicQueryError'
import type { DocumentLinkTarget, DocumentPublicProfile } from '@linyup/shared'
import { PUBLIC_PROFILE_SUBCOLLECTION } from '@linyup/shared'

/**
 * Where a team's document links can point — every one of its world-readable
 * document mirrors, keyed by document id.
 *
 * The mirror at `documents/{id}/public_profile/{id}` is double-gated on
 * `published` AND `isPublic`, so a document that is merely absent from this map
 * is one a visitor may not open. That is the whole availability check: the
 * resolver renders such a link as plain text rather than a dead link, and no
 * extra permission probe is needed.
 *
 * The DOC ID is the document id — the mirror carries no `documentId` field —
 * which is what lets a stored reference find its target after both slugs have
 * been renamed.
 */
export function useDocumentLinkTargets(teamId: string | null): Map<string, DocumentLinkTarget> {
  const [targets, setTargets] = useState<Map<string, DocumentLinkTarget>>(new Map())

  useEffect(() => {
    if (!teamId) {
      setTargets(new Map())
      return
    }
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
        const next = new Map<string, DocumentLinkTarget>()
        for (const d of snap.docs) {
          const p = d.data() as DocumentPublicProfile
          next.set(d.id, { slug: p.slug, title: p.title, version: p.version ?? null })
        }
        setTargets(next)
      } catch (err: unknown) {
        // Reported, never swallowed: a rules or index failure here degrades
        // every document link on the page to plain text, and a silent catch is
        // exactly how that would be mistaken for "the author linked nothing".
        reportPublicLoadFailure('documents/link-targets', err)
        if (!cancelled) setTargets(new Map())
      }
    })()
    return () => {
      cancelled = true
    }
  }, [teamId])

  return targets
}
