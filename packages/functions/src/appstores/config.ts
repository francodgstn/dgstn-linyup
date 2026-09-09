/**
 * Configuration for the app-store ingest.
 *
 * ── IDENTIFIERS ARE PARAMS, CREDENTIALS ARE SECRETS ────────────────────────
 * Everything here is a PUBLIC identifier — the ASC app id is already committed
 * in `apps/mobile/eas.json`, the package name ships inside the app. The ASC key
 * id and issuer id look like identifiers too, but they are stored as SECRETS
 * (see `appleJwt.ts`) because `packages/functions/.env.production` and its
 * siblings are TRACKED IN GIT, and a value written there is in the history
 * forever. `utils/operator.ts` states the same principle.
 *
 * ── EVERY PARAM HERE MUST BE SPELLED OUT IN ALL FIVE `.env.<alias>` FILES ──
 * Even empty. `default:` is not enough for a non-interactive deploy —
 * firebase-tools prompts for the value and CI has nobody to ask, so the whole
 * deploy fails with "In non-interactive mode but have no value for the
 * following environment variables". That broke staging on 2026-08-21; see the
 * long note in `utils/operator.ts`.
 */
import { defineString } from 'firebase-functions/params'

/**
 * The kill switch, and the reason merging this code changes nothing anywhere.
 *
 * Off by default: there is ONE App Store record and ONE Play listing, so every
 * environment that can reach them reaches the same real app. Turning this on is
 * a deliberate act, per environment.
 */
export const STORE_INGEST_ENABLED = defineString('STORE_INGEST_ENABLED', {
  default: 'false',
  description: "Set to 'true' to let the app-store ingest run in this environment.",
})

/** App Store Connect app id. Public — it is in apps/mobile/eas.json. */
export const ASC_APP_ID = defineString('ASC_APP_ID', {
  default: '',
  description: 'App Store Connect app id for the member app (e.g. 6808572774).',
})

/**
 * Vendor number, required ONLY by `/v1/salesReports`. Found in App Store
 * Connect → Payments and Financial Reports.
 */
export const ASC_VENDOR_NUMBER = defineString('ASC_VENDOR_NUMBER', {
  default: '',
  description: 'App Store Connect vendor number — needed for daily sales reports only.',
})

/** Android application id. Public — it ships inside the app. */
export const PLAY_PACKAGE_NAME = defineString('PLAY_PACKAGE_NAME', {
  default: '',
  description: 'Google Play package name for the member app (e.g. com.dgstn.linyup).',
})

/**
 * Play Console reports bucket, `pubsite_prod_rev_<developerId>`.
 *
 * The developer id is NOT derivable from anything in this repo — read it off
 * Play Console → Download reports. And note the bucket lives in GOOGLE's
 * project: access is granted in the Play Console ("View app information and
 * download bulk reports"), not through our GCP IAM, so Terraform cannot express
 * it and a `plan` will look clean while the fetch 403s.
 */
export const PLAY_REPORTS_BUCKET = defineString('PLAY_REPORTS_BUCKET', {
  default: '',
  description: 'Play Console reports GCS bucket (pubsite_prod_rev_<developerId>).',
})

/**
 * Storefront for the public iTunes lookup.
 *
 * Ratings and review counts are PER STOREFRONT on the App Store, so this is not
 * cosmetic — 'ch' and 'us' return different numbers for the same app.
 */
export const ITUNES_LOOKUP_COUNTRY = defineString('ITUNES_LOOKUP_COUNTRY', {
  default: 'ch',
  description: 'Storefront (ISO-3166-1 alpha-2) for the public iTunes lookup.',
})

export function storeIngestEnabled(): boolean {
  return STORE_INGEST_ENABLED.value().trim().toLowerCase() === 'true'
}
