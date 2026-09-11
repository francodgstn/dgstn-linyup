// The organisation's own word for an affiliation — "Affiliation", "Lizenz",
// "Club membership" — resolved for a reader's language. ONE fallback chain,
// because there were two: the web fell through to the first FILLED translation,
// so a studio that entered only German got it everywhere; the member app fell
// straight to the English word "Affiliation" — the same org, two nouns, and
// nothing could have told either side.
//
// Which locale to ask for is the CALLER's question (the web uses the reader's
// UI locale; the member app still the device's — docs/scalability-2026-09.md
// item 29). This owns only what happens once that is known.

import type { UiLanguage } from './regional'

export type AffiliationTerm = Partial<Record<UiLanguage, string>>

/** What every surface prints when the organisation has set no term at all. */
export const DEFAULT_AFFILIATION_TERM = 'Affiliation'

const filled = (v: string | undefined | null): string | undefined => {
  const s = v?.trim()
  return s ? s : undefined
}

/**
 * Reader's language → English → any filled translation → the default. A blank
 * string is not a translation at any step: an editor that saved `de: ''`
 * cleared it, and must not print an empty noun.
 */
export function resolveAffiliationTerm(
  term: AffiliationTerm | Partial<Record<string, string>> | null | undefined,
  locale: string,
): string {
  if (!term) return DEFAULT_AFFILIATION_TERM
  const short = locale.slice(0, 2).toLowerCase()
  const values = term as Partial<Record<string, string>>
  const firstFilled = Object.values(values).find((v) => filled(v))
  return filled(values[short]) ?? filled(values.en) ?? firstFilled?.trim() ?? DEFAULT_AFFILIATION_TERM
}
