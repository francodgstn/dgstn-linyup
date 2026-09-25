// Automation Library — curated pre-built automation rules for Linyup.
//
// Each LibraryItem represents one automation rule (and an optional email template)
// that can be browsed and installed from the Library dialog.
//
// library_key: stable identifier stored as `system_key` on Firestore docs.
//   - Migrated starter-kit items keep their old sys_* keys for backward compat.
//   - New items use lib_* keys.
//
// Template system_key convention:
//   - New items: `${library_key}:${lang}` per language variant
//   - Migrated items: no `template` field; action references existing sys_* template
//
// Adding new items in future: append to AUTOMATION_LIBRARY, ship. The library
// dialog re-reads this at load time — no migration needed.

import type { LucideIcon } from 'lucide-react'
import { UserPlus, RefreshCw, Trophy, CalendarCheck, Settings2 } from 'lucide-react'
import { TRIAL_CLEANUP_RULE, TRIAL_CLEANUP_RULE_KEY, planIsAtLeast, type SaasPlan } from '@linyup/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LibraryCategory = 'trial' | 'retention' | 'milestones' | 'appointment' | 'admin'
export type SupportedLanguage = 'en' | 'de' | 'fr' | 'it'

export interface TemplateContent {
  subject: string
  body: string // markdown
}

export type LibraryAction =
  | { type: 'send_email'; template_key: string } // resolved to templateId at install time
  | { type: 'update_field'; field: string; value: string }
  | { type: 'archive_contact' } // archive (never delete) the contact
  | { type: 'add_note'; note: string } // append a timestamped note to the contact
  | { type: 'notify_team'; subject: string; body: string }
  | { type: 'log_activity'; message: string }

export interface LibraryItem {
  library_key: string
  category: LibraryCategory
  name: string
  description: string // 1-line shown on card
  tags: string[]
  /** The tier this ready-made rule belongs to. READ — see
   *  `libraryItemUnlocked`: for a long time this field was declared on every
   *  item and consulted by nothing, so a Free team could install a 'studio'
   *  item from the dialog. A declared-but-unenforced gate is worse than none,
   *  because everyone maintaining the catalog reads it as a guarantee. */
  requires_plan: 'free' | 'coach' | 'studio'
  /** Defined only for items that own their email template. Migrated items reference
   *  an existing sys_* template via the action's template_key instead. */
  template?: {
    name: string
    body_mode: 'markdown'
    /** At least 'en' is required. All 4 variants are created at install time when present. */
    translations: { en: TemplateContent } & Partial<Record<SupportedLanguage, TemplateContent>>
  }
  rule: {
    trigger: { type: string; delayMinutes?: number }
    conditions: Array<Record<string, unknown>>
    actions: LibraryAction[]
  }
}

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

export const CATEGORY_META: Record<
  LibraryCategory,
  { label: string; icon: LucideIcon; color: string }
> = {
  trial: { label: 'Trial Conversion', icon: UserPlus, color: 'text-blue-500' },
  retention: { label: 'Retention', icon: RefreshCw, color: 'text-green-500' },
  milestones: { label: 'Milestones', icon: Trophy, color: 'text-amber-500' },
  appointment: { label: 'Appointments', icon: CalendarCheck, color: 'text-purple-500' },
  admin: { label: 'Internal / Admin', icon: Settings2, color: 'text-slate-500' },
}

// ---------------------------------------------------------------------------
// Automation Library
// ---------------------------------------------------------------------------

export const AUTOMATION_LIBRARY: LibraryItem[] = [
  // ── TRIAL CONVERSION ──────────────────────────────────────────────────────

  {
    library_key: 'lib_trial_welcome',
    category: 'trial',
    name: 'Welcome new trial',
    description: 'Sends a warm welcome email the moment a trial contact is created.',
    tags: ['trial', 'welcome', 'first contact', 'onboarding'],
    requires_plan: 'studio',
    template: {
      name: 'Welcome to your first session',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: 'Welcome to {{teamName}}, {{firstname}}!',
          body: `Hi {{firstname}},

We are delighted to welcome you to **{{teamName}}** for your first session!

A few things to know before you arrive:

- **Arrive a few minutes early** so we can welcome you and answer any questions.
- No experience needed — we will guide you through everything.
- Need to reschedule? Just reply to this email or rebook online.

**[Book your trial session ↗]({{bookingUrl}})**

We look forward to meeting you!

The {{teamName}} team`,
        },
        de: {
          subject: 'Willkommen bei {{teamName}}, {{firstname}}!',
          body: `Hallo {{firstname}},

herzlich willkommen bei **{{teamName}}** — wir freuen uns auf deine erste Session!

Ein paar Hinweise vor deinem Besuch:

- **Komm ein paar Minuten früher**, damit wir dich in Ruhe begrüssen und deine Fragen beantworten können.
- Keine Vorkenntnisse nötig — wir begleiten dich Schritt für Schritt.
- Termin verschieben? Antworte einfach auf diese E-Mail oder buche online neu.

**[Probetermin buchen ↗]({{bookingUrl}})**

Wir freuen uns, dich kennenzulernen!

Das {{teamName}}-Team`,
        },
        fr: {
          subject: 'Bienvenue chez {{teamName}}, {{firstname}} !',
          body: `Bonjour {{firstname}},

Bienvenue chez **{{teamName}}** — nous nous réjouissons de vous accueillir pour votre première séance !

Quelques informations avant votre venue :

- **Arrivez quelques minutes à l'avance** pour que nous puissions vous accueillir et répondre à vos questions.
- Aucune expérience nécessaire — nous vous guiderons pas à pas.
- Besoin de reporter ? Répondez simplement à cet e-mail ou réservez un nouveau créneau en ligne.

**[Réserver votre séance d'essai ↗]({{bookingUrl}})**

Au plaisir de vous rencontrer !

L'équipe {{teamName}}`,
        },
        it: {
          subject: 'Benvenuto/a a {{teamName}}, {{firstname}}!',
          body: `Ciao {{firstname}},

Benvenuto/a a **{{teamName}}** — siamo felici di accoglierti per la tua prima sessione!

Alcune informazioni prima del tuo arrivo:

- **Arriva qualche minuto prima**, così potremo accoglierti con calma e rispondere alle tue domande.
- Nessuna esperienza necessaria — ti guideremo passo dopo passo.
- Devi spostare l'appuntamento? Rispondi a questa email o prenota di nuovo online.

**[Prenota la tua sessione di prova ↗]({{bookingUrl}})**

Non vediamo l'ora di conoscerti!

Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'contact_created' },
      conditions: [{ type: 'acquisition_stage', value: 'trial_booked' }],
      actions: [{ type: 'send_email', template_key: 'lib_trial_welcome' }],
    },
  },

  {
    // THE WELCOME, at the moment of joining. Deliberately NOT `contact_created`
    // with an `acquisition_stage = joined` condition: for the population this
    // mail is most for — a trial lead who converted — `contact_created` fired at
    // trial-booking time, when the stage was `trial_booked`, and it never
    // re-evaluates. `acquisition_stage_changed` fires on the forward move
    // itself, including the one `auth/signupJoin.ts` makes when the signup form
    // is completed, so the condition below is read at exactly the right instant.
    library_key: 'lib_member_welcome',
    category: 'trial',
    name: 'Welcome a new member',
    description:
      'Sends a welcome email the moment a contact becomes a member — including a trial lead who just completed signup.',
    tags: ['member', 'welcome', 'joined', 'onboarding', 'conversion'],
    requires_plan: 'studio',
    template: {
      name: 'Welcome to the team',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: 'You are in, {{firstname}} — welcome to {{teamName}}!',
          body: `Hi {{firstname}},

Welcome to **{{teamName}}** — we are really glad to have you with us.

Here is how to get going:

- **Book your next sessions** whenever you like, online.
- Bring anything you need for training; if you are unsure, just ask us.
- Questions about your membership? Reply to this email and we will sort it out.

**[Book your next session ↗]({{bookingUrl}})**

See you on the floor,
The {{teamName}} team`,
        },
        de: {
          subject: 'Willkommen im Team, {{firstname}} — schön, dass du bei {{teamName}} bist!',
          body: `Hallo {{firstname}},

herzlich willkommen bei **{{teamName}}** — wir freuen uns sehr, dass du dabei bist.

So geht es los:

- **Buche deine nächsten Einheiten** jederzeit online.
- Bring mit, was du fürs Training brauchst; wenn du unsicher bist, frag uns einfach.
- Fragen zu deiner Mitgliedschaft? Antworte auf diese E-Mail, wir kümmern uns darum.

**[Nächste Einheit buchen ↗]({{bookingUrl}})**

Bis bald,
Das {{teamName}}-Team`,
        },
        fr: {
          subject: 'Bienvenue parmi nous, {{firstname}} — vous faites partie de {{teamName}} !',
          body: `Bonjour {{firstname}},

Bienvenue chez **{{teamName}}** — nous sommes ravis de vous compter parmi nous.

Pour bien démarrer :

- **Réservez vos prochaines séances** en ligne, quand vous le souhaitez.
- Apportez ce dont vous avez besoin pour l'entraînement ; en cas de doute, demandez-nous.
- Une question sur votre abonnement ? Répondez à cet e-mail et nous nous en occupons.

**[Réserver votre prochaine séance ↗]({{bookingUrl}})**

À très bientôt,
L'équipe {{teamName}}`,
        },
        it: {
          subject: 'Benvenuto/a nel team, {{firstname}} — siamo felici di averti in {{teamName}}!',
          body: `Ciao {{firstname}},

Benvenuto/a in **{{teamName}}** — siamo davvero felici di averti con noi.

Ecco come iniziare:

- **Prenota le tue prossime sessioni** online, quando vuoi.
- Porta ciò che ti serve per l'allenamento; se hai dubbi, chiedici pure.
- Domande sul tuo abbonamento? Rispondi a questa email e ce ne occupiamo noi.

**[Prenota la prossima sessione ↗]({{bookingUrl}})**

A presto,
Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'acquisition_stage_changed' },
      conditions: [{ type: 'acquisition_stage', value: 'joined' }],
      actions: [{ type: 'send_email', template_key: 'lib_member_welcome' }],
    },
  },

  {
    // Installed ACTIVE by default for every new team (functions onTeamCreated) —
    // rule shape shared via @linyup/shared TRIAL_CLEANUP_RULE. Listed here so
    // existing teams can (re)install it and everyone can see/edit what it does.
    library_key: TRIAL_CLEANUP_RULE_KEY,
    category: 'trial',
    name: TRIAL_CLEANUP_RULE.name,
    description:
      'Keeps your list clean: archives (never deletes) trial bookings that never attended within 30 days. Edit the rule to change the window. Installed automatically for new teams.',
    tags: ['trial', 'cleanup', 'archive', 'hygiene'],
    // 'free', and provably so: `onTeamCreated` installs this rule ACTIVE for
    // EVERY new team whatever its plan. Locking the re-install behind Coach
    // would refuse a Free team a rule it is already running.
    requires_plan: 'free',
    rule: {
      trigger: { type: TRIAL_CLEANUP_RULE.trigger.type },
      conditions: TRIAL_CLEANUP_RULE.conditions.map((c) => ({ ...c })),
      actions: [{ type: 'archive_contact' }],
    },
  },

  {
    library_key: 'sys_rule_noshow_1d',
    category: 'trial',
    name: 'Trial no-show — 1-day follow-up',
    description: 'Sends a rebook nudge one day after a trial booking is marked no-show.',
    tags: ['trial', 'no-show', 'rebook', 'recovery'],
    requires_plan: 'studio',
    // No template field — uses existing sys_rebook_nudge
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'bio_link_booking_no_show', delay_days: 1 },
        { type: 'sessions_attended_exactly', value: 0 },
        { type: 'acquisition_stage', value: 'trial_booked' },
      ],
      actions: [{ type: 'send_email', template_key: 'sys_rebook_nudge' }],
    },
  },

  {
    library_key: 'lib_trial_noshow_3d',
    category: 'trial',
    name: 'Trial no-show — 3-day reminder',
    description: 'A gentler mid-point follow-up 3 days after a missed trial booking.',
    tags: ['trial', 'no-show', 'rebook', 'recovery'],
    requires_plan: 'studio',
    template: {
      name: 'We still have a spot for you',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: 'We still have a spot for you, {{firstname}}',
          body: `Hi {{firstname}},

We know life can be unpredictable — we noticed you missed your trial at **{{teamName}}** a few days ago, and we wanted to reach out one more time.

If you are still interested, we would love to have you. Booking again takes just a moment:

**[Find a new time ↗]({{bookingUrl}})**

No pressure — but the door is always open.

The {{teamName}} team`,
        },
        de: {
          subject: 'Wir haben noch einen Platz für dich, {{firstname}}',
          body: `Hallo {{firstname}},

das Leben ist manchmal unberechenbar — wir haben bemerkt, dass du dein Probetraining bei **{{teamName}}** vor einigen Tagen verpasst hast, und möchten uns noch einmal melden.

Falls du noch Interesse hast, sind wir gerne für dich da. Eine neue Zeit buchen geht ganz schnell:

**[Neuen Termin finden ↗]({{bookingUrl}})**

Kein Druck — die Tür steht immer offen.

Das {{teamName}}-Team`,
        },
        fr: {
          subject: 'Nous avons encore une place pour vous, {{firstname}}',
          body: `Bonjour {{firstname}},

Nous savons que la vie peut être imprévisible — nous avons remarqué que vous avez manqué votre essai chez **{{teamName}}** il y a quelques jours et nous voulions vous contacter une dernière fois.

Si vous êtes toujours intéressé·e, nous serions ravis de vous accueillir. Reprendre rendez-vous ne prend qu'un instant :

**[Trouver un nouveau créneau ↗]({{bookingUrl}})**

Sans pression — la porte est toujours ouverte.

L'équipe {{teamName}}`,
        },
        it: {
          subject: 'Abbiamo ancora un posto per te, {{firstname}}',
          body: `Ciao {{firstname}},

La vita può essere imprevedibile — abbiamo notato che hai perso il tuo appuntamento di prova a **{{teamName}}** qualche giorno fa e volevamo contattarti ancora una volta.

Se sei ancora interessato/a, ci farebbe molto piacere averti con noi. Prenotare un nuovo orario è semplicissimo:

**[Trova un nuovo orario ↗]({{bookingUrl}})**

Nessuna pressione — la porta è sempre aperta.

Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'bio_link_booking_no_show', delay_days: 3 },
        { type: 'sessions_attended_exactly', value: 0 },
        { type: 'acquisition_stage', value: 'trial_booked' },
      ],
      actions: [{ type: 'send_email', template_key: 'lib_trial_noshow_3d' }],
    },
  },

  {
    library_key: 'sys_rule_noshow_5d',
    category: 'trial',
    name: 'Trial no-show — 5-day reminder',
    description: 'Final rebook nudge 5 days after a missed trial booking.',
    tags: ['trial', 'no-show', 'rebook', 'recovery'],
    requires_plan: 'studio',
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'bio_link_booking_no_show', delay_days: 5 },
        { type: 'sessions_attended_exactly', value: 0 },
        { type: 'acquisition_stage', value: 'trial_booked' },
      ],
      actions: [{ type: 'send_email', template_key: 'sys_rebook_nudge' }],
    },
  },

  {
    // THE HOUR AFTER, not the morning after. Every other trial follow-up here
    // hangs off `schedule_daily`, which runs once at 02:00 UTC — so a Tuesday
    // 19:00 trial is answered in the middle of Tuesday night, when the person
    // has stopped thinking about it. `session_ended` is anchored to the
    // session's OWN end time and carries a delay, so this one arrives while
    // they are still drying their hair.
    //
    // "AND THE TRIAL PARTICIPATED" NEEDS NO CONDITION. A `session_ended` rule
    // resolves its recipients from the session's `participants` rows at FIRE
    // time, and a participant row is written at check-in — so somebody who
    // booked and did not turn up, or canceled, is never in the list. A
    // condition testing attendance would be a second, weaker answer to a
    // question the trigger has already answered exactly.
    //
    // The conditions therefore only narrow WHICH attendee: a trial lead
    // (`trial_attended` is stamped at check-in, before this fires), at the very
    // start of their journey, who has not joined yet.
    library_key: 'lib_trial_post_session',
    category: 'trial',
    name: 'Trial attended — 1-hour follow-up',
    description:
      'Thanks a trial contact one hour after their first session ends, while it is still fresh.',
    tags: ['trial', 'follow-up', 'conversion', 'first session', 'same day'],
    requires_plan: 'studio',
    template: {
      name: 'How was your first session?',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: 'How was it, {{firstname}}?',
          body: `Hi {{firstname}},

Thanks for training with us today — we hope you enjoyed it.

If anything is still on your mind, just reply to this email: how it felt, what you would like to work on next, or anything that was not clear.

Ready for the next one?

**[Book your next session ↗]({{bookingUrl}})**
**[See our memberships ↗]({{membershipUrl}})**

See you soon,

The {{teamName}} team`,
        },
        de: {
          subject: 'Wie war es, {{firstname}}?',
          body: `Hallo {{firstname}},

danke, dass du heute bei uns trainiert hast — wir hoffen, es hat dir gefallen.

Wenn dir noch etwas im Kopf herumgeht, antworte einfach auf diese E-Mail: wie es sich angefühlt hat, woran du als Nächstes arbeiten möchtest, oder was unklar geblieben ist.

Bereit für das nächste Mal?

**[Nächsten Termin buchen ↗]({{bookingUrl}})**
**[Unsere Abos ansehen ↗]({{membershipUrl}})**

Bis bald,

Das {{teamName}}-Team`,
        },
        fr: {
          subject: 'Alors, {{firstname}} ?',
          body: `Bonjour {{firstname}},

Merci d'être venu vous entraîner avec nous aujourd'hui — nous espérons que cela vous a plu.

Si quelque chose vous trotte encore dans la tête, répondez simplement à cet e-mail : vos impressions, ce que vous aimeriez travailler ensuite, ou ce qui est resté flou.

Prêt pour la prochaine séance ?

**[Réserver votre prochaine séance ↗]({{bookingUrl}})**
**[Voir nos abonnements ↗]({{membershipUrl}})**

À très bientôt,

L'équipe {{teamName}}`,
        },
        it: {
          subject: "Com'è andata, {{firstname}}?",
          body: `Ciao {{firstname}},

Grazie per esserti allenato con noi oggi — speriamo ti sia piaciuto.

Se hai ancora qualche dubbio, rispondi semplicemente a questa email: come ti è sembrato, su cosa vorresti lavorare la prossima volta, o cosa non ti è stato chiaro.

Pronto per la prossima?

**[Prenota la prossima sessione ↗]({{bookingUrl}})**
**[Scopri i nostri abbonamenti ↗]({{membershipUrl}})**

A presto,

Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'session_ended', delayMinutes: 60 },
      conditions: [
        { type: 'acquisition_stage', value: 'trial_attended' },
        { type: 'sessions_attended_max', value: 1 },
        { type: 'subscription', value: 'none' },
      ],
      actions: [{ type: 'send_email', template_key: 'lib_trial_post_session' }],
    },
  },

  {
    library_key: 'sys_rule_trial_day1',
    category: 'trial',
    name: 'Trial attended — day-1 follow-up',
    description: 'Follows up the day after a trial contact completes their first session.',
    tags: ['trial', 'follow-up', 'conversion', 'first session'],
    requires_plan: 'studio',
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'sessions_attended_exactly', value: 1 },
        { type: 'acquisition_stage', value: 'trial_attended' },
        { type: 'subscription', value: 'none' },
      ],
      actions: [{ type: 'send_email', template_key: 'sys_trial_followup' }],
    },
  },

  {
    library_key: 'sys_rule_trial_7d',
    category: 'trial',
    name: 'Trial attended — 7-day nudge',
    description: "Nudges a trial contact who hasn't subscribed 7 days after their first session.",
    tags: ['trial', 'nudge', 'conversion', 'inactivity'],
    requires_plan: 'studio',
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'sessions_attended_exactly', value: 1 },
        { type: 'acquisition_stage', value: 'trial_attended' },
        { type: 'subscription', value: 'none' },
        { type: 'inactivity_days', value: 7 },
      ],
      actions: [{ type: 'send_email', template_key: 'sys_trial_followup' }],
    },
  },

  {
    library_key: 'sys_rule_trial_21d',
    category: 'trial',
    name: 'Trial attended — 21-day final',
    description: 'Final conversion email sent 21 days after a trial with no follow-up booking.',
    tags: ['trial', 'conversion', 'final', 'inactivity'],
    requires_plan: 'studio',
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'sessions_attended_exactly', value: 1 },
        { type: 'acquisition_stage', value: 'trial_attended' },
        { type: 'inactivity_days', value: 21 },
      ],
      actions: [{ type: 'send_email', template_key: 'sys_trial_followup' }],
    },
  },

  // ── RETENTION ─────────────────────────────────────────────────────────────

  {
    library_key: 'sys_rule_winback_30d',
    category: 'retention',
    name: 'Member inactive — 30 days',
    description: 'Win-back email after 30 days of inactivity for regular members.',
    tags: ['member', 'winback', 'inactivity', 'retention'],
    requires_plan: 'studio',
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'sessions_attended_min', value: 2 },
        { type: 'acquisition_stage', value: 'joined' },
        { type: 'inactivity_days', value: 30 },
      ],
      actions: [{ type: 'send_email', template_key: 'sys_winback' }],
    },
  },

  {
    library_key: 'sys_rule_winback_60d',
    category: 'retention',
    name: 'Member inactive — 60 days',
    description: 'Second win-back email for members absent for 60 days.',
    tags: ['member', 'winback', 'inactivity', 'retention'],
    requires_plan: 'studio',
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'sessions_attended_min', value: 2 },
        { type: 'acquisition_stage', value: 'joined' },
        { type: 'inactivity_days', value: 60 },
      ],
      actions: [{ type: 'send_email', template_key: 'sys_winback' }],
    },
  },

  {
    library_key: 'lib_winback_90d',
    category: 'retention',
    name: 'Member inactive — 90 days (last chance)',
    description: 'A final, heartfelt reach-out to members who have been away for 3 months.',
    tags: ['member', 'winback', 'inactivity', 'retention', 'last chance'],
    requires_plan: 'studio',
    template: {
      name: 'One last message from us',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: 'One last message from {{teamName}}, {{firstname}}',
          body: `Hi {{firstname}},

It has been three months since we last saw you at **{{teamName}}**, and we did not want to let more time pass without reaching out.

We genuinely miss having you around. If something got in the way — life, work, anything — we understand completely.

Whenever you are ready, we will be here. No judgment, no catch-up required.

**[Come back ↗]({{bookingUrl}})**

If you have moved on, that is okay too. We just wanted you to know the door is always open.

Warm regards,
The {{teamName}} team`,
        },
        de: {
          subject: 'Eine letzte Nachricht von {{teamName}}, {{firstname}}',
          body: `Hallo {{firstname}},

drei Monate sind vergangen, seit wir dich zuletzt bei **{{teamName}}** gesehen haben, und wir wollten uns noch einmal melden, bevor noch mehr Zeit vergeht.

Wir vermissen dich wirklich. Wenn etwas dazwischengekommen ist — das Leben, die Arbeit, was auch immer — haben wir vollstes Verständnis.

Wann immer du bereit bist, sind wir für dich da. Kein Druck, kein Aufholen nötig.

**[Wieder einsteigen ↗]({{bookingUrl}})**

Wenn du dich anderweitig entschieden hast, ist das auch vollkommen in Ordnung. Wir wollten nur, dass du weisst: die Tür steht immer offen.

Mit herzlichen Grüssen,
Das {{teamName}}-Team`,
        },
        fr: {
          subject: 'Un dernier message de {{teamName}}, {{firstname}}',
          body: `Bonjour {{firstname}},

Cela fait trois mois que nous ne vous avons pas vu·e chez **{{teamName}}**, et nous ne voulions pas laisser passer plus de temps sans prendre de vos nouvelles.

Vous nous manquez sincèrement. Si quelque chose s'est mis en travers du chemin — la vie, le travail, n'importe quoi — nous comprenons tout à fait.

Quand vous serez prêt·e, nous serons là. Sans jugement, sans avoir besoin de rattraper quoi que ce soit.

**[Revenir ↗]({{bookingUrl}})**

Si vous avez tourné la page, c'est tout à fait bien aussi. Nous voulions juste que vous sachiez que la porte est toujours ouverte.

Bien cordialement,
L'équipe {{teamName}}`,
        },
        it: {
          subject: 'Un ultimo messaggio da {{teamName}}, {{firstname}}',
          body: `Ciao {{firstname}},

sono passati tre mesi dall'ultima volta che ti abbiamo visto/a a **{{teamName}}**, e non volevamo lasciare passare altro tempo senza farti sapere che pensiamo a te.

Ci manchi davvero. Se qualcosa ti ha impedito di tornare — la vita, il lavoro, qualsiasi cosa — lo capiamo perfettamente.

Quando sei pronto/a, siamo qui. Senza giudizi, senza pressioni.

**[Torna con noi ↗]({{bookingUrl}})**

Se hai deciso di andare avanti altrove, va benissimo così. Volevamo solo che tu sapesse che la porta è sempre aperta.

Un caro saluto,
Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [
        { type: 'sessions_attended_min', value: 2 },
        { type: 'acquisition_stage', value: 'joined' },
        { type: 'inactivity_days', value: 90 },
      ],
      actions: [{ type: 'send_email', template_key: 'lib_winback_90d' }],
    },
  },

  {
    library_key: 'lib_membership_expired',
    category: 'retention',
    name: 'Membership expired — re-engagement',
    description: 'Fires the moment a contact\'s membership status changes to "expired".',
    tags: ['membership', 'expired', 'renewal', 'retention'],
    requires_plan: 'studio',
    template: {
      name: 'Your membership has expired',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: '{{firstname}}, your membership at {{teamName}} has expired',
          body: `Hi {{firstname}},

Your membership at **{{teamName}}** has expired. We hope you have enjoyed your time with us!

If you would like to continue, renewing is simple:

**[Renew your membership ↗]({{membershipUrl}})**

If you have any questions or would like to talk about your options, just reply to this email — we are happy to help.

We hope to welcome you back soon.

The {{teamName}} team`,
        },
        de: {
          subject: '{{firstname}}, deine Mitgliedschaft bei {{teamName}} ist abgelaufen',
          body: `Hallo {{firstname}},

deine Mitgliedschaft bei **{{teamName}}** ist abgelaufen. Wir hoffen, du hattest eine tolle Zeit bei uns!

Wenn du weitermachen möchtest, ist die Verlängerung ganz einfach:

**[Mitgliedschaft verlängern ↗]({{membershipUrl}})**

Wenn du Fragen hast oder über deine Möglichkeiten sprechen möchtest, antworte einfach auf diese E-Mail — wir helfen dir gerne.

Wir hoffen, dich bald wieder bei uns zu sehen.

Das {{teamName}}-Team`,
        },
        fr: {
          subject: '{{firstname}}, votre adhésion chez {{teamName}} a expiré',
          body: `Bonjour {{firstname}},

Votre adhésion chez **{{teamName}}** a expiré. Nous espérons que vous avez apprécié votre expérience parmi nous !

Si vous souhaitez continuer, le renouvellement est simple :

**[Renouveler votre adhésion ↗]({{membershipUrl}})**

Si vous avez des questions ou souhaitez discuter de vos options, répondez simplement à cet e-mail — nous sommes là pour vous aider.

Nous espérons vous revoir bientôt.

L'équipe {{teamName}}`,
        },
        it: {
          subject: '{{firstname}}, la tua iscrizione a {{teamName}} è scaduta',
          body: `Ciao {{firstname}},

La tua iscrizione a **{{teamName}}** è scaduta. Speriamo tu abbia apprezzato il tuo percorso con noi!

Se vuoi continuare, il rinnovo è semplicissimo:

**[Rinnova la tua iscrizione ↗]({{membershipUrl}})**

Se hai domande o vuoi parlare delle tue opzioni, rispondi a questa email — siamo felici di aiutarti.

Speriamo di rivederti presto.

Il team {{teamName}}`,
        },
      },
    },
    rule: {
      // NOTE: precise "affiliation expired" detection needs the deferred
      // affiliation_status / affiliation_expires_in conditions. Until then this
      // fires on any affiliation change for an affiliated contact.
      trigger: { type: 'affiliation_changed' },
      conditions: [{ type: 'has_affiliation' }],
      actions: [{ type: 'send_email', template_key: 'lib_membership_expired' }],
    },
  },

  // ── MILESTONES ─────────────────────────────────────────────────────────────

  {
    library_key: 'lib_milestone_1st',
    category: 'milestones',
    name: '1st session — a great start',
    description: "Celebrates a contact's first completed session and invites them to join.",
    tags: ['milestone', 'first session', 'welcome', 'conversion'],
    requires_plan: 'studio',
    template: {
      name: 'First session — done!',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: 'Your first session at {{teamName}} — well done, {{firstname}}!',
          body: `Hi {{firstname}},

You showed up, and that is the hardest part. Welcome to **{{teamName}}**!

We hope your first session was a great experience. Every journey starts with one session, and you have just taken yours.

If you would like to keep training with us, joining is easy:

**[Become a member ↗]({{membershipUrl}})**

And if you enjoyed your time, we would love a quick review — it means a lot to a small team like ours:

**[Leave a review ↗]({{reviewUrl}})**

See you next time!

The {{teamName}} team`,
        },
        de: {
          subject: 'Deine erste Session bei {{teamName}} — gut gemacht, {{firstname}}!',
          body: `Hallo {{firstname}},

du bist erschienen — das ist das Schwierigste. Willkommen bei **{{teamName}}**!

Wir hoffen, deine erste Session war ein tolles Erlebnis. Jede Reise beginnt mit einer Session, und du hast gerade deine erste absolviert.

Wenn du weiter mit uns trainieren möchtest, ist der Beitritt ganz einfach:

**[Mitglied werden ↗]({{membershipUrl}})**

Und wenn dir die Zeit bei uns gefallen hat, würden wir uns über eine kurze Bewertung freuen:

**[Bewertung hinterlassen ↗]({{reviewUrl}})**

Bis zum nächsten Mal!

Das {{teamName}}-Team`,
        },
        fr: {
          subject: 'Votre première séance chez {{teamName}} — bravo, {{firstname}} !',
          body: `Bonjour {{firstname}},

Vous êtes venu·e, et c'est la partie la plus difficile. Bienvenue chez **{{teamName}}** !

Nous espérons que votre première séance a été une belle expérience. Chaque aventure commence par une séance, et vous venez d'accomplir la vôtre.

Si vous souhaitez continuer à vous entraîner avec nous, rejoindre le club est simple :

**[Devenir membre ↗]({{membershipUrl}})**

Et si vous avez apprécié votre expérience, un avis rapide nous aiderait beaucoup :

**[Laisser un avis ↗]({{reviewUrl}})**

À bientôt !

L'équipe {{teamName}}`,
        },
        it: {
          subject: 'La tua prima sessione a {{teamName}} — complimenti, {{firstname}}!',
          body: `Ciao {{firstname}},

Sei venuto/a — ed è la parte più difficile. Benvenuto/a a **{{teamName}}**!

Speriamo che la tua prima sessione sia stata un'esperienza meravigliosa. Ogni viaggio inizia con una sessione, e tu hai appena completato la tua.

Se vuoi continuare ad allenarti con noi, diventare membro è semplice:

**[Diventa membro ↗]({{membershipUrl}})**

E se hai apprezzato la tua esperienza, una breve recensione per noi vale moltissimo:

**[Lascia una recensione ↗]({{reviewUrl}})**

A presto!

Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [{ type: 'sessions_attended_exactly', value: 1 }],
      actions: [{ type: 'send_email', template_key: 'lib_milestone_1st' }],
    },
  },

  {
    library_key: 'lib_milestone_5',
    category: 'milestones',
    name: '5 sessions — finding your rhythm',
    description: 'Sends a congratulatory email after a contact completes 5 sessions.',
    tags: ['milestone', '5 sessions', 'congratulations'],
    requires_plan: 'studio',
    template: {
      name: '5 sessions — finding your rhythm!',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: "5 sessions at {{teamName}}, {{firstname}} — you're finding your rhythm!",
          body: `Hi {{firstname}},

Five sessions in — you are officially finding your rhythm at **{{teamName}}** and we are glad to have you with us!

Consistency is everything, and you are already building it. Keep it up!

If you have a spare moment, sharing your experience helps others find a place like ours:

**[Leave a review ↗]({{reviewUrl}})**

See you soon,
The {{teamName}} team`,
        },
        de: {
          subject: '5 Sessions bei {{teamName}}, {{firstname}} — du findest deinen Rhythmus!',
          body: `Hallo {{firstname}},

Fünf Sessions absolviert — du findest deinen Rhythmus bei **{{teamName}}** und wir freuen uns sehr, dich dabei zu haben!

Regelmässigkeit ist alles, und du baust sie bereits auf. Weiter so!

Wenn du einen Moment Zeit hast, hilft deine Erfahrung anderen dabei, einen Platz wie unseren zu finden:

**[Bewertung hinterlassen ↗]({{reviewUrl}})**

Bis bald,
Das {{teamName}}-Team`,
        },
        fr: {
          subject: '5 séances chez {{teamName}}, {{firstname}} — vous trouvez votre rythme !',
          body: `Bonjour {{firstname}},

Cinq séances au compteur — vous trouvez votre rythme chez **{{teamName}}** et nous sommes ravis de vous avoir parmi nous !

La régularité est la clé de la progression, et vous êtes déjà en train de la construire. Continuez comme ça !

Si vous avez un moment, votre avis aide d'autres personnes à nous trouver :

**[Laisser un avis ↗]({{reviewUrl}})**

À bientôt,
L'équipe {{teamName}}`,
        },
        it: {
          subject: '5 sessioni a {{teamName}}, {{firstname}} — stai trovando il tuo ritmo!',
          body: `Ciao {{firstname}},

Cinque sessioni completate — stai trovando il tuo ritmo a **{{teamName}}** e siamo molto felici di averti con noi!

La costanza è tutto, e tu la stai già costruendo. Continua così!

Se hai un momento, condividere la tua esperienza aiuta altri a trovare un posto come il nostro:

**[Lascia una recensione ↗]({{reviewUrl}})**

A presto,
Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [{ type: 'sessions_attended_exactly', value: 5 }],
      actions: [{ type: 'send_email', template_key: 'lib_milestone_5' }],
    },
  },

  {
    library_key: 'sys_rule_milestone_10',
    category: 'milestones',
    name: '10 sessions — thank you!',
    description: 'Celebrates 10 completed sessions and requests a review.',
    tags: ['milestone', '10 sessions', 'thank you', 'review'],
    requires_plan: 'studio',
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [{ type: 'sessions_attended_exactly', value: 10 }],
      actions: [{ type: 'send_email', template_key: 'sys_milestone_10' }],
    },
  },

  {
    library_key: 'lib_milestone_25',
    category: 'milestones',
    name: '25 sessions — committed!',
    description: 'Recognizes the dedication of reaching 25 sessions.',
    tags: ['milestone', '25 sessions', 'committed', 'congratulations'],
    requires_plan: 'studio',
    template: {
      name: "25 sessions — you're committed!",
      body_mode: 'markdown',
      translations: {
        en: {
          subject: '25 sessions, {{firstname}} — thank you for your commitment!',
          body: `Hi {{firstname}},

**25 sessions** at **{{teamName}}** — that is no accident. It takes real commitment to show up consistently, and you have it.

You are an important part of what makes our community special. Thank you for being here.

If you have not shared your experience yet, this is a great moment — your story could inspire someone who is still on the fence:

**[Share your journey ↗]({{reviewUrl}})**

Keep going — you are doing great.

The {{teamName}} team`,
        },
        de: {
          subject: '25 Sessions, {{firstname}} — danke für dein Engagement!',
          body: `Hallo {{firstname}},

**25 Sessions** bei **{{teamName}}** — das passiert nicht zufällig. Es braucht echte Disziplin, um regelmässig zu erscheinen, und du hast sie.

Du bist ein wichtiger Teil von dem, was unsere Gemeinschaft besonders macht. Danke, dass du dabei bist.

Falls du deine Erfahrung noch nicht geteilt hast, ist jetzt ein guter Moment — deine Geschichte könnte jemanden inspirieren, der noch zögert:

**[Teile deinen Weg ↗]({{reviewUrl}})**

Weiter so — du machst das grossartig.

Das {{teamName}}-Team`,
        },
        fr: {
          subject: '25 séances, {{firstname}} — merci pour votre engagement !',
          body: `Bonjour {{firstname}},

**25 séances** chez **{{teamName}}** — ce n'est pas un hasard. Il faut un vrai engagement pour se présenter régulièrement, et vous l'avez.

Vous faites partie intégrante de ce qui rend notre communauté spéciale. Merci d'être là.

Si vous n'avez pas encore partagé votre expérience, c'est le bon moment — votre témoignage pourrait inspirer quelqu'un qui hésite encore :

**[Partagez votre parcours ↗]({{reviewUrl}})**

Continuez — vous faites du très bon travail.

L'équipe {{teamName}}`,
        },
        it: {
          subject: '25 sessioni, {{firstname}} — grazie per il tuo impegno!',
          body: `Ciao {{firstname}},

**25 sessioni** a **{{teamName}}** — non è un caso. Ci vuole vera dedizione per presentarsi con costanza, e tu ce l'hai.

Sei una parte importante di ciò che rende speciale la nostra comunità. Grazie per essere qui.

Se non hai ancora condiviso la tua esperienza, questo è il momento giusto — la tua storia potrebbe ispirare qualcuno che è ancora indeciso:

**[Condividi il tuo percorso ↗]({{reviewUrl}})**

Continua così — stai facendo un lavoro straordinario.

Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [{ type: 'sessions_attended_exactly', value: 25 }],
      actions: [{ type: 'send_email', template_key: 'lib_milestone_25' }],
    },
  },

  {
    library_key: 'lib_milestone_50',
    category: 'milestones',
    name: '50 sessions — a milestone worth celebrating',
    description: 'A celebration for contacts who reach 50 sessions.',
    tags: ['milestone', '50 sessions', 'congratulations'],
    requires_plan: 'studio',
    template: {
      name: '50 sessions — congratulations!',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: '50 sessions at {{teamName}} — congratulations, {{firstname}}!',
          body: `Hi {{firstname}},

**50 sessions** at **{{teamName}}** — a milestone few reach.

You have shown up fifty times and become a real part of our community. That is something to be genuinely proud of.

Thank you for the energy you bring every time — it makes a difference for everyone around you.

If you would like to mark the occasion with a quick review, we would be honored:

**[Share your story ↗]({{reviewUrl}})**

Here is to the next fifty!

The {{teamName}} team`,
        },
        de: {
          subject: '50 Sessions bei {{teamName}} — herzlichen Glückwunsch, {{firstname}}!',
          body: `Hallo {{firstname}},

**50 Sessions** bei **{{teamName}}** — ein Meilenstein, den nur wenige erreichen.

Du bist fünfzigmal erschienen und ein fester Teil unserer Community geworden. Darauf kannst du wirklich stolz sein.

Danke für die Energie, die du jedes Mal mitbringst — sie macht einen Unterschied für alle um dich herum.

Wenn du diesen Meilenstein mit einer kurzen Bewertung feiern möchtest, würden wir uns sehr freuen:

**[Teile deine Geschichte ↗]({{reviewUrl}})**

Auf die nächsten fünfzig!

Das {{teamName}}-Team`,
        },
        fr: {
          subject: '50 séances chez {{teamName}} — félicitations, {{firstname}} !',
          body: `Bonjour {{firstname}},

**50 séances** chez **{{teamName}}** — un jalon que peu de personnes atteignent.

Vous êtes venu·e cinquante fois et vous faites désormais pleinement partie de notre communauté. Vous pouvez en être véritablement fier·fière.

Merci pour l'énergie que vous apportez à chaque fois — elle fait la différence pour tout le monde autour de vous.

Si vous souhaitez marquer l'occasion avec un avis rapide, nous en serions honorés :

**[Partagez votre histoire ↗]({{reviewUrl}})**

À la prochaine cinquantaine !

L'équipe {{teamName}}`,
        },
        it: {
          subject: '50 sessioni a {{teamName}} — congratulazioni, {{firstname}}!',
          body: `Ciao {{firstname}},

**50 sessioni** a **{{teamName}}** — un traguardo che pochi raggiungono.

Ti sei presentato/a cinquanta volte e sei diventato/a una parte importante della nostra comunità. È qualcosa di cui essere davvero orgoglioso/a.

Grazie per l'energia che porti ogni volta — fa la differenza per tutti intorno a te.

Se vuoi celebrare questo traguardo con una breve recensione, ne saremmo onorati:

**[Condividi la tua storia ↗]({{reviewUrl}})**

Ai prossimi cinquanta!

Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'schedule_daily' },
      conditions: [{ type: 'sessions_attended_exactly', value: 50 }],
      actions: [{ type: 'send_email', template_key: 'lib_milestone_50' }],
    },
  },

  // ── APPOINTMENT ───────────────────────────────────────────────────────────

  {
    library_key: 'lib_session_feedback',
    category: 'appointment',
    name: 'Post-session feedback request',
    description: 'Sends a feedback request to participants 60 minutes after a session ends.',
    tags: ['feedback', 'review', 'session', 'appointment'],
    requires_plan: 'studio',
    template: {
      name: 'How was your session?',
      body_mode: 'markdown',
      translations: {
        en: {
          subject: 'How was your session at {{teamName}}, {{firstname}}?',
          body: `Hi {{firstname}},

Thanks for joining us today at **{{teamName}}**! We hope you had a great session.

Your feedback helps us keep improving. If you have a minute, we would love to hear how it went:

**[Share your experience ↗]({{reviewUrl}})**

See you next time!

The {{teamName}} team`,
        },
        de: {
          subject: 'Wie war deine Session bei {{teamName}}, {{firstname}}?',
          body: `Hallo {{firstname}},

danke, dass du heute bei **{{teamName}}** dabei warst! Wir hoffen, die Session hat dir Spass gemacht.

Dein Feedback hilft uns, uns stetig zu verbessern. Wenn du einen Moment Zeit hast, würden wir uns sehr über deine Rückmeldung freuen:

**[Teile deine Erfahrung ↗]({{reviewUrl}})**

Bis zum nächsten Mal!

Das {{teamName}}-Team`,
        },
        fr: {
          subject: "Comment s'est passée votre séance chez {{teamName}}, {{firstname}} ?",
          body: `Bonjour {{firstname}},

Merci d'avoir participé à votre séance aujourd'hui chez **{{teamName}}** ! Nous espérons qu'elle s'est bien passée.

Votre avis nous aide à nous améliorer en permanence. Si vous avez une minute, nous serions ravis de connaître votre ressenti :

**[Partagez votre expérience ↗]({{reviewUrl}})**

À bientôt !

L'équipe {{teamName}}`,
        },
        it: {
          subject: 'Come è andata la tua sessione a {{teamName}}, {{firstname}}?',
          body: `Ciao {{firstname}},

Grazie per aver partecipato oggi a **{{teamName}}**! Speriamo che la sessione sia stata ottima.

Il tuo feedback ci aiuta a migliorare continuamente. Se hai un minuto, ci farebbe molto piacere sapere come è andata:

**[Condividi la tua esperienza ↗]({{reviewUrl}})**

A presto!

Il team {{teamName}}`,
        },
      },
    },
    rule: {
      trigger: { type: 'session_ended', delayMinutes: 60 },
      conditions: [],
      actions: [{ type: 'send_email', template_key: 'lib_session_feedback' }],
    },
  },

  // ── ADMIN / INTERNAL ──────────────────────────────────────────────────────

  {
    library_key: 'lib_notify_new_trial',
    category: 'admin',
    name: 'Notify team: new trial registered',
    description: 'Sends an internal alert to the team email when a new trial contact is created.',
    tags: ['admin', 'trial', 'internal', 'notification'],
    requires_plan: 'studio',
    // No email template — uses notify_team action (sends to team email address)
    rule: {
      trigger: { type: 'contact_created' },
      conditions: [{ type: 'acquisition_stage', value: 'trial_booked' }],
      actions: [
        {
          type: 'notify_team',
          subject: 'New trial registration: {{firstname}} {{lastname}}',
          body: `A new trial contact has registered at **{{teamName}}**.

**Name:** {{firstname}} {{lastname}}

Check the contact in your Linyup dashboard to follow up.`,
        },
      ],
    },
  },
]

// ---------------------------------------------------------------------------
// Starter bundle — subset of library items to install in one click.
// The `sys_rule_*` keys are the old SYSTEM_RULES, kept verbatim for backward
// compat; membership is not restricted to that prefix (see lib_member_welcome).
// Every item lands `active: false` — the bundle installs through the same
// `installItems` writer as the library dialog, and nothing in it is an
// exception. Nothing here counts itself either: the button's label reads
// `starterBundleItemsForPlan(plan).length`, so this list is the only place a
// bundle change is made.
// ---------------------------------------------------------------------------

export const STARTER_BUNDLE_KEYS: string[] = [
  'sys_rule_noshow_1d',
  'sys_rule_noshow_5d',
  'sys_rule_trial_day1',
  'sys_rule_trial_7d',
  'sys_rule_trial_21d',
  'sys_rule_winback_30d',
  'sys_rule_winback_60d',
  'sys_rule_milestone_10',
  // The welcome at the moment of joining. In the bundle because the day-one
  // studio's first automated mail should be the one that greets a new member,
  // not only the ones that chase a lapsed one. It fires on
  // `acquisition_stage_changed` — the trigger that also fires when a trial lead
  // completes the signup form — so it reaches the population it is written for
  // rather than only contacts created already-joined. `requires_plan: 'studio'`
  // still applies: `starterBundleItemsForPlan` filters it out below Studio, and
  // the button's count follows.
  'lib_member_welcome',
]

// ---------------------------------------------------------------------------
// Plan gating
// ---------------------------------------------------------------------------

/** Whether `plan` may install `item`. THE ONE READER of `requires_plan` —
 *  the dialog locks on it, the select-all skips it, the install filters on it
 *  and the starter bundle filters on it, so a new call site cannot quietly
 *  reintroduce the unenforced-gate bug.
 *
 *  Fails CLOSED on an unknown plan: `usePlan()` reports null while the team
 *  doc loads, and treating that as "allowed" would open the gate for exactly
 *  as long as it takes to click. */
export function libraryItemUnlocked(item: LibraryItem, plan: SaasPlan | null): boolean {
  return plan != null && planIsAtLeast(plan, item.requires_plan)
}

/** The starter-bundle items this plan may actually install. The empty state
 *  counts them: offering "Quick-start (8 rules)" to a team that can install
 *  none of them is a button that does nothing. */
export function starterBundleItemsForPlan(plan: SaasPlan | null): LibraryItem[] {
  return AUTOMATION_LIBRARY.filter(
    (i) => STARTER_BUNDLE_KEYS.includes(i.library_key) && libraryItemUnlocked(i, plan)
  )
}
