'use client'

// Experimental features — the studio's opt-in for work that is built and
// working but not yet settled. The list comes from the ONE registry
// (packages/shared/src/types/experimental.ts); adding the next experiment is an
// entry there plus the read at its own surface, and this page needs no edit.
//
// Deliberately NOT a plugin: an install spends a slot under `pluginInstallLimit`
// and an experiment is not worth a Coach's single explore slot (UX-39).
//
// Team-doc writes are owner-only per firestore.rules
// (`allow update: if hasTeamRole(teamId, 'owner') && paymentsUnchanged()`), so a
// manager who deep-links here gets the list read-only with the reason stated.
// The rail hides the row for her (`gate: 'ownerOnly'`) — that is navigation,
// never enforcement.
//
// ── TWO STORES, ONE LIST ────────────────────────────────────────────────────
// Most entries are a key in `teams/{id}.settings.experimentalFeatures`. One is
// not: `waitlist` is `bookingSettings.waitlistEnabled` on the team's public
// profile, because that field already existed and already had readers (the
// activity editor, and the promoter server-side via the claim window beside
// it). Copying it into the map would have created a second answer to one
// question. `ExperimentalFeatureStore` in the registry is the discriminator;
// this page is the only place both stores are written.
//
// The public profile is team-member writable, so hosting that switch here makes
// it owner-only in practice. That is a tightening, and the intended one: it is
// the switch that decides whether the studio has queues at all, not a booking
// preference a manager tunes.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { doc, setDoc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  TEAMS_COLLECTION,
  featureStore,
  type ExperimentalFeature,
  type ExperimentalFeatureId,
} from '@linyup/shared'
import { useAuth } from '@/contexts/AuthContext'
import { useExperimentalFeatures } from '@/hooks/useExperimentalFeatures'
import { bookingSettingsRef, useBookingSettings } from '@/hooks/useBookingSettings'
import { usePlan } from '@/hooks/usePlan'
import { usePlanName } from '@/hooks/usePlanName'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { toast } from 'sonner'
import { FlaskConical } from 'lucide-react'
import { SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'

/** Absent falls back to the SAME default the promoter applies server-side
 *  (WAITLIST_DEFAULT_CLAIM_MINUTES) — showing a different number here than the
 *  one actually used is worse than showing none. */
const DEFAULT_CLAIM_MINUTES = 120
const CLAIM_MINUTE_CHOICES = [60, 120, 240, 480, 1440]

export default function ExperimentalSettingsPage() {
  const t = useTranslations('SettingsExperimental')
  // The claim-window copy stays in the namespace that owns it — the control
  // moved page, the wording did not, and duplicating it into a second namespace
  // is how two screens start describing one setting differently.
  const tb = useTranslations('SettingsBooking')
  const { currentTeamId, teamRole } = useAuth()
  const { features, enabled, isLoading } = useExperimentalFeatures()
  const { data: bookingSettings, isLoading: bookingLoading } = useBookingSettings(currentTeamId)
  const qc = useQueryClient()
  // A tier note, never a tier gate: an experiment is not sold, so the switch
  // stays live below the tier and only says where the surface will appear.
  const { isAtLeast } = usePlan()
  const planName = usePlanName()
  const canEdit = teamRole === 'owner'
  const [pending, setPending] = useState<ExperimentalFeatureId | null>(null)

  const waitlistOn = bookingSettings?.waitlistEnabled === true
  const rawClaim = Number(bookingSettings?.waitlistClaimMinutes)
  const claimMinutes =
    Number.isInteger(rawClaim) && rawClaim >= 60 && rawClaim <= 1440
      ? rawClaim
      : DEFAULT_CLAIM_MINUTES

  /** Is this entry on? Asked of whichever store the entry declares — never of
   *  the map alone, which does not hold every answer. */
  const isOn = (feature: ExperimentalFeature) =>
    featureStore(feature) === 'booking-settings' ? waitlistOn : enabled[feature.id] === true

  // The whole map is written at once, never a per-key dotted path: a feature id
  // is kebab-case and a hyphen is not legal in an unquoted Firestore field path.
  // Rebuilding from `enabled` (already normalized) also drops any stale id a
  // withdrawn experiment left behind.
  async function toggleTeamSetting(id: ExperimentalFeatureId, next: boolean) {
    const map: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(enabled)) if (value) map[key] = true
    if (next) map[id] = true
    else delete map[id]
    await updateDoc(doc(db, TEAMS_COLLECTION, currentTeamId!), {
      'settings.experimentalFeatures': map,
    })
    // No local state to reconcile — AuthContext holds the team doc on an
    // onSnapshot, so the switch and the consuming surface both follow the write.
  }

  /** A MERGE into the nested `bookingSettings` map, so nothing else the booking
   *  settings page owns (window, cutoff, contact fields) is touched. */
  async function writeBookingSettings(patch: Record<string, unknown>) {
    await setDoc(bookingSettingsRef(currentTeamId!), { bookingSettings: patch }, { merge: true })
    await qc.invalidateQueries({ queryKey: ['booking-settings', currentTeamId] })
  }

  async function toggle(feature: ExperimentalFeature, next: boolean) {
    if (!currentTeamId || !canEdit) return
    setPending(feature.id)
    try {
      if (featureStore(feature) === 'booking-settings') {
        // The claim window is written alongside, so switching the queue on
        // stores the number this page is showing rather than leaving the field
        // absent and the displayed value a guess about the server's default.
        await writeBookingSettings({
          waitlistEnabled: next,
          waitlistClaimMinutes: claimMinutes,
        })
      } else {
        await toggleTeamSetting(feature.id, next)
      }
      toast.success(next ? t('toastEnabled') : t('toastDisabled'))
    } catch (err) {
      console.error('[experimental toggle] failed:', err)
      toast.error(err instanceof Error ? err.message : t('toastFailed'))
    } finally {
      setPending(null)
    }
  }

  async function setClaimMinutes(minutes: number) {
    if (!currentTeamId || !canEdit) return
    setPending('waitlist')
    try {
      await writeBookingSettings({ waitlistClaimMinutes: minutes })
      toast.success(t('toastEnabled'))
    } catch (err) {
      console.error('[experimental claim window] failed:', err)
      toast.error(err instanceof Error ? err.message : t('toastFailed'))
    } finally {
      setPending(null)
    }
  }

  /** The one bespoke sub-control on this page: the waitlist's claim window,
   *  which is the waitlist's OWN setting and means nothing without it. It is a
   *  row under the waitlist's own switch, grouped with it, so a studio with no
   *  queue never meets it as a question (UX-41). */
  function subControl(feature: ExperimentalFeature) {
    if (feature.id !== 'waitlist' || !waitlistOn) return null
    return (
      <SettingsRow
        htmlFor="waitlist-claim-window"
        label={tb('waitlistClaimMinutesLabel')}
        hint={tb('waitlistClaimMinutesHint')}
      >
        <Select
          value={String(claimMinutes)}
          onValueChange={(v) => setClaimMinutes(Number(v))}
          disabled={!canEdit || pending === 'waitlist'}
        >
          <SelectTrigger id="waitlist-claim-window" className="w-full">
            <span className="flex flex-1 truncate text-left text-sm">
              {tb('waitlistClaimMinutesValue', { minutes: claimMinutes })}
            </span>
          </SelectTrigger>
          <SelectContent>
            {CLAIM_MINUTE_CHOICES.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {tb('waitlistClaimMinutesValue', { minutes })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    )
  }

  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('pageSubtitle')}</p>
      </div>

      <div className="max-w-2xl space-y-4">
        {/* What "experimental" means here, said plainly and once. Nothing below
            repeats it — a warning printed on every row stops being read. */}
        <div className="flex items-start gap-2.5 rounded-xl border border-dashed bg-muted/30 p-4">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t('meaningTitle')}</h2>
            <p className="text-xs text-muted-foreground">{t('meaningBody')}</p>
          </div>
        </div>

        {!canEdit && <p className="text-xs text-muted-foreground">{t('ownerOnly')}</p>}

        {isLoading || bookingLoading ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : features.length === 0 ? (
          // Reachable: the list empties whenever the last experiment graduates
          // into a real feature or is withdrawn.
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : (
          // ROWS, NOT CARDS (the Settings → General layout). Each switch still
          // saves the moment it is flipped — one switch that is not part of a
          // form saves instantly — so this page has no save bar. What a feature
          // does and where it shows up are behind its ⓘ; the plan note stays
          // visible, because it explains why switching it on changes nothing.
          <SettingsSection>
            {features.map((feature) => {
              const on = isOn(feature)
              const name = t(feature.nameKey as Parameters<typeof t>[0])
              const planNote =
                feature.minPlan && !isAtLeast(feature.minPlan)
                  ? t('planNote', { plan: planName(feature.minPlan) })
                  : null
              return (
                <div key={feature.id}>
                  <SettingsRow
                    inline
                    htmlFor={`experiment-${feature.id}`}
                    label={name}
                    hint={
                      <>
                        {t(feature.descriptionKey as Parameters<typeof t>[0])}{' '}
                        <span className="mt-1.5 block">
                          {t('whereLabel')} {t(feature.surfaceKey as Parameters<typeof t>[0])}
                        </span>
                      </>
                    }
                  >
                    <Switch
                      id={`experiment-${feature.id}`}
                      checked={on}
                      disabled={!canEdit || pending === feature.id}
                      onCheckedChange={(checked: boolean) => toggle(feature, checked)}
                      aria-label={name}
                    />
                  </SettingsRow>
                  {planNote && <p className="-mt-2 pb-4 text-xs text-muted-foreground">{planNote}</p>}
                  {subControl(feature)}
                </div>
              )
            })}
          </SettingsSection>
        )}
      </div>
    </div>
  )
}
