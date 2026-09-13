// Document numbering for the shared PDF rail — one per-year counter per
// document KIND (a Tarif 595 receipt series and a QR-bill invoice series
// never share a sequence, hence the caller-supplied `counterRef`/`prefix`).
//
// `formatDocumentNumber` is the SAME format Tarif 595's own
// `formatTarif595Number` (`@linyup/shared`) renders for the settings-page
// preview — that copy exists only because it runs in `packages/shared`,
// which the web app can import and this functions-only package cannot be
// imported BY. Delegating here rather than reimplementing means the number a
// studio previews before ever issuing one is guaranteed to equal the number
// `allocateNumber` actually stamps.
//
// `allocateNumber` is the STATEFUL half: it reads the counter document INSIDE
// the caller's transaction, resets to 1 on a new year, and writes the new
// `last` as an ABSOLUTE value — never `FieldValue.increment` (CLAUDE.md's
// counter doctrine: an absolute value derived from a read taken in the same
// transaction that writes it is the only shape that can't drift under
// concurrent issuance).

import { FieldValue } from 'firebase-admin/firestore'
import { formatTarif595Number } from '@linyup/shared'

/** `stringType1_35`-shaped fields elsewhere print a document number verbatim
 *  (e.g. the QR-bill `message`/reference derivation) — 35 is the ceiling
 *  those fields share, so a runaway prefix or an absurd `n` fails loudly here
 *  rather than silently truncating on a printed document later. */
export const DOCUMENT_NUMBER_MAX = 35

export function formatDocumentNumber(prefix: string, year: string | number, n: number): string {
  const formatted = formatTarif595Number(prefix, year, n)
  if (formatted.length > DOCUMENT_NUMBER_MAX) {
    throw new Error(
      `formatDocumentNumber: '${formatted}' is ${formatted.length} characters, over the ${DOCUMENT_NUMBER_MAX}-character limit`
    )
  }
  return formatted
}

interface DocumentNumberCounter {
  last: number
  year: string
  updated_at?: FirebaseFirestore.FieldValue
}

export interface AllocatedNumber {
  number: string
  last: number
}

/**
 * Allocate the next number in `prefix`'s series for `year`, per-year reset.
 * Must run inside a transaction the caller owns — this reads the counter
 * document with `tx.get` and writes the new value with `tx.set`, so it is
 * safe under concurrent issuance only because both happen in the SAME
 * transaction as whatever else the caller is committing (e.g. the receipt or
 * invoice document itself).
 */
export async function allocateNumber(
  tx: FirebaseFirestore.Transaction,
  counterRef: FirebaseFirestore.DocumentReference,
  prefix: string,
  year: string
): Promise<AllocatedNumber> {
  const snap = await tx.get(counterRef)
  const data = snap.exists ? (snap.data() as Partial<DocumentNumberCounter> | undefined) : undefined
  const last = data?.year === year ? (data.last ?? 0) + 1 : 1

  const counter: DocumentNumberCounter = { last, year, updated_at: FieldValue.serverTimestamp() }
  tx.set(counterRef, counter)

  return { number: formatDocumentNumber(prefix, year, last), last }
}
