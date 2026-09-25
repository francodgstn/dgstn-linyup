'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { useTranslations } from 'next-intl'
import { Lock, Pencil } from 'lucide-react'
import { db } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useCapabilities } from '@/hooks/useCapabilities'
import { usePlan } from '@/hooks/usePlan'
import { useTeamSeats } from '@/hooks/useTeamSeats'
import { PlanUpgradeNotice } from '@/components/plan/PlanUpgradeNotice'
import {
  TEAMS_COLLECTION,
  ROLE_CONFIG_SUBCOLLECTION,
  CAPABILITY_CATALOG,
  CAPABILITY_GROUPS,
  COACH_DEFAULT_CAPABILITIES,
  SYSTEM_ROLE_CAPABILITIES,
  capabilityEnforcement,
  capabilityGroup,
  capabilityIsScoped,
  coachLockReason,
  dataScopeForRole,
  type Capability,
  type CapabilityGroup,
  type CoachLockReason,
  type TeamRole,
} from '@linyup/shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'

/**
 * ROLES & PERMISSIONS — every role, one at a time.
 *
 * The page used to render exactly one thing: the Coach role's capability
 * switches. That was the only EDITABLE role, so it was the only one shown — and
 * the effect was that "Roles & permissions" answered "what can a coach do?" and
 * refused the other three quarters of the question. "Can a manager see billing?"
 * is asked far more often than "should a coach be able to delete contacts", and
 * it had no answer anywhere in the product; the subtitle simply asserted that
 * the other roles were fixed and left the reader to guess what they were fixed
 * AT.
 *
 * So the page picks a role first. Owner, Manager and Viewer render the capability
 * list READ-ONLY from `SYSTEM_ROLE_CAPABILITIES` — the one definition the rules
 * and the callables read, so this screen cannot drift from what is enforced.
 * Coach renders the same list, editable.
 *
 * ── EVERY ROLE SHOWS THE WHOLE CATALOGUE ───────────────────────────────────
 * …including the capabilities the role does NOT have, and (for Coach) the ones
 * it can never be given. A list of only what a role can do cannot answer "can
 * this role do X" for any X outside it — the reader is left unable to tell "no"
 * from "not listed here".
 *
 * Coach used to be the exception, rendering only the thirteen assignable rows on
 * the reasoning that "a switch that can never move is not one". Two things were
 * wrong with that. The fixed roles already render switches that never move, so
 * the rule was not applied consistently; and the list CHANGING LENGTH as you
 * click between roles is worse than an inert row, because it silently reframes
 * what you are looking at. The five ungrantable rows are locked and say which
 * wall they are behind (`coachLockReason`) instead of vanishing.
 *
 * ── THE ROWS SAY WHAT THEY ACTUALLY GOVERN ─────────────────────────────────
 * Not every id in the catalogue gates something in the app. `contacts.view`,
 * `contacts.view.all`, `schedule.view` and `schedule.view.all` are read only by
 * the public-API scope table — reading a contact in the web app is
 * `canAccessContact` in firestore.rules, which asks for team membership and
 * own-scope and no capability at all. Presenting those four identically to
 * `contacts.manage` told studios they had a restriction they did not have, so
 * they carry an "API only" tag. `capabilityEnforcement` owns that answer and
 * packages/functions/src/utils/capabilityEnforcement.test.ts re-derives it from
 * the source, so wiring one of them into a page makes the tag correct itself
 * rather than going quietly stale.
 *
 * ── GROUPED, WITH THE SCOPE NOTE ON THE HEADING ────────────────────────────
 * The "Applies only to their own records" note was per-row, on the scoped rows
 * only, which made rows two different heights for a fact that is true of a whole
 * area. It sits on the group heading now. The widening rows inside those groups
 * ("View all contacts", "View full calendar") say so in their own labels — that
 * is what they are for.
 */

/** Selector order: most powerful first, which is also how the roles are ranked
 *  for member management (ROLE_RANK). */
const ROLES: TeamRole[] = ['owner', 'manager', 'coach', 'viewer']

export default function RolePermissionsPage() {
  const t = useTranslations('Roles')
  const tc = useTranslations('Capabilities')
  const tm = useTranslations('TeamMembers')
  const { currentTeamId, user } = useAuth()
  const { can } = useCapabilities()
  const { hasFeature, minimumPlanFor, isLoading: planLoading } = usePlan()
  const qc = useQueryClient()
  const [role, setRole] = useState<TeamRole>('coach')
  const editableRole = role === 'coach'

  // Asked only when the plan says no — a Studio team needs no roll call to be
  // allowed, so it pays for no extra callable.
  const { data: seats, isLoading: seatsLoading } = useTeamSeats(
    currentTeamId,
    !hasFeature('multiple_managers')
  )
  // UX-42: this page had NO plan awareness at all — a complete, saveable Coach
  // permission editor on a plan where a second user cannot exist, so nobody can
  // ever hold the role being configured. It stays visible (the studio should be
  // able to see what the role does before paying for it) and says why it can't
  // be used, which is the same gate the invite button uses.
  //
  // That gate moved from Coach to Studio on 2026-08-18 — it FOLLOWS the invite,
  // because a role nobody can be invited into governs nobody. It reads the
  // `multiple_managers` flag rather than naming a tier, so it cannot drift from
  // the invite gate again.
  //
  // …with the exception that makes it honest: a team that ALREADY has somebody
  // in the Coach role keeps the editor, whatever its plan. The gate is on
  // adding a person, never on the people who are here — and locking it for them
  // would leave a real coach's permissions frozen at whatever they were the day
  // the plan changed.
  const planAllows = hasFeature('multiple_managers')
  const minPlan = minimumPlanFor('multiple_managers')
  const allowed = planAllows || seats?.hasCoachRoleMember === true
  const canEdit = can('members.manage') && allowed && editableRole
  // Neither answer is known until both reads are in; refusing early would flash
  // a lock at a team that turns out to hold a coach.
  const gateKnown = !planLoading && (planAllows || !seatsLoading)

  const { data: stored, isLoading } = useQuery({
    queryKey: ['role-config', currentTeamId, 'coach'],
    enabled: !!currentTeamId,
    queryFn: async () => {
      const snap = await getDoc(
        doc(db, TEAMS_COLLECTION, currentTeamId!, ROLE_CONFIG_SUBCOLLECTION, 'coach')
      )
      const d = snap.exists() ? snap.data() : null
      return {
        capabilities: (d?.capabilities as Capability[] | undefined) ?? null,
      }
    },
  })

  // `?? ` and not `||`: a stored EMPTY array means "this studio grants its coaches
  // nothing", which is a real answer and not the same as never having saved.
  // `resolveRoleCapabilities` makes the same distinction — it did not always, and
  // the disagreement was a silent grant of the five defaults.
  const initial = useMemo<Set<Capability>>(
    () => new Set(stored?.capabilities ?? COACH_DEFAULT_CAPABILITIES),
    [stored]
  )
  const [draft, setDraft] = useState<Set<Capability> | null>(null)
  const coachSelected = draft ?? initial
  const dirty = draft !== null
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  /** The rows to render for the selected role. ONE source for what is held: the
   *  fixed sets come from `SYSTEM_ROLE_CAPABILITIES` (what the rules read), never
   *  from a list retyped for display. */
  const rows = useMemo(() => {
    const held: ReadonlySet<Capability> = editableRole
      ? coachSelected
      : new Set(SYSTEM_ROLE_CAPABILITIES[role as 'owner' | 'manager' | 'viewer'])
    return CAPABILITY_CATALOG.map((meta) => {
      const lock = editableRole ? coachLockReason(meta.id) : null
      return {
        meta,
        group: capabilityGroup(meta.domain),
        // A locked row is always OFF. `resolveRoleCapabilities` strips these from
        // any stored override, so rendering one ON would show a grant that does
        // not exist — which is the class of bug this page is being fixed for.
        held: lock ? false : held.has(meta.id),
        lock,
        apiOnly: capabilityEnforcement(meta.id) === 'api',
      }
    })
  }, [editableRole, coachSelected, role])

  const groups = useMemo(
    () =>
      CAPABILITY_GROUPS.map((group) => ({
        group,
        rows: rows.filter((r) => r.group === group),
      })).filter((g) => g.rows.length > 0),
    [rows]
  )

  function toggle(cap: Capability, on: boolean) {
    // Defensive: a locked row renders disabled, and its capability would be
    // stripped on resolve anyway — but storing one would put a grant in the
    // document that the screen then shows as off.
    if (coachLockReason(cap)) return
    const next = new Set(draft ?? initial)
    if (on) next.add(cap)
    else next.delete(cap)
    setDraft(next)
    setSaved(false)
  }

  async function save() {
    if (!currentTeamId) return
    setSaving(true)
    try {
      await setDoc(
        doc(db, TEAMS_COLLECTION, currentTeamId, ROLE_CONFIG_SUBCOLLECTION, 'coach'),
        {
          role: 'coach',
          capabilities: [...coachSelected],
          updatedBy: user?.uid ?? null,
          updated_at: serverTimestamp(),
        },
        { merge: true }
      )
      await qc.invalidateQueries({ queryKey: ['role-config', currentTeamId, 'coach'] })
      setDraft(null)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const roleLabel = (r: TeamRole) => tm(`role_${r}` as Parameters<typeof tm>[0])

  // Written out as literals rather than built from a prefix: `pnpm i18n:check`
  // cannot verify a computed key against the message files, so it counts and
  // reports them instead of failing them — and a section heading that silently
  // renders its own key id is exactly what that check exists to catch.
  function groupLabel(g: CapabilityGroup): string {
    switch (g) {
      case 'contacts':
        return t('group_contacts')
      case 'schedule':
        return t('group_schedule')
      case 'studio':
        return t('group_studio')
      case 'administration':
        return t('group_administration')
    }
  }

  function lockLabel(reason: CoachLockReason): string {
    return reason === 'owners_only' ? t('lock_owners_only') : t('lock_owners_and_managers')
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-4">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* THE ROLE PICKER — chips rather than a select. There are four, they are
          all worth seeing at once, and which one is editable is part of what the
          reader came to learn: a select would hide three of the four answers
          behind a click and show the "customizable" marker on none of them. */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('rolePickerLabel')}</p>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('rolePickerLabel')}>
          {ROLES.map((r) => {
            const active = r === role
            return (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setRole(r)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-muted text-muted-foreground'
                }`}
              >
                {r === 'coach' ? <Pencil className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                {roleLabel(r)}
              </button>
            )
          })}
        </div>
      </div>

      {/* The plan gate is about the COACH role specifically — it says nobody can
          be invited into it — so it appears with it and not over the read-only
          descriptions of the other three. */}
      {editableRole && gateKnown && !allowed && (
        <PlanUpgradeNotice
          minPlan={minPlan}
          feature="multiple_managers"
          variant="inline"
          title={t('seatLockedTitle')}
          description={t('seatLockedBody')}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2">
              {roleLabel(role)}
              <Badge variant={editableRole ? 'secondary' : 'outline'} className="text-xs">
                {editableRole ? t('badgeCustomizable') : t('badgeFixed')}
              </Badge>
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {dataScopeForRole(role) === 'own' ? t('ownScopeNote') : t('allScopeNote')}
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {editableRole ? t('coachSubtitle') : t('fixedRoleNote')}
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading && editableRole ? (
            <p className="text-sm text-muted-foreground">…</p>
          ) : (
            groups.map(({ group, rows: groupRows }) => {
              // The scope note belongs to the AREA, not the row. Shown only where
              // it is true: an own-scoped role, in a group that actually holds
              // scoped capabilities.
              const showScopeNote =
                dataScopeForRole(role) === 'own' &&
                groupRows.some((r) => capabilityIsScoped(r.meta.id))
              return (
                <section key={group} className="space-y-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b pb-1.5">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {groupLabel(group)}
                    </h2>
                    {showScopeNote && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {t('scopedHint')}
                      </span>
                    )}
                  </div>

                  {groupRows.map(({ meta, held, lock, apiOnly }) => (
                    <div key={meta.id} className="flex items-center justify-between gap-3">
                      <Label
                        htmlFor={`${role}-${meta.id}`}
                        className={`flex flex-wrap items-center gap-x-2 text-sm font-medium ${
                          held ? '' : 'text-muted-foreground'
                        }`}
                      >
                        {tc(meta.labelKey as Parameters<typeof tc>[0])}
                        {apiOnly && (
                          // Visible text, so `title` is extending something already
                          // labelled rather than being the label — which is the line
                          // components/ui/tip.tsx draws for when a styled tooltip is owed.
                          <span
                            title={t('apiOnlyTitle')}
                            className="rounded border px-1 py-px text-[10px] font-normal uppercase tracking-wide text-muted-foreground"
                          >
                            {t('apiOnlyTag')}
                          </span>
                        )}
                      </Label>
                      <div className="flex shrink-0 items-center gap-2">
                        {lock && (
                          <span className="text-xs text-muted-foreground">{lockLabel(lock)}</span>
                        )}
                        <Switch
                          id={`${role}-${meta.id}`}
                          checked={held}
                          onCheckedChange={(v: boolean) => toggle(meta.id, v)}
                          disabled={!canEdit || !!lock}
                        />
                      </div>
                    </div>
                  ))}
                </section>
              )
            })
          )}
        </CardContent>
      </Card>

      {editableRole && <p className="text-xs text-muted-foreground">{t('coachAssignHint')}</p>}

      {canEdit && <SettingsSaveBar onSave={save} saving={saving} saved={saved} disabled={!dirty} />}
    </div>
  )
}
