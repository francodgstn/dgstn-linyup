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

/** THE one reader of a contact's WhatsApp consent. */
export function whatsappConsentAllows(contact: { whatsapp_consent?: unknown } | null | undefined): boolean {
  const consent = contact?.whatsapp_consent as { status?: unknown } | null | undefined
  return consent?.status === 'opted_in'
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
