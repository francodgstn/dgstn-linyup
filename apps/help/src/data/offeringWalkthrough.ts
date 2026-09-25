// THE OFFERING WALKTHROUGH: the questions a studio owner answers to set up
// something new to sell, and the exact setup each answer leads to.
//
// Written from the owner's side of the desk. They know what they want to run
// ("a Tuesday yoga class members get included, newcomers can try once"), not
// our model (activities, access rules, benefits), so every question is asked
// in their words and every answer turns into a step in OURS: the screen, the
// field and the value, spelled as the app spells them.
//
// It doubles as the analysis for an in-app setup wizard: the questions are
// the wizard's steps, and `steps` is what the wizard would write. Keep it true
// to the app's forms; a step naming a field that does not exist is worse than
// no step. Checked against apps/web/messages/en.json (Activities,
// OfferCatalogue, CourseBlocks, TeamSettings.subType*) on 2026-09-25.
//
// Shape: a question has options; an option may add setup `steps`, add a
// `note` (a consequence worth knowing, e.g. a class nobody new can book), and
// point at the `next` question. An option without `next` ends the walk, and
// the page adds FINAL_STEPS to every finished setup.

export interface WalkOption {
  label: string
  hint?: string
  next?: string
  /** Setup steps this answer adds. `**x**` renders bold: use it for UI names. */
  steps?: string[]
  /** Something to know about this choice. */
  note?: string
}

export interface WalkQuestion {
  id: string
  ask: string
  help?: string
  options: WalkOption[]
}

export const WALK_START = 'what'

export const FINAL_STEPS: string[] = [
  'Check it before anyone books: open **Manage → Pricing**, pick **Guest**, then each of your plans, and read what each would pay. Fix anything listed under **Things to fix**.',
]

export const QUESTIONS: WalkQuestion[] = [
  {
    id: 'what',
    ask: 'What do you want to offer?',
    help: 'Pick the closest. You can walk through again for the next thing.',
    options: [
      {
        label: 'A class people join at a set time',
        hint: 'Yoga on Tuesdays, kids judo, an open gym',
        next: 'class-who',
        steps: [
          'In **Manage → Offerings**, choose **New activity**, give it a name, and set **Offer as** to **Class**. The settings below are in its **Access & pricing** section, unless a step says otherwise.',
        ],
      },
      {
        label: 'Time with me or a coach, one person at a time',
        hint: 'Personal training, a consultation, an intro call',
        next: 'appt-price',
        steps: [
          'In **Manage → Offerings**, choose **New activity**, give it a name, and set **Offer as** to **Appointment**. Pick the **Session lengths** clients can choose from, such as 30 and 60 minutes. The prices are in its **Access & pricing** section.',
        ],
      },
      {
        label: 'A set of dates sold together',
        hint: 'A 13-week term, a weekend workshop, a beginners course',
        next: 'course-when',
        steps: ['In **Manage → Offerings**, choose **New course** and give it a name.'],
      },
      {
        label: 'A membership or a pack of classes',
        hint: 'Monthly unlimited, a 10-class card, a free pass for your coaches',
        next: 'plan-kind',
      },
      {
        label: 'Something to watch in their own time',
        hint: 'Recorded lessons, a video programme',
        steps: [
          'Install the **Online courses** plugin, then add the course in **Manage → Online courses**.',
          'Choose who can open it: **Free** for anyone, **Sign-in required**, **Subscription** (included in the plans you pick), or **Sold** at a price you set.',
        ],
        note: 'Videos are embedded from YouTube or Vimeo, not uploaded.',
      },
      {
        label: 'A product',
        hint: 'A T-shirt, a drink, equipment',
        steps: ['Install the **Products** plugin, then add it in **Manage → Products** with its price and any variants, such as sizes.'],
        note: 'A product has one price for everyone: plans don\'t include or discount it.',
      },
      {
        label: 'A camp or an event with a programme',
        hint: 'A summer camp, a seminar, a grading',
        steps: ['Create it under **Events**. An event takes registrations and can carry a programme over several days.'],
        note: 'Events are not paid for online: the fee is shown to people, and you collect it yourself.',
      },
    ],
  },

  // ── A class ───────────────────────────────────────────────────────────────
  {
    id: 'class-who',
    ask: 'Who should be able to book it?',
    options: [
      { label: 'Anyone, including people I\'ve never met', next: 'class-pay' },
      {
        label: 'Only people who have signed up with me',
        hint: 'Your existing members and contacts',
        next: 'class-pay',
        steps: [
          'Under **More options**, switch on **Only people who signed up with you**. Visitors can\'t book it, even paying; newcomers can still take a trial if you allow one.',
        ],
      },
    ],
  },
  {
    id: 'class-pay',
    ask: 'How do people pay for it?',
    options: [
      {
        label: 'It\'s included in a membership or pack',
        hint: 'Nobody pays per class',
        next: 'class-newcomers',
        steps: [
          'In **Manage → Offerings**, open each plan that includes it and switch **Can book** on for this class. No plan yet? Walk through "A membership or a pack of classes" first.',
          'Set **Offer drop-in / single class** to **No drop-in for this class**.',
        ],
      },
      {
        label: 'Per class',
        hint: 'A drop-in price, no plan needed',
        next: 'class-rate',
        steps: [
          'Set **Offer drop-in / single class** to **Your usual price** (set once on **Manage → Pricing**) or **Own price for this class**.',
        ],
      },
      {
        label: 'Both: members come included, everyone else pays per class',
        next: 'class-rate',
        steps: [
          'In **Manage → Offerings**, open each plan that includes it and switch **Can book** on for this class.',
          'Set **Offer drop-in / single class** to **Your usual price** or **Own price for this class**: that is what everyone without one of those plans pays.',
        ],
      },
      {
        label: 'It\'s free',
        next: 'class-places',
        steps: ['Set **Offer drop-in / single class** to **No drop-in for this class**, and include it in no plan.'],
        note: 'Free with no plan attached means anyone can book it at no cost, like a community run.',
      },
    ],
  },
  {
    id: 'class-rate',
    ask: 'Should some members pay less than the full drop-in?',
    help: 'For plans that don\'t include this class, such as a plan for another discipline.',
    options: [
      {
        label: 'Yes',
        next: 'class-newcomers',
        steps: [
          'In **Manage → Offerings**, open the class and switch **Member rate** on for those plans: a percentage off or a fixed member price.',
        ],
      },
      { label: 'No, the same price for everyone', next: 'class-newcomers' },
    ],
  },
  {
    id: 'class-newcomers',
    ask: 'Can a newcomer try it before committing?',
    options: [
      {
        label: 'Yes, the first class is free',
        next: 'class-places',
        steps: ['Switch on **Trial class for newcomers** and leave **Trial price** empty. Each person gets one trial, ever.'],
      },
      {
        label: 'Yes, at a reduced price',
        next: 'class-places',
        steps: ['Switch on **Trial class for newcomers** and set a **Trial price**, such as 15. Each person gets one trial, ever.'],
      },
      {
        label: 'No',
        next: 'class-places',
        note: 'If the class is only included in plans and has no drop-in, someone without a plan can see it but not book it. That is fine for a members-only class, and a dead end for one you want new people in.',
      },
    ],
  },
  {
    id: 'class-places',
    ask: 'Is there a limit on places?',
    options: [
      {
        label: 'Yes',
        next: 'class-when',
        steps: ['When you put it on the calendar, set **Max participants**.'],
        note: 'A full class can offer a **Waitlist** (experimental): the first in line is offered the seat when one frees up.',
      },
      { label: 'No limit', next: 'class-when' },
    ],
  },
  {
    id: 'class-when',
    ask: 'When does it run?',
    options: [
      {
        label: 'Every week at the same time',
        steps: [
          'In **Schedule**, choose **New → New class**, pick this activity, and switch on **Repeat this session** with the days it runs. Keep **Allow online booking** on.',
        ],
      },
      {
        label: 'Once, or on a few dates',
        steps: ['In **Schedule**, choose **New → New class** for each date and pick this activity. Keep **Allow online booking** on.'],
      },
    ],
  },

  // ── An appointment ────────────────────────────────────────────────────────
  {
    id: 'appt-price',
    ask: 'Do clients pay for it?',
    help: 'Appointments have no "who can book" setting: the price decides who can book.',
    options: [
      {
        label: 'Yes, a price for each length',
        next: 'appt-members',
        steps: ['Under **Access & pricing**, set each length to **Priced** and enter its price.'],
      },
      {
        label: 'Some lengths are free',
        hint: 'A free 15-minute intro next to a paid hour',
        next: 'appt-members',
        steps: ['Set the free length to **Free** and the others to **Priced**, each with its price.'],
      },
      {
        label: 'No, it\'s free',
        next: 'appt-when',
        steps: ['Set every length to **Free**.'],
        note: 'A free appointment can be booked by anyone, guests included.',
      },
      {
        label: 'Only members can book it',
        next: 'appt-members',
        steps: ['Set the lengths to **Only with a plan**. They are not sold on their own.'],
        note: 'With **Only with a plan**, you must pick at least one plan in the next step, or nobody can book it.',
      },
    ],
  },
  {
    id: 'appt-members',
    ask: 'Do members get a better deal?',
    options: [
      {
        label: 'It\'s included in their plan',
        next: 'appt-when',
        steps: [
          'In **Manage → Offerings**, open the appointment, pick the plans, and choose **Included**. If a plan is a class pack, each booking uses one of its credits.',
        ],
      },
      {
        label: 'They pay less',
        next: 'appt-when',
        steps: ['In **Manage → Offerings**, open the appointment, pick the plans, and choose a percentage off or a fixed member price.'],
      },
      { label: 'No, the same price for everyone', next: 'appt-when' },
    ],
  },
  {
    id: 'appt-when',
    ask: 'When can people book it?',
    options: [
      {
        label: 'When I or my coaches are available',
        steps: [
          'Open **Schedule → Availability** and add the times each coach can be booked, choosing which appointments each window offers. Nothing goes on the calendar until someone books.',
        ],
      },
    ],
  },

  // ── A course ──────────────────────────────────────────────────────────────
  {
    id: 'course-when',
    ask: 'How does it run?',
    options: [
      {
        label: 'Every week between two dates',
        hint: 'Wednesdays from August to November',
        next: 'course-places',
        steps: ['Under **When it runs**, choose **Every week** and set the **First lesson** and **Last lesson**.'],
      },
      {
        label: 'On particular dates, each with its own time',
        hint: 'A Saturday and a Sunday',
        next: 'course-places',
        steps: ['Under **When it runs**, choose **Set dates** and add each date with its time and length.'],
      },
    ],
  },
  {
    id: 'course-places',
    ask: 'Is the number of places limited?',
    options: [
      {
        label: 'Yes',
        next: 'course-price',
        steps: ['Set **Places**. They count for the whole course: a missed lesson doesn\'t free one.'],
        note: 'When it\'s full, people can ask to be told if a place comes free.',
      },
      { label: 'No limit', next: 'course-price' },
    ],
  },
  {
    id: 'course-price',
    ask: 'What does it cost?',
    options: [
      {
        label: 'One price for the whole course',
        next: 'course-members',
        steps: ['Set the **Price** for the whole course. People pay once and have a place in every lesson.'],
      },
      {
        label: 'It\'s free',
        next: 'course-who',
        steps: ['Leave **Price** empty.'],
        note: 'A free course can\'t be linked to plans: there is nothing to include or discount.',
      },
    ],
  },
  {
    id: 'course-members',
    ask: 'Do members get it included or cheaper?',
    options: [
      {
        label: 'Included in their plan',
        next: 'course-who',
        steps: ['In **Manage → Offerings → Courses**, open the course and pick the plans that include it.'],
      },
      {
        label: 'Cheaper',
        next: 'course-who',
        steps: ['In **Manage → Offerings → Courses**, open the course and give those plans a member rate.'],
      },
      { label: 'No', next: 'course-who' },
    ],
  },
  {
    id: 'course-who',
    ask: 'Who can enrol?',
    options: [
      { label: 'Anyone', next: 'course-close' },
      {
        label: 'Only people who have signed up with me',
        next: 'course-close',
        steps: ['Switch on **Only people who signed up with you**.'],
      },
    ],
  },
  {
    id: 'course-close',
    ask: 'When should bookings close?',
    options: [
      {
        label: 'A few days before the first lesson',
        steps: ['Set **Stop taking bookings** to the number of days before the first lesson.', '**Publish** the course when it\'s ready. It appears in your shop\'s Courses tab.'],
      },
      {
        label: 'Keep them open until it starts',
        steps: ['Leave **Stop taking bookings** empty.', '**Publish** the course when it\'s ready. It appears in your shop\'s Courses tab.'],
      },
    ],
  },

  // ── A membership or a pack ────────────────────────────────────────────────
  {
    id: 'plan-kind',
    ask: 'How do people pay for it?',
    help: 'In **Manage → Offerings**, choose **New plan**, or **Start from a template** for the common shapes.',
    options: [
      {
        label: 'Every month or year, until they cancel',
        hint: 'A membership',
        next: 'plan-limit',
        steps: ['Choose **New plan** (or the **Membership** template) and add a recurring price, monthly or yearly. You can add both.'],
      },
      {
        label: 'Once, for a number of classes',
        hint: 'A 10-class card',
        next: 'plan-includes',
        steps: [
          'Choose **New plan** (or the **10-class pack** template) and add a one-time price with the number of **Classes** and how many months they stay valid. Each booking uses one credit; a cancelled booking gives it back.',
        ],
      },
      {
        label: 'Nothing, it\'s free',
        hint: 'For your coaches, family, guests',
        next: 'plan-includes',
        steps: ['Use the **Complimentary** template: no charge, and you assign it to people yourself.'],
      },
      {
        label: 'A partner app pays me per visit',
        hint: 'FitPass, Urban Sports Club and similar',
        next: 'plan-includes',
        steps: [
          'Choose **New plan**, set **Who charges the member** to **A partner app**, and enter what the partner pays you per visit. Assign it to the partner\'s members.',
        ],
      },
    ],
  },
  {
    id: 'plan-limit',
    ask: 'Should it limit how often they come?',
    options: [
      {
        label: 'Yes',
        hint: 'Two classes a week',
        next: 'plan-intro',
        steps: ['Set **Class limit**, per day, week or month. After the limit, members pay the drop-in price.'],
      },
      { label: 'No, unlimited', next: 'plan-intro' },
    ],
  },
  {
    id: 'plan-intro',
    ask: 'Do you want an introductory offer?',
    options: [
      {
        label: 'Yes, a lower price at the start',
        next: 'plan-includes',
        steps: ['Add an intro price to the recurring price: how much, and for how many periods. 0 makes the first periods free.'],
      },
      { label: 'No', next: 'plan-includes' },
    ],
  },
  {
    id: 'plan-includes',
    ask: 'What does it include?',
    options: [
      {
        label: 'Some or all of my classes',
        next: 'plan-sell',
        steps: ['In **Manage → Offerings**, open the plan and switch **Can book** on for each class it includes.'],
      },
      {
        label: 'Appointments or courses too',
        next: 'plan-sell',
        steps: [
          'Switch **Can book** on for the classes, then open each appointment or course in **Manage → Offerings** and pick this plan as **Included**, or give it a member price.',
        ],
      },
    ],
  },
  {
    id: 'plan-sell',
    ask: 'How do people get it?',
    options: [
      {
        label: 'They buy it online',
        steps: [
          'Switch on **Show on public pricing page** so it appears in your shop and on your pricing table.',
          'Online payments need your Stripe account connected: see [Payments](/studio/payments/).',
        ],
      },
      {
        label: 'I give it to them myself',
        steps: ['Leave it off the public pricing page, and assign it on the person\'s **Plans & Payments** tab.'],
      },
    ],
  },
]
