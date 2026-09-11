'use client'

import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  collection, query, orderBy, getDocs, addDoc,
  doc, getDoc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  BookOpen, Search, Mail, Bell, Settings2, FileText,
  Clock, UserPlus, TrendingUp, CalendarCheck, ShieldCheck, CreditCard, Play,
  Check, Plus, Lock,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import {  TEAMS_COLLECTION, PLAN_ORDER, type SaasPlan, AUTOMATION_RULES_SUBCOLLECTION, OUTREACH_TEMPLATES_SUBCOLLECTION } from '@linyup/shared'
import { usePlan } from '@/hooks/usePlan'
import { usePlanName } from '@/hooks/usePlanName'
import { useUpgradeModal } from '@/contexts/UpgradeModalContext'
import { PlanUpgradeNotice } from '@/components/plan/PlanUpgradeNotice'
import {
  AUTOMATION_LIBRARY, CATEGORY_META, libraryItemUnlocked, starterBundleItemsForPlan,
  type LibraryCategory, type LibraryItem, type LibraryAction, type SupportedLanguage,
} from './automationLibrary'

// ─── Types (local to this file) ───────────────────────────────────────────────

interface InstalledTemplate { id: string; system_key?: string }
interface InstalledRule { system_key?: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function triggerChip(type: string): { label: string; Icon: React.ElementType } {
  switch (type) {
    case 'schedule_daily':            return { label: 'Daily',         Icon: Clock }
    case 'contact_created':           return { label: 'On create',     Icon: UserPlus }
    case 'acquisition_stage_changed': return { label: 'Stage moved',   Icon: TrendingUp }
    case 'booking_confirmed':         return { label: 'Booking',       Icon: CalendarCheck }
    case 'booking_no_show':           return { label: 'No-show',       Icon: CalendarCheck }
    case 'affiliation_changed':       return { label: 'Affiliation',   Icon: ShieldCheck }
    case 'subscription_changed':      return { label: 'Subscription',  Icon: CreditCard }
    case 'session_ended':             return { label: 'Session end',   Icon: CalendarCheck }
    case 'manual':                    return { label: 'Manual',        Icon: Play }
    default:                          return { label: type,            Icon: Clock }
  }
}

function primaryAction(actions: LibraryAction[]): { label: string; Icon: React.ElementType } {
  const first = actions[0]
  if (!first) return { label: 'Action', Icon: Play }
  switch (first.type) {
    case 'send_email':   return { label: 'Email',        Icon: Mail }
    case 'notify_team':  return { label: 'Team alert',   Icon: Bell }
    case 'update_field': return { label: 'Update field', Icon: Settings2 }
    case 'log_activity': return { label: 'Log activity', Icon: FileText }
    default:             return { label: 'Action',       Icon: Play }
  }
}

// ─── LibraryCard ──────────────────────────────────────────────────────────────

function LibraryCard({
  item, installed, selected, locked, lockedPlanLabel, onToggle, onLockedClick,
}: {
  item: LibraryItem
  installed: boolean
  selected: boolean
  /** Above the team's plan — see `libraryItemUnlocked`. Rendered, not hidden:
   *  a hidden item is indistinguishable from one that does not exist, so it
   *  gives the studio no reason to upgrade and no way to ask. */
  locked: boolean
  /** The plan that unlocks it, already resolved to its marketing name. */
  lockedPlanLabel: string
  onToggle: () => void
  onLockedClick: () => void
}) {
  const trig  = triggerChip(item.rule.trigger.type)
  const act   = primaryAction(item.rule.actions)
  const TrigIcon = trig.Icon
  const ActIcon  = act.Icon

  return (
    <button
      type="button"
      onClick={installed ? undefined : locked ? onLockedClick : onToggle}
      disabled={installed}
      className={[
        'relative w-full text-left rounded-xl border p-3.5 transition-all',
        installed
          ? 'bg-muted/40 border-transparent opacity-60 cursor-default'
          : locked
            ? 'bg-muted/20 border-dashed border-border hover:border-primary/50'
            : selected
              ? 'bg-primary/5 border-primary ring-1 ring-primary shadow-sm'
              : 'bg-card border-border hover:border-primary/50 hover:shadow-sm',
      ].join(' ')}
    >
      {/* Checkbox / installed / locked indicator */}
      <span className={[
        'absolute top-3 right-3 h-4 w-4 rounded flex items-center justify-center border',
        installed
          ? 'border-transparent bg-muted text-muted-foreground'
          : locked
            ? 'border-transparent text-muted-foreground'
            : selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/30 bg-background',
      ].join(' ')}>
        {locked && !installed
          ? <Lock className="h-2.5 w-2.5" />
          : (installed || selected) && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>

      <p className="font-semibold text-sm leading-snug pr-6">{item.name}</p>
      <p className="text-xs text-muted-foreground mt-1 leading-snug line-clamp-2">{item.description}</p>

      <div className="flex gap-1.5 mt-2.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs rounded-full border px-2 py-0.5 text-muted-foreground bg-muted">
          <TrigIcon className="h-2.5 w-2.5" />{trig.label}
          {item.rule.trigger.delayMinutes ? ` +${item.rule.trigger.delayMinutes}m` : ''}
        </span>
        <span className="inline-flex items-center gap-1 text-xs rounded-full border px-2 py-0.5 text-muted-foreground bg-muted">
          <ActIcon className="h-2.5 w-2.5" />{act.label}
        </span>
        {installed && (
          <Badge variant="secondary" className="text-xs h-5">Installed</Badge>
        )}
        {locked && !installed && (
          <Badge variant="outline" className="text-xs h-5 gap-1">
            <Lock className="h-2.5 w-2.5" />{lockedPlanLabel}
          </Badge>
        )}
      </div>
    </button>
  )
}

// ─── Install logic ────────────────────────────────────────────────────────────

async function installItems(
  items: LibraryItem[],
  teamId: string,
  teamLanguage: string,
  allTemplates: InstalledTemplate[],
  installedRuleKeys: Set<string>
): Promise<void> {
  const SUPPORTED: SupportedLanguage[] = ['en', 'de', 'fr', 'it']
  const teamLang: SupportedLanguage = SUPPORTED.includes(teamLanguage as SupportedLanguage)
    ? (teamLanguage as SupportedLanguage)
    : 'en'

  const templatesRef = collection(db, TEAMS_COLLECTION, teamId, OUTREACH_TEMPLATES_SUBCOLLECTION)
  const rulesRef     = collection(db, TEAMS_COLLECTION, teamId, AUTOMATION_RULES_SUBCOLLECTION)

  // Resolve template_key → installed templateId (team-language variant)
  const teamLangTemplateId: Record<string, string> = {}

  for (const item of items) {
    if (item.template) {
      const langs = Object.keys(item.template.translations) as SupportedLanguage[]
      for (const lang of langs) {
        const content = item.template.translations[lang]!
        // New-style key: `library_key:lang`; old-style: just `library_key`
        const systemKey = `${item.library_key}:${lang}`
        const existing =
          allTemplates.find(t => t.system_key === systemKey) ??
          (lang === 'en' ? allTemplates.find(t => t.system_key === item.library_key) : undefined)

        if (existing) {
          if (lang === teamLang) teamLangTemplateId[item.library_key] = existing.id
        } else {
          const isDefault = lang === teamLang
          const ref = await addDoc(templatesRef, {
            name: isDefault ? item.template.name : `${item.template.name} (${lang.toUpperCase()})`,
            subject: content.subject,
            body: content.body,
            body_mode: item.template.body_mode,
            language: lang,
            active: true,
            system_key: systemKey,
            created_at: serverTimestamp(),
          })
          if (lang === teamLang) teamLangTemplateId[item.library_key] = ref.id
        }
      }
      // Fallback to 'en' if team language variant not available
      if (!teamLangTemplateId[item.library_key]) {
        teamLangTemplateId[item.library_key] =
          allTemplates.find(t => t.system_key === `${item.library_key}:en`)?.id ??
          allTemplates.find(t => t.system_key === item.library_key)?.id ??
          ''
      }
    }

    // Skip rule if already installed
    if (installedRuleKeys.has(item.library_key)) continue

    // Resolve actions — send_email needs the templateId; others pass through
    const actions = item.rule.actions.map((a) => {
      if (a.type === 'send_email') {
        // Look up by the action's template_key (may reference an existing sys_* template)
        const tmplKey = a.template_key
        const id =
          teamLangTemplateId[tmplKey] ??
          allTemplates.find(t => t.system_key === tmplKey)?.id ??
          ''
        return { type: 'send_email', templateId: id }
      }
      return a as Record<string, unknown>
    })

    await addDoc(rulesRef, {
      name: item.name,
      active: false,
      trigger: item.rule.trigger,
      conditions: item.rule.conditions,
      actions,
      system_key: item.library_key,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    })
  }
}

// ─── LibraryDialog ─────────────────────────────────────────────────────────

export function LibraryDialog({
  open,
  onOpenChange,
  teamId,
  rules,
  onInstalled,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  rules: InstalledRule[]
  onInstalled: () => void
}) {
  const t = useTranslations('Automations')
  const planName = usePlanName()
  const { plan } = usePlan()
  const { openUpgradeModal } = useUpgradeModal()
  const [search, setSearch]       = useState('')
  const [catFilter, setCatFilter] = useState<LibraryCategory | 'all'>('all')
  const [selected, setSelected]   = useState<Set<string>>(new Set())
  const [installing, setInstalling] = useState(false)
  const [error, setError]           = useState('')

  // Installed rule keys — O(1) lookup
  const installedRuleKeys = useMemo(
    () => new Set(rules.flatMap(r => r.system_key ? [r.system_key] : [])),
    [rules]
  )

  // Plan gate (UX-86). `requires_plan` was declared on every item and read by
  // nothing, so a Free team could install a Studio automation from here.
  const isLocked = (item: LibraryItem) => !libraryItemUnlocked(item, plan)
  // The CHEAPEST plan that unlocks anything currently locked — the notice must
  // name a plan the reader can act on, and naming the highest would overstate
  // the price of the next step.
  const lockedMinPlan = useMemo<SaasPlan | null>(() => {
    const locked = AUTOMATION_LIBRARY.filter(i => isLocked(i)).map(i => i.requires_plan as SaasPlan)
    if (locked.length === 0) return null
    return locked.reduce((a, b) => (PLAN_ORDER.indexOf(b) < PLAN_ORDER.indexOf(a) ? b : a))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan])

  // Fetch ALL templates (no active filter) when dialog opens, for install-time lookup
  const { data: allTemplates = [] } = useQuery<InstalledTemplate[]>({
    queryKey: ['outreach_templates_for_library', teamId],
    enabled: open && !!teamId,
    queryFn: async () => {
      const snap = await getDocs(
        query(collection(db, TEAMS_COLLECTION, teamId, OUTREACH_TEMPLATES_SUBCOLLECTION), orderBy('name', 'asc'))
      )
      return snap.docs.map(d => ({ ...d.data(), id: d.id }) as InstalledTemplate)
    },
    staleTime: 60000,
  })

  // Fetch team document for language setting
  const { data: teamData } = useQuery<Record<string, unknown>>({
    queryKey: ['team_for_library', teamId],
    enabled: open && !!teamId,
    queryFn: async () => {
      const snap = await getDoc(doc(db, TEAMS_COLLECTION, teamId))
      return snap.exists() ? (snap.data() as Record<string, unknown>) : {}
    },
    staleTime: 300000,
  })
  const teamLanguage = (teamData?.language as string) || 'en'

  // Filter library items
  const visibleItems = useMemo(() => {
    const term = search.toLowerCase()
    return AUTOMATION_LIBRARY.filter(item => {
      if (catFilter !== 'all' && item.category !== catFilter) return false
      if (!term) return true
      return (
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term) ||
        item.tags.some(t => t.includes(term))
      )
    })
  }, [search, catFilter])

  // Group by category for rendering
  const grouped = useMemo(() => {
    const cats = Object.keys(CATEGORY_META) as LibraryCategory[]
    return cats.map(cat => ({
      cat,
      items: visibleItems.filter(i => i.category === cat),
    })).filter(g => g.items.length > 0)
  }, [visibleItems])

  function toggle(key: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function selectAllAvailable() {
    const available = visibleItems
      .filter(i => !installedRuleKeys.has(i.library_key) && !isLocked(i))
      .map(i => i.library_key)
    setSelected(new Set(available))
  }

  async function handleInstall() {
    if (selected.size === 0) return
    setInstalling(true)
    setError('')
    try {
      // Re-filtered here and not only at selection time: the plan can change
      // (or finish loading) while the dialog is open, and the selection set
      // outlives that.
      const items = AUTOMATION_LIBRARY.filter(i => selected.has(i.library_key) && !isLocked(i))
      await installItems(items, teamId, teamLanguage, allTemplates, installedRuleKeys)
      setSelected(new Set())
      onInstalled()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message || 'Failed to install automations')
    } finally {
      setInstalling(false)
    }
  }

  // Count available (not yet installed) items in current view
  const availableCount  = visibleItems.filter(
    i => !installedRuleKeys.has(i.library_key) && !isLocked(i)
  ).length
  const installedCount  = AUTOMATION_LIBRARY.filter(i => installedRuleKeys.has(i.library_key)).length

  // Category pills
  const CATEGORIES = Object.entries(CATEGORY_META) as [LibraryCategory, typeof CATEGORY_META[LibraryCategory]][]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[860px] h-[90dvh] max-h-[90dvh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <BookOpen className="h-5 w-5 text-primary" />
            Automation Library
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            {AUTOMATION_LIBRARY.length} pre-built automations · {installedCount} installed
          </p>
        </DialogHeader>

        {/* Search + category filter */}
        <div className="px-6 py-3 border-b shrink-0 space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search automations…"
              className="h-8 text-xs pl-8"
            />
          </div>

          <div className="flex gap-1 overflow-x-auto pb-0.5">
            <button
              onClick={() => setCatFilter('all')}
              className={[
                'shrink-0 text-xs px-3 py-1 rounded-full border transition-colors',
                catFilter === 'all'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              All ({AUTOMATION_LIBRARY.length})
            </button>
            {CATEGORIES.map(([cat, meta]) => {
              const CatIcon = meta.icon
              const count = AUTOMATION_LIBRARY.filter(i => i.category === cat).length
              return (
                <button
                  key={cat}
                  onClick={() => setCatFilter(cat)}
                  className={[
                    'shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border transition-colors',
                    catFilter === cat
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  <CatIcon className="h-3 w-3" />{meta.label} ({count})
                </button>
              )
            })}
          </div>
        </div>

        {/* Scrollable items */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* Above-tier items stay visible and locked; this is the one control
              that can change the answer (the shared UX-42 notice). */}
          {lockedMinPlan && (
            <PlanUpgradeNotice
              minPlan={lockedMinPlan}
              feature="automation_flows"
              variant="inline"
              description={t('library.lockedNotice')}
            />
          )}
          {grouped.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No automations match your search.
            </p>
          )}

          {grouped.map(({ cat, items }) => {
            const meta = CATEGORY_META[cat]
            const CatIcon = meta.icon
            return (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-3">
                  <CatIcon className={`h-3.5 w-3.5 ${meta.color}`} />
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {meta.label}
                  </h3>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {items.map(item => (
                    <LibraryCard
                      key={item.library_key}
                      item={item}
                      installed={installedRuleKeys.has(item.library_key)}
                      selected={selected.has(item.library_key)}
                      locked={isLocked(item)}
                      lockedPlanLabel={planName(item.requires_plan as SaasPlan)}
                      onToggle={() => toggle(item.library_key)}
                      onLockedClick={() =>
                        openUpgradeModal({ minPlan: item.requires_plan as SaasPlan })
                      }
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Sticky footer */}
        <div className="px-6 py-4 border-t bg-background shrink-0">
          {error && <p className="text-xs text-destructive mb-2">{error}</p>}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={selectAllAvailable}
                disabled={availableCount === 0}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:no-underline disabled:opacity-40"
              >
                Select all available ({availableCount})
              </button>
              {selected.size > 0 && (
                <span className="text-xs text-muted-foreground">
                  {selected.size} selected
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                size="sm"
                onClick={handleInstall}
                disabled={selected.size === 0 || installing}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                {installing
                  ? 'Installing…'
                  : selected.size > 0
                    ? `Add ${selected.size} automation${selected.size > 1 ? 's' : ''}`
                    : 'Add automations'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Quick-start installer (used by empty-state button) ───────────────────────

/** `plan` is REQUIRED, and deliberately not optional-with-a-default: the
 *  quick-start button installs the whole starter bundle in one click with no
 *  review step, so a call site that forgot to pass it would reopen UX-86 at its
 *  widest point. Filtering happens in `starterBundleItemsForPlan`, the same
 *  reader the dialog locks on.
 *
 *  Every rule lands `active: false` (installItems, above) — including the
 *  welcome mail, which is the one whose failure mode is loudest: a bundle that
 *  installed it live would greet the entire existing roster the first time
 *  anyone's stage moved. The studio switches each rule on after reading it. */
export async function installStarterBundle(
  teamId: string,
  allTemplates: InstalledTemplate[],
  installedRuleKeys: Set<string>,
  opts: { plan: SaasPlan | null; teamLanguage?: string }
): Promise<void> {
  const items = starterBundleItemsForPlan(opts.plan)
  await installItems(items, teamId, opts.teamLanguage ?? 'en', allTemplates, installedRuleKeys)
}
