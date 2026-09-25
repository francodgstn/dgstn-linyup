'use client'

// THE CALENDARS CONTROL — "which calendars are shown", not "filter the list
// down to one".
//
// This began as a single-select filter (All | Classes | Appointments | Events,
// exactly one lit), became four independent chips, and is now ONE chip that
// opens a menu of checkboxes. Each step fixed a different lie:
//
//  - single-select could not express "classes AND appointments but not events";
//  - four chips in a row beside the coach chip read as four filters OF THE SAME
//    KIND as the coach one, when the coach chip was a single-select filter and
//    these are visibility toggles. Same row, same shape, two different
//    grammars — which is exactly what a studio cannot be expected to infer.
//
// So the four now sit behind one trigger that has the coach chip's shape, and
// the caret is what says "there is more behind this". Inside, the classical
// checkbox idiom every calendar sidebar already taught the user.
//
// THE WORD IS "CALENDARS". It shipped as "layers" for a few commits and was
// renamed through — a layer is a drawing-tool word no studio arrives with, and
// Google and Apple both call precisely this checklist "calendars". See
// `hooks/useVisibleCalendars.ts`.
//
// "CALENDARS" vs "CALENDAR VIEW" — the page has a Calendar/List view toggle a
// few pixels above this chip, so the overload is real and is handled by never
// letting a label here be the bare singular. The trigger says "All calendars",
// or names the ones drawn; the trigger's accessible name is "Calendars shown";
// and the one sentence that has to mention the view says "calendar view" in
// full, next to "the list", so the contrast is on the page rather than in the
// reader's head.
//
// THE TRIGGER NAMES WHAT IS DRAWN, always — one grammar, never a bare noun, and
// a NAMED STATE IS PREFERRED TO A LIST:
//
//   all four on  → "All calendars"
//   the default  → "Only sessions & events"   (classes + appointments + events)
//   nothing on   → "No calendars"             (real, reachable, must say so)
//   anything else→ the names, joined          ("Classes, Bookable hours")
//
// The two named arms are exactly the two actions at the foot of the menu, and
// that correspondence is the invariant: a state is named here iff one click
// below reaches it. It is also what fixed the original objection — the everyday
// state used to render as "Classes, Appointments, Events", an enumeration that
// made the studio read three words to learn one fact. A static "Calendars"
// would tell it nothing at all, and a count ("3 of 4") gives a number instead of
// a fact. The coach chip set this precedent — it shows the current selection,
// not the word "Coach".
//
// LIT MEANS "you have hidden something BEYOND the considered default". Not
// merely "something is hidden": bookable hours is off by default on purpose, so
// that rule would leave the chip permanently lit and the signal would mean
// nothing. Not "not all shown" either, for the same reason. And showing
// everything is the least restricted state there is, so it is not lit either.
// Equivalently, and this is the useful way to hold it: THE TWO NAMED STATES ARE
// THE TWO CALM ONES, and every other state is a narrowing the studio chose.
//
// NEITHER NAMED ACTION IS "THE DEFAULT" BY LABEL. "Only sessions & events"
// happens to BE the default set, so `isDefault` is the correct disabled test for
// it — but the word "default" appears nowhere a studio can read, because what it
// needs to know is what it will see, not which state we blessed.
//
// Bookable hours is the one calendar with a surface it cannot draw on — the
// LIST has no representation of a published window (a window is not an entry,
// it is the absence of one). Its row is therefore disabled in list view AND
// says why on a second line: a disabled control never receives hover, so an
// explanation that lives in a tooltip is an explanation nobody reads.
//
// No color swatches, deliberately. The grid colors events by event TYPE and
// availability bands by COACH — there is no per-calendar color anywhere on it,
// so a swatch here would be a new mapping that matches nothing the studio can
// see. The icons are the ones the "+ New" menu already uses for the same four
// things, so recognition carries across the two menus.
//
// SECTIONS: see CALENDAR_SECTIONS in `hooks/useVisibleCalendars.ts` — the
// membership and the occurrence-vs-availability reasoning are owned there, not
// restated here, and the list is composed so that a calendar outside a section
// cannot exist.

import { useTranslations } from 'next-intl'
import { CalendarClock, CalendarDays, CalendarRange, ChevronDown, Eye, User } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  CALENDAR_SECTIONS,
  SCHEDULE_CALENDARS,
  type CalendarSectionKey,
  type ScheduleCalendar,
  type VisibleCalendarsValue,
} from '@/hooks/useVisibleCalendars'

/** The same icons the "+ New" menu uses for the same four things. */
const CALENDAR_ICON: Record<ScheduleCalendar, LucideIcon> = {
  classes: CalendarDays,
  appointments: User,
  bookableHours: CalendarClock,
  events: CalendarRange,
}

interface Props {
  calendars: VisibleCalendarsValue
  /** Bookable hours only draws on the calendar view — see the header. */
  calendarView: boolean
  /** Called when a calendar is switched OFF, so the page can drop sub-filters
   *  that only make sense while it is shown (the class activity picker). */
  onCalendarHidden?: (calendar: ScheduleCalendar) => void
}

export function VisibleCalendarsMenu({ calendars, calendarView, onCalendarHidden }: Props) {
  const t = useTranslations('Calendar')

  const label: Record<ScheduleCalendar, string> = {
    classes: t('filterClasses'),
    appointments: t('filterAppointments'),
    bookableHours: t('bookableHours'),
    events: t('filterEvents'),
  }

  // Section headings. Written as a Record of LITERAL keys rather than a
  // computed `t('calendars.section' + key)`, because message keys are untyped
  // strings in this app — a computed one that was never merged renders its own
  // id to the studio and greps to nothing.
  const sectionLabel: Record<CalendarSectionKey, string> = {
    sessionsAndEvents: t('calendars.sectionSessionsAndEvents'),
    other: t('calendars.sectionOther'),
  }

  // THE NAMED STATES ARE EXACTLY THE ACTIONS, and that is the invariant to keep:
  // a state gets a name here iff there is one click below that reaches it.
  // Naming a state with no action leaves the studio reading a label it cannot
  // act on; offering an action whose result the trigger then spells out as a
  // list is what this menu was rebuilt to stop doing.
  const shown = SCHEDULE_CALENDARS.filter((c) => calendars.isVisible(c))
  const triggerLabel = calendars.allVisible
    ? t('calendars.all')
    : calendars.isDefault
      ? t('calendars.onlySessionsAndEvents')
      : shown.length === 0
        ? t('calendars.none')
        : shown.map((c) => label[c]).join(', ')

  // See the header: the default hides one on purpose, so "something is hidden"
  // is not news — "you hid something beyond the default" is. Both named states
  // are calm: `allVisible` hides nothing, `isDefault` hides only what the studio
  // was always going to land on. Everything else is a deliberate narrowing and
  // says so. No branch was added for the named actions — they were already the
  // two states this rule excused.
  const lit = !calendars.allVisible && !calendars.isDefault

  return (
    <DropdownMenu>
      {/* Same shape as the coach chip beside it — the two are peers in this row
          and must not be hand-sized independently. The eye is deliberately not a
          calendar glyph: the view toggle a few pixels above already owns those,
          and this control is about visibility, which is also what the
          hidden-calendars notice's EyeOff says. */}
      <DropdownMenuTrigger
        aria-label={t('calendars.heading')}
        title={triggerLabel}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
          lit
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:text-foreground'
        )}
      >
        <Eye className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[13rem] truncate">{triggerLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {/* TWO SECTIONS — "Sessions & events" (things that HAPPEN) and "Other"
            (bookable hours: WINDOWS, where nothing exists until somebody
            books). The membership and the reasoning live on CALENDAR_SECTIONS
            in `hooks/useVisibleCalendars.ts`; a fifth calendar is placed by
            asking whether it happens, not which collection it is stored in.

            The group is also NOT decoration. `DropdownMenuLabel` is Base UI's
            `Menu.GroupLabel`, which THROWS ("MenuGroupRootContext is missing")
            if it is not inside a `Menu.Group` — a runtime crash on first open
            that typecheck, lint and the production build all pass straight
            over, because the popup only mounts when the menu is opened. Two
            labeled sections is the structure the primitive wanted anyway. */}
        {CALENDAR_SECTIONS.map((section) => (
          <DropdownMenuGroup key={section.key}>
            <DropdownMenuLabel>{sectionLabel[section.key]}</DropdownMenuLabel>
            {section.calendars.map((calendar) => {
              const visible = calendars.isVisible(calendar)
              const calendarOnly = calendar === 'bookableHours' && !calendarView
              const Icon = CALENDAR_ICON[calendar]
              return (
                <DropdownMenuCheckboxItem
                  key={calendar}
                  checked={visible}
                  disabled={calendarOnly}
                  // Ticking one must not dismiss the menu — a studio setting up
                  // its week ticks two or three in a row. (Base UI's
                  // CheckboxItem already defaults `closeOnClick` to false;
                  // stated here so a future primitive swap does not silently
                  // change it.)
                  closeOnClick={false}
                  onCheckedChange={() => {
                    calendars.toggle(calendar)
                    if (visible) onCalendarHidden?.(calendar)
                  }}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{label[calendar]}</span>
                    {/* Not a tooltip: a disabled row never receives hover. */}
                    {calendarOnly && (
                      <span className="text-xs text-muted-foreground">
                        {t('calendars.calendarViewOnly')}
                      </span>
                    )}
                  </span>
                </DropdownMenuCheckboxItem>
              )
            })}
          </DropdownMenuGroup>
        ))}

        {/* THE TWO NAMED STATES, separated from the checkboxes because they are
            a different kind of thing: a checkbox states one calendar, these set
            the whole set at once. "All calendars" is RECOVERY ("I cannot find
            my week"). "Only sessions & events" is the everyday view AND the
            state a studio lands on untouched — which is why it carries a name
            rather than the generic "Reset to default" that used to sit here:
            one item, not two doing the same thing under different words.

            `isDefault` is the right test for the second one precisely BECAUSE
            the named state and the default are now the same set (derived, not
            re-listed — see the hook). If they ever diverge this disables on the
            wrong state, which is the failure the derivation prevents. */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={calendars.showAll} disabled={calendars.allVisible}>
          {t('calendars.all')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={calendars.showOnlyDefault} disabled={calendars.isDefault}>
          {t('calendars.onlySessionsAndEvents')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
