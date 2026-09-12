// Tarif 595 — the callables. Creation (preview, issue) is plugin-gated; the
// rest consumes an existing receipt and is not (gate.test.ts pins the split).
export { previewTarif595Receipt, issueTarif595Receipt } from './issue'
export { voidTarif595Receipt } from './void'
export { downloadTarif595Receipt } from './download'
export { emailTarif595Receipt } from './email'
