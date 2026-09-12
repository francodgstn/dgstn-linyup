'use client'

import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { EventCategory, Contact, RankingSystem } from '@linyup/shared'
import { rankLevelIndex } from '@linyup/shared'
import { useRankingSystems } from '@/hooks/useRankingSystems'
import { useFightingCupCategories } from './useCategories'

function contactAge(contact: Contact): number | null {
  if (!contact.birthdate) return null
  const dob = (contact.birthdate as { toDate(): Date }).toDate()
  const now = new Date()
  let age = now.getFullYear() - dob.getFullYear()
  if (
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())
  ) age--
  return age
}

function filterCategories(
  categories: EventCategory[],
  contact: Contact,
  weight: number | null,
  rankingSystems: RankingSystem[],
): EventCategory[] {
  const age = contactAge(contact)
  const gender = contact.gender

  return categories.filter((cat) => {
    // A RETIRED division is never offered for a NEW entry. The migration that
    // reconstructs HMD's historic categories writes soft-deleted ones too —
    // deliberately, because a twenty-year-old check-in references them and the
    // lineup export has to be able to name what it says the competitor entered.
    // Naming a past division and offering it today are different questions, and
    // the hook that feeds both deliberately answers only the first.
    if ((cat as { deleted_at?: unknown }).deleted_at) return false
    if (cat.gender && cat.gender !== 'both' && gender && cat.gender !== gender) return false
    if (age !== null) {
      if (cat.min_age != null && age < cat.min_age) return false
      if (cat.max_age != null && age > cat.max_age) return false
    }
    if (weight !== null) {
      if (cat.min_weight != null && weight < cat.min_weight) return false
      if (cat.max_weight != null && weight > cat.max_weight) return false
    }
    // Rank filtering: a category's `min_rank`/`max_rank` and the contact's rank
    // are RankRefs (an id, or a legacy number on a record the data flip has not
    // reached); both resolve to a position on the ladder and are compared there.
    // A ladder we cannot find leaves the rank unchecked, exactly as an absent
    // rank does today.
    if (cat.ranking_system_id && contact.ranks) {
      const rank = contact.ranks[cat.ranking_system_id]
      const ladder = rankingSystems.find((s) => s.id === cat.ranking_system_id)?.levels
      if (rank !== undefined && ladder) {
        const at = rankLevelIndex(ladder, rank)
        if (at >= 0) {
          if (cat.min_rank != null) {
            const lo = rankLevelIndex(ladder, cat.min_rank)
            if (lo >= 0 && at < lo) return false
          }
          if (cat.max_rank != null) {
            const hi = rankLevelIndex(ladder, cat.max_rank)
            if (hi >= 0 && at > hi) return false
          }
        }
      }
    }
    return true
  })
}

export function CheckinForm({
  contact,
  eventId,
  existing,
  onSubmit,
  onCancel,
  busy,
}: {
  contact: Contact
  eventId: string
  existing?: Record<string, unknown>
  onSubmit: (data: Record<string, unknown>) => void
  onCancel: () => void
  busy?: boolean
}) {
  const { data: allCategories = [], isLoading } = useFightingCupCategories(eventId)
  const { rankingSystems } = useRankingSystems()
  const [weight, setWeight] = useState<string>(
    String((existing?.weight as number | undefined) ?? contact.weight ?? ''),
  )
  const [selectedCats, setSelectedCats] = useState<Set<string>>(
    new Set((existing?.categories as string[] | undefined) ?? []),
  )

  const weightNum = weight ? parseFloat(weight) : null

  const eligibleCategories = useMemo(
    () => filterCategories(allCategories, contact, weightNum, rankingSystems),
    [allCategories, contact, weightNum, rankingSystems],
  )

  // Fields needed to place a competitor accurately. Surfaced as a warning so the
  // organizer knows why categories may be filtered out (parity with the legacy
  // pre-check-in validation, but non-blocking — categories may not need them all).
  const missingFields = useMemo(() => {
    const m: string[] = []
    if (weightNum == null) m.push('weight')
    if (!contact.birthdate) m.push('date of birth')
    if (!contact.gender) m.push('gender')
    return m
  }, [weightNum, contact.birthdate, contact.gender])

  function toggleCat(id: string) {
    setSelectedCats((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleSubmit() {
    onSubmit({
      categories: Array.from(selectedCats),
      weight: weightNum ?? undefined,
    })
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-sm font-medium">{contact.firstname} {contact.lastname}</p>

      {/* Weight input */}
      <div className="space-y-1.5">
        <Label>Weight (kg)</Label>
        <Input
          type="number"
          step="0.1"
          min="0"
          value={weight}
          onChange={(e) => { setWeight(e.target.value); setSelectedCats(new Set()) }}
          placeholder="e.g. 67.5"
        />
        <p className="text-xs text-muted-foreground">
          Entering weight filters eligible categories automatically.
        </p>
      </div>

      {/* Category selection */}
      <div className="space-y-2">
        <Label>
          Categories{' '}
          <span className="font-normal text-muted-foreground text-xs">
            ({eligibleCategories.length} eligible)
          </span>
        </Label>

        {allCategories.length === 0 && (
          <p className="text-sm text-muted-foreground italic">
            No categories configured for this event. Add categories in the Categories tab.
          </p>
        )}

        {allCategories.length > 0 && missingFields.length > 0 && (
          <p className="text-xs text-amber-600">
            Missing {missingFields.join(', ')} — some categories may be hidden until set on this contact.
          </p>
        )}

        <div className="space-y-1.5">
          {eligibleCategories.map((cat) => {
            const selected = selectedCats.has(cat.id)
            return (
              <button
                key={cat.id}
                onClick={() => toggleCat(cat.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-sm text-left transition-colors ${
                  selected
                    ? 'border-primary bg-primary/10 font-medium'
                    : 'border-border hover:bg-muted'
                }`}
              >
                {cat.color && (
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: cat.color }} />
                )}
                <span className="flex-1">{cat.name}</span>
                {cat.min_weight != null && cat.max_weight != null && (
                  <span className="text-xs text-muted-foreground">
                    {cat.min_weight}–{cat.max_weight} kg
                  </span>
                )}
                {selected && <span className="text-primary text-xs font-bold">✓</span>}
              </button>
            )
          })}
        </div>

        {allCategories.length > 0 && eligibleCategories.length === 0 && (
          <p className="text-xs text-amber-600">
            No categories match this competitor&apos;s profile. Check weight, age, gender, and rank.
          </p>
        )}
      </div>

      {selectedCats.size === 0 && allCategories.length > 0 && (
        <p className="text-xs text-amber-600">Select at least one category.</p>
      )}

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button
          onClick={handleSubmit}
          disabled={busy || (allCategories.length > 0 && selectedCats.size === 0)}
        >
          {existing ? 'Update' : 'Check in'}
        </Button>
      </div>
    </div>
  )
}
