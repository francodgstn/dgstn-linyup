/**
 * The three SHOP purchase receipts — credit pack / membership, course, product.
 *
 * Bodies only; the posture, the reads and the `mail_sends` keying live next door
 * in `purchaseReceipts.ts`. UX-77 kept these out of UX-76 for one reason: they
 * cannot share the class-booking body. A course has no time and no location, a
 * product has neither and may need collection terms instead, and a credit pack's
 * whole job is a NUMBER — how many credits the buyer now holds and what they are
 * for. One template with four holes punched in it would say nothing well.
 *
 * ESCAPING: same idiom as `booking/templates.ts` — every interpolated value is
 * escaped once at the top of its builder, under the name the body reaches for,
 * so a line added later cannot pick up a raw value by using the obvious
 * identifier. Subjects go out RAW on purpose (Brevo takes the subject as its own
 * API field) and read `p.x` explicitly to signal it.
 */
import { buildEmailTemplate } from '../utils/email'
import { detailsBox, ctaButton, factLines } from '../utils/emailLayout'
import { escapeHtml } from '../utils/html'
import {
  introOfferSpan,
  type IntroSpanUnit,
  type SubscriptionRecurrence,
} from '@linyup/shared'

export type Lang = 'en' | 'de' | 'fr' | 'it'

const LOCALES: Record<Lang, string> = { en: 'en-GB', de: 'de-CH', fr: 'fr-CH', it: 'it-CH' }

/** A money fact, in MAJOR units — "CHF 30.00". Two decimals because these lines
 *  are receipts, not price tags. */
export interface PaidAmount {
  amount: number
  currency: string
  /** Paid with stored value rather than a card — the facts line says so, because
   *  a buyer who spent a gift card should not read "Paid: CHF 30.00" and wonder
   *  which of the two got charged. */
  giftCard?: boolean
  /** HOW it was paid, in the studio's own words — "Cash", "Bank transfer",
   *  "TWINT". Set by the DESK rails (UX-80), where the tender is the studio's
   *  free-text payment mode and the buyer should not be left to assume a card
   *  was charged; the online rails leave it unset and the line stays a bare
   *  amount. Wins over `giftCard` when both are somehow present, because a
   *  named tender is more specific than a category. */
  methodLabel?: string
}

const GIFT_CARD_SUFFIX: Record<Lang, string> = {
  en: 'gift card',
  de: 'Geschenkkarte',
  fr: 'carte cadeau',
  it: 'carta regalo',
}

function money(paid: PaidAmount | null | undefined, lang: Lang): string | null {
  if (!paid) return null
  const value = `${escapeHtml(paid.currency.toUpperCase())} ${paid.amount.toFixed(2)}`
  // The studio's own mode label is free text it typed into its settings, so it
  // is escaped here like every other interpolated value.
  const method = (paid.methodLabel ?? '').trim()
  if (method) return `${value} (${escapeHtml(method)})`
  return paid.giftCard ? `${value} (${GIFT_CARD_SUFFIX[lang]})` : value
}

function formatDay(d: Date, lang: Lang): string {
  return d.toLocaleDateString(LOCALES[lang], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Zurich',
  })
}

const PAID_LABELS: Record<Lang, string> = {
  en: 'Paid',
  de: 'Bezahlt',
  fr: 'Payé',
  it: 'Pagato',
}

const GREETINGS: Record<Lang, (n: string) => string> = {
  en: (n) => (n ? `Hi ${n},` : 'Hi,'),
  de: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
  fr: (n) => (n ? `Bonjour ${n},` : 'Bonjour,'),
  it: (n) => (n ? `Ciao ${n},` : 'Ciao,'),
}

/** The member-area line every one of these receipts carries. A shop buyer may
 *  never have heard of the Space, and this mail is the moment they have a reason
 *  to open it. */
const SPACE_LINES: Record<Lang, (url: string) => string> = {
  en: (u) =>
    `You can see this and everything else you hold in your <a href="${u}">member area</a> — sign in with this email address, no password needed.`,
  de: (u) =>
    `Das und alles Weitere finden Sie in Ihrem <a href="${u}">Mitgliederbereich</a> — Anmeldung mit dieser E-Mail-Adresse, ohne Passwort.`,
  fr: (u) =>
    `Vous retrouvez ceci et tout le reste dans votre <a href="${u}">espace membre</a> — connexion avec cette adresse e-mail, sans mot de passe.`,
  it: (u) =>
    `Trovi questo e tutto il resto nella tua <a href="${u}">area riservata</a> — accesso con questo indirizzo e-mail, senza password.`,
}

const SPACE_CTA: Record<Lang, string> = {
  en: 'Open my member area',
  de: 'Mitgliederbereich öffnen',
  fr: 'Ouvrir mon espace membre',
  it: 'Apri la mia area riservata',
}

// ─── 1. Credit pack ───────────────────────────────────────────────────────────

export interface CreditPackReceiptParams {
  firstname: string
  teamName: string
  packName: string
  /** THE POINT OF THIS MAIL. Comes from the grant document that was just
   *  written — never from `Contact.credit_summary`, which a trigger maintains
   *  and which can still be stale at the moment this is built. */
  credits: number
  /** The pack's validity window, or null when the credits never expire. */
  expiresAt?: Date | null
  /** Activity names the credits can be spent on, when the pack is scoped to
   *  some. Empty ⇒ the copy stays general rather than inventing a scope. */
  activityNames?: string[]
  paid?: PaidAmount | null
  /**
   * These credits were GIVEN, not bought — the `grantCredits` rail (a goodwill
   * make-up lesson, a correction). The mail is otherwise identical, because the
   * payload is identical: a number, a scope and an expiry.
   *
   * It exists because the purchase copy opens "Thank you — your purchase is
   * confirmed", and saying that to somebody who paid nothing is the kind of
   * small lie a member notices and a studio then has to explain. A CASH pack
   * recorded at the desk is a purchase and leaves this false.
   */
  granted?: boolean
  spaceUrl?: string | null
  lang?: Lang
}

export function buildCreditPackReceiptEmail(p: CreditPackReceiptParams): {
  subject: string
  html: string
  text: string
} {
  const lang = p.lang ?? 'en'
  const firstname = escapeHtml(p.firstname)
  const teamName = escapeHtml(p.teamName)
  const packName = escapeHtml(p.packName)
  const n = p.credits
  const paidLine = money(p.paid, lang)
  const activities = (p.activityNames ?? []).map((a) => escapeHtml(a))

  const titles: Record<Lang, string> = {
    en: 'Your credits are ready',
    de: 'Ihr Guthaben ist bereit',
    fr: 'Vos crédits sont prêts',
    it: 'I tuoi crediti sono pronti',
  }

  // The subject is a NUMBER and a place, which is the same news either way — it
  // is the body that must not say "thank you for your purchase" to somebody who
  // did not make one.
  const subjects: Record<Lang, string> = {
    en: `${n} credits at ${p.teamName}`,
    de: `${n} Guthaben bei ${p.teamName}`,
    fr: `${n} crédits chez ${p.teamName}`,
    it: `${n} crediti presso ${p.teamName}`,
  }

  const purchaseIntros: Record<Lang, string> = {
    en: `Thank you — your purchase is confirmed. Your pack gives you <strong>${n} credits</strong> at <strong>${teamName}</strong>, and one credit books one class.`,
    de: `Vielen Dank — Ihr Kauf ist bestätigt. Ihr Paket enthält <strong>${n} Guthaben</strong> bei <strong>${teamName}</strong>; eine Buchung kostet ein Guthaben.`,
    fr: `Merci — votre achat est confirmé. Votre pack vous donne <strong>${n} crédits</strong> chez <strong>${teamName}</strong>, et un crédit réserve un cours.`,
    it: `Grazie — il tuo acquisto è confermato. Il tuo pacchetto ti dà <strong>${n} crediti</strong> presso <strong>${teamName}</strong>, e un credito prenota una lezione.`,
  }

  // GIVEN, not bought — no "thank you", no "purchase". See `granted`.
  const grantedIntros: Record<Lang, string> = {
    en: `<strong>${teamName}</strong> has added <strong>${n} credits</strong> to your account. One credit books one class.`,
    de: `<strong>${teamName}</strong> hat Ihrem Konto <strong>${n} Guthaben</strong> gutgeschrieben. Eine Buchung kostet ein Guthaben.`,
    fr: `<strong>${teamName}</strong> a crédité votre compte de <strong>${n} crédits</strong>. Un crédit réserve un cours.`,
    it: `<strong>${teamName}</strong> ha aggiunto <strong>${n} crediti</strong> al tuo account. Un credito prenota una lezione.`,
  }

  const intros = p.granted ? grantedIntros : purchaseIntros

  const factLabels: Record<Lang, { pack: string; credits: string; valid: string; noExpiry: string }> = {
    en: { pack: 'Pack', credits: 'Credits', valid: 'Valid until', noExpiry: 'No expiry date' },
    de: { pack: 'Paket', credits: 'Guthaben', valid: 'Gültig bis', noExpiry: 'Ohne Ablaufdatum' },
    fr: { pack: 'Pack', credits: 'Crédits', valid: "Valable jusqu'au", noExpiry: "Pas de date d'expiration" },
    it: { pack: 'Pacchetto', credits: 'Crediti', valid: 'Valido fino al', noExpiry: 'Senza scadenza' },
  }
  const L = factLabels[lang]

  const facts = [
    `<strong>${L.pack}:</strong> ${packName}`,
    `<strong>${L.credits}:</strong> ${n}`,
    p.expiresAt
      ? `<strong>${L.valid}:</strong> ${formatDay(p.expiresAt, lang)}`
      : `<strong>${L.valid}:</strong> ${L.noExpiry}`,
    paidLine ? `<strong>${PAID_LABELS[lang]}:</strong> ${paidLine}` : '',
  ]

  // Named, not summarized: "selected classes" tells a buyer nothing, and a pack
  // that turns out not to cover the class they wanted is the complaint this line
  // exists to prevent.
  const scopeLines: Record<Lang, (list: string) => string> = {
    en: (l) => `Use them to book: ${l}.`,
    de: (l) => `Damit buchen Sie: ${l}.`,
    fr: (l) => `Utilisez-les pour réserver : ${l}.`,
    it: (l) => `Usali per prenotare: ${l}.`,
  }

  const body = [
    `<p>${GREETINGS[lang](firstname)}</p>`,
    `<p>${intros[lang]}</p>`,
    detailsBox({ content: factLines(facts) }),
    activities.length ? `<p>${scopeLines[lang](activities.join(', '))}</p>` : '',
    p.spaceUrl
      ? `<p style="text-align:center;margin-top:24px;">${ctaButton(p.spaceUrl, SPACE_CTA[lang])}</p>`
      : '',
    p.spaceUrl ? `<p style="font-size:14px;">${SPACE_LINES[lang](p.spaceUrl)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return { subject: subjects[lang], ...buildEmailTemplate({ title: titles[lang], body }) }
}

// ─── 2. Membership (the same rail, without credits) ───────────────────────────

export interface MembershipReceiptParams {
  firstname: string
  teamName: string
  planName: string
  /** Recurring ⇒ the copy says it renews by itself; one-off ⇒ it does not. */
  recurring: boolean
  /** One-off memberships that include a run of months — the date they run to. */
  validUntil?: Date | null
  paid?: PaidAmount | null
  /**
   * The plan's INTRO OFFER, when one applied — and only when the first charge
   * corroborated it (`introReceiptTerms` in connect/webhook.ts does that check).
   *
   * It is restated HERE because `paid` alone is a smaller number with no story:
   * a member who was told "CHF 1 for the first 3 months, then CHF 79/month"
   * before purchase and then receives a receipt saying "Paid: CHF 1.00" has been
   * shown the discount as if it were the price. The receipt has to carry the
   * whole schedule, exactly as the pricing card did.
   */
  intro?: {
    periods: number
    /** Per-period price while it runs, MAJOR units. 0 = free. */
    amount: number
    /** The price it returns to, MAJOR units. */
    fullAmount: number
    recurrence: string
    currency: string
  } | null
  spaceUrl?: string | null
  lang?: Lang
}

// ─── Intro-offer copy ─────────────────────────────────────────────────────────
// Four locales, plural-correct, and the span is converted the way a member
// counts it (introOfferSpan: "your first 6 months", never "2 quarters").

const INTRO_LABELS: Record<Lang, string> = {
  en: 'Intro offer',
  de: 'Einführungsangebot',
  fr: 'Offre de lancement',
  it: 'Offerta di lancio',
}

// "the first 3 months", declined. The article + ordinal + noun are written out
// per language and per unit rather than assembled from parts, because German
// gender and French/Italian ordinal placement do not survive assembly —
// "vos 3 mois premiers" is what a naive template produces.
const FIRST_SPAN: Record<Lang, Record<IntroSpanUnit, (c: number) => string>> = {
  en: {
    week: (c) => (c === 1 ? 'the first week' : `the first ${c} weeks`),
    month: (c) => (c === 1 ? 'the first month' : `the first ${c} months`),
    year: (c) => (c === 1 ? 'the first year' : `the first ${c} years`),
  },
  de: {
    week: (c) => (c === 1 ? 'die erste Woche' : `die ersten ${c} Wochen`),
    month: (c) => (c === 1 ? 'den ersten Monat' : `die ersten ${c} Monate`),
    year: (c) => (c === 1 ? 'das erste Jahr' : `die ersten ${c} Jahre`),
  },
  fr: {
    week: (c) => (c === 1 ? 'la première semaine' : `les ${c} premières semaines`),
    month: (c) => (c === 1 ? 'le premier mois' : `les ${c} premiers mois`),
    year: (c) => (c === 1 ? 'la première année' : `les ${c} premières années`),
  },
  it: {
    week: (c) => (c === 1 ? 'la prima settimana' : `le prime ${c} settimane`),
    month: (c) => (c === 1 ? 'il primo mese' : `i primi ${c} mesi`),
    year: (c) => (c === 1 ? 'il primo anno' : `i primi ${c} anni`),
  },
}

const FREE_WORD: Record<Lang, string> = {
  en: 'free',
  de: 'gratis',
  fr: 'gratuit',
  it: 'gratis',
}

/** The preposition that joins a price (or "free") to the span. */
const FOR_WORD: Record<Lang, string> = { en: 'for', de: 'für', fr: 'pour', it: 'per' }

/** "per month" / "every 2 weeks" — how the renewal price is qualified. */
const PER_PERIOD: Record<Lang, Record<string, string>> = {
  en: {
    weekly: 'per week',
    biweekly: 'every 2 weeks',
    monthly: 'per month',
    quarterly: 'per quarter',
    annual: 'per year',
  },
  de: {
    weekly: 'pro Woche',
    biweekly: 'alle 2 Wochen',
    monthly: 'pro Monat',
    quarterly: 'pro Quartal',
    annual: 'pro Jahr',
  },
  fr: {
    weekly: 'par semaine',
    biweekly: 'toutes les 2 semaines',
    monthly: 'par mois',
    quarterly: 'par trimestre',
    annual: 'par an',
  },
  it: {
    weekly: 'a settimana',
    biweekly: 'ogni 2 settimane',
    monthly: 'al mese',
    quarterly: 'a trimestre',
    annual: "all'anno",
  },
}

/** The fact row ("CHF 1.00 for the first 3 months") + the sentence that says
 *  what happens after it ("After that, this membership renews at …"). */
function introLines(
  intro: NonNullable<MembershipReceiptParams['intro']>,
  lang: Lang
): { fact: string; after: string } {
  const { count, unit } = introOfferSpan(intro.recurrence as SubscriptionRecurrence, intro.periods)
  const span = escapeHtml(FIRST_SPAN[lang][unit](count))
  const currency = escapeHtml(intro.currency.toUpperCase())
  const lead =
    intro.amount === 0 ? FREE_WORD[lang] : `${currency} ${intro.amount.toFixed(2)}`
  const fullPrice = `${currency} ${intro.fullAmount.toFixed(2)}`
  const per = escapeHtml(PER_PERIOD[lang][intro.recurrence] ?? PER_PERIOD[lang].monthly)

  const afters: Record<Lang, string> = {
    en: `After that, this membership renews at ${fullPrice} ${per}.`,
    de: `Danach verlängert sich diese Mitgliedschaft zu ${fullPrice} ${per}.`,
    fr: `Ensuite, cet abonnement se renouvelle à ${fullPrice} ${per}.`,
    it: `Successivamente, questo abbonamento si rinnova a ${fullPrice} ${per}.`,
  }

  return { fact: `${lead} ${FOR_WORD[lang]} ${span}`, after: afters[lang] }
}

export function buildMembershipReceiptEmail(p: MembershipReceiptParams): {
  subject: string
  html: string
  text: string
} {
  const lang = p.lang ?? 'en'
  const firstname = escapeHtml(p.firstname)
  const teamName = escapeHtml(p.teamName)
  const planName = escapeHtml(p.planName)
  const paidLine = money(p.paid, lang)

  const titles: Record<Lang, string> = {
    en: 'Membership confirmed',
    de: 'Mitgliedschaft bestätigt',
    fr: 'Abonnement confirmé',
    it: 'Abbonamento confermato',
  }

  const subjects: Record<Lang, string> = {
    en: `Membership confirmed – ${p.planName}`,
    de: `Mitgliedschaft bestätigt – ${p.planName}`,
    fr: `Abonnement confirmé – ${p.planName}`,
    it: `Abbonamento confermato – ${p.planName}`,
  }

  const intros: Record<Lang, string> = {
    en: `Thank you — your <strong>${planName}</strong> membership at <strong>${teamName}</strong> is active.`,
    de: `Vielen Dank — Ihre Mitgliedschaft <strong>${planName}</strong> bei <strong>${teamName}</strong> ist aktiv.`,
    fr: `Merci — votre abonnement <strong>${planName}</strong> chez <strong>${teamName}</strong> est actif.`,
    it: `Grazie — il tuo abbonamento <strong>${planName}</strong> presso <strong>${teamName}</strong> è attivo.`,
  }

  const factLabels: Record<Lang, { plan: string; until: string }> = {
    en: { plan: 'Membership', until: 'Included until' },
    de: { plan: 'Mitgliedschaft', until: 'Enthalten bis' },
    fr: { plan: 'Abonnement', until: "Inclus jusqu'au" },
    it: { plan: 'Abbonamento', until: 'Incluso fino al' },
  }
  const L = factLabels[lang]

  // Restated from the pricing card, and only when the charge corroborated it —
  // see MembershipReceiptParams.intro.
  const intro = p.intro ? introLines(p.intro, lang) : null

  const facts = [
    `<strong>${L.plan}:</strong> ${planName}`,
    p.validUntil ? `<strong>${L.until}:</strong> ${formatDay(p.validUntil, lang)}` : '',
    intro ? `<strong>${INTRO_LABELS[lang]}:</strong> ${intro.fact}` : '',
    paidLine ? `<strong>${PAID_LABELS[lang]}:</strong> ${paidLine}` : '',
  ]

  // "Manage or cancel", not "cancel": the member area opens Stripe's billing
  // portal (Space → Payments), which does both — and claiming only the second
  // would understate it while claiming a button that is labeled differently.
  const renewalLines: Record<Lang, string> = {
    en: 'This membership renews automatically until you cancel it. You can manage or cancel it any time from your member area.',
    de: 'Diese Mitgliedschaft verlängert sich automatisch, bis Sie sie kündigen. Verwalten oder kündigen können Sie sie jederzeit im Mitgliederbereich.',
    fr: "Cet abonnement se renouvelle automatiquement jusqu'à votre résiliation. Vous pouvez le gérer ou le résilier à tout moment depuis votre espace membre.",
    it: 'Questo abbonamento si rinnova automaticamente finché non lo disdici. Puoi gestirlo o disdirlo in qualsiasi momento dalla tua area riservata.',
  }

  const oneOffLines: Record<Lang, string> = {
    en: 'This was a one-off payment — nothing renews automatically.',
    de: 'Das war eine einmalige Zahlung — es verlängert sich nichts automatisch.',
    fr: "Il s'agit d'un paiement unique — rien ne se renouvelle automatiquement.",
    it: 'È stato un pagamento una tantum — non si rinnova nulla automaticamente.',
  }

  const body = [
    `<p>${GREETINGS[lang](firstname)}</p>`,
    `<p>${intros[lang]}</p>`,
    detailsBox({ content: factLines(facts) }),
    // BEFORE the generic renewal sentence, deliberately: "renews automatically"
    // read on its own, after a receipt showing CHF 1.00, says the member renews
    // at CHF 1.00. This is the sentence that corrects that.
    intro ? `<p>${intro.after}</p>` : '',
    `<p>${p.recurring ? renewalLines[lang] : oneOffLines[lang]}</p>`,
    p.spaceUrl
      ? `<p style="text-align:center;margin-top:24px;">${ctaButton(p.spaceUrl, SPACE_CTA[lang])}</p>`
      : '',
    p.spaceUrl ? `<p style="font-size:14px;">${SPACE_LINES[lang](p.spaceUrl)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return { subject: subjects[lang], ...buildEmailTemplate({ title: titles[lang], body }) }
}

// ─── 3. Course ────────────────────────────────────────────────────────────────

export interface CourseReceiptParams {
  firstname: string
  teamName: string
  courseTitle: string
  paid?: PaidAmount | null
  /** Deep link to the course in the member area when the course has a slug,
   *  else the Space root. WHERE TO WATCH IT is the whole job of this mail. */
  watchUrl?: string | null
  spaceUrl?: string | null
  lang?: Lang
}

export function buildCourseReceiptEmail(p: CourseReceiptParams): {
  subject: string
  html: string
  text: string
} {
  const lang = p.lang ?? 'en'
  const firstname = escapeHtml(p.firstname)
  const teamName = escapeHtml(p.teamName)
  const courseTitle = escapeHtml(p.courseTitle)
  const paidLine = money(p.paid, lang)

  const titles: Record<Lang, string> = {
    en: 'Your course is ready',
    de: 'Ihr Kurs ist bereit',
    fr: 'Votre cours est prêt',
    it: 'Il tuo corso è pronto',
  }

  const subjects: Record<Lang, string> = {
    en: `You now have access to ${p.courseTitle}`,
    de: `Sie haben jetzt Zugang zu ${p.courseTitle}`,
    fr: `Vous avez maintenant accès à ${p.courseTitle}`,
    it: `Ora hai accesso a ${p.courseTitle}`,
  }

  const intros: Record<Lang, string> = {
    en: `Thank you — <strong>${courseTitle}</strong> from <strong>${teamName}</strong> is now open in your member area.`,
    de: `Vielen Dank — <strong>${courseTitle}</strong> von <strong>${teamName}</strong> ist jetzt in Ihrem Mitgliederbereich freigeschaltet.`,
    fr: `Merci — <strong>${courseTitle}</strong> de <strong>${teamName}</strong> est maintenant ouvert dans votre espace membre.`,
    it: `Grazie — <strong>${courseTitle}</strong> di <strong>${teamName}</strong> è ora disponibile nella tua area riservata.`,
  }

  const factLabels: Record<Lang, string> = {
    en: 'Course',
    de: 'Kurs',
    fr: 'Cours',
    it: 'Corso',
  }

  const facts = [
    `<strong>${factLabels[lang]}:</strong> ${courseTitle}`,
    paidLine ? `<strong>${PAID_LABELS[lang]}:</strong> ${paidLine}` : '',
  ]

  // A course entitlement is LIFETIME (courses/{id}/purchases/{contactId} has no
  // expiry and nothing ever removes it), so say that plainly instead of the
  // vague "enjoy your access" that reads like a window.
  const lifetimeLines: Record<Lang, string> = {
    en: 'It is yours for good — watch it as often as you like, with no expiry date.',
    de: 'Der Kurs gehört dauerhaft Ihnen — beliebig oft ansehen, ohne Ablaufdatum.',
    fr: "Il est à vous pour toujours — regardez-le autant de fois que vous voulez, sans date d'expiration.",
    it: 'È tuo per sempre — guardalo quante volte vuoi, senza scadenza.',
  }

  const watchCtas: Record<Lang, string> = {
    en: 'Watch the course',
    de: 'Kurs ansehen',
    fr: 'Regarder le cours',
    it: 'Guarda il corso',
  }

  const cta = p.watchUrl ?? p.spaceUrl ?? null

  const body = [
    `<p>${GREETINGS[lang](firstname)}</p>`,
    `<p>${intros[lang]}</p>`,
    detailsBox({ content: factLines(facts) }),
    `<p>${lifetimeLines[lang]}</p>`,
    cta ? `<p style="text-align:center;margin-top:24px;">${ctaButton(cta, watchCtas[lang])}</p>` : '',
    p.spaceUrl ? `<p style="font-size:14px;">${SPACE_LINES[lang](p.spaceUrl)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return { subject: subjects[lang], ...buildEmailTemplate({ title: titles[lang], body }) }
}

// ─── 4. Product ───────────────────────────────────────────────────────────────

export interface ProductReceiptParams {
  firstname: string
  teamName: string
  /** "Hoodie · XL" — product name plus the variant when one was chosen. */
  itemLabel: string
  paid?: PaidAmount | null
  /**
   * HOW TO GET IT, in the studio's own words (UX-79) — the product's own
   * `collectionNote` or the team default, already resolved by the caller
   * through `resolveProductCollectionNote`.
   *
   * When present it REPLACES the generic "arranges handover directly" sentence
   * rather than joining it: the generic line exists only because the product
   * model could not say anything, and printing both would have the studio's own
   * terms argue with a platform disclaimer. The "ask them" sentence stays either
   * way — a note answers the common case, not every case.
   */
  collectionNote?: string | null
  /** The studio's published address, when it has one. */
  teamEmail?: string | null
  spaceUrl?: string | null
  lang?: Lang
}

export function buildProductReceiptEmail(p: ProductReceiptParams): {
  subject: string
  html: string
  text: string
} {
  const lang = p.lang ?? 'en'
  const firstname = escapeHtml(p.firstname)
  const teamName = escapeHtml(p.teamName)
  const itemLabel = escapeHtml(p.itemLabel)
  const teamEmail = p.teamEmail ? escapeHtml(p.teamEmail) : null
  const paidLine = money(p.paid, lang)
  const collectionNote = (p.collectionNote ?? '').trim()
    ? escapeHtml((p.collectionNote ?? '').trim())
    : null

  const titles: Record<Lang, string> = {
    en: 'Order confirmed',
    de: 'Bestellung bestätigt',
    fr: 'Commande confirmée',
    it: 'Ordine confermato',
  }

  const subjects: Record<Lang, string> = {
    en: `Order confirmed – ${p.itemLabel}`,
    de: `Bestellung bestätigt – ${p.itemLabel}`,
    fr: `Commande confirmée – ${p.itemLabel}`,
    it: `Ordine confermato – ${p.itemLabel}`,
  }

  const intros: Record<Lang, string> = {
    en: `Thank you — your order at <strong>${teamName}</strong> is confirmed.`,
    de: `Vielen Dank — Ihre Bestellung bei <strong>${teamName}</strong> ist bestätigt.`,
    fr: `Merci — votre commande chez <strong>${teamName}</strong> est confirmée.`,
    it: `Grazie — il tuo ordine presso <strong>${teamName}</strong> è confermato.`,
  }

  const factLabels: Record<Lang, string> = {
    en: 'Item',
    de: 'Artikel',
    fr: 'Article',
    it: 'Articolo',
  }

  const facts = [
    `<strong>${factLabels[lang]}:</strong> ${itemLabel}`,
    paidLine ? `<strong>${PAID_LABELS[lang]}:</strong> ${paidLine}` : '',
  ]

  const nextTitles: Record<Lang, string> = {
    en: 'What happens next',
    de: 'Wie es weitergeht',
    fr: 'La suite',
    it: 'Cosa succede ora',
  }

  // WHAT IS TRUE, NOT WHAT WOULD BE NICE. Used when the studio has said NOTHING
  // — no product `collectionNote` and no team default. It promises no shipping
  // and no timeframe, because nothing in the data could back either; it says the
  // studio has the order and gives the buyer a way to ask. The studio's own note
  // replaces this line the moment there is one (UX-79).
  const nextLines: Record<Lang, string> = {
    en: `${teamName} arranges handover directly — nothing is shipped automatically.`,
    de: `${teamName} regelt die Übergabe direkt — es wird nichts automatisch versendet.`,
    fr: `${teamName} organise la remise directement — rien n'est expédié automatiquement.`,
    it: `${teamName} organizza la consegna direttamente — non viene spedito nulla automaticamente.`,
  }

  const askLines: Record<Lang, (mail: string) => string> = {
    en: (m) => `Ask them at <a href="mailto:${m}">${m}</a> if you are not sure how to collect it.`,
    de: (m) => `Fragen Sie unter <a href="mailto:${m}">${m}</a> nach, wenn Sie nicht wissen, wie Sie es erhalten.`,
    fr: (m) => `Écrivez-leur à <a href="mailto:${m}">${m}</a> si vous ne savez pas comment le récupérer.`,
    it: (m) => `Scrivi a <a href="mailto:${m}">${m}</a> se non sai come ritirarlo.`,
  }

  const askReplyLines: Record<Lang, string> = {
    en: 'Reply to this email if you are not sure how to collect it.',
    de: 'Antworten Sie auf diese E-Mail, wenn Sie nicht wissen, wie Sie es erhalten.',
    fr: 'Répondez à cet e-mail si vous ne savez pas comment le récupérer.',
    it: 'Rispondi a questa email se non sai come ritirarlo.',
  }

  const body = [
    `<p>${GREETINGS[lang](firstname)}</p>`,
    `<p>${intros[lang]}</p>`,
    detailsBox({ content: factLines(facts) }),
    detailsBox({
      title: nextTitles[lang],
      content: `<p style="margin:0;">${collectionNote ?? nextLines[lang]} ${
        teamEmail ? askLines[lang](teamEmail) : askReplyLines[lang]
      }</p>`,
    }),
    p.spaceUrl ? `<p style="font-size:14px;">${SPACE_LINES[lang](p.spaceUrl)}</p>` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return { subject: subjects[lang], ...buildEmailTemplate({ title: titles[lang], body }) }
}
