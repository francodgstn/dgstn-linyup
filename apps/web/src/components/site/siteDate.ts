/**
 * Formats a stored site-post date ('YYYY-MM-DD', see `SitePageRef.publishedOn`)
 * for display.
 *
 * Parsed as a UTC calendar date, never as a local one: the stored value is a
 * date, not an instant, so a reader west of it must not see it slip back a
 * day. Same convention as `packages/shared/src/utils/availability.ts`'s
 * wall-clock times — the date is what it says, wherever the reader is.
 */
export function formatSiteDate(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, (m || 1) - 1, d || 1)))
}
