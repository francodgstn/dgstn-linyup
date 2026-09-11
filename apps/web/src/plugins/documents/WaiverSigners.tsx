'use client'

// The signers tab — who has signed this waiver, and how good the evidence is.
//
// ── THE STANDING EVIDENCE LINE IS THE POINT OF THIS SCREEN ──────────────────
// Everything else here a studio could infer. This it could not:
//
//   "31 members' signatures predate a change they were never asked to accept."
//
// The gate treats a signature below no floor as VALID — that is what a `silent`
// publish means — and the roster chip renders nothing for `valid`. So a studio
// running `silent` publishes accumulates a population whose records are one tick
// against wording that no longer exists, and NOTHING else in the product says
// so. This line is the only place that answers "how good is my evidence right
// now", and it is a rendering of two numbers already stored, not a new
// mechanism.
//
// (The second half of that sentence — "…and 4 of those notices did not arrive" —
// belongs to the `notify` outcome, which is deferred to v2. It is absent here
// rather than shown as zero: a count of notices nothing sends is a false
// reassurance, not a placeholder.)
//
// ── WHY THE READ IS WHOLE AND THE TABLE IS NOT ────────────────────────────────
// The standing line above is a count over the whole signed population, and no
// cheap query reproduces it (valid-under-the-floor AND below-a-silent-version is
// two ranges on two fields). So the read stays whole — it is roster-scale, one
// row per member who ever signed — and what is paged is the TABLE: a page at a
// time, with the footer saying how many of how many
// (docs/scalability-2026-09.md §17 A12).
//
// ── WHY IT IS A CLIENT READ ─────────────────────────────────────────────────
// `firestore.rules` grants a team member read on `documents/{d}/signers` and on
// the version subcollection. The no-client-reads discipline covers the PUBLIC
// surfaces, where the reader is a visitor with no membership.

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Skeleton } from '@/components/ui/skeleton'
import { LoadMoreFooter } from '@/components/ui/load-more-footer'
import {
  DOCUMENTS_COLLECTION,
  DOCUMENT_SIGNERS_SUBCOLLECTION,
  waiverAcceptanceState,
  type StudioDocument,
  type WaiverAcceptanceState,
  type WaiverSignerState,
} from '@linyup/shared'
import { useDocumentVersions } from './hooks'

/** Rows mounted per "show more". */
const SIGNERS_PAGE_SIZE = 100

const STATE_TONE: Record<WaiverAcceptanceState, string> = {
  valid: 'text-green-700',
  none: 'text-muted-foreground',
  superseded: 'text-amber-700',
  expired: 'text-amber-700',
  revoked: 'text-destructive',
}

export function WaiverSigners({ document }: { document: StudioDocument }) {
  const t = useTranslations('Waivers')

  const signersQ = useQuery<WaiverSignerState[]>({
    queryKey: ['waiver-signers-all', document.id],
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(db, DOCUMENTS_COLLECTION, document.id, DOCUMENT_SIGNERS_SUBCOLLECTION),
          where('teamId', '==', document.teamId)
        )
      )
      return snap.docs.map((d) => d.data() as WaiverSignerState)
    },
  })
  const versionsQ = useDocumentVersions(document.id)
  const [shown, setShown] = useState(SIGNERS_PAGE_SIZE)

  const rows = useMemo(() => {
    const nowMs = Date.now()
    const floor = document.min_valid_version ?? 0
    return (signersQ.data ?? [])
      .map((s) => ({
        signer: s,
        state: waiverAcceptanceState(
          { min_valid_version: floor },
          {
            accepted_version: s.accepted_version,
            accepted_at: s.accepted_at,
            valid_until: s.valid_until ?? null,
            status: s.status,
          },
          nowMs
        ),
      }))
      .sort((a, b) => b.signer.accepted_at.toMillis() - a.signer.accepted_at.toMillis())
  }, [signersQ.data, document.min_valid_version])

  // THE STANDING LINE. Every version published ABOVE a signer's accepted version
  // whose outcome was `silent` is a change that signer was never asked about —
  // and, because `silent` does not move the floor, their signature still counts.
  // That gap is exactly what the studio cannot see anywhere else.
  const unaskedChanges = useMemo(() => {
    const silent = (versionsQ.data ?? []).filter((v) => v.publish_outcome === 'silent')
    if (silent.length === 0) return 0
    return rows.filter(
      (r) => r.state === 'valid' && silent.some((v) => v.version > r.signer.accepted_version)
    ).length
  }, [rows, versionsQ.data])

  if (signersQ.isLoading) return <Skeleton className="h-32 rounded-lg" />

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-semibold">{t('signersTitle')}</h2>

      {unaskedChanges > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t('evidenceLine', { count: unaskedChanges })}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('signersEmpty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">{t('colName')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('colVersion')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('colSigned')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('colSigner')}</th>
                <th className="py-1.5 font-medium">{t('colState')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map(({ signer, state }) => (
                <tr key={signer.contactId} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{signer.contact_name}</span>
                    {signer.contact_email && (
                      <span className="block text-xs text-muted-foreground">
                        {signer.contact_email}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">{signer.accepted_version}</td>
                  <td className="py-1.5 pr-3">
                    {signer.accepted_at.toDate().toLocaleDateString()}
                  </td>
                  <td className="py-1.5 pr-3">
                    {/* WHO SAID they ticked, and how strongly that address was
                        proved. Two different axes, and neither is the other: the
                        role is a SELF-DECLARATION nothing verified, while
                        `verified_code` is a real proof of a mailbox. Both are a
                        column and not a tooltip, because together they are the
                        whole strength of a record. */}
                    {t(`role_${signer.signer_role}` as Parameters<typeof t>[0])}
                    {signer.signer_role === 'guardian' && (
                      <span className="block text-xs text-amber-700">{t('roleSelfDeclared')}</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {t(`verified_${signer.signer_email_verified_by}` as Parameters<typeof t>[0])}
                    </span>
                  </td>
                  <td className={`py-1.5 font-medium ${STATE_TONE[state]}`}>
                    {t(`state_${state}` as Parameters<typeof t>[0])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <LoadMoreFooter
            shown={Math.min(shown, rows.length)}
            total={rows.length}
            hasMore={shown < rows.length}
            loading={false}
            onLoadMore={() => setShown((n) => n + SIGNERS_PAGE_SIZE)}
          />
        </div>
      )}
    </div>
  )
}
