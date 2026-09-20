/**
 * Tarif 595 demo data for a SEEDED tenant — the health-insurance receipt
 * plugin, configured well enough that a prospect can press "Issue receipt" and
 * watch a real PDF + XML come out (docs/tarif-595.md).
 *
 * EVERY IDENTIFIER IS COMPUTED, NEVER TYPED. A GLN and an AHVN13 carry a GS1
 * check digit and an IBAN a mod-97 one, and the issue path refuses an invalid
 * one — so a hand-written placeholder is a demo that dies at the last click,
 * which is the worst possible moment. The builders below derive the check digit
 * from the body, so a placeholder is malformed only if this file is wrong.
 *
 * They are still PLACEHOLDERS: the numbers belong to nobody, the studio's real
 * GLN/ZSR come from its label body (Qualitop/Qualicert), and the seeded config
 * says `modus: 'test'` so nothing about it looks like a production claim.
 */

/** GS1 mod-10 check digit for a body of digits (the same arithmetic
 *  `isValidGln` / `isValidAhv` verify in packages/shared/src/types/tarif595.ts;
 *  re-implemented here because tsconfig.scripts.json does not resolve the
 *  workspace import — same convention as scripts/lib/affiliations.ts). */
function gs1CheckDigit(body: string): string {
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48
    sum += i % 2 === 0 ? d * 3 : d
  }
  return String((10 - (sum % 10)) % 10)
}

/** A syntactically valid GLN (13 digits) from 12 digits of body. */
export function seedGln(body12: string): string {
  const body = body12.replace(/\D/g, '').padEnd(12, '0').slice(0, 12)
  return body + gs1CheckDigit(body)
}

/** A syntactically valid AHVN13 — `756` + 9 digits + check digit. */
export function seedAhv(body9: string | number): string {
  const body = `756${String(body9).replace(/\D/g, '').padStart(9, '0').slice(0, 9)}`
  return body + gs1CheckDigit(body)
}

/** `zsrPartyType`: one upper-case letter + six digits. */
export function seedZsr(letter: string, digits: string | number): string {
  return `${letter.toUpperCase().slice(0, 1)}${String(digits).replace(/\D/g, '').padStart(6, '0').slice(0, 6)}`
}

/** The insurers a seeded member is "with". Real Swiss insurers by name with
 *  their published GLNs would be a claim we cannot check, so these are the
 *  standard's own shape with placeholder GLNs — enough for the XML to validate
 *  and for the screen to look like itself. */
export const SEED_INSURERS = [
  { name: 'Demo Krankenkasse AG', gln: seedGln('760000000001') },
  { name: 'Musterversicherung Schweiz', gln: seedGln('760000000002') },
  { name: 'Beispiel Assura Demo', gln: seedGln('760000000003') },
] as const

/**
 * ONE mapping of a seeded offering onto a tariff position.
 *
 * `successor` is worth seeding wherever it applies: the swimming positions
 * (7002–7005) expire on 2026-12-31 and the 2027 edition replaces them with
 * 3201–3203, which is exactly the case `tarif595MappingOn` exists for — a
 * studio issuing January receipts for December lessons needs both editions at
 * once. A seeded successor means the settings screen shows that machinery
 * working rather than an expiry warning nobody can act on.
 */
export interface SeedTarif595Mapping {
  position: string
  unit: 'month' | 'year' | 'lesson' | 'entry' | 'flat'
  customName?: string | null
  entries?: number | null
  successor?: { from: string; position: string; ptPosition?: string | null } | null
}

/**
 * A one-line Swiss address ("Klebestrasse 3, 8041 Zürich") split into the
 * STRUCTURED postal the receipt XML needs — the standard wants street and house
 * number apart, and a seeded tenant only ever has the printed line.
 *
 * Every part falls back rather than throwing: a seeded address is demo data and
 * an unparseable one must still produce a legal profile the screen can show.
 */
export function splitSwissAddress(
  address: string,
  fallbackCity = 'Zürich'
): { street_name: string; house_no: string; zip: string; city: string } {
  const [streetPart = '', cityPart = ''] = address.split(',', 2)
  const street = streetPart.trim()
  const houseMatch = /\s(\d+[a-zA-Z]?)$/.exec(street)
  const zipMatch = /\b(\d{4})\b/.exec(cityPart)
  return {
    street_name: (houseMatch ? street.slice(0, houseMatch.index) : street).trim() || 'Musterstrasse',
    house_no: houseMatch?.[1] ?? '1',
    zip: zipMatch?.[1] ?? '8000',
    city: cityPart.replace(/\b\d{4}\b/, '').trim() || fallbackCity,
  }
}

/** One contact's insurance data — what `issueTarif595Receipt` needs besides the
 *  payment itself. */
export interface SeedTarif595Contact {
  contactId: string
  ahvSeed: number
  insurerIndex?: number
  insuredNumber?: string
}

export interface SeedTarif595Input {
  /** Receipt numbers read `{prefix}-{year}-{00001}`. */
  prefix: string
  /** Distinguishes one seeded tenant's placeholder identifiers from another's. */
  identitySeed: string
  offerings: Record<string, SeedTarif595Mapping>
  contacts: SeedTarif595Contact[]
  language?: 'de' | 'fr' | 'it'
}

/** The `tarif595_settings/config` document, with identifiers derived from
 *  `identitySeed` so two seeded tenants never share a GLN. */
export function buildTarif595Config(input: SeedTarif595Input): Record<string, unknown> {
  const digits = Array.from(input.identitySeed).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 1_000_000, 7)
  const gln = seedGln(`76${String(digits).padStart(10, '0')}`)
  return {
    language: input.language ?? 'de',
    // TEST, always: a seeded tenant must never look like it is billing an
    // insurer for real. The studio flips this itself once its label body has
    // validated a sample receipt.
    modus: 'test',
    biller: { gln, zsr: seedZsr('T', digits) },
    provider: { gln, gln_location: gln, zsr: seedZsr('T', digits), uid: null },
    numbering: { prefix: input.prefix },
    offerings: input.offerings,
  }
}

/** One `tarif595_contacts/{contactId}` row. */
export function buildTarif595ContactRow(c: SeedTarif595Contact): Record<string, unknown> {
  const insurer = SEED_INSURERS[(c.insurerIndex ?? 0) % SEED_INSURERS.length]
  return {
    ahv_number: seedAhv(c.ahvSeed),
    insurer_name: insurer.name,
    insurer_gln: insurer.gln,
    insured_number: c.insuredNumber ?? `DEMO-${String(c.ahvSeed).padStart(6, '0')}`,
    sex_override: null,
    guardian: null,
  }
}
