// THE LANDSCAPE: every app, service, provider and store around Linyup, and who
// talks to whom. The ONE description of the boxes and their connections: the
// Landscape component draws it on the home page and above docs/landscape.md.
// That page owns the prose around it (the journeys through the system, what
// surprises newcomers) and deliberately does not restate the boxes.
//
// Connections are listed once, on either end (`links`), and read both ways by
// `neighbours`: "the web app talks to Firestore" and "Firestore is talked to by
// the web app" are one fact, and writing it twice is how the two ends drift.
//
// `kind` says whose it is: `part` is our code, `platform` is a managed Google
// service in our own projects, `external` is a third party.

export type LayerId = 'people' | 'apps' | 'edge' | 'backend' | 'data' | 'providers' | 'delivery'

export interface Layer {
  id: LayerId
  title: string
  note?: string
}

export interface LandscapeNode {
  id: string
  label: string
  /** Under the label: a domain, a framework, a region. A few words. */
  sub?: string
  layer: LayerId
  kind?: 'part' | 'platform' | 'external'
  /** One or two sentences for the panel. */
  what: string
  runs?: string
  code?: string
  links?: string[]
  docs?: { label: string; href: string }[]
}

export const LAYERS: Layer[] = [
  { id: 'people', title: 'Who uses it' },
  { id: 'apps', title: 'Apps', note: 'What people open' },
  { id: 'edge', title: 'Hosting & edge', note: 'Where the apps are served from' },
  { id: 'backend', title: 'Backend', note: 'Cloud Functions gen2, europe-west6' },
  { id: 'data', title: 'Data & platform', note: 'Firebase and Google Cloud' },
  { id: 'providers', title: 'Providers', note: 'Third parties we call, or that call us' },
  { id: 'delivery', title: 'Build & deploy', note: 'How code reaches each environment' },
]

export const NODES: LandscapeNode[] = [
  // ── Who uses it ───────────────────────────────────────────────────────────
  {
    id: 'staff',
    label: 'Studio staff',
    sub: 'owners, managers, coaches',
    layer: 'people',
    what: 'The people who run a studio or an organisation. They sign in to the dashboard. The tenant boundary is their team (teamId).',
    links: ['web'],
    docs: [{ label: 'Glossary', href: '/glossary/' }],
  },
  {
    id: 'members',
    label: 'Members & visitors',
    sub: 'contacts, guests',
    layer: 'people',
    what: 'A studio\'s contacts and anyone visiting its public pages: they book, pay, sign waivers and open their Space. Members sign in with an emailed code, never a password.',
    links: ['web', 'mobile', 'embed', 'landing', 'help'],
    docs: [{ label: 'Contact state model', href: '/contact-state-model/' }],
  },
  {
    id: 'operators',
    label: 'Linyup team',
    sub: 'operators',
    layer: 'people',
    what: 'Linyup staff running the platform: tenants, feedback, messaging policies, store insights. They use the operator console only.',
    links: ['admin'],
  },
  {
    id: 'integrators',
    label: 'AI assistants & integrations',
    sub: 'claude.ai, ChatGPT, API keys',
    layer: 'people',
    what: 'Tools a studio connects to its own data: an AI assistant over MCP (OAuth), or a script with an API key. Read-only and staff-only.',
    links: ['api'],
    docs: [{ label: 'Public API & MCP', href: '/public-api/' }],
  },

  // ── Apps ──────────────────────────────────────────────────────────────────
  {
    id: 'web',
    label: 'Web app',
    sub: 'app.linyup.com · Next.js',
    layer: 'apps',
    what: 'The studio dashboard AND every public surface a visitor sees: bio-link, website, Space, shop, booking, forms, kiosk (/public/{slug}/…) and the embeddable booking panel (/embed/…). Reads Firestore directly through the client SDK; everything with a side effect is a callable.',
    runs: 'Firebase App Hosting, backend linyup-web-eu (europe-west4). Staging: app-stg.linyup.com. Sandbox: demo.linyup.com, which also serves the /try playground.',
    code: 'apps/web/',
    links: ['app-hosting', 'auth', 'firestore', 'storage', 'routers', 'stripe', 'posthog'],
    docs: [
      { label: 'Route structure', href: '/rules/public-routes/' },
      { label: 'Public data boundary', href: '/rules/public-data/' },
      { label: 'Firebase SDK split', href: '/rules/firebase-sdk/' },
    ],
  },
  {
    id: 'mobile',
    label: 'Member app',
    sub: 'Expo · iOS & Android',
    layer: 'apps',
    what: 'The member app: bookings, plans, Space, push reminders. Signs in with the same contact session as the web Space. A client we cannot update: store binaries keep calling callables by name for as long as they are installed.',
    runs: 'Built and updated over the air by Expo EAS; distributed through the App Store and Google Play.',
    code: 'apps/mobile/',
    links: ['auth', 'firestore', 'routers', 'expo', 'stores'],
    docs: [
      { label: 'App architecture', href: '/repo/mobile-architecture/' },
      { label: 'Releasing', href: '/repo/mobile-release/' },
    ],
  },
  {
    id: 'embed',
    label: 'Booking embed',
    sub: 'embed.js on studio sites',
    layer: 'apps',
    what: 'Two lines of HTML a studio pastes into its own website (Wix, Squarespace…). The script draws the modal on the host page and loads /embed/{slug}/book from the web app inside it.',
    code: 'apps/web/public/embed.js',
    links: ['web'],
    docs: [{ label: 'Booking embed', href: '/embed-booking/' }],
  },
  {
    id: 'admin',
    label: 'Operator console',
    sub: 'ops.linyup.com · Next.js',
    layer: 'apps',
    what: 'Linyup\'s own back office: tenants, feedback, messaging policies, store insights. Google sign-in, limited to an operator allow-list; server actions use the Admin SDK with the console\'s own service account.',
    runs: 'Firebase App Hosting, backend linyup-admin-eu. Staging: ops-stg.linyup.com. Not in sandbox.',
    code: 'apps/admin/',
    links: ['app-hosting', 'auth', 'firestore', 'routers', 'secrets', 'posthog'],
  },
  {
    id: 'landing',
    label: 'Landing site',
    sub: 'linyup.com · Astro',
    layer: 'apps',
    what: 'Marketing pages, pricing, the public roadmap and the legal pages. Static, in four languages.',
    runs: 'Firebase Hosting, target landing.',
    code: 'apps/landing/',
    links: ['hosting', 'posthog'],
  },
  {
    id: 'help',
    label: 'Help centre',
    sub: 'help.linyup.com · Starlight',
    layer: 'apps',
    what: 'Public how-to guides for studio owners. Static. Staging and production only.',
    runs: 'Firebase Hosting, target help.',
    code: 'apps/help/',
    links: ['hosting'],
  },

  // ── Hosting & edge ────────────────────────────────────────────────────────
  {
    id: 'app-hosting',
    label: 'Firebase App Hosting',
    sub: 'web + operator console',
    layer: 'edge',
    kind: 'platform',
    what: 'Builds and serves the two Next.js apps (server rendering on Cloud Run). Production rollouts are started by the release workflow at the tagged commit; staging rolls out from main.',
    links: [],
    docs: [{ label: 'Environments', href: '/rules/environments/' }],
  },
  {
    id: 'hosting',
    label: 'Firebase Hosting',
    sub: 'landing · help · api',
    layer: 'edge',
    kind: 'platform',
    what: 'Static hosting for the landing site and the help centre, and the front door of the public API: every path on the api target is rewritten to the api function.',
    links: ['api'],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    sub: 'DNS · custom-domain Worker',
    layer: 'edge',
    kind: 'external',
    what: 'DNS for linyup.com, and custom domains for studios: Cloudflare for SaaS plus the tenant-router Worker, which serves a studio\'s own hostname (book.example.ch) from the web app. The functions call its API to register a hostname.',
    code: 'infra/workers/tenant-router/',
    links: ['web', 'routers'],
    docs: [
      { label: 'Custom domains', href: '/custom-domains/' },
      { label: 'Tenant router', href: '/repo/tenant-router/' },
    ],
  },

  // ── Backend ───────────────────────────────────────────────────────────────
  {
    id: 'routers',
    label: 'Callable routers',
    sub: 'rpcStudio, rpcMember, rpcCheckout…',
    layer: 'backend',
    what: 'Every callable (onCall) is served through a domain router by audience: studio, member, checkout, finance, billing, org, ops, heavy. A new callable is NOT a new function. Clients call them through callFunction, never httpsCallable.',
    code: 'packages/functions/src/routers/',
    links: ['firestore', 'auth', 'storage', 'secrets', 'vertex', 'stripe', 'brevo', 'whatsapp', 'translation'],
    docs: [
      { label: 'Callables are served by routers', href: '/rules/callables-are-served-by-routers-a-new-callable-is-not-a-new-/' },
      { label: 'Cloud Functions', href: '/rules/cloud-functions/' },
    ],
  },
  {
    id: 'triggers',
    label: 'Firestore triggers',
    sub: 'mirrors, counters, automations',
    layer: 'backend',
    what: 'React to document writes: rebuild the world-readable public_profile mirrors, keep counters absolute, fire automation events, post finance journal rows, send the mail and push a change implies.',
    code: 'packages/functions/src/sync/ and each domain folder',
    links: ['firestore', 'brevo', 'whatsapp', 'expo', 'translation'],
    docs: [{ label: 'Public data boundary', href: '/rules/public-data/' }],
  },
  {
    id: 'scheduled',
    label: 'Scheduled jobs',
    sub: 'Scheduler → Cloud Tasks',
    layer: 'backend',
    what: 'Daily tasks, hourly reminders, weekly and monthly reports, trial lifecycle, store ingest. A cron is a dispatcher: it enqueues one Cloud Task per tenant, and a …ForTeam worker does that tenant\'s work.',
    code: 'packages/functions/src/utils/tenantFanOut.ts',
    links: ['firestore', 'brevo', 'expo', 'vertex', 'stores'],
    docs: [{ label: 'Scheduled jobs', href: '/rules/scheduled-jobs/' }],
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    sub: 'Stripe, Brevo, WhatsApp, stores…',
    layer: 'backend',
    what: 'Where providers call us: Stripe (SaaS billing and Connect), a studio\'s own Stripe or Payrexx, Brevo delivery events, WhatsApp, App Store Connect, plus the automations\' inbound webhook. Each is a named URL somebody outside the repo holds, so it is never routed or renamed.',
    links: ['firestore', 'secrets', 'stripe', 'gateways', 'brevo', 'whatsapp', 'stores'],
    docs: [
      { label: 'Member payments', href: '/payment-contact-studio/' },
      { label: 'SaaS billing', href: '/payment-studio-linyup/' },
    ],
  },
  {
    id: 'api',
    label: 'Public API & MCP',
    sub: 'api.linyup.com',
    layer: 'backend',
    what: 'One function serving the read-only REST API (/v1), the remote MCP server (/mcp) and its OAuth endpoints, for staff. API keys and OAuth grants live in Firestore.',
    code: 'packages/functions/src/api/',
    links: ['firestore', 'secrets'],
    docs: [{ label: 'Public API & MCP', href: '/public-api/' }],
  },

  // ── Data & platform ───────────────────────────────────────────────────────
  {
    id: 'auth',
    label: 'Firebase Auth',
    sub: 'staff, contacts, kiosk',
    layer: 'data',
    kind: 'platform',
    what: 'Staff sign in with email and password, a magic link, Google or Apple; the console with Google only. Members and kiosks get custom tokens minted by the functions (contact sessions, kiosk sessions), and the rules check their claims. A blocking function gates sign-up.',
    links: ['identity'],
    docs: [{ label: 'Member Space', href: '/rules/public-space/' }],
  },
  {
    id: 'firestore',
    label: 'Firestore',
    sub: 'europe-west6 · rules',
    layer: 'data',
    kind: 'platform',
    what: 'The database. Almost every document carries a teamId, and firestore.rules enforces the tenant boundary. Public pages read only public_profile mirrors. Daily backups; TTL on the ledgers (mail sends, activity log, API usage…).',
    code: 'firestore.rules, firestore.index.json, packages/shared/src/paths.ts',
    links: [],
    docs: [
      { label: 'Security rules', href: '/rules/security-rules/' },
      { label: 'Public data boundary', href: '/rules/public-data/' },
    ],
  },
  {
    id: 'storage',
    label: 'Cloud Storage',
    sub: 'uploads, receipts',
    layer: 'data',
    kind: 'platform',
    what: 'Images, documents, audio, generated PDFs (receipts, invoices). No hosted video: lessons embed YouTube or Vimeo, because video egress would be the largest line on the bill.',
    code: 'storage.rules',
    links: [],
  },
  {
    id: 'secrets',
    label: 'Secret Manager',
    sub: 'API keys, webhook secrets',
    layer: 'data',
    kind: 'platform',
    what: 'Every credential: Stripe keys and webhook secrets, Brevo, DeepL, Cloudflare, App Store Connect, Google Play. Created empty by Terraform, filled by hand or from the operator console. The emulator reads the same names from packages/functions/.env.local.',
    links: [],
    docs: [{ label: 'Infrastructure', href: '/repo/infra/' }],
  },
  {
    id: 'vertex',
    label: 'Vertex AI',
    sub: 'Gemini',
    layer: 'data',
    kind: 'platform',
    what: 'The only AI provider: contact summaries, the AI insights plugin, drafting offerings from a prompt. Cannot run against the emulators.',
    code: 'packages/functions/src/utils/vertexClient.ts',
    links: [],
    docs: [{ label: 'AI insights', href: '/ai-insights/' }],
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    sub: 'logs, alerts, budgets',
    layer: 'data',
    kind: 'platform',
    what: 'Cloud Logging, Error Reporting, uptime checks, alert policies and billing budgets (a budget alert reaches a function over Pub/Sub). Firestore rules denials are NOT logged anywhere server-side.',
    code: 'infra/modules/monitoring/',
    links: ['routers', 'triggers', 'scheduled', 'webhooks', 'api'],
  },

  // ── Providers ─────────────────────────────────────────────────────────────
  {
    id: 'stripe',
    label: 'Stripe',
    sub: 'SaaS billing + Connect',
    layer: 'providers',
    kind: 'external',
    what: 'Two rails. Studios pay Linyup for their plan (Stripe Billing). Members pay studios through Stripe Connect direct charges into the studio\'s own account, with a platform fee; Linyup never holds a studio\'s money.',
    links: [],
    docs: [
      { label: 'Member payments', href: '/payment-contact-studio/' },
      { label: 'SaaS billing', href: '/payment-studio-linyup/' },
      { label: 'Stripe object shape', href: '/rules/stripe-shape/' },
    ],
  },
  {
    id: 'gateways',
    label: 'Studio gateways',
    sub: 'own Stripe, Payrexx',
    layer: 'providers',
    kind: 'external',
    what: 'A studio that already takes payments elsewhere keeps doing so; their webhooks record those payments in Linyup so the member\'s history is complete.',
    code: 'packages/functions/src/utils/gateway/',
    links: [],
  },
  {
    id: 'brevo',
    label: 'Brevo',
    sub: 'email + SMS',
    layer: 'providers',
    kind: 'external',
    what: 'All outbound email over its HTTP API, sent as the studio (managed sender or a verified own domain) or as Linyup; bounces come back by webhook as suppressions. Also the SMS provider, off by default. No SMTP anywhere.',
    code: 'packages/functions/src/mail/',
    links: [],
    docs: [{ label: 'Email sending', href: '/repo/mail/' }],
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    sub: 'Meta Cloud API',
    layer: 'providers',
    kind: 'external',
    what: 'A studio connects its own WhatsApp Business number; templates only, and only to contacts who opted in. Meta bills the studio.',
    code: 'packages/functions/src/whatsapp/',
    links: [],
    docs: [{ label: 'WhatsApp', href: '/whatsapp-outbound/' }],
  },
  {
    id: 'translation',
    label: 'DeepL',
    sub: 'Google Translation fallback',
    layer: 'providers',
    kind: 'external',
    what: 'Machine-translates a studio\'s website into the other three languages when it is published. Can never fail a publish.',
    code: 'packages/functions/src/translate/',
    links: [],
    docs: [{ label: 'Site translations', href: '/site-translations/' }],
  },
  {
    id: 'posthog',
    label: 'PostHog',
    sub: 'product analytics, EU',
    layer: 'providers',
    kind: 'external',
    what: 'Product analytics: the landing site (behind a consent banner), the web app in production, the console, and a server-side event stream from the functions. Session replay is off.',
    links: [],
  },
  {
    id: 'expo',
    label: 'Expo',
    sub: 'EAS builds, updates, push',
    layer: 'providers',
    kind: 'external',
    what: 'EAS builds the member app and ships over-the-air updates per channel; the functions send push notifications through Expo\'s push service.',
    links: ['stores'],
    docs: [{ label: 'EAS & CI setup', href: '/mobile-eas-setup/' }],
  },
  {
    id: 'stores',
    label: 'App Store & Google Play',
    sub: 'distribution, store data',
    layer: 'providers',
    kind: 'external',
    what: 'Where the member app is published. Their APIs also feed the operator console\'s store insights (ingest currently switched off), and App Store Connect calls a webhook.',
    links: [],
    docs: [
      { label: 'Store setup', href: '/mobile-store-setup/' },
      { label: 'Store insights', href: '/app-store-insights/' },
    ],
  },
  {
    id: 'identity',
    label: 'Google & Apple sign-in',
    sub: 'OAuth for staff',
    layer: 'providers',
    kind: 'external',
    what: 'Social sign-in for studio staff (and Google for the operator console), through Firebase Auth.',
    links: [],
  },

  // ── Build & deploy ────────────────────────────────────────────────────────
  {
    id: 'github',
    label: 'GitHub Actions',
    sub: 'verify, deploy, mobile',
    layer: 'delivery',
    what: 'verify.yml checks every PR. deploy.yml ships main to staging; deploy-prod.yml ships a v* tag to production after a reviewer approves; deploy-sandbox.yml ships a sandbox-* tag; mobile.yml builds the app. Keyless access to Google Cloud through Workload Identity Federation.',
    code: '.github/workflows/',
    links: ['app-hosting', 'hosting', 'routers', 'triggers', 'scheduled', 'webhooks', 'api', 'expo', 'envs'],
    docs: [{ label: 'Environments', href: '/rules/environments/' }],
  },
  {
    id: 'terraform',
    label: 'Terraform',
    sub: 'infra/',
    layer: 'delivery',
    what: 'Creates the empty resources of each project: APIs, Firebase apps, Firestore and its backups, buckets, secrets, IAM, budgets, monitoring, App Hosting backends. The Firebase CLI then deploys code and rules into them.',
    code: 'infra/',
    links: ['firestore', 'storage', 'secrets', 'monitoring', 'app-hosting', 'hosting', 'envs'],
    docs: [{ label: 'Infrastructure', href: '/repo/infra/' }],
  },
  {
    id: 'envs',
    label: 'Four environments',
    sub: 'emulator · staging · prod · sandbox',
    layer: 'delivery',
    what: 'demo-linyup is the local emulator suite, with no real project behind it. linyup-staging follows main. linyup-prod follows v* release tags. linyup-sandbox hosts prospect demos and the /try playground, deploys only on a sandbox-* tag, and has no landing, help or console.',
    links: [],
    docs: [
      { label: 'Environments', href: '/rules/environments/' },
      { label: 'Local development', href: '/rules/local-development/' },
      { label: 'Sandbox safety', href: '/rules/sandbox-safety/' },
    ],
  },
]

/** Every node connected to `id`, whichever end listed the connection. */
export function neighbours(id: string): Set<string> {
  const out = new Set<string>()
  for (const n of NODES) {
    if (n.id === id) for (const l of n.links ?? []) out.add(l)
    else if (n.links?.includes(id)) out.add(n.id)
  }
  return out
}
