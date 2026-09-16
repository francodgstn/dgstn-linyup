'use client'

// Part 1 of the Pricing section: "How pricing fits together" — a compact
// four-node diagram (What you offer / What you sell / Member benefits / The
// price preview) in the ConceptMap style, wired to a shared detail panel
// (body + a short "what it covers" list + one in-app link), the same linked-
// system pattern as CoreConcepts/ConceptMap, just collapsed into one file
// since there's only one diagram here.
import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Route } from 'next'
import { ArrowRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { MONEY_MAP_NODES, MONEY_MAP_EDGES, MONEY_MAP_VIEWBOX, type MoneyMapNodeId } from './data'

export function PricingMoneyMap() {
  const t = useTranslations('HowTo')
  // Never empty — the panel always shows a node. "What you offer" is the
  // natural starting point: everything else exists to price it.
  const [selected, setSelected] = useState<MoneyMapNodeId>('offer')
  const panelRef = useRef<HTMLDivElement>(null)

  function select(id: MoneyMapNodeId, scroll = false) {
    setSelected(id)
    if (scroll) {
      requestAnimationFrame(() =>
        panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      )
    }
  }

  const node = MONEY_MAP_NODES.find((n) => n.id === selected)!

  // `items` is OPTIONAL-shaped like CoreConcepts' `terms`/`compare` blocks —
  // check t.has first (t.raw logs MISSING_MESSAGE otherwise), and guard with
  // Array.isArray since a miss still returns the key path as a truthy string.
  const raw = (key: string): unknown[] => {
    const path = `pricing.map.nodes.${selected}.${key}` as Parameters<typeof t.has>[0]
    if (!t.has(path)) return []
    const v = t.raw(path)
    return Array.isArray(v) ? v : []
  }
  const items = raw('items') as string[]

  return (
    <div>
      <h3 className="text-base font-semibold">{t('pricing.map.title')}</h3>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('pricing.map.intro')}</p>

      <div className="mx-auto mt-5 max-w-2xl">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <svg
            viewBox={MONEY_MAP_VIEWBOX}
            role="group"
            aria-label={t('pricing.map.diagramAria')}
            className="h-auto w-full min-w-[480px]"
          >
            <defs>
              <marker
                id="howto-pricing-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/60" />
              </marker>
            </defs>

            {MONEY_MAP_EDGES.map((e) => (
              <line
                key={e.labelKey}
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                strokeWidth={1.5}
                className="stroke-border"
                markerEnd="url(#howto-pricing-arrow)"
              />
            ))}

            {MONEY_MAP_NODES.map((n) => {
              const active = n.id === selected
              return (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={t(`pricing.map.nodes.${n.id}.label` as Parameters<typeof t>[0])}
                  aria-pressed={active}
                  onClick={() => select(n.id, true)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault()
                      select(n.id, true)
                    }
                  }}
                  className="cursor-pointer outline-none focus-visible:opacity-80"
                >
                  <rect
                    x={n.x}
                    y={n.y}
                    width={n.w}
                    height={n.h}
                    rx={12}
                    strokeWidth={active ? 1.5 : 1}
                    className={
                      active
                        ? 'fill-primary/10 stroke-primary transition-colors'
                        : 'fill-card stroke-border transition-colors hover:stroke-muted-foreground/60'
                    }
                  />
                  {(() => {
                    // A shortLabel may carry a newline to wrap inside the
                    // node — SVG <text> doesn't wrap, so a two-word name that
                    // exceeds the box is split explicitly (see ConceptMap).
                    const lines = (
                      t(`pricing.map.nodes.${n.id}.shortLabel` as Parameters<typeof t>[0]) as string
                    ).split('\n')
                    const mid = n.y + n.h / 2 + 4.5
                    return (
                      <text
                        x={n.x + n.w / 2}
                        y={lines.length > 1 ? mid - 7 : mid}
                        textAnchor="middle"
                        fontSize={13}
                        className={`select-none ${active ? 'fill-primary font-semibold' : 'fill-foreground font-medium'}`}
                      >
                        {lines.map((line, i) => (
                          <tspan key={i} x={n.x + n.w / 2} dy={i === 0 ? 0 : 14}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                    )
                  })()}
                </g>
              )
            })}

            {MONEY_MAP_EDGES.map((e) => (
              <text
                key={e.labelKey}
                x={e.lx}
                y={e.ly}
                textAnchor="middle"
                fontSize={11}
                strokeWidth={5}
                style={{ paintOrder: 'stroke' }}
                className="pointer-events-none fill-muted-foreground stroke-background select-none"
              >
                {t(`pricing.map.edges.${e.labelKey}` as Parameters<typeof t>[0])}
              </text>
            ))}
          </svg>
        </div>
        <p className="mt-1 text-center text-xs text-muted-foreground sm:hidden">
          {t('pricing.map.diagramHint')}
        </p>
      </div>

      {/* Selector card row — same node set as the diagram, one shared panel. */}
      <div role="tablist" className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {MONEY_MAP_NODES.map((n) => {
          const active = n.id === selected
          const Icon = n.icon
          return (
            <button
              key={n.id}
              type="button"
              role="tab"
              id={`howto-pricing-map-tab-${n.id}`}
              aria-selected={active}
              aria-controls="howto-pricing-map-panel"
              onClick={() => select(n.id)}
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
                  {t(`pricing.map.nodes.${n.id}.label` as Parameters<typeof t>[0])}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                  {t(`pricing.map.nodes.${n.id}.tagline` as Parameters<typeof t>[0])}
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
        id="howto-pricing-map-panel"
        aria-labelledby={`howto-pricing-map-tab-${selected}`}
        className="mt-4 scroll-mt-20 rounded-xl border bg-card p-5"
      >
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(`pricing.map.nodes.${selected}.body` as Parameters<typeof t>[0])}
        </p>

        {items.length > 0 && (
          <div className="mt-4">
            <p className="pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t('termsLabel')}
            </p>
            <ul className="space-y-1.5">
              {items.map((item, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0 text-primary">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t pt-3">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('seeInApp')}
          </span>
          <Link
            href={node.href as Route}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {t(`pricing.linkLabels.${node.linkKey}` as Parameters<typeof t>[0])}
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  )
}
