'use client'

/**
 * AFFILIATION SETTINGS — everything that DEFINES an affiliation, in one place.
 *
 * The four controls here had been split across two pages for different reasons,
 * and neither placement was working:
 *
 *   Terminology + Lock affiliation   sat on org SETTINGS, several screens below
 *                                    the organization's name and language
 *   Statuses + Types                 sat beneath the ROSTER on the Affiliations
 *                                    page (moved there 2026-08-28)
 *
 * The 2026-08-28 move was right about the diagnosis — configuration buried in an
 * unrelated settings page is configuration nobody finds — and this keeps that
 * fix while going further: the answer is not "put the config next to the data",
 * which makes a roster you scroll past to reach a form, but "give the config its
 * own destination and link to it from the roster" (Franco, 2026-09-05).
 *
 * So Affiliations is now purely the roster — who holds the federation's license
 * and whether it is current — with a related link up top pointing here.
 *
 * Each card applies its own `isAdmin` gate, and that gate is COURTESY:
 * `firestore.rules` admits only an org_admin to `affiliation_statuses` and
 * `affiliation_types`, so a viewer past the disabled buttons is still refused by
 * the database.
 */

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useQuery } from '@tanstack/react-query'
import { doc, getDoc } from 'firebase/firestore'
import type { Route } from 'next'
import { db } from '@/lib/firebase'
import { useOrg } from '@/contexts/OrgContext'
import { ORGANIZATIONS_COLLECTION } from '@linyup/shared'
import type { Organization } from '@linyup/shared'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  MembershipStatusesCard,
  OrgAffiliationTypesCard,
} from '@/components/org/AffiliationVocabularyCards'
import { TerminologyCard, MembershipLockCard } from '@/components/org/AffiliationPolicyCards'

export default function OrgAffiliationSettingsPage() {
  const t = useTranslations('OrgAffiliationSettings')
  const tNav = useTranslations('Org')
  const { orgId } = useParams<{ orgId: string }>()
  const { isAdmin } = useOrg()
  const [toast, setToast] = useState<{ msg: string; type?: 'success' | 'error' } | null>(null)

  const orgQ = useQuery<Organization | null>({
    queryKey: ['org', orgId],
    queryFn: async () => {
      const snap = await getDoc(doc(db, ORGANIZATIONS_COLLECTION, orgId))
      return snap.exists() ? ({ ...snap.data(), id: snap.id } as Organization) : null
    },
  })

  function showToast(msg: string, type?: 'success' | 'error') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('pageTitle')}
        subtitle={t('pageSubtitle')}
        quickLinks={[
          { href: `/org/${orgId}/affiliations` as Route, label: tNav('tabAffiliations') },
        ]}
      />

      <TerminologyCard
        orgId={orgId}
        org={orgQ.data ?? null}
        isAdmin={isAdmin}
        onSaved={(msg) => showToast(msg)}
      />
      <MembershipStatusesCard orgId={orgId} isAdmin={isAdmin} />
      <OrgAffiliationTypesCard orgId={orgId} isAdmin={isAdmin} />
      <MembershipLockCard
        orgId={orgId}
        org={orgQ.data ?? null}
        isAdmin={isAdmin}
        onSaved={(msg, type) => showToast(msg, type)}
      />

      {toast && (
        <div
          className={`fixed bottom-4 right-4 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white z-50 ${
            toast.type === 'error' ? 'bg-destructive' : 'bg-green-600'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}
