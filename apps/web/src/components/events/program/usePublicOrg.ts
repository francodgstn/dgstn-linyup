'use client'

import { useEffect, useState } from 'react'
import { collection, getDocs, limit, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { ORG_SITE_PUBLISHED_COLLECTION } from '@linyup/shared'

/** Resolve an organisation from the fully-public `org_site_published` snapshot
 *  — the same single read the org site page performs. An org without a
 *  published site has no public surface to hang events off. */
export function usePublicOrgBySlug(slug: string) {
  const [state, setState] = useState<{ loading: boolean; orgId: string | null; name: string }>({
    loading: true, orgId: null, name: '',
  })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const snap = await getDocs(
          query(collection(db, ORG_SITE_PUBLISHED_COLLECTION), where('slug', '==', slug), limit(1)),
        )
        if (cancelled) return
        const data = snap.empty ? null : (snap.docs[0].data() as { orgId: string; name: string })
        setState({ loading: false, orgId: data?.orgId ?? null, name: data?.name ?? '' })
      } catch {
        if (!cancelled) setState({ loading: false, orgId: null, name: '' })
      }
    })()
    return () => { cancelled = true }
  }, [slug])

  return state
}
