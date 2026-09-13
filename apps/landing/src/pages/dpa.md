---
layout: ../layouts/LegalLayout.astro
title: Data Processing Agreement
description: How Linyup processes personal data on behalf of its customers.
lastUpdated: 13 September 2026
---

> **DRAFT — NOT YET REVIEWED BY A LAWYER.** This text is a starting point
> prepared from how the product actually works, not legal advice, and it has not
> been reviewed. Do not rely on it, and remove this notice only once a qualified
> lawyer has reviewed and approved the wording. In particular, the Art. 28 GDPR
> and FADP wording, the sub-processor notice period and the return-and-deletion
> commitments need checking against what we can actually deliver.

# 4. Data Processing Agreement

This agreement forms part of the [Terms of Service](/terms) and applies whenever
you use Linyup to process personal data about your own contacts.

## 4.1 Roles

You are the **controller**. We are your **processor**. This agreement covers the
personal data you put into Linyup about your members, students, clients,
prospects and staff. It does not cover your own account data, for which we are
the controller — see the [Privacy Policy](/privacy).

## 4.2 Subject matter, duration, nature and purpose

We process your contacts' personal data only to provide the service described in
the Terms — storing records, scheduling, taking bookings, sending messages you
configure, and processing payments through your own Stripe account — for as long
as your account exists, plus the deletion windows in §4.8.

## 4.3 Categories of data subject and personal data

**Data subjects:** the people you manage — members, students, clients, prospects,
and the staff you invite.

**Personal data:**

- identity and contact details: name, email, phone, date of birth, postal
  address, photo;
- relationship data: membership and subscription status, groups, join date,
  acquisition source, notes you write;
- activity data: bookings, attendance, waitlist entries, appointments, course
  access;
- transaction metadata: amounts, status, references, refunds, credits and gift
  cards. **We never store card numbers** — those are entered directly with
  Stripe;
- documents you have people sign, with the version and timestamp of acceptance;
- **health-insurance reimbursement data**, only where you enable the Tarif 595
  plugin: a contact's AHV social security number, health insurer and insured
  number, and the receipts (Rückforderungsbelege) and QR-bill invoices you issue
  from them. The AHV number is subject to the restrictions of the Swiss AHV Act
  on its systematic use; **you are responsible for the lawful basis for
  collecting it** and for informing your contacts. We hold it only in a record
  readable by your managers and owners, print it only on the receipts you issue,
  and delete it when a contact is anonymised; issued receipts and invoices are
  kept as your accounting records;
- **any additional fields you choose to define.** Linyup lets you create custom
  fields, so the categories above cannot be exhaustive. You decide what goes in
  them, and you are responsible for the lawfulness of collecting it.

## 4.4 Our obligations

We will:

- process your contacts' personal data only on your documented instructions,
  **including as regards any transfer to a country outside Switzerland or the
  EEA**, unless we are required to process it by law — in which case we will tell
  you before doing so, unless the law forbids that. Your instructions include
  your use of the service's features: using a feature is an instruction to
  process the data that feature needs;
- ensure people authorised to process it are bound by confidentiality;
- take appropriate technical and organisational security measures (§4.6);
- respect the sub-processor conditions in §4.5;
- help you, so far as we reasonably can, to respond to data-subject requests and
  to meet your obligations on security, breach notification and impact
  assessments;
- tell you without undue delay if we become aware of a personal-data breach
  affecting your data;
- on termination, at your choice return or delete the data as set out in §4.8,
  and delete any existing copies unless we are required to keep them by law;
- make available the information reasonably needed to demonstrate compliance with
  this agreement.

If we believe an instruction breaches data-protection law, we will tell you.

## 4.5 Sub-processors

You give general authorisation for us to engage the sub-processors below. We
impose on each of them, by contract, data-protection obligations materially the
same as those in this agreement, and **we remain fully responsible to you for
their performance**.

| Sub-processor | Purpose | Location of processing |
|---|---|---|
| Google Cloud / Firebase (Google) | Hosting, database, file storage, serverless functions | Switzerland (`europe-west6`, Zurich) |
| Brevo (Sendinblue SAS) | Transactional email **and SMS**, including document attachments you choose to send (receipts, invoices) | France (EU) |
| Stripe Payments Europe, Ltd. | Payment processing | Ireland (EU), with group processing in the United States |
| PostHog, Inc. | Product analytics (session recording off) | EU region (Frankfurt); provider based in the United States |

We will give you at least **20 days' notice** by email to the account owner before
adding or replacing a sub-processor. You may object within that period on
reasonable data-protection grounds; if we cannot resolve your objection, either of
us may end the agreement.

## 4.6 Security

Measures currently in place include: tenant isolation enforced at the database
layer rather than in application code; encryption in transit; credentials held in
a managed secret store rather than in configuration; short-lived tokens for
member sign-in; rate limiting on public endpoints; and role-based access within
each studio account.

## 4.7 International transfers

Application data is processed in Switzerland. Where a sub-processor processes
data outside Switzerland or the EEA, that transfer is covered by recognised
safeguards — the EU and Swiss Standard Contractual Clauses and, where applicable,
an adequacy mechanism such as the EU–U.S. / Swiss–U.S. Data Privacy Framework.

## 4.8 Return and deletion

You can delete individual contacts at any time from within the application; a
contact deletion request starts a **30-day** window, after which the record is
anonymised.

Deleting your studio starts a **30-day** reversible window, after which the
studio and its data are permanently removed.

You can export your contact book yourself at any time, from the Contacts page,
as a CSV file — including archived contacts and any custom fields you defined.
Financial records have their own export. For anything else, we will provide a
copy in a commonly used machine-readable format on request, within a reasonable
period.

**One limitation, stated plainly:** deleting a studio does not close the Stripe
connected account you created. That account is yours and is governed by your own
agreement with Stripe; close it with Stripe directly.

## 4.9 Audits

We will respond to reasonable written requests for information needed to
demonstrate compliance. Where an on-site audit is required by law, it will be at
your cost, on reasonable notice, no more than once a year unless a regulator
requires otherwise, and subject to confidentiality.

## 4.10 Precedence

If this agreement conflicts with the Terms of Service on the processing of your
contacts' personal data, this agreement prevails.
