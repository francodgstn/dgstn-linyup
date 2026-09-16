'use client'

/**
 * DRAFT YOUR OFFER WITH AI — the review step, which is the whole feature.
 *
 * The model's proposal arrives here and goes no further until somebody reads
 * it. That is not a courtesy: `draftOfferings` writes nothing at all, and
 * `applyOfferingDraft` re-parses whatever this sends, so this dialog is the
 * seam where a human decides — and it is the only thing between a sentence and
 * a priced record (Franco, 2026-09-02).
 *
 * TICKED IN, NOT TICKED OUT. Every row arrives selected because the common case
 * is "yes, all of it"; unticking is how you drop the two you did not want. The
 * count on the button is what a studio reads before committing.
 *
 * PRICES ARE CALLED SUGGESTIONS, out loud, above the list. Structure applied
 * wrongly is an annoying afternoon; a plan created at the wrong monthly price is
 * a refund conversation with a member. The model is told to omit prices it is
 * guessing rather than invent them, and where one did come back it is shown as
 * a chip a reader's eye lands on rather than as a settled field.
 */

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { httpsCallable } from 'firebase/functions'
import { Sparkles, Zap, IdCard, AlertTriangle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { functions } from '@/lib/firebase'
import { formatCurrency } from '@/lib/format'
import { OFFERING_DRAFT_LIMITS, type OfferingDraft } from '@linyup/shared'

type DraftResult = { draft: OfferingDraft; problems: { path: string; code: string }[] }

export function AiDraftDialog({
  open,
  onOpenChange,
  teamId,
  currency,
  onApplied,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  teamId: string
  currency: string
  /** Refresh the rail — the new records exist by the time this runs. */
  onApplied: () => void
}) {
  const t = useTranslations('OfferCatalogue')
  const [prompt, setPrompt] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<DraftResult | null>(null)
  /** Draft keys the studio has UNticked. Absent from here = included. */
  const [dropped, setDropped] = useState<Set<string>>(new Set())

  const draft = result?.draft ?? null
  const kept = useMemo(() => {
    if (!draft) return null
    // A plan the studio dropped must also stop gating an activity it was the
    // only key for — otherwise the applier's own fallback would quietly turn a
    // gated activity open, which is a different thing from what was reviewed.
    const keptPlans = draft.plans.filter((p) => !dropped.has(p.key))
    const livePlanKeys = new Set(keptPlans.map((p) => p.key))
    return {
      activities: draft.activities
        .filter((a) => !dropped.has(a.key))
        .map((a) => ({ ...a, planKeys: a.planKeys?.filter((k) => livePlanKeys.has(k)) })),
      plans: keptPlans.map((p) => ({
        ...p,
        activityKeys: p.activityKeys?.filter((k) => !dropped.has(k)),
      })),
    }
  }, [draft, dropped])

  const keptCount = (kept?.activities.length ?? 0) + (kept?.plans.length ?? 0)

  function reset() {
    setResult(null)
    setDropped(new Set())
  }

  async function generate() {
    if (!prompt.trim() || drafting) return
    setDrafting(true)
    reset()
    try {
      const call = httpsCallable<{ teamId: string; prompt: string }, DraftResult>(
        functions,
        'draftOfferings'
      )
      const res = await call({ teamId, prompt: prompt.trim() })
      setResult(res.data)
    } catch (err) {
      console.error('[ai-draft] failed:', err)
      toast.error(t('aiFailed'))
    } finally {
      setDrafting(false)
    }
  }

  async function apply() {
    if (!kept || applying) return
    if (keptCount === 0) {
      toast.error(t('aiNothingPicked'))
      return
    }
    setApplying(true)
    try {
      const call = httpsCallable<
        { teamId: string; draft: OfferingDraft },
        { activities: number; plans: number }
      >(functions, 'applyOfferingDraft')
      const res = await call({ teamId, draft: kept })
      toast.success(t('aiApplied', { activities: res.data.activities, plans: res.data.plans }))
      onApplied()
      onOpenChange(false)
      setPrompt('')
      reset()
    } catch (err) {
      console.error('[ai-draft] apply failed:', err)
      toast.error(t('aiFailed'))
    } finally {
      setApplying(false)
    }
  }

  const toggle = (key: string) =>
    setDropped((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const planName = (key: string) => draft?.plans.find((p) => p.key === key)?.name ?? key

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset() }}>
      <DialogContent className="sm:max-w-lg lg:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('aiTitle')}
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('aiIntro')}</p>

          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('aiPlaceholder')}
            maxLength={OFFERING_DRAFT_LIMITS.promptChars}
            rows={3}
            disabled={drafting || applying}
          />

          {/* SAID PLAINLY, not buried in a tooltip. The reason a studio can use
              this without reading the code is that the scope is narrow, so the
              scope is the thing to say. */}
          <p className="text-xs text-muted-foreground">{t('aiScopeNote')}</p>

          {!result && (
            <Button onClick={() => void generate()} disabled={!prompt.trim() || drafting}>
              {drafting ? t('aiGenerating') : t('aiGenerate')}
            </Button>
          )}

          {draft && (
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">{t('aiReviewTitle')}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void generate()}
                  disabled={drafting || applying}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {drafting ? t('aiGenerating') : t('aiRetry')}
                </Button>
              </div>

              {draft.note && <p className="text-xs text-muted-foreground">{draft.note}</p>}

              <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('aiPriceWarning')}
              </p>

              <div className="space-y-2">
                {draft.plans.map((plan) => {
                  const on = !dropped.has(plan.key)
                  return (
                    <DraftRow
                      key={plan.key}
                      on={on}
                      onToggle={() => toggle(plan.key)}
                      icon={<IdCard className="h-4 w-4" />}
                      name={plan.name}
                      chips={
                        plan.prices?.length
                          ? plan.prices.map((p) => `${formatCurrency(p.amount, currency)} · ${p.recurrence}`)
                          : [t('aiNoPrice')]
                      }
                      note={plan.description}
                    />
                  )
                })}
                {draft.activities.map((activity) => {
                  const on = !dropped.has(activity.key)
                  const gates = (activity.planKeys ?? [])
                    .concat(
                      draft.plans
                        .filter((p) => p.activityKeys?.includes(activity.key))
                        .map((p) => p.key)
                    )
                    .filter((k, i, arr) => arr.indexOf(k) === i && !dropped.has(k))
                  const chips: string[] = []
                  if (activity.type === 'appointment' && activity.durations?.length) {
                    activity.durations.forEach((d) =>
                      chips.push(
                        d.priceAmount !== undefined
                          ? `${d.minutes}′ · ${formatCurrency(d.priceAmount, currency)}`
                          : `${d.minutes}′`
                      )
                    )
                  }
                  if (activity.dropInPriceAmount !== undefined) {
                    chips.push(formatCurrency(activity.dropInPriceAmount, currency))
                  }
                  if (activity.accessTier === 'subscription') {
                    chips.push(
                      gates.length
                        ? t('aiIncludes', { plans: gates.map(planName).join(', ') })
                        : t('aiOpensNothing')
                    )
                  }
                  return (
                    <DraftRow
                      key={activity.key}
                      on={on}
                      onToggle={() => toggle(activity.key)}
                      icon={<Zap className="h-4 w-4" />}
                      name={activity.name}
                      chips={chips}
                      note={activity.description}
                    />
                  )
                })}
              </div>
            </div>
          )}
        </DialogBody>

        {draft && (
          <DialogFooter>
            <Button onClick={() => void apply()} disabled={applying || keptCount === 0}>
              {applying ? t('aiApplying') : t('aiApply', { count: keptCount })}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** One proposed record. A plain checkbox rather than a switch: this is a list
 *  of things to include, which is what a checkbox means. */
function DraftRow({
  on,
  onToggle,
  icon,
  name,
  chips,
  note,
}: {
  on: boolean
  onToggle: () => void
  icon: React.ReactNode
  name: string
  chips: string[]
  note?: string
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
        on ? 'bg-card' : 'bg-muted/40 opacity-60'
      }`}
    >
      <input type="checkbox" checked={on} onChange={onToggle} className="mt-1 h-4 w-4 shrink-0" />
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="block text-sm font-medium">{name}</span>
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
        {chips.length > 0 && (
          <span className="flex flex-wrap gap-1 pt-0.5">
            {chips.map((c, i) => (
              <Badge key={i} variant="outline" className="text-[0.6875rem] font-normal">
                {c}
              </Badge>
            ))}
          </span>
        )}
      </span>
    </label>
  )
}
