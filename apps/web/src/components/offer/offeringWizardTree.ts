// ─── The setup guide's questions, as structure ──────────────────────────────
//
// "Set up with a guide" (OfferingWizardDialog) asks the questions of the help
// centre's offering walkthrough (apps/help/src/data/offeringWalkthrough.ts).
// The two share STRUCTURE and never words: each surface writes its own copy
// (the help page explains in English, the app acts in four languages), and the
// same question id with the same option ids, in the same order, means the
// same thing on both.
//
// This is the app's side. The dialog renders every choice question from it
// (`Choices`), with a label for every option the type demands, so an option
// added here cannot go unrendered, and one removed cannot stay rendered.
// packages/functions/src/offer/wizardDrift.test.ts compares it with the help
// tree and fails when they disagree.
//
// NOTHING IS IMPORTED: the drift test loads this file on its own.

export const WIZARD_TREE = {
  what: ['class', 'appointment', 'course', 'plan', 'online', 'product', 'event'],
  'class-who': ['anyone', 'signed_up'],
  'class-pay': ['included', 'per_class', 'both', 'free'],
  'class-rate': ['yes', 'no'],
  'class-newcomers': ['free', 'priced', 'no'],
  'appt-price': ['priced', 'some_free', 'free', 'plan_only'],
  'appt-members': ['included', 'less', 'no'],
  'course-when': ['weekly', 'dates'],
  'course-places': ['yes', 'no'],
  'course-price': ['priced', 'free'],
  'course-members': ['included', 'cheaper', 'no'],
  'course-who': ['anyone', 'signed_up'],
  'course-close': ['days', 'open'],
  'plan-kind': ['membership', 'pack', 'complimentary', 'partner'],
  'plan-limit': ['limited', 'unlimited'],
  'plan-intro': ['yes', 'no'],
  'plan-sell': ['online', 'assign'],
} as const

export type WizardQuestion = keyof typeof WIZARD_TREE
export type WizardOption<Q extends WizardQuestion> = (typeof WIZARD_TREE)[Q][number]

/**
 * The help page's questions the guide does not ask as a choice, and why. Each
 * is deliberate; the drift test refuses an entry that names no help question,
 * so this cannot quietly outlive the question it excuses.
 */
export const HELP_ONLY_QUESTIONS: Record<string, string> = {
  'class-places':
    'Places are set per session when the class goes on the calendar; the done screen links there.',
  'class-when': 'Putting the class on the calendar; the done screen links to it.',
  'appt-when': 'Availability; the done screen links to it.',
  'plan-includes':
    'Asked as a picker of the studio’s own classes, since the guide can link them; appointments and courses link from their own questions.',
}
