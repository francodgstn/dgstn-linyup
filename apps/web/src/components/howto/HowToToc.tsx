'use client'

// Table of contents for the How-to page. Two renderings of one list: a sticky
// rail beside the content on wide screens, and a scrollable chip row under the
// page title everywhere else (there's no room for a rail next to the sidebar).
// Both stick as you scroll. The active entry is the last section whose top has
// passed a line near the top of the viewport — measured from getBoundingClient-
// Rect (viewport-relative, so it's correct whatever element scrolls), and
// recomputed on an IntersectionObserver + scroll signal.
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

export interface TocSection {
  id: string
  /** Key under HowTo.toc. */
  labelKey: string
}

export const TOC_SECTIONS: TocSection[] = [
  { id: 'concepts', labelKey: 'concepts' },
  { id: 'public-pages', labelKey: 'publicPages' },
  { id: 'pricing', labelKey: 'pricing' },
  { id: 'faq', labelKey: 'faq' },
  { id: 'keep-going', labelKey: 'utilities' },
]

// A section counts as current once its top passes this far down the viewport —
// roughly where the eye sits, and clear of the mobile header.
const ACTIVE_OFFSET = 140

function useActiveSection() {
  const [active, setActive] = useState(TOC_SECTIONS[0].id)

  useEffect(() => {
    let frame = 0
    // Position is read from getBoundingClientRect — viewport-relative, so it's
    // correct no matter which element is doing the scrolling.
    const measure = () => {
      frame = 0
      let current = TOC_SECTIONS[0].id
      for (const s of TOC_SECTIONS) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top <= ACTIVE_OFFSET) current = s.id
      }
      // At the very bottom the last section may never reach the offset (it can
      // be shorter than the viewport), so claim it explicitly. The root
      // <html>/<body> is the scroller in this app.
      const de = document.scrollingElement ?? document.documentElement
      if (de.scrollHeight - de.scrollTop - de.clientHeight <= 2) {
        current = TOC_SECTIONS[TOC_SECTIONS.length - 1].id
      }
      setActive(current)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }

    // An IntersectionObserver fires on scroll regardless of which container
    // scrolls — this app scrolls a nested region, so a plain window 'scroll'
    // listener never hears it. The rootMargin pulls the root's top edge down to
    // the ACTIVE_OFFSET line, so each section boundary crossing it triggers a
    // recompute. The capture-phase scroll listener is a belt-and-braces catch
    // for scroll from any element (bubbling scroll events don't reach window).
    const io = new IntersectionObserver(schedule, {
      rootMargin: `-${ACTIVE_OFFSET}px 0px 0px 0px`,
      threshold: [0, 1],
    })
    for (const s of TOC_SECTIONS) {
      const el = document.getElementById(s.id)
      if (el) io.observe(el)
    }
    measure()
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      io.disconnect()
      window.removeEventListener('scroll', schedule, { capture: true } as EventListenerOptions)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  return active
}

/** Chip row shown under the page title below `xl`, where the rail has no room.
 *  Sticks to the top of the scroll area once the title scrolls past, with a
 *  translucent backing so scrolling content stays legible behind it. */
export function HowToTocChips() {
  const t = useTranslations('HowTo')
  const active = useActiveSection()

  return (
    <nav
      aria-label={t('tocTitle')}
      // `top-14` below `md`, not `top-0`: the app header is sticky on phones
      // (MobileHeader, 3.5rem), so a bar pinned at 0 slides UNDER it and the
      // chips disappear exactly when they are the only navigation there is.
      className="sticky top-14 md:top-0 z-20 -mx-4 mt-5 flex gap-2 overflow-x-auto border-b bg-background/80 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/70 xl:hidden"
    >
      {TOC_SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={active === s.id ? 'true' : undefined}
          className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
            active === s.id
              ? 'border-primary bg-primary/[0.06] text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {t(`toc.${s.labelKey}` as Parameters<typeof t>[0])}
        </a>
      ))}
    </nav>
  )
}

/** Sticky rail beside the content, from `xl` up. */
export function HowToTocRail() {
  const t = useTranslations('HowTo')
  const active = useActiveSection()

  return (
    <nav
      aria-label={t('tocTitle')}
      className="sticky top-6 hidden w-44 shrink-0 self-start xl:block"
    >
      <p className="px-3 pb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {t('tocTitle')}
      </p>
      <ul className="space-y-0.5 border-l">
        {TOC_SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? 'true' : undefined}
              className={`-ml-px block border-l py-1.5 pl-3 text-xs transition-colors ${
                active === s.id
                  ? 'border-primary font-semibold text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground'
              }`}
            >
              {t(`toc.${s.labelKey}` as Parameters<typeof t>[0])}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
