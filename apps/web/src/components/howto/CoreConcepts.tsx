'use client'

// "Core concepts" area of the How-to page: heading + the clickable concept map
// + a row of five selector cards driving one shared detail panel (body, key
// terms, in-app links). Diagram nodes and cards select the same state — one
// linked system rather than two ways of expanding things.
import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { ArrowRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { CONCEPTS, type ConceptId } from './concepts'
import { ConceptMap } from './ConceptMap'

export function CoreConcepts() {
  const t = useTranslations('HowTo')
  // Never empty — the panel always shows a concept. Contacts is where both the
  // map (the apex) and the card row start, so it's also where the panel starts.
  const [selected, setSelected] = useState<ConceptId>('contacts')
  const panelRef = useRef<HTMLDivElement>(null)

  // Diagram clicks scroll the panel into view (it may be below the fold);
  // card clicks don't need to — the panel sits right under the row.
  function selectConcept(id: ConceptId, scroll = false) {
    setSelected(id)
    if (scroll) {
      requestAnimationFrame(() =>
        panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      )
    }
  }

  const concept = CONCEPTS.find((c) => c.id === selected)!
  // These blocks are OPTIONAL per concept, so a missing key is normal, not a
  // fault. Two traps: `t.raw` reports MISSING_MESSAGE to the console (and to
  // error tracking) for every absent key, so check `t.has` first; and what it
  // returns on a miss is the key PATH — a truthy string — so the result still
  // needs an Array.isArray guard rather than `?? []`, or it reaches .map.
  const raw = (key: string): unknown[] => {
    const path = `concepts.${selected}.${key}` as Parameters<typeof t.has>[0]
    if (!t.has(path)) return []
    const v = t.raw(path)
    return Array.isArray(v) ? v : []
  }
  const terms = raw('terms') as string[]
  // Optional side-by-side block: a concept covering several shapes of the same
  // thing (classes vs appointments vs events) needs them contrasted, not just
  // listed. Data-driven from i18n so the panel stays generic — a concept
  // without `compare` simply doesn't render one.
  const compare = raw('compare') as { title: string; body: string }[]
  // Optional funnel block: a top-down stage flow mirroring the real
  // AcquisitionTimeline on the contact detail page, with each stage's meaning
  // and the entry points that land someone on it.
  const funnel = raw('funnel') as { label: string; meaning: string; entries: string[] }[]

  return (
    <section>
      <h2 className="text-lg font-semibold">{t('conceptsTitle')}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('conceptsIntro')}</p>

      <div className="mt-6">
        <ConceptMap selected={selected} onSelect={(id) => selectConcept(id, true)} />
      </div>

      {/* Selector card row */}
      <div role="tablist" className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {CONCEPTS.map((c) => {
          const active = c.id === selected
          const Icon = c.icon
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              id={`howto-concept-tab-${c.id}`}
              aria-selected={active}
              aria-controls="howto-concept-panel"
              onClick={() => selectConcept(c.id)}
              className={`flex flex-col items-start gap-2 rounded-xl border bg-card p-3 text-left transition-colors ${
                active
                  ? 'border-primary bg-primary/[0.04] ring-1 ring-primary/40'
                  : 'hover:border-muted-foreground/30'
              }`}
            >
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-md ${
                  active ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary'
                }`}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-tight">
                  {t(`concepts.${c.id}.label` as Parameters<typeof t>[0])}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                  {t(`concepts.${c.id}.tagline` as Parameters<typeof t>[0])}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/* Shared detail panel */}
      <div
        ref={panelRef}
        role="tabpanel"
        id="howto-concept-panel"
        aria-labelledby={`howto-concept-tab-${selected}`}
        className="mt-4 scroll-mt-20 rounded-xl border bg-card p-5"
      >
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(`concepts.${selected}.body` as Parameters<typeof t>[0])}
        </p>

        {compare.length > 0 && (
          <div className="mt-4">
            <p className="text-sm text-muted-foreground">
              {t(`concepts.${selected}.compareIntro` as Parameters<typeof t>[0])}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {compare.map((c, i) => (
                <div key={i} className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-xs font-semibold">{c.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Acquisition funnel — same rail-and-connector shape as the real
            AcquisitionTimeline on the contact detail page, so the explanation
            and the thing being explained look like each other. Nodes are
            NUMBERED rather than checked: this is the whole path, not one
            contact's progress, and ticks would read as "already reached". */}
        {funnel.length > 0 && (
          <div className="mt-4">
            <p className="text-sm text-muted-foreground">
              {t(`concepts.${selected}.funnelIntro` as Parameters<typeof t>[0])}
            </p>
            <ol className="mt-3 flex flex-col">
              {funnel.map((stage, i) => {
                const isLast = i === funnel.length - 1
                return (
                  <li key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-primary bg-primary/10 text-[0.625rem] font-semibold text-primary">
                        {i + 1}
                      </span>
                      {!isLast && <span className="my-1 w-0.5 flex-1 bg-primary/30" />}
                    </div>
                    <div className={`min-w-0 ${isLast ? '' : 'pb-4'}`}>
                      <p className="text-[0.8125rem] font-medium leading-5">{stage.label}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {stage.meaning}
                      </p>
                      {stage.entries.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="text-[0.6875rem] text-muted-foreground/70">
                            {t('funnelEntriesLabel')}
                          </span>
                          {stage.entries.map((e, j) => (
                            <span
                              key={j}
                              className="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground"
                            >
                              {e}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t(`concepts.${selected}.funnelNote` as Parameters<typeof t>[0])}
            </p>
          </div>
        )}

        {terms.length > 0 && (
          <div className="mt-4">
            <p className="pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t('termsLabel')}
            </p>
            <ul className="space-y-1.5">
              {terms.map((term, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0 text-primary">•</span>
                  <span>{term}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t pt-3">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('seeInApp')}
          </span>
          {concept.links.map((l) => (
            <Link
              key={l.href}
              href={l.href as Route}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {t(`concepts.${selected}.links.${l.labelKey}` as Parameters<typeof t>[0])}
              <ArrowRight className="h-3 w-3" />
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
