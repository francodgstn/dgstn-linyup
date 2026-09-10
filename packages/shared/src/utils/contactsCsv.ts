/**
 * The contact book, as a file the studio can take away.
 *
 * WHY THIS EXISTS. The DPA commits us to returning the Customer's data on
 * request, and until this shipped there was no way for a studio to get its own
 * roster out — finance had an export, contacts did not. A processor that cannot
 * hand back what it holds is making a promise its code does not keep.
 *
 * SO THE BIAS IS TOWARD COMPLETENESS, not toward a tidy spreadsheet. Everything
 * the studio typed comes back, including archived people and every custom field
 * they defined. Where the two goals conflict — a nested map, a list of groups —
 * the value is flattened into something a human opens in Excel rather than
 * dropped, because a column nobody can read is still better than data that never
 * came back.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   - anonymised records. `anonymized_at` means the identifying data is already
 *     gone by design; exporting the husk would suggest otherwise.
 *   - bookings, payments and attendance. They belong to different exports with
 *     different shapes, and cramming them into a contact row would produce
 *     either one row per booking (not a contact list) or a cell containing a
 *     year of history (not readable). Finance already has its own.
 *   - internal denormalisation — rollup counters, cached summaries, sync
 *     bookkeeping. They are our implementation, not the studio's data.
 */

/** Escapes one field per RFC 4180: quote when the value contains a quote, comma
 *  or newline; embedded quotes are doubled. Same rule as `financeCsv`. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** A Firestore Timestamp, a Date, or anything else that can name an instant. */
function isoOrEmpty(value: unknown): string {
  if (!value) return ''
  const v = value as { toDate?: () => Date; seconds?: number }
  if (typeof v.toDate === 'function') return v.toDate().toISOString()
  if (typeof v.seconds === 'number') return new Date(v.seconds * 1000).toISOString()
  if (value instanceof Date) return value.toISOString()
  return ''
}

/** Date only — a birthdate with a time on it reads as false precision. */
function dateOrEmpty(value: unknown): string {
  return isoOrEmpty(value).slice(0, 10)
}

function str(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

/** The four-part address map, joined the way a person would write it. */
function addressLine(address: unknown): string {
  if (!address || typeof address !== 'object') return ''
  const a = address as Record<string, unknown>
  const street = [str(a.route), str(a.street_number)].filter(Boolean).join(' ')
  return [street, [str(a.postal_code), str(a.locality)].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ')
}

/** Group NAMES, not ids — an id means nothing outside our database, and the
 *  point of an export is that it survives leaving. */
function groupNames(ids: unknown, lookup: Map<string, string>): string {
  if (!Array.isArray(ids)) return ''
  return ids.map((id) => lookup.get(String(id)) ?? String(id)).join('; ')
}

/** Emergency contacts, flattened. Rare enough that one column is honest. */
function emergencyLine(list: unknown): string {
  if (!Array.isArray(list)) return ''
  return list
    .map((e) => {
      const c = e as Record<string, unknown>
      return [str(c.name), str(c.phone), str(c.email)].filter(Boolean).join(' ')
    })
    .filter(Boolean)
    .join('; ')
}

/** The fixed columns, in the order they appear. Custom-field columns are
 *  appended after these, one per definition, in the studio's own order. */
export const CONTACT_CSV_COLUMNS = [
  'id',
  'firstname',
  'lastname',
  'email',
  'phone',
  'gender',
  'birthdate',
  'address',
  'emergency_contacts',
  'groups',
  'acquisition_stage',
  'source',
  'source_detail',
  'partner_app',
  'subscription_type',
  'subscription_status',
  'subscription_amount',
  'joined_at',
  'trial_booked_at',
  'trial_attended_at',
  'converted_at',
  'sms_opt_out',
  'notes',
  'external_since',
  'archived_at',
  'deletion_requested_at',
  'created_at',
] as const

export interface ContactCsvCustomField {
  /** The key inside `Contact.custom_fields`. */
  id: string
  /** The studio's own label, used as the column header. */
  label: string
}

export interface ContactCsvOptions {
  /** The team's custom-field definitions, in the studio's order. */
  customFields?: ContactCsvCustomField[]
  /** groupId → group name, so the export carries names rather than ids. */
  groupNames?: Map<string, string>
}

/**
 * Serialise contacts to CSV: UTF-8, CRLF, header row always present, rows in
 * the order given.
 *
 * A custom-field column header is the studio's LABEL, which is not guaranteed
 * unique — two fields may share one. The header is therefore suffixed with the
 * field id when a label repeats, so a duplicate never silently collapses two
 * columns of real data into one.
 */
export function toContactsCsv(
  contacts: Record<string, unknown>[],
  options: ContactCsvOptions = {}
): string {
  const custom = options.customFields ?? []
  const lookup = options.groupNames ?? new Map<string, string>()

  const labelCounts = new Map<string, number>()
  for (const f of custom) labelCounts.set(f.label, (labelCounts.get(f.label) ?? 0) + 1)
  const customHeaders = custom.map((f) =>
    (labelCounts.get(f.label) ?? 0) > 1 ? `${f.label} (${f.id})` : f.label
  )

  const lines: string[] = [[...CONTACT_CSV_COLUMNS, ...customHeaders].map(csvField).join(',')]

  for (const c of contacts) {
    const customValues = (c.custom_fields ?? {}) as Record<string, unknown>
    lines.push(
      [
        str(c.id),
        str(c.firstname),
        str(c.lastname),
        str(c.email),
        str(c.phone),
        str(c.gender),
        dateOrEmpty(c.birthdate),
        addressLine(c.address),
        emergencyLine(c.emergency_contacts),
        groupNames(c.group_ids, lookup),
        str(c.acquisition_stage),
        str(c.source),
        str(c.source_detail),
        str(c.acquisition_partner_app),
        str(c.subscription_type_name),
        str(c.subscription_status),
        str(c.subscription_amount),
        isoOrEmpty(c.signup_completed_at),
        isoOrEmpty(c.trial_booked_at),
        isoOrEmpty(c.trial_attended_at),
        isoOrEmpty(c.converted_at),
        str(c.sms_opt_out),
        str(c.notes),
        isoOrEmpty(c.external_since),
        isoOrEmpty(c.archived_at),
        isoOrEmpty(c.deletion_scheduled_for),
        isoOrEmpty(c.created_at),
        ...custom.map((f) => str(customValues[f.id])),
      ]
        .map(csvField)
        .join(',')
    )
  }
  return lines.join('\r\n') + '\r\n'
}
