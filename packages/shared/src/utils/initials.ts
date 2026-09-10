// Initials for an avatar bubble — ONE rule, because the FALLBACK was the part
// that had drifted: every web copy wrote `|| '?'` and the member app's wrote
// none, so a contact with no name was a "?" bubble on the coach's screen and
// an empty one in her own app.

/** `firstname` + `lastname` initials, upper-cased; `'?'` when there is nothing
 *  to show — never an empty bubble. */
export function personInitials(person: {
  firstname?: string | null
  lastname?: string | null
}): string {
  return `${person.firstname?.[0] ?? ''}${person.lastname?.[0] ?? ''}`.toUpperCase() || '?'
}

/** Initials from ONE display-name string — "Ada Lovelace" → "AL", "Ada" →
 *  "A" — for people who are not contacts: a coach (whose fallback is an
 *  email address, which the caller passes in place of a missing name), an
 *  organisation's member club. */
export function nameInitials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return `${parts[0][0]}${parts[1]?.[0] ?? ''}`.toUpperCase()
}
