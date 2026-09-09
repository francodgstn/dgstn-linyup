/**
 * The handover between the contacts list and the QR slip sheet.
 *
 * Its own module rather than an export on either page: importing a constant
 * from a route component drags that whole route into the other one's bundle,
 * and the contacts list is not the place to pay for the sheet's QR library.
 *
 * sessionStorage rather than the URL because three hundred document ids do not
 * fit in a query string — and rather than a filter, because the list is live: a
 * filter re-evaluated on the sheet would print a different set from the one the
 * studio ticked.
 */
export const QR_SHEET_SELECTION_KEY = 'linyup:qr-sheet-selection'

export function writeQrSheetSelection(ids: string[]): void {
  try {
    sessionStorage.setItem(QR_SHEET_SELECTION_KEY, JSON.stringify(ids))
  } catch {
    // A browser refusing session storage (private mode, storage disabled) gets
    // an empty sheet and the "nothing selected" message, which is the honest
    // outcome — never a silently wrong selection.
  }
}

export function readQrSheetSelection(): string[] {
  try {
    const raw = sessionStorage.getItem(QR_SHEET_SELECTION_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}
