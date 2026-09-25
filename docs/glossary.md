---
title: Glossary
description: The words the code and these docs use, and which ones they deliberately avoid.
status: living
area: start
order: 3
---
# Glossary

Short definitions, each with the page that owns the details.

## Tenants and people

- **Team**: one studio or coach, and the tenant boundary. Almost every document
  carries a `teamId`.
- **Organisation**: a group of member studios, such as a federation or a chain.
  Organisations have their own navigation scope and see only a limited slice of
  their members' people. See [Member visibility](./org-contact-visibility.md).
- **Staff / team member**: someone who signs in to the dashboard, with a role
  (`owner`, `manager`, …). Not a contact.
- **Contact**: a person the studio looks after. Members, leads and externals are
  all contacts. See [Contact state model](./contact-state-model.md).
- **Lead**: a contact who has not yet committed, such as someone who booked a
  trial. Not the same as a *lead tenant* (below).
- **External**: someone who trains at the studio but is not on its roster, for
  example a partner-app drop-in. They can book and are counted in attendance,
  but automations and headcounts skip them.
- **Provisional contact**: created by an unfinished public flow. Expired ones are
  purged nightly.
- **Lead tenant**: a demo studio seeded for a prospective customer in the
  sandbox project. See [Lead sandboxes](/repo/leads/).

## What a studio sells

- **Activity**: the *what*: a class type or an appointment type, with its
  durations and prices.
- **Session**: one occurrence on the calendar (`sessions/{id}`), for both classes
  and appointments.
- **Class**: a seat in a scheduled session. The session exists before anyone
  books it.
- **Appointment**: a provider's exclusive time. Nothing exists until it is
  booked. See [Classes vs appointments](/rules/classes-vs-appointments/).
- **Availability**: the *when* for appointments: a provider's bookable windows.
- **Event**: a session with a **programme**, a multi-day, multi-track agenda. See
  [Event programmes](./event-program.md).
- **Plan / subscription type**: a membership a contact holds. It can include
  classes. See [Multi-plan holdings](./multi-plan-holdings.md).
- **Drop-in**: a single paid class without a plan.
- **Trial**: a newcomer's first class. It can be free or priced, and it is used
  once per person. It is never a subscription.
- **Offerings**: the dashboard area where activities and plans are managed.
- **Course**: a bounded set of lessons sold as one thing: "13 Wednesdays, 9
  places, one price". It owns a session series, so its lessons are ordinary
  sessions. See [Courses](./courses.md).
- **Online course**: on-demand video content in the online-courses plugin: free,
  sign-in, subscription or sold one-off. A different thing from a *Course*, and
  the screens never use one word for both.

## Money

- **Connect / member payments**: money from a contact to a studio, through
  Stripe Connect direct charges. See [Member payments](./payment-contact-studio.md).
- **SaaS billing**: money from a studio to Linyup for its plan tier (`free`,
  `coach`, `studio`, `organization`). See [SaaS billing](./payment-studio-linyup.md).
- **Resolver**: a pure function in `packages/shared` that is the only place a
  question gets answered, for example `resolvePaymentOptions` for "what does
  this cost this person". Extend the resolver. Never add a parallel check.
- **Benefit**: a member price that a plan grants on an activity.
- **Promo code**: a price *modifier* applied inside the resolver. A gift card,
  by contrast, is a *tender* applied at checkout. See [Promo codes](./promo-codes.md).
- **Journal**: the finance plugin's record of money events. Promo codes and
  Tarif 595 receipts never write to it.

## Public surfaces

- **Slug**: a team's public handle in `/public/{slug}`.
- **public_profile mirror**: a world-readable copy of the fields a public page
  may show. It is written by sync triggers and is the only thing public routes
  read. See [Public data boundary](/rules/public-data/).
- **Bio-link / Site / Space / Shop**: the public surfaces. They are a link page,
  a website, the member's personal portal, and the store.
- **Embed**: the booking modal on a studio's *own* website. See
  [Booking embed](./embed-booking.md).
- **Contact session**: passwordless sign-in for contacts (an email code and a
  custom token), used by the Space and the member app.

## Words we avoid

- Write **Appointment**, never "1:1", even as a short label.
- Plan tiers have stable IDs. Display names come from the `Plans` message
  namespace and must never be hard-coded. See [Plan tiers](/rules/plan-tiers/).
