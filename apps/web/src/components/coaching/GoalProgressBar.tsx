'use client'

// The step rail above a goal's task list: one circle per task on a track that
// fills as they get ticked.
//
// ONE COMPONENT, TWO SURFACES. The admin tab and the member's Space both draw
// this, and for a while each carried its own copy — structurally identical,
// differing only in where the colours came from (Tailwind semantic tokens vs
// the tenant palette from `useSpaceTheme`). That is the exact shape of drift
// docs/scalability-2026-09.md is about, freshly created in the same month the
// document was written. So: the geometry lives here once, and colour is a
// parameter. Pass nothing and it uses the app's semantic tokens (dark mode and
// all); pass a `palette` and it paints with the tenant's colours instead.
//
// DELIBERATELY NOT JUST A PERCENTAGE BAR. A goal's tasks are a short, named
// sequence ("bring a gi", "drill the entry", "spar it") — five of them, not five
// hundred — so the steps themselves have to be visible, and a bare bar would
// hide how many are left. It reuses the SAME icons the task rows use
// (CheckCircle2 / Circle), so a circle on the rail and a circle in the list
// below are visibly the same thing.
//
// TWO READINGS, ON PURPOSE, and they answer different questions:
//   • the FILL is how far along the goal is — done ÷ total, a summary;
//   • each CIRCLE is that task's own state.
// They are drawn together because a list finished out of order is a real thing:
// the fill says "two of four", the circles say WHICH two, and neither has to
// lie to keep the other honest. (Which is also why the steps must arrive in
// the order they were written — see `sortSteps` in @linyup/shared for the bug
// where they did not, and the rail contradicted itself.)

import { CheckCircle2, Circle } from 'lucide-react'
import type { Goal } from '@linyup/shared'

/** Tenant colours for a themed surface. Absent ⇒ the app's semantic tokens. */
export interface GoalProgressPalette {
  /** The fill and the done-circle — the "progress" colour. */
  accent: string
  /** Pending circles and the count label. */
  muted: string
  /** Behind each circle, so the track does not show through the icon. */
  halo: string
  /** The unfilled track. */
  track: string
}

export function GoalProgressBar({
  steps,
  label,
  palette,
}: {
  steps: Goal[]
  label: string
  palette?: GoalProgressPalette
}) {
  // Nothing to draw for a goal with no tasks — the caller decides what, if
  // anything, to show instead; a "no tasks yet" line says more than an empty
  // rail would.
  if (steps.length === 0) return null

  const done = steps.filter((s) => s.status === 'achieved').length
  const pct = Math.round((done / steps.length) * 100)

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex min-w-0 flex-1 items-center" aria-hidden="true">
        {/* The track, and the fill that advances along it. Inset by half an
            icon at each end so the fill starts and finishes UNDER the first and
            last circles rather than poking out past them. */}
        <div
          className={`absolute inset-x-2 h-1 rounded-full ${palette ? '' : 'bg-muted-foreground/20'}`}
          style={palette ? { background: palette.track } : undefined}
        />
        <div
          className={`absolute left-2 h-1 rounded-full transition-[width] duration-300 ${palette ? '' : 'bg-green-500'}`}
          style={{
            width: `calc((100% - 1rem) * ${pct} / 100)`,
            ...(palette ? { background: palette.accent } : {}),
          }}
        />
        {/* Evenly spread across the full width — `justify-between` rather than
            flexing the connectors, which bunched the last two circles together
            whenever a goal had three tasks. */}
        <div className="relative flex w-full items-center justify-between">
          {steps.map((step) => (
            <span
              key={step.id}
              className={`rounded-full leading-none ${palette ? '' : 'bg-card'}`}
              style={palette ? { background: palette.halo } : undefined}
            >
              {step.status === 'achieved' ? (
                <CheckCircle2
                  className={`h-4 w-4 ${palette ? '' : 'text-green-500'}`}
                  style={palette ? { color: palette.accent } : undefined}
                />
              ) : (
                <Circle
                  className={`h-4 w-4 ${palette ? '' : 'text-muted-foreground/40'}`}
                  style={palette ? { color: palette.muted, opacity: 0.5 } : undefined}
                />
              )}
            </span>
          ))}
        </div>
      </div>
      {/* The rail says which, this says how many — and this is the part that
          survives being read at a glance on a phone. */}
      <span
        className={`shrink-0 text-xs tabular-nums ${palette ? '' : 'text-muted-foreground'}`}
        style={palette ? { color: palette.muted } : undefined}
      >
        {label}
      </span>
    </div>
  )
}
