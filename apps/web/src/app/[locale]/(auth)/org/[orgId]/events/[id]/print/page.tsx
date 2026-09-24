'use client'

import { useParams } from 'next/navigation'
import { useOrg } from '@/contexts/OrgContext'
import { StaffProgramPrint } from '@/components/events/program/StaffProgramPrint'

// An org event's programme as a printable handout / PDF. See StaffProgramPrint.
export default function OrgEventProgramPrintPage() {
  const { orgId, id } = useParams<{ orgId: string; id: string }>()
  const { org } = useOrg()
  return (
    <StaffProgramPrint eventId={id} backHref={`/org/${orgId}/events/${id}`} ownerName={org?.name} />
  )
}
