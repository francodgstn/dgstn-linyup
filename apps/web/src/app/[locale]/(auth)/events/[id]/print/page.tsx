'use client'

import { useParams } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { StaffProgramPrint } from '@/components/events/program/StaffProgramPrint'

// The event's program as a printable handout / PDF. See StaffProgramPrint.
export default function EventProgramPrintPage() {
  const { id } = useParams<{ id: string }>()
  const { team } = useAuth()
  return <StaffProgramPrint eventId={id} backHref={`/events/${id}?tab=program`} ownerName={team?.name} />
}
