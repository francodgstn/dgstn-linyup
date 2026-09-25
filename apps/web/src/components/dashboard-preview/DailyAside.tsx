'use client'

/**
 * THE QUOTE — the page's one element with no job to do, and therefore the one
 * that has to be placed rather than parked.
 *
 * It has moved three times, and has come back to where it worked. It began as
 * the incumbent's last line, below everything — a sign-off nobody scrolls to.
 * It was then pinned to the foot of the right-hand figure RAIL, using air that
 * the rail had anyway, which was the best home it has had. When the rail became
 * a two-column figure block there was no spare column of air left, so it spent
 * a round as a centered full-width band between the working area and the Trends
 * seam — which cost the page ~86px to say nothing, and the queue was short.
 *
 * It is back at the FOOT OF THE REFERENCE COLUMN (Franco, 2026-08-18): under
 * the donut, pushed down by the column's `justify-between`, holding the bottom
 * edge while the queue beside it grew into the 86px the band was using. That is
 * the whole argument for this placement — the quote occupies air that another
 * block cannot use, and it costs the layout nothing it wanted.
 *
 * LEFT-ALIGNED, not centered: it now lives in a ~417px column under a donut and
 * a legend that both align left. It was centered only because it used to span
 * the page.
 *
 * IT MUST NOT READ AS A SYSTEM MESSAGE. Beside real figures, a small gray line
 * looks like a status or a warning. The treatment is unmistakably a quotation
 * and nothing else: a muted quote glyph, an em-dashed attribution set to the
 * RIGHT, and `figure`/`blockquote`/`figcaption` markup, so it announces itself
 * as an aside to a screen reader too.
 *
 * ITALIC, REVERSED (Franco, 2026-08-21). This comment used to say "upright text
 * (no italic)" and gave the reason above — that italic gray reads as a system
 * notice. Seen on the page it does the opposite: with the glyph opening it and
 * the attribution closing it right-aligned, the slant is what makes it read as
 * a pull-quote rather than as a caption nobody placed. The old reasoning is
 * kept here because it is still the right worry; it just turned out not to
 * describe this treatment.
 *
 * NO RULE ABOVE IT. One was tried this same day and removed: the Trends seam
 * already draws a divider a few rows below, and two horizontal lines that close
 * to each other rule off nothing — they just box the column in. Whitespace and
 * the glyph carry the separation.
 */

import { getDailyQuote } from '@/data/quotes'

export function DailyAside() {
  const quote = getDailyQuote()
  return (
    <figure>
      <blockquote className="text-sm italic leading-relaxed text-muted-foreground">
        {/* The glyph stays UPRIGHT while the text slants — a slanted quotation
            mark beside slanted text loses the shape that identifies it. */}
        <span aria-hidden className="font-heading mr-1 text-base not-italic text-primary/25">
          &ldquo;
        </span>
        {quote.text}
      </blockquote>
      {/* Right-aligned, which is where an attribution goes when the thing it
          attributes is a quotation rather than a caption: it closes the block
          instead of starting a new left-aligned line under a column of other
          left-aligned lines. */}
      <figcaption className="mt-1 text-right text-xs text-muted-foreground/60">
        — {quote.author}
      </figcaption>
    </figure>
  )
}
