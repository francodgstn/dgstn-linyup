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
  COACH_ASSIGNABLE_CAPABILITIES,
  COACH_DEFAULT_CAPABILITIES,
  SYSTEM_ROLE_CAPABILITIES,
  capabilityIsScoped,
  dataScopeForRole,
  type Capability,
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
 * So the page now picks a role first. Owner, Manager and Viewer render the same
 * capability list, READ-ONLY, from `SYSTEM_ROLE_CAPABILITIES` — the one
 * definition the rules and the callables read, so this screen cannot drift from
 * what is enforced. Coach renders the editable subset it always did.
 *
 * ── FIXED ROLES SHOW THE WHOLE CATALOGUE ───────────────────────────────────
 * …including the capabilities they do NOT have, greyed and off. A list of only
 * what a manager can do cannot answer "can a manager do X" for any X outside it
 * — the reader is left unable to tell "no" from "not listed here". Coach shows
 * the assignable subset instead, because there the list is a set of controls and
 * a switch that can never move is not one.
 */

const ASSIGNABLE = new Set(COACH_ASSIGNABLE_CAPABILITIES)
/** The Coach editor's menu: what a team may grant. */
const COACH_CATALOG = CAPABILITY_CATALOG.filter((c) => ASSIGNABLE.has(c.id))

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
        doc(db, TEAMS_COLLECTION, currentTeamId!, ROLE_CONFIG_SUBCOLLECTION, 'coach'),
      )
      const d = snap.exists() ? snap.data() : null
      return {
        capabilities: (d?.capabilities as Capability[] | undefined) ?? null,
      }
    },
  })

  const initial = useMemo<Set<Capability>>(
    () => new Set(stored?.capabilities ?? COACH_DEFAULT_CAPABILITIES),
    [stored],
  )
  const [draft, setDraft] = useState<Set<Capability> | null>(null)
  const coachSelected = draft ?? initial
  const dirty = draft !== null
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  /** The rows to render for the selected role, and whether each is held. ONE
   *  source for both halves: the fixed sets come from `SYSTEM_ROLE_CAPABILITIES`
   *  (what the rules read), never from a list retyped for display. */
  const rows = useMemo(() => {
    if (editableRole) {
      return COACH_CATALOG.map((c) => ({ meta: c, held: coachSelected.has(c.id) }))
    }
    const held = new Set(SYSTEM_ROLE_CAPABILITIES[role as 'owner' | 'manager' | 'viewer'])
    return CAPABILITY_CATALOG.map((c) => ({ meta: c, held: held.has(c.id) }))
  }, [editableRole, coachSelected, role])

  function toggle(cap: Capability, on: boolean) {
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
        { merge: true },
      )
      await qc.invalidateQueries({ queryKey: ['role-config', currentTeamId, 'coach'] })
      setDraft(null)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const roleLabel = (r: TeamRole) => tm(`role_${r}` as Parameters<typeof tm>[0])

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
        <CardContent className="space-y-5">
          {isLoading && editableRole ? (
            <p className="text-sm text-muted-foreground">…</p>
          ) : (
            <div className="space-y-2.5">
              {rows.map(({ meta, held }) => (
                <div key={meta.id} className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label
                      htmlFor={`${role}-${meta.id}`}
                      className={`text-sm font-medium ${held ? '' : 'text-muted-foreground'}`}
                    >
                      {tc(meta.labelKey as Parameters<typeof tc>[0])}
                    </Label>
                    {capabilityIsScoped(meta.id) && dataScopeForRole(role) === 'own' && (
                      <p className="text-xs text-muted-foreground">{t('scopedHint')}</p>
                    )}
                  </div>
                  <Switch
                    id={`${role}-${meta.id}`}
                    checked={held}
                    onCheckedChange={(v: boolean) => toggle(meta.id, v)}
                    disabled={!canEdit}
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {editableRole && (
        <p className="text-xs text-muted-foreground">{t('coachAssignHint')}</p>
      )}

      {canEdit && (
        <SettingsSaveBar onSave={save} saving={saving} saved={saved} disabled={!dirty} />
      )}
    </div>
  )
}
