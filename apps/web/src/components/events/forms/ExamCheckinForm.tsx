'use client'

import { findRankLevel, rankLevelKey } from '@linyup/shared'

import { useState } from 'react'
import type { Route } from 'next'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useRankingSystems } from '@/hooks/useRankingSystems'
import type { RankingSystem, RankRef } from '@linyup/shared'

export function ExamCheckinForm({
  contact,
  rankingSystems,
  existing,
  onSubmit,
  onCancel,
  busy,
}: {
  contact: { id: string; firstname: string; lastname: string }
  rankingSystems: RankingSystem[]
  existing?: Record<string, unknown>
  onSubmit: (data: Record<string, unknown>) => void
  onCancel: () => void
  busy?: boolean
}) {
  const t = useTranslations('CheckinPanel')
  const tCommon = useTranslations('Common')

  // The list itself stays a prop — an org-wide event is examined against the
  // ORG's systems, which the event page has already resolved. This read is only
  // for the empty state, which has to point at a page the studio can actually
  // add a system on.
  const { managedByOrg, orgId } = useRankingSystems()

  // A RankRef per system: the level's id (what this form writes), or a legacy
  // number on a check-in recorded before ids existed.
  const existingDisciplines = (existing?.disciplines as Record<string, RankRef>) ?? {}

  const [disciplines, setDisciplines] = useState<Record<string, RankRef>>(existingDisciplines)

  function setLevel(systemId: string, level: RankRef | null) {
    setDisciplines((prev) => {
      const next = { ...prev }
      if (level === null) delete next[systemId]
      else next[systemId] = level
      return next
    })
  }

  // ABSENCE means "not examined"; 0 is a real result. Every scale's first level
  // is `value: 0` — the white belt, the entry grade — so testing `> 0` made the
  // one level a beginner actually earns unrecordable: it read back as nothing
  // examined, greyed the button and lit the warning. The key being present is
  // the whole question, which is the same rule `isCheckinCompleted`'s exam arm
  // applies in @linyup/shared.
  const examined = (systemId: string) =>
    Object.prototype.hasOwnProperty.call(disciplines, systemId)
  const hasAny = Object.keys(disciplines).length > 0

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{contact.firstname} {contact.lastname}</p>
      <p className="text-xs text-muted-foreground">{t('examIntro')}</p>

      {rankingSystems.length === 0 && (
        // WHERE the systems live decides where this sends them. An org-managed
        // studio has no editable ranking tab of its own — its systems come from
        // the organisation — so "add them in Team settings" pointed at a screen
        // that is read-only for exactly the tenants most likely to run exams.
        <p className="text-sm text-muted-foreground italic">
          {t('examNoSystems')}{' '}
          <Link
            href={
              (managedByOrg && orgId
                ? `/org/${orgId}/ranking`
                : '/settings/team?tab=ranking') as Route
            }
            className="not-italic text-primary hover:underline"
          >
            {managedByOrg && orgId ? t('examNoSystemsOrgLink') : t('examNoSystemsTeamLink')}
          </Link>
        </p>
      )}

      {rankingSystems.map((sys) => {
        const levels = sys.levels ?? []
        return (
          <div key={sys.id} className="space-y-1.5">
            <Label>{sys.name}</Label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setLevel(sys.id, null)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                  !examined(sys.id)
                    ? 'bg-muted text-muted-foreground border-transparent'
                    : 'hover:bg-muted border-border'
                }`}
              >
                {t('examNotExamined')}
              </button>
              {levels.map((lvl) => (
                <button
                  key={lvl.id}
                  onClick={() => setLevel(sys.id, rankLevelKey(lvl))}
                  className={`px-3 py-1.5 text-xs rounded-md border transition-colors flex items-center gap-1.5 ${
                    findRankLevel(levels, disciplines[sys.id]) === lvl
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'hover:bg-muted border-border'
                  }`}
                >
                  {lvl.color && (
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: lvl.color }}
                    />
                  )}
                  {lvl.label}
                </button>
              ))}
            </div>
          </div>
        )
      })}

      {!hasAny && rankingSystems.length > 0 && (
        <p className="text-xs text-amber-600">{t('examSelectAtLeastOne')}</p>
      )}

      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onCancel} disabled={busy}>{tCommon('cancel')}</Button>
        <Button
          onClick={() => onSubmit({ disciplines })}
          disabled={busy || (!hasAny && rankingSystems.length > 0)}
        >
          {existing ? t('submitUpdate') : t('submitCheckIn')}
        </Button>
      </div>
    </div>
  )
}
