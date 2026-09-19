'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { doc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { CONTACTS_COLLECTION, type Contact } from '@linyup/shared'
import { useCapabilities } from '@/hooks/useCapabilities'
import { Check } from 'lucide-react'
import { callFunction } from '@/lib/callFunction'

// Multi-coach assignment for a contact. Owners/managers (members.manage) pick one or
// more coaches; a coach-role member then sees the contact in their own book (own
// scope keys off assigned_coach_ids). Eligible coaches = team members flagged as
// coaches (per-member is_coach; absent ⇒ coach — toggled per user in Settings → Team).
// Writes assigned_coach_ids directly, independent of the profile form.
export function CoachAssignment({ contact, teamId }: { contact: Contact; teamId: string | null }) {
  const t = useTranslations('Contacts')
  const { can } = useCapabilities()
  const qc = useQueryClient()
  const canEdit = !!teamId && can('members.manage')

  const { data: coaches = [] } = useQuery({
    queryKey: ['team-coaches-roster', teamId],
    enabled: canEdit,
    queryFn: async () => {
      // Member display names live on users/{uid}, which Firestore rules deny reading
      // cross-user client-side — so the roster comes from the listTeamMembers callable
      // (same source as useCoaches / the /coaches page). Coach roster = members flagged
      // as coaches (per-member is_coach; absent ⇒ coach).
      const res = await callFunction('listTeamMembers')({ teamId })
      const members =
        (res.data as {
          members?: Array<{
            userId: string
            displayName: string | null
            email: string | null
            isCoach: boolean
          }>
        }).members ?? []
      return members
        .filter((m) => m.isCoach)
        .map((m) => ({ uid: m.userId, name: m.displayName || m.email || m.userId }))
    },
  })

  const [assigned, setAssigned] = useState<Set<string>>(
    () => new Set(contact.assigned_coach_ids ?? []),
  )
  const [saving, setSaving] = useState<string | null>(null)

  if (!canEdit) return null

  async function toggle(uid: string, on: boolean) {
    if (!teamId) return
    const next = new Set(assigned)
    if (on) next.add(uid)
    else next.delete(uid)
    setAssigned(next) // optimistic
    setSaving(uid)
    try {
      await updateDoc(doc(db, CONTACTS_COLLECTION, contact.id), {
        assigned_coach_ids: on ? arrayUnion(uid) : arrayRemove(uid),
      })
      qc.invalidateQueries({ queryKey: ['contacts'] })
    } finally {
      setSaving(null)
    }
  }

  // TOGGLE CHIPS, NOT A STACK OF SWITCH ROWS.
  //
  // This was one full-width row per coach — a name on the left, a switch on the
  // right, and a lot of nothing between them. A studio with eight coaches got
  // eight rows of mostly empty space at the top of the Coaching tab, pushing the
  // work below it down, to express what is simply a multi-select of short names.
  //
  // Chips wrap, so the height is proportional to the number of coaches rather
  // than linear in it, and assignment reads at a glance from fill instead of
  // from eight switch positions. The whole control is still one tap per coach.
  //
  // A chip is a real toggle button, not a decoration: `aria-pressed` carries the
  // state a `Switch` used to, so this stays operable and announced without the
  // visible label/switch pairing.
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-sm font-semibold">{t('coachesTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('coachesHint')}</p>
      </div>
      {coaches.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('coachesNone')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {coaches.map((c) => {
            const on = assigned.has(c.uid)
            return (
              <button
                key={c.uid}
                type="button"
                aria-pressed={on}
                disabled={saving === c.uid}
                onClick={() => toggle(c.uid, !on)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                  on
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'border-dashed text-muted-foreground hover:border-solid hover:text-foreground'
                }`}
              >
                {on && <Check className="h-3 w-3 shrink-0" />}
                {c.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
