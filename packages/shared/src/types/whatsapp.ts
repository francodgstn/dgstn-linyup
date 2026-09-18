import type { Timestamp } from './common'

// ─── WhatsApp Business (outbound) ────────────────────────────────────────────
// docs/whatsapp-outbound.md owns the design. A studio connects its OWN WhatsApp
// Business number (kept in the WhatsApp Business App — Meta's coexistence
// onboarding) and Meta bills the studio. Linyup sends pre-approved templates
// only, to contacts who opted in, and reads inbound messages for STOP alone.

export const WHATSAPP_PLUGIN_ID = 'whatsapp'

// ─── Consent ─────────────────────────────────────────────────────────────────

export type WhatsAppConsentSource =
  | 'booking_form'
  | 'signup_form'
  | 'space'
  | 'member_app'
  | 'staff'
  | 'reply_stop'
  /** Meta refused a marketing message because the member tapped "stop
   *  promotions" in WhatsApp — ends the marketing answer only. */
  | 'meta_stop_promotions'

/**
 * `Contact.whatsapp_consent` — present only once somebody has answered. Absent
 * reads as NOT opted in: Meta requires an opt-in before any business-initiated
 * message, reminders included. Read through `whatsappConsentAllows`, never
 * inline.
 */
export interface WhatsAppConsent {
  status: 'opted_in' | 'opted_out'
  at: Timestamp
  source: WhatsAppConsentSource
  /** The staff uid, when `source === 'staff'`. */
  recorded_by?: string
}

/**
 * The two answers a member gives, and they are independent (Franco,
 * 2026-09-18): booking REMINDERS, and NEWS AND OFFERS. Almost every automation
 * message — a welcome, a win-back, a birthday — is MARKETING in Meta's terms,
 * which a member who ticked "reminders" never agreed to.
 */
export type WhatsAppConsentKind = 'reminders' | 'marketing'

/** The contact field each kind is stored on. */
export const WHATSAPP_CONSENT_FIELD: Record<WhatsAppConsentKind, 'whatsapp_consent' | 'whatsapp_marketing_consent'> = {
  reminders: 'whatsapp_consent',
  marketing: 'whatsapp_marketing_consent',
}

/** THE one reader of a contact's WhatsApp consent. */
export function whatsappConsentAllows(
  contact: { whatsapp_consent?: unknown; whatsapp_marketing_consent?: unknown } | null | undefined,
  kind: WhatsAppConsentKind = 'reminders',
): boolean {
  const consent = (contact as Record<string, unknown> | null | undefined)?.[WHATSAPP_CONSENT_FIELD[kind]] as
    | { status?: unknown }
    | null
    | undefined
  return consent?.status === 'opted_in'
}

/** Which consent a template needs: a utility message is reminder-like; anything
 *  Meta calls marketing needs the news-and-offers answer. */
export function whatsappConsentKindFor(category: string | null | undefined): WhatsAppConsentKind {
  return category === 'UTILITY' ? 'reminders' : 'marketing'
}

// ─── Connection ──────────────────────────────────────────────────────────────

export type WhatsAppConnectionStatus = 'connected' | 'disconnected' | 'error'

export type WhatsAppTemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'MISSING'

/**
 * `teams/{teamId}/integrations/whatsapp` — display state, written only by
 * functions. Holds no credential: the business token lives encrypted in
 * `whatsapp_connections/{teamId}`, which every client is denied.
 */
export interface WhatsAppIntegration {
  status: WhatsAppConnectionStatus
  waba_id: string | null
  phone_number_id: string | null
  display_phone_number: string | null
  verified_name: string | null
  is_on_biz_app: boolean | null
  quality_rating: string | null
  /** Keyed `{templateName}:{language}`. */
  templates: Record<string, { status: WhatsAppTemplateStatus; reason?: string | null }>
  connected_by: string | null
  connected_at: Timestamp | null
  updated_at: Timestamp
  last_error: string | null
}

export function whatsappTemplateStatusKey(name: string, language: string): string {
  return `${name}:${language}`
}

/** Is this template usable for sends right now? */
export function whatsappTemplateApproved(
  integration: Pick<WhatsAppIntegration, 'status' | 'templates'> | null | undefined,
  name: string,
  language: string,
): boolean {
  if (integration?.status !== 'connected') return false
  return integration.templates?.[whatsappTemplateStatusKey(name, language)]?.status === 'APPROVED'
}

// ─── Linyup-owned templates ──────────────────────────────────────────────────
// Provisioned into each studio's WhatsApp Business account at connect. Meta
// approves a template per (name, language) and an approved one cannot be edited
// in place, so a content change publishes a new `_vN` name rather than editing
// this one.

export type WhatsAppLanguage = 'en' | 'de' | 'fr' | 'it'
export const WHATSAPP_LANGUAGES: readonly WhatsAppLanguage[] = ['en', 'de', 'fr', 'it']

export function resolveWhatsAppLanguage(lang: string | null | undefined): WhatsAppLanguage {
  const base = (lang ?? '').toLowerCase().split(/[-_]/)[0]
  return (WHATSAPP_LANGUAGES as readonly string[]).includes(base) ? (base as WhatsAppLanguage) : 'en'
}

export interface WhatsAppTemplateDefinition {
  name: string
  category: 'UTILITY' | 'MARKETING'
  /** Named body parameters, in the order they appear, with an example each —
   *  Meta refuses a template whose parameters carry no example. */
  params: readonly { name: string; example: string }[]
  body: Record<WhatsAppLanguage, string>
  /** A URL button whose dynamic part is appended to the environment's app
   *  origin, supplied at provisioning. */
  urlButton?: { text: Record<WhatsAppLanguage, string>; example: string }
}

export const WHATSAPP_BOOKING_REMINDER_TEMPLATE: WhatsAppTemplateDefinition = {
  name: 'linyup_booking_reminder_v1',
  category: 'UTILITY',
  params: [
    { name: 'first_name', example: 'Anna' },
    { name: 'class_name', example: 'Yoga Flow' },
    { name: 'studio_name', example: 'Studio Aare' },
    { name: 'date', example: 'Monday, 22 September' },
    { name: 'time', example: '18:30' },
  ],
  // A body may not start or end with a parameter, hence the closing sentence.
  body: {
    en: 'Hi {{first_name}}, this is a reminder of your {{class_name}} session at {{studio_name}} on {{date}} at {{time}}. Need to change it? Use the button below.',
    de: 'Hallo {{first_name}}, wir erinnern Sie an Ihren Termin {{class_name}} bei {{studio_name}} am {{date}} um {{time}}. Möchten Sie etwas ändern? Nutzen Sie die Schaltfläche unten.',
    fr: 'Bonjour {{first_name}}, nous vous rappelons votre séance {{class_name}} chez {{studio_name}} le {{date}} à {{time}}. Besoin de modifier ? Utilisez le bouton ci-dessous.',
    it: 'Ciao {{first_name}}, ti ricordiamo la tua lezione {{class_name}} da {{studio_name}} il {{date}} alle {{time}}. Vuoi modificarla? Usa il pulsante qui sotto.',
  },
  urlButton: {
    text: {
      en: 'Manage booking',
      de: 'Buchung verwalten',
      fr: 'Gérer la réservation',
      it: 'Gestisci prenotazione',
    },
    example: 'public/studio-aare/manage-booking?token=abc123',
  },
}

/** Every template Linyup provisions. */
export const WHATSAPP_LINYUP_TEMPLATES: readonly WhatsAppTemplateDefinition[] = [
  WHATSAPP_BOOKING_REMINDER_TEMPLATE,
]

// ─── Inbound opt-out ─────────────────────────────────────────────────────────

const STOP_KEYWORDS = new Set([
  'stop',
  'stopp',
  'arret',
  'arreter',
  'basta',
  'abmelden',
  'unsubscribe',
  'desabonner',
  'disiscrivi',
])

/**
 * Is this inbound text an opt-out? A whole-message keyword only — "stop by
 * later?" is a question for the studio, not an opt-out — case-, accent- and
 * punctuation-insensitive.
 */
export function isWhatsAppStopMessage(text: string | null | undefined): boolean {
  if (!text) return false
  const normalised = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
  return STOP_KEYWORDS.has(normalised)
}

// ─── Studio templates (Phase 2) ──────────────────────────────────────────────
// `teams/{teamId}/whatsapp_templates/{id}` — written by the studio in Linyup and
// submitted to Meta by `submitWhatsAppTemplate`; every client write is denied.
// docs/whatsapp-outbound.md → "6b".

export type WhatsAppTemplateCategory = 'UTILITY' | 'MARKETING'

/** One submission at Meta. An approved template is never edited in place: an
 *  edit is a NEW submission under a new name, and the old one keeps sending
 *  until the new one is approved. */
export interface WhatsAppTemplateSubmission {
  meta_name: string
  category: WhatsAppTemplateCategory
  body: string
  status: WhatsAppTemplateStatus
  reason: string | null
  submitted_at: Timestamp
  /** Set when Meta moved it to another category after submission. */
  recategorized_at?: Timestamp
}

export interface WhatsAppStudioTemplate {
  id: string
  /** The studio's own name for it; never sent. */
  label: string
  language: WhatsAppLanguage
  /** What sends today — null until a first submission is approved. */
  live: WhatsAppTemplateSubmission | null
  /** An edit (or the first submission) awaiting Meta — null when none. */
  next: WhatsAppTemplateSubmission | null
  created_by: string
  created_at: Timestamp
  updated_at: Timestamp
}

/**
 * The tokens a studio may put in a WhatsApp template — the chat-sized subset of
 * the email template variables (`substituteVariables`), each with the named
 * parameter Meta sees (lowercase letters and underscores) and the sample Meta
 * requires with every submission.
 */
export const WHATSAPP_TEMPLATE_TOKENS = {
  firstname: { param: 'first_name', example: 'Anna' },
  lastname: { param: 'last_name', example: 'Keller' },
  teamName: { param: 'studio_name', example: 'Studio Aare' },
  date: { param: 'date', example: '22 September 2026' },
  bookingUrl: { param: 'booking_url', example: 'https://app.linyup.com/public/studio-aare/booking' },
  membershipUrl: { param: 'membership_url', example: 'https://app.linyup.com/public/studio-aare/signup' },
  bioLinkUrl: { param: 'bio_link_url', example: 'https://app.linyup.com/public/studio-aare' },
  websiteUrl: { param: 'website_url', example: 'https://studio-aare.ch' },
  reviewUrl: { param: 'review_url', example: 'https://g.page/r/studio-aare/review' },
} as const

export type WhatsAppTemplateToken = keyof typeof WHATSAPP_TEMPLATE_TOKENS

export const WHATSAPP_TEMPLATE_BODY_MAX = 1024
export const WHATSAPP_TEMPLATE_LABEL_MAX = 60

export type WhatsAppTemplateProblem =
  | 'empty'
  | 'too_long'
  | 'unknown_token'
  | 'starts_with_token'
  | 'ends_with_token'
  | 'adjacent_tokens'

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Every `{{token}}` in order of appearance, repeats included. */
export function whatsappTemplateTokensIn(body: string): string[] {
  return [...(body ?? '').matchAll(TOKEN_RE)].map((m) => m[1])
}

/**
 * What Meta would refuse, found before Meta does: the studio should hear it in
 * the editor, not a day later as a rejection. Returns every problem, none when
 * the body can be submitted. Shared so the editor and the callable agree.
 */
export function validateWhatsAppTemplateBody(body: string): {
  problems: WhatsAppTemplateProblem[]
  unknown: string[]
} {
  const text = (body ?? '').trim()
  if (!text) return { problems: ['empty'], unknown: [] }
  const problems = new Set<WhatsAppTemplateProblem>()
  if (text.length > WHATSAPP_TEMPLATE_BODY_MAX) problems.add('too_long')
  const unknown = whatsappTemplateTokensIn(text).filter((t) => !(t in WHATSAPP_TEMPLATE_TOKENS))
  if (unknown.length) problems.add('unknown_token')
  if (/^\{\{/.test(text)) problems.add('starts_with_token')
  if (/\}\}$/.test(text)) problems.add('ends_with_token')
  if (/\}\}\s*\{\{/.test(text)) problems.add('adjacent_tokens')
  return { problems: [...problems], unknown: [...new Set(unknown)] }
}

/** The body as Meta receives it — tokens renamed to their named parameters —
 *  and the ordered, de-duplicated parameters with their examples. */
export function whatsappTemplateForMeta(body: string): {
  text: string
  params: { token: WhatsAppTemplateToken; name: string; example: string }[]
} {
  const params: { token: WhatsAppTemplateToken; name: string; example: string }[] = []
  const text = (body ?? '').trim().replace(TOKEN_RE, (whole, raw: string) => {
    const token = raw as WhatsAppTemplateToken
    const def = WHATSAPP_TEMPLATE_TOKENS[token]
    if (!def) return whole
    if (!params.some((p) => p.token === token)) params.push({ token, name: def.param, example: def.example })
    return `{{${def.param}}}`
  })
  return { text, params }
}

/** Can this template send right now? */
export function whatsappStudioTemplateSendable(
  template: Pick<WhatsAppStudioTemplate, 'live'> | null | undefined,
): boolean {
  return template?.live?.status === 'APPROVED'
}
