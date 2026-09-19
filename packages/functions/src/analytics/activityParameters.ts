/**
 * An activity-log entry's `parameters` map with every `undefined` value
 * dropped.
 *
 * The triggers copy fields straight off the document that fired them —
 * `contact_firstname: booking.firstname` — and a booking or check-in that
 * carries no name is legitimate (a booking written by a server path that only
 * stores the contact id, as the member-app review tenant does). The Admin SDK
 * refuses `undefined` outright ("Cannot use \"undefined\" as a Firestore
 * value"), and the logger swallows the error, so the row was silently lost.
 *
 * Omitting the key rather than writing `null`: nothing reads these name
 * fields back (they are a display snapshot), and an absent key is what a
 * reader of an older row already has to handle.
 */
export function withDefinedParameters<T extends Record<string, unknown>>(entry: T): T {
  const parameters = entry.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return entry
  const defined = Object.fromEntries(
    Object.entries(parameters as Record<string, unknown>).filter(([, v]) => v !== undefined)
  )
  return { ...entry, parameters: defined }
}
