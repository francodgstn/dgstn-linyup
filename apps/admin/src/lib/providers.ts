// Third-party providers / vendors the platform depends on.
//
// A directory whose first job is to get you into each vendor's control panel in
// one click, and whose second is to show what that vendor will tell us about
// what we are spending with them.
//
// ── COST: THREE VENDORS ANSWER, THE REST DO NOT ─────────────────────────────
// `costFeed` marks a card that carries a live figure (recorded onto the daily
// `platform_metrics` snapshot; see queries/providerCosts.ts). `costNote` is the
// honest alternative for everyone else — a card with neither reads as an
// unexplained blank, which on a cost page invites the reader to assume zero.
//
// The three units are deliberately NOT normalised into one "spend" number: GCP
// reports month-to-date money, Brevo credits remaining, DeepL characters. See
// `PlatformProviderCosts` in @linyup/shared for why converting them would be
// inventing precision.

export type ProviderCategory =
  | 'Infrastructure'
  | 'Payments'
  | 'Email'
  | 'Analytics'
  | 'Content'
  | 'Mobile'
  | 'Other'

export interface Provider {
  /** Stable slug — used as the React key and (later) to key live data. */
  id: string
  name: string
  category: ProviderCategory
  /** One-line reminder of what we use them for. */
  description: string
  /** The console/dashboard to reach out to quickly. */
  panelUrl: string
  /** Optional deep link to their docs. */
  docsUrl?: string
  /** Optional public status page. */
  statusUrl?: string
  /**
   * This card shows a live cost/usage figure from that vendor, keyed to the
   * matching block on the platform snapshot. Absent = nothing is fetched.
   */
  costFeed?: 'gcp' | 'brevo' | 'deepl' | 'stripe'
  /**
   * Why this card shows no figure — a missing API, or a bill that appears on
   * another card. Rendered in place of a number so the blank is explained.
   * Set this on every provider WITHOUT a `costFeed`.
   */
  costNote?: string
}

// Order within a category is preserved; categories render in CATEGORY_ORDER.
export const CATEGORY_ORDER: ProviderCategory[] = [
  'Infrastructure',
  'Payments',
  'Email',
  'Analytics',
  'Content',
  'Mobile',
  'Other',
]

export const PROVIDERS: Provider[] = [
  {
    id: 'firebase',
    name: 'Firebase',
    category: 'Infrastructure',
    description: 'Auth, Firestore, Storage, Cloud Functions & App Hosting.',
    panelUrl: 'https://console.firebase.google.com/project/linyup-prod/overview',
    docsUrl: 'https://firebase.google.com/docs',
    statusUrl: 'https://status.firebase.google.com/',
    costNote:
      'Billed together with Google Cloud — the spend is on that card, not counted twice here.',
  },
  {
    id: 'google-cloud',
    name: 'Google Cloud',
    category: 'Infrastructure',
    description: 'Secret Manager, Cloud Scheduler, Tasks, Cloud Translation & billing for the project.',
    panelUrl: 'https://console.cloud.google.com/home/dashboard?project=linyup-prod',
    docsUrl: 'https://cloud.google.com/docs',
    statusUrl: 'https://status.cloud.google.com/',
    costFeed: 'gcp',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'Infrastructure',
    description:
      'Authoritative DNS for linyup.com, plus Cloudflare for SaaS — the studios’ custom domains and the tenant-router Worker.',
    panelUrl: 'https://dash.cloudflare.com/',
    docsUrl: 'https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/',
    statusUrl: 'https://www.cloudflarestatus.com/',
    costNote:
      'No usable cost API. Workers and Cloudflare for SaaS are flat-rate; the analytics API reports requests, not money.',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Payments',
    description: 'SaaS billing + Connect (member → studio) payments.',
    panelUrl: 'https://dashboard.stripe.com/',
    docsUrl: 'https://docs.stripe.com/',
    statusUrl: 'https://status.stripe.com/',
    costFeed: 'stripe',
  },
  {
    id: 'brevo',
    name: 'Brevo',
    category: 'Email',
    description: 'Transactional email (ESP) + bounce/spam webhooks.',
    panelUrl: 'https://app.brevo.com/',
    docsUrl: 'https://developers.brevo.com/',
    statusUrl: 'https://status.brevo.com/',
    costFeed: 'brevo',
  },
  {
    id: 'posthog',
    name: 'PostHog',
    category: 'Analytics',
    description: 'Product analytics for the landing site and web app.',
    panelUrl: 'https://eu.posthog.com/',
    docsUrl: 'https://posthog.com/docs',
    statusUrl: 'https://status.posthog.com/',
    costNote:
      'No usable cost API — usage is visible in their panel only.',
  },
  {
    id: 'deepl',
    name: 'DeepL',
    category: 'Content',
    description:
      'Machine translation for studio websites & embed widgets at publish (docs/site-translations.md).',
    panelUrl: 'https://www.deepl.com/your-account/summary',
    docsUrl: 'https://developers.deepl.com/docs',
    statusUrl: 'https://status.deepl.com/',
    costFeed: 'deepl',
  },
  // The two store portals. What the console can show WITHOUT opening them lives
  // on the Member app page; these rows are the one-click route to the things it
  // cannot — App Review's rejection message and Resolution Center thread, and
  // Play's policy status and Console inbox, none of which either vendor exposes
  // through an API.
  {
    id: 'apple-app-store',
    name: 'App Store Connect',
    category: 'Mobile',
    description:
      'iOS member app — releases, App Review, TestFlight. Rejection reasons live here and nowhere else.',
    panelUrl: 'https://appstoreconnect.apple.com/apps/6808572774/distribution',
    docsUrl: 'https://developer.apple.com/documentation/appstoreconnectapi',
    statusUrl: 'https://developer.apple.com/system-status/',
    costNote:
      'Revenue, not cost. What the console can show without opening it is on the Member app page.',
  },
  {
    id: 'google-play',
    name: 'Google Play Console',
    category: 'Mobile',
    description:
      'Android member app — releases, testing tracks, Android vitals. Policy status is portal-only.',
    panelUrl: 'https://play.google.com/console',
    docsUrl: 'https://developers.google.com/android-publisher',
    statusUrl: 'https://status.play.google.com/',
    costNote:
      'Revenue, not cost. What the console can show without opening it is on the Member app page.',
  },
]
