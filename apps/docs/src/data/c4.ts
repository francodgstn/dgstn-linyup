// THE C4 VIEWS: how Linyup's parts connect, at three levels of zoom.
//
//   Context     Linyup as one box, with the people and outside systems around it
//   Containers  what is inside that box: apps, functions, stores, and the arrows
//   Components  inside one container, for the two worth opening
//
// Positions are NOT written here: ELK lays every view out at build time
// (C4.astro), so adding an element or an arrow never means re-drawing by hand.
// What is written here is the model: the elements once, and per view which of
// them appear and what each arrow says.
//
// The Landscape (landscape.ts) is the inventory, one box per thing with no
// arrows; this is the wiring. An element's `ref` points at its Landscape box,
// which supplies the "Read more" links, so the two never disagree about where
// a thing is explained.

export type C4Kind = 'person' | 'system' | 'container' | 'store' | 'component' | 'external'

export interface C4Element {
  name: string
  kind: C4Kind
  /** The [technology] line, C4-style. */
  tech?: string
  /** One short sentence; wrapped to fit the box. */
  desc: string
  /** The Landscape box that explains it (its docs links are reused). */
  ref?: string
  /** A view that opens this element up. */
  drill?: string
}

export interface C4Rel {
  from: string
  to: string
  label: string
  tech?: string
  /** Dashed: an event, a webhook or a queue, not a call the caller waits on. */
  async?: boolean
}

export interface C4View {
  id: string
  level: 'Context' | 'Containers' | 'Components'
  title: string
  /** The view one level up, for the breadcrumb. */
  parent?: string
  /** One sentence under the breadcrumb. */
  caption: string
  /** The system or container this view looks inside: drawn as a dashed boundary. */
  boundary?: { label: string; members: string[] }
  /** Elements outside the boundary. */
  around: string[]
  /** Pinned to the top row (who calls in) and the bottom row (what is called):
   *  without it the layout scatters the outside world between the layers. */
  top?: string[]
  bottom?: string[]
  rels: C4Rel[]
}

export const ELEMENTS: Record<string, C4Element> = {
  // ── People ────────────────────────────────────────────────────────────────
  staff: { name: 'Studio staff', kind: 'person', desc: 'Owners, managers and coaches running a studio.', ref: 'staff' },
  members: { name: 'Members & visitors', kind: 'person', desc: 'A studio\'s contacts, and anyone on its public pages.', ref: 'members' },
  prospects: { name: 'Prospects', kind: 'person', desc: 'Studio owners finding out about Linyup.' },
  operators: { name: 'Linyup team', kind: 'person', desc: 'Runs the platform.', ref: 'operators' },

  // ── The system ────────────────────────────────────────────────────────────
  linyup: {
    name: 'Linyup',
    kind: 'system',
    tech: 'software system',
    desc: 'Classes, appointments, contacts, payments, public pages and a member app, for studios.',
    drill: 'containers',
  },

  // ── Containers ────────────────────────────────────────────────────────────
  web: { name: 'Web app', kind: 'container', tech: 'Next.js, App Hosting', desc: 'Studio dashboard and every public page.', ref: 'web', drill: 'web' },
  mobile: { name: 'Member app', kind: 'container', tech: 'Expo, React Native', desc: 'Bookings, plans and Space for members.', ref: 'mobile' },
  admin: { name: 'Operator console', kind: 'container', tech: 'Next.js, App Hosting', desc: 'Linyup\'s back office.', ref: 'admin' },
  landing: { name: 'Landing site', kind: 'container', tech: 'Astro, Hosting', desc: 'Marketing, pricing, roadmap, legal.', ref: 'landing' },
  help: { name: 'Help centre', kind: 'container', tech: 'Starlight, Hosting', desc: 'Guides for studio owners.', ref: 'help' },
  functions: {
    name: 'Cloud Functions',
    kind: 'container',
    tech: 'gen2, europe-west6',
    desc: 'Callables behind routers, triggers, schedules and webhooks.',
    ref: 'routers',
    drill: 'functions',
  },
  api: { name: 'Public API & MCP', kind: 'container', tech: 'function behind Hosting', desc: 'Read-only REST and MCP for staff tools.', ref: 'api' },
  firestore: { name: 'Firestore', kind: 'store', tech: 'europe-west6', desc: 'All tenant data; rules enforce the tenant boundary.', ref: 'firestore' },
  storage: { name: 'Cloud Storage', kind: 'store', tech: 'europe-west6', desc: 'Uploads and generated PDFs.', ref: 'storage' },
  auth: { name: 'Firebase Auth', kind: 'container', tech: 'managed', desc: 'Staff sign-in; custom tokens for members and kiosks.', ref: 'auth' },
  tasks: { name: 'Scheduler & Cloud Tasks', kind: 'container', tech: 'managed', desc: 'Starts jobs, then one task per tenant.', ref: 'scheduled' },
  secrets: { name: 'Secret Manager', kind: 'store', tech: 'managed', desc: 'Every provider credential.', ref: 'secrets' },
  vertex: { name: 'Vertex AI', kind: 'container', tech: 'Gemini', desc: 'Summaries, insights, drafting offerings.', ref: 'vertex' },

  // ── Outside systems ───────────────────────────────────────────────────────
  integrators: { name: 'AI assistants & scripts', kind: 'external', tech: 'claude.ai, ChatGPT, API keys', desc: 'Staff tools reading the studio\'s data.', ref: 'integrators' },
  stripe: { name: 'Stripe', kind: 'external', tech: 'Billing + Connect', desc: 'Studios\' plans; members paying studios directly.', ref: 'stripe' },
  gateways: { name: 'Studio gateways', kind: 'external', tech: 'own Stripe, Payrexx', desc: 'Payment systems a studio already runs.', ref: 'gateways' },
  brevo: { name: 'Brevo', kind: 'external', tech: 'HTTP API', desc: 'Sends email and SMS; reports bounces.', ref: 'brevo' },
  whatsapp: { name: 'WhatsApp', kind: 'external', tech: 'Meta Cloud API', desc: 'Template messages from the studio\'s own number.', ref: 'whatsapp' },
  deepl: { name: 'DeepL', kind: 'external', tech: '+ Google Translation', desc: 'Translates studio websites.', ref: 'translation' },
  expo: { name: 'Expo', kind: 'external', tech: 'EAS, push service', desc: 'Builds and updates the member app; delivers push.', ref: 'expo' },
  cloudflare: { name: 'Cloudflare', kind: 'external', tech: 'DNS, Worker', desc: 'Serves studios\' own domains from the web app.', ref: 'cloudflare' },
  posthog: { name: 'PostHog', kind: 'external', tech: 'EU', desc: 'Product analytics.', ref: 'posthog' },
  identity: { name: 'Google & Apple', kind: 'external', tech: 'OAuth', desc: 'Social sign-in for staff.', ref: 'identity' },
  studioSite: { name: 'Studio\'s own website', kind: 'external', tech: 'Wix, Squarespace…', desc: 'Where a studio pastes the booking embed.' },

  // ── Web app components ────────────────────────────────────────────────────
  proxy: { name: 'Proxy', kind: 'component', tech: 'src/proxy.ts', desc: 'Locale routing, frame headers, studios\' own hostnames.' },
  dashboard: { name: 'Studio dashboard', kind: 'component', tech: 'app/[locale]/(auth)', desc: 'Every staff page, behind sign-in.' },
  publicSurfaces: { name: 'Public surfaces', kind: 'component', tech: '/public/{slug}/…', desc: 'Bio-link, site, Space, shop, booking, forms, kiosk.' },
  embedPanel: { name: 'Embed panel', kind: 'component', tech: '/embed/{slug}/…', desc: 'The booking funnel, drawn inside a framed panel.' },
  embedJs: { name: 'embed.js', kind: 'component', tech: 'public/embed.js', desc: 'Runs on the studio\'s page: draws the modal, frames the panel.', ref: 'embed' },
  callFn: { name: 'callFunction', kind: 'component', tech: 'src/lib/callFunction.ts', desc: 'Sends each callable to its router; falls back to its name.' },
  sdk: { name: 'Firebase client', kind: 'component', tech: 'firebase.ts, firebase-auth.ts', desc: 'Firestore and Storage anywhere; Auth only in the browser.' },

  // ── Cloud Functions components ────────────────────────────────────────────
  routers: { name: 'Callable routers', kind: 'component', tech: 'rpcStudio, rpcMember, rpcCheckout…', desc: 'One HTTPS function per audience serving its callables.', ref: 'routers' },
  callables: { name: 'Domain callables', kind: 'component', tech: 'onCall, per domain folder', desc: 'Booking, checkout, courses, websites; each checks its own access.' },
  resolvers: { name: 'Shared resolvers', kind: 'component', tech: 'packages/shared', desc: 'One answer each: price, class access, contact filter.' },
  triggers: { name: 'Firestore triggers', kind: 'component', tech: 'onDocumentWritten', desc: 'Public mirrors, counters, automations, the journal.', ref: 'triggers' },
  dispatchers: { name: 'Schedule dispatchers', kind: 'component', tech: 'onSchedule', desc: 'List the tenants, enqueue one task each.', ref: 'scheduled' },
  workers: { name: 'Tenant workers', kind: 'component', tech: '…ForTeam, task queues', desc: 'One tenant\'s reminders, no-shows, reports.' },
  webhooks: { name: 'Webhook handlers', kind: 'component', tech: 'onRequest', desc: 'Stripe, Connect, gateways, Brevo, WhatsApp, stores.', ref: 'webhooks' },
  apiFn: { name: 'API & MCP', kind: 'component', tech: 'the api function', desc: 'REST /v1, /mcp and OAuth.', ref: 'api' },
  mail: { name: 'Mail service', kind: 'component', tech: 'src/mail', desc: 'Picks the sender, sends, keeps the ledger.', ref: 'brevo' },
  waRail: { name: 'WhatsApp rail', kind: 'component', tech: 'sendStudioWhatsApp', desc: 'Checks consent, sends templates.', ref: 'whatsapp' },
  translate: { name: 'Translation', kind: 'component', tech: 'src/translate', desc: 'Vendor chosen in one file.', ref: 'translation' },
}

export const VIEWS: C4View[] = [
  {
    id: 'context',
    level: 'Context',
    title: 'System context',
    caption: 'Linyup as one box: who uses it, and the outside systems it depends on.',
    boundary: undefined,
    around: ['staff', 'members', 'prospects', 'operators', 'integrators', 'linyup', 'cloudflare', 'identity', 'stripe', 'gateways', 'brevo', 'whatsapp', 'deepl', 'expo', 'posthog'],
    top: ['staff', 'members', 'prospects', 'operators', 'integrators', 'cloudflare', 'gateways'],
    bottom: ['identity', 'stripe', 'brevo', 'whatsapp', 'deepl', 'expo', 'posthog'],
    rels: [
      { from: 'staff', to: 'linyup', label: 'Runs the studio', tech: 'browser' },
      { from: 'members', to: 'linyup', label: 'Books, pays, opens their Space', tech: 'browser, member app' },
      { from: 'prospects', to: 'linyup', label: 'Reads about Linyup' },
      { from: 'operators', to: 'linyup', label: 'Operates the platform' },
      { from: 'integrators', to: 'linyup', label: 'Reads studio data', tech: 'MCP, REST' },
      { from: 'members', to: 'stripe', label: 'Pays', tech: 'Stripe Checkout' },
      { from: 'cloudflare', to: 'linyup', label: 'Forwards studios\' own domains' },
      { from: 'linyup', to: 'identity', label: 'Signs staff in', tech: 'OAuth' },
      { from: 'linyup', to: 'stripe', label: 'Creates charges, subscriptions' },
      { from: 'stripe', to: 'linyup', label: 'Reports payments', tech: 'webhooks', async: true },
      { from: 'gateways', to: 'linyup', label: 'Report payments', tech: 'webhooks', async: true },
      { from: 'linyup', to: 'brevo', label: 'Sends email, SMS' },
      { from: 'brevo', to: 'linyup', label: 'Reports bounces', tech: 'webhook', async: true },
      { from: 'linyup', to: 'whatsapp', label: 'Sends templates' },
      { from: 'linyup', to: 'deepl', label: 'Translates websites' },
      { from: 'linyup', to: 'expo', label: 'Sends push' },
      { from: 'linyup', to: 'posthog', label: 'Sends product events' },
    ],
  },
  {
    id: 'containers',
    level: 'Containers',
    title: 'Containers',
    parent: 'context',
    caption: 'What runs inside Linyup, and what each part calls. Dashed arrows are events, webhooks and queues.',
    boundary: {
      label: 'Linyup',
      members: ['web', 'mobile', 'admin', 'landing', 'help', 'api', 'functions', 'auth', 'tasks', 'firestore', 'storage', 'secrets', 'vertex'],
    },
    around: ['staff', 'members', 'prospects', 'operators', 'integrators', 'cloudflare', 'identity', 'stripe', 'gateways', 'brevo', 'whatsapp', 'deepl', 'expo', 'posthog'],
    top: ['prospects', 'staff', 'members', 'operators', 'integrators', 'cloudflare'],
    bottom: ['identity', 'stripe', 'gateways', 'brevo', 'whatsapp', 'deepl', 'expo', 'posthog'],
    rels: [
      { from: 'staff', to: 'web', label: 'Runs the studio', tech: 'HTTPS' },
      { from: 'staff', to: 'help', label: 'Reads guides' },
      { from: 'members', to: 'web', label: 'Books, pays, Space', tech: 'HTTPS' },
      { from: 'members', to: 'mobile', label: 'Uses' },
      { from: 'members', to: 'stripe', label: 'Pays', tech: 'Checkout' },
      { from: 'prospects', to: 'landing', label: 'Reads' },
      { from: 'operators', to: 'admin', label: 'Operates' },
      { from: 'integrators', to: 'api', label: 'Reads data', tech: 'MCP, REST' },
      { from: 'cloudflare', to: 'web', label: 'Forwards own domains' },
      { from: 'web', to: 'firestore', label: 'Reads, live', tech: 'client SDK, rules' },
      { from: 'web', to: 'functions', label: 'Calls', tech: 'callFunction → router' },
      { from: 'web', to: 'auth', label: 'Signs in' },
      { from: 'web', to: 'storage', label: 'Uploads', tech: 'rules' },
      { from: 'mobile', to: 'functions', label: 'Calls by name' },
      { from: 'mobile', to: 'firestore', label: 'Reads' },
      { from: 'mobile', to: 'auth', label: 'Signs in', tech: 'custom token' },
      { from: 'expo', to: 'mobile', label: 'Ships updates, push', async: true },
      { from: 'admin', to: 'functions', label: 'Calls', tech: 'rpcOps' },
      { from: 'admin', to: 'firestore', label: 'Reads, writes', tech: 'Admin SDK' },
      { from: 'admin', to: 'secrets', label: 'Stores credentials' },
      { from: 'api', to: 'firestore', label: 'Reads', tech: 'Admin SDK' },
      { from: 'functions', to: 'firestore', label: 'Reads, writes', tech: 'Admin SDK' },
      { from: 'firestore', to: 'functions', label: 'Triggers on write', async: true },
      { from: 'functions', to: 'tasks', label: 'Enqueues per tenant' },
      { from: 'tasks', to: 'functions', label: 'Runs jobs', async: true },
      { from: 'functions', to: 'auth', label: 'Mints member sessions' },
      { from: 'functions', to: 'storage', label: 'Writes PDFs' },
      { from: 'functions', to: 'secrets', label: 'Reads credentials' },
      { from: 'functions', to: 'vertex', label: 'Summarises, drafts' },
      { from: 'functions', to: 'stripe', label: 'Charges, subscriptions' },
      { from: 'stripe', to: 'functions', label: 'Webhooks', async: true },
      { from: 'gateways', to: 'functions', label: 'Webhooks', async: true },
      { from: 'functions', to: 'brevo', label: 'Email, SMS' },
      { from: 'brevo', to: 'functions', label: 'Bounces', async: true },
      { from: 'functions', to: 'whatsapp', label: 'Templates' },
      { from: 'functions', to: 'deepl', label: 'Translates' },
      { from: 'functions', to: 'expo', label: 'Push' },
      { from: 'functions', to: 'cloudflare', label: 'Registers hostnames' },
      { from: 'auth', to: 'identity', label: 'OAuth' },
      { from: 'web', to: 'posthog', label: 'Events' },
      { from: 'landing', to: 'posthog', label: 'Events' },
    ],
  },
  {
    id: 'web',
    level: 'Components',
    title: 'Web app',
    parent: 'containers',
    caption: 'One Next.js app is both the dashboard and every public page. Only /embed may be framed by another site.',
    boundary: { label: 'Web app', members: ['proxy', 'dashboard', 'publicSurfaces', 'embedPanel', 'callFn', 'sdk'] },
    around: ['staff', 'members', 'studioSite', 'embedJs', 'cloudflare', 'functions', 'firestore', 'auth', 'storage'],
    top: ['staff', 'members', 'cloudflare'],
    bottom: ['functions', 'firestore', 'auth', 'storage'],
    rels: [
      { from: 'staff', to: 'proxy', label: 'Opens the dashboard' },
      { from: 'members', to: 'proxy', label: 'Opens a public page' },
      { from: 'members', to: 'studioSite', label: 'Visits' },
      { from: 'studioSite', to: 'embedJs', label: 'Loads' },
      { from: 'embedJs', to: 'embedPanel', label: 'Frames the panel', tech: 'postMessage' },
      { from: 'cloudflare', to: 'proxy', label: 'Own-domain requests' },
      { from: 'proxy', to: 'dashboard', label: 'Routes' },
      { from: 'proxy', to: 'publicSurfaces', label: 'Routes' },
      { from: 'proxy', to: 'embedPanel', label: 'Routes, allows framing' },
      { from: 'dashboard', to: 'sdk', label: 'Reads, live' },
      { from: 'publicSurfaces', to: 'sdk', label: 'Reads public mirrors' },
      { from: 'embedPanel', to: 'sdk', label: 'Reads public mirrors' },
      { from: 'dashboard', to: 'callFn', label: 'Calls' },
      { from: 'publicSurfaces', to: 'callFn', label: 'Books, pays' },
      { from: 'embedPanel', to: 'callFn', label: 'Books, pays' },
      { from: 'callFn', to: 'functions', label: 'HTTPS', tech: 'rpc* routers' },
      { from: 'sdk', to: 'firestore', label: 'Reads' },
      { from: 'sdk', to: 'auth', label: 'Signs in' },
      { from: 'sdk', to: 'storage', label: 'Uploads' },
    ],
  },
  {
    id: 'functions',
    level: 'Components',
    title: 'Cloud Functions',
    parent: 'containers',
    caption: 'Callables come in through routers; everything else is bound to an event, a schedule or a URL someone outside holds.',
    boundary: {
      label: 'Cloud Functions',
      members: ['routers', 'callables', 'resolvers', 'triggers', 'dispatchers', 'workers', 'webhooks', 'apiFn', 'mail', 'waRail', 'translate'],
    },
    around: ['web', 'mobile', 'admin', 'integrators', 'tasks', 'firestore', 'stripe', 'gateways', 'brevo', 'whatsapp', 'deepl', 'vertex'],
    top: ['web', 'mobile', 'admin', 'integrators', 'gateways'],
    bottom: ['firestore', 'brevo', 'whatsapp', 'deepl', 'vertex'],
    rels: [
      { from: 'web', to: 'routers', label: 'Calls', tech: 'HTTPS' },
      { from: 'mobile', to: 'routers', label: 'Calls, name fallback' },
      { from: 'admin', to: 'routers', label: 'Calls', tech: 'rpcOps' },
      { from: 'integrators', to: 'apiFn', label: 'Reads', tech: 'MCP, REST' },
      { from: 'routers', to: 'callables', label: 'Hands each call on' },
      { from: 'callables', to: 'resolvers', label: 'Prices, access' },
      { from: 'callables', to: 'firestore', label: 'Reads, writes' },
      { from: 'callables', to: 'stripe', label: 'Checkout, subscriptions' },
      { from: 'callables', to: 'mail', label: 'Sends' },
      { from: 'callables', to: 'translate', label: 'On publish' },
      { from: 'callables', to: 'vertex', label: 'AI features' },
      { from: 'firestore', to: 'triggers', label: 'On write', async: true },
      { from: 'triggers', to: 'firestore', label: 'Mirrors, counters' },
      { from: 'triggers', to: 'mail', label: 'Sends' },
      { from: 'triggers', to: 'waRail', label: 'Sends' },
      { from: 'tasks', to: 'dispatchers', label: 'On schedule', async: true },
      { from: 'dispatchers', to: 'tasks', label: 'One task per tenant' },
      { from: 'tasks', to: 'workers', label: 'Runs', async: true },
      { from: 'workers', to: 'firestore', label: 'Reads, writes' },
      { from: 'workers', to: 'mail', label: 'Reminders, reports' },
      { from: 'stripe', to: 'webhooks', label: 'Payments', async: true },
      { from: 'gateways', to: 'webhooks', label: 'Payments', async: true },
      { from: 'brevo', to: 'webhooks', label: 'Bounces', async: true },
      { from: 'whatsapp', to: 'webhooks', label: 'Status', async: true },
      { from: 'webhooks', to: 'firestore', label: 'Records' },
      { from: 'apiFn', to: 'firestore', label: 'Reads' },
      { from: 'mail', to: 'brevo', label: 'HTTP API' },
      { from: 'waRail', to: 'whatsapp', label: 'Graph API' },
      { from: 'translate', to: 'deepl', label: 'HTTP API' },
    ],
  },
]
