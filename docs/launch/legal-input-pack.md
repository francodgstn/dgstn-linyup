# Input pack for the ToS + DPA — facts, extracted from the code

This exists so a lawyer drafting Linyup's **Terms of Service** and **Data
Processing Agreement** does not have to bill for discovery. Everything below was
read out of the source, not out of the privacy policy — where the two disagree,
the code is what actually happens and the policy is what needs correcting.

**Status: NOT LEGAL ADVICE, and nothing here is binding text.** This is a
factual annexe. The drafting is Track A's external step.

Verified against `main` at `61b963a6`, 2026-08-25.

---

## 1. The parties, and who is what

| | |
|---|---|
| **Provider** | Franco D'Agostino, trading as "D'Agostino Production", Kleinhüningerstrasse 205, 4057 Basel, Switzerland. Not in the commercial register. "Linyup" is the product name, not a legal entity. (`apps/landing/src/pages/legal.md`) |
| **Customer** | A studio / coach / club — a business, never a consumer. The product has no consumer tier. |
| **Roles** | For the Customer's own **contacts** (members, students, clients), the **Customer is controller and Linyup is processor**. For the Customer's own account data (the person who signs up), Linyup is controller. This split is already stated at `privacy.md` §2.9 and is correct. |

The DPA is the processor half of that split. It is what `privacy.md` promises
twice and what does not exist.

---

## 2. Data categories Linyup processes on the Customer's behalf

Extracted from `packages/shared/src/types/contact.ts` and the booking rails.

- **Identity**: first name, last name, email, phone, date of birth, postal
  address (four-part map), photo.
- **Relationship**: acquisition source, affiliation status, subscription type
  and status, join date, group membership, notes written by the studio.
- **Activity**: bookings, attendance / check-ins, waitlist entries, appointment
  history, course purchases and entitlements.
- **Money**: payment line items, refunds, gift cards, credit packs, promo
  redemptions. **Card details are never stored** — they are entered directly
  with Stripe; Linyup receives status, amount and a reference.
- **Customer-defined**: arbitrary **custom fields** the studio configures. Linyup
  cannot enumerate these in advance, which matters for the DPA's data-categories
  annexe — it should describe the category as open-ended and put the choice of
  what to collect on the Customer, consistent with §2.9.
- **Signed documents**: waiver acceptances, with the frozen document version, the
  acceptance timestamp, and a self-declared minor/guardian flag.
- **Special-category risk**: nothing is collected as health data by design, but a
  studio can plainly type one into a note or a custom field. Worth an explicit
  clause telling the Customer not to, rather than silence.

---

## 3. Sub-processors

`privacy.md` §2.4 already carries this table and it is accurate, with **one
correction**:

| Sub-processor | Purpose | Location |
|---|---|---|
| Google Cloud / Firebase | Hosting, database, file storage, serverless functions | `europe-west6` (Zurich, CH) |
| Brevo (Sendinblue SAS) | Transactional email **and SMS** | France (EU) |
| PostHog, Inc. | Product analytics (session recording off) | EU region (Frankfurt); provider US-based |
| Stripe Payments Europe, Ltd. | Payment processing | Ireland (EU), group processing in the US |

**Correction owed:** the table says Brevo is "Transactional and marketing email".
`packages/functions/src/mail/smsService.ts` routes **SMS through Brevo too**
(`brevoSmsProvider`), so member **phone numbers** reach it. Fix the policy line
in the same pass as the DPA.

Application data stays in Switzerland (`europe-west6`). Transfers outside CH/EEA
are covered by SCCs / DPF per §2.4 — the DPA should name the same mechanism.

---

## 4. Retention and deletion — as implemented, not as promised

| What | Rule | Where |
|---|---|---|
| Contact self-deletion | **30-day** grace, then anonymisation | `CONTACT_DELETION_GRACE_DAYS`, `shared/utils/contactDeletion.ts:32`; actor is `dailyTasks/anonymizeScheduledContacts.ts` |
| Studio account deletion | **30-day** reversible window, then purge | `TEAM_DELETION_GRACE_DAYS`, `functions/src/teams/deleteAccount.ts:50`; actor is `dailyTasks/purgeScheduledTeams.ts` |
| Unverified signups | Hard-deleted after **7 days** | `UNVERIFIED_MAX_AGE_DAYS`, `dailyTasks/purgeUnverifiedSignups.ts:43` |
| Provisional contacts | Hard-deleted nightly once expired | `dailyTasks/purgeProvisionalContacts.ts` |
| Verification codes | Purged nightly | `dailyTasks/purgeVerificationCodes.ts` |
| Website logs | 30 days (Google Cloud default) | `privacy.md` §2.5 |

**Known gap the DPA must not overstate:** `purgeTeam` leaves the studio's Stripe
Connect account live. Recorded as accepted in `readiness-2026-08.md`. A
return/deletion clause that claims total erasure would be inaccurate today.

---

## 5. Return and portability

A DPA normally commits the processor to return the controller's data on
termination. What exists:

- **Contacts CSV export** — `functions/src/contacts/exportContacts.ts`, reached
  from the Contacts page. Manager-only, includes archived contacts and every
  custom field the studio defined, and **refuses rather than truncating** when an
  export exceeds the inline size limit. Added 2026-08-25 precisely so the DPA's
  return-of-data clause describes something that exists.
- **Finance/report CSV export** — `functions/src/finance/exportReport.ts`, plus
  CSV on the payments and custom-forms surfaces.
- Migration tooling (`scripts/migration/`) exists but is operator-run, one
  direction, and HMD-specific.

**Still not self-serve:** bookings, attendance and waiver acceptances have no
export. They are recoverable by hand, so the clause should promise a
machine-readable copy "on request within a reasonable period" rather than imply
everything is a button.

---

## 6. Security measures (Art. 32 annexe input)

- Tenant isolation enforced in `firestore.rules` by `teamId`, not in application
  code; public surfaces read only world-readable `public_profile` mirrors.
- Secrets in Google Secret Manager (`brevo-api-key`, Stripe keys); **no stored
  mail credentials**, no SMTP.
- Passwordless contact sessions are short-lived custom tokens with claims checked
  in rules, not in the UI.
- Rate limiting on every public callable, per-surface.
- PITR enabled. **A restore has never been rehearsed** — `readiness-2026-08.md`
  lists this as still open. Do not let the DPA imply a tested RTO/RPO.
- **App Check is implemented but NOT enforced** — deferred by decision, so it is not a
  live control. **Do not let the DPA or any customer answer imply active bot / automated-
  abuse protection from it.** What IS live is the per-surface rate limiting above. See
  `docs/app-check-rollout.md` → "Why it is still off". ("Partial", the earlier wording
  here, reads as *in place, partially* — it is not in place.)

---

## 7. Sub-processor change notification

Nothing in the product notifies Customers when a sub-processor changes. If the
DPA promises notice (most do), that is an operational commitment with no
mechanism behind it yet — either add a simple notification path or word the
clause as notice by email to the account owner, which is achievable today.

---

## 8. Decisions taken, and what is left for the lawyer

Franco settled these on **2026-08-25**, after benchmarking the Swiss and
Austrian comparators (Webling, ClubDesk, Fairgate, Eversports). The draft already
reflects them; what follows is why, so a reviewer argues with the reasoning
rather than rediscovering it.

**DECIDED — 1. Governing law.** Swiss law, exclusive jurisdiction in **Basel**,
conflict-of-law rules and the CISG excluded. Aligned with the field: every
comparator uses its own seat (Webling → Winterthur, ClubDesk → **Basel**,
Eversports → Vienna). The earlier draft's concession — "without prejudice to
mandatory protection at your place of establishment" — was **removed**.

CORRECTION, recorded because the decision was taken on a claim that turned out to
be wrong: it was removed on the basis that no comparator offers it. **KLARA does**
— its §13 applies Swiss law "vorbehältlich zwingenden Rechts des jeweiligen
Wohnsitzlandes des Nutzers" and expressly reserves mandatory venues. KLARA sells
to Swiss SMEs including sole traders, so mandatory consumer law bites harder for
them than for a B2B-only product, which is a real distinction — but the removal
now rests on that distinction rather than on the field being unanimous. Franco was
offered KLARA's narrow reservation on 2026-08-25 and left it out.

**DECIDED — 2. Two documents.** Terms (`# 3.`) and DPA (`# 4.`), the DPA forming
part of the Terms with a precedence clause. Direct Swiss precedent: ClubDesk
concluded that accepting the AGB automatically concludes the AVV, keeping it a
separate document without separate signing.

**DECIDED — 3. Activation-based acceptance, not click-wrap.** Creating the studio
forms the agreement; a notice on the team step says so and links both documents.
This is the MAJORITY practice in the field, not a shortcut: Webling forms the
contract on its activation email, Eversports on activation after the operator
supplies its details, and KLARA §3 makes the act of REGISTERING carry the user's
confirmation that they are legally capable and authorised to represent — which is
the load-bearing part for B2B formation, and what §3.1 of the draft now says.
Only Fairgate uses an explicit tick-box. Amendments: **six
weeks' notice** by email with a **written objection right** and a termination
route if no agreement (Eversports' shape).
*The trade, recorded because it is reversible:* click-wrap is stronger evidence
of assent. The RECORD is identical either way — `provisionTeam` stamps version,
timestamp, uid and email onto the team — so restoring the tick-box is a UI change
on step two, not a data-model change.

**DECIDED — 4. No SLA; ClubDesk's and KLARA's liability shape, not Webling's.**
No availability guarantee, with the causes named (maintenance, network, power,
provider outage). Liability limited to **intent and gross negligence**, with
**slight AND medium negligence** excluded so far as the law permits — the wider
exclusion is KLARA's, adopted 2026-08-25 — except for life/body/health.
Consequential loss excluded, and capped at **twice the annual plan fee** per
contract year, with the free plan capped at twice the next paid plan's fee,
because a cap of "fees paid" is **zero** for a free customer.
Note the belt-and-braces: KLARA relies on the negligence tiers with NO monetary
cap, ClubDesk uses a cap; this draft has both.
*Why not Webling:* its blanket disclaimer of all liability is very likely partly
void, since **Art. 100 OR** does not permit excluding liability for intent or
gross negligence. Declining an SLA and writing an unenforceable liability clause
are separate choices; only the first was wanted.

**DECIDED — 5. Platform fees confirmed** and now stated in §3.5 as a table:
Free 2.5%, Coach 1.5%, Studio 0.8%, Organization 0.5%, no minimum and no fixed
component (`CONNECT_TAKE_RATE`, `shared/src/types/connect.ts`). Stripe's own
processing fees are separate and charged by Stripe. (Revised 2026-08-29 by a
pre-launch commercial review; the first set was 1.7 / 1.2 / 0.7 / 0.4 %.)

### Resolved on 2026-08-25, after checking the comparators

**Sub-processor notice → 20 days**, with an objection right and a termination
route if unresolved. Fairgate's window, now named in §4.5 (it previously promised
notice with no period at all). **The mechanism is still manual** — nothing in the
product sends this; it is an email somebody has to remember.

**§3.11 stands as drafted** (Franco: "keep as is, like KLARA, fine for now"). It
mirrors KLARA §10 — liable for intent and gross negligence, slight and medium
excluded so far as the law permits, life/body/health carved out — plus ClubDesk's
2× annual-fee cap that KLARA does not have. Still worth a lawyer's eye on the
exact gross-negligence boundary, since Art. 100 OR is where a loose one fails.

**The one-year claim limitation was REMOVED.** It came from Eversports, which is
Austrian. Neither Swiss comparator has one: KLARA's AGB contains no limitation
clause at all, and ClubDesk relies on its cap. More to the point, **Art. 129 OR
does not permit the statutory limitation periods to be altered by agreement**, so
a contractual one-year period is doubtful in Switzerland whatever the drafting.
Statutory limitation now applies, which is both the aligned answer and the safer
one.

**The DPA was reviewed against Art. 28(3) GDPR and Fairgate's AVV.** Three real
gaps were closed:

| Gap | Fix |
|---|---|
| Instructions clause did not mention third-country transfers, which Art. 28(3)(a) requires expressly | §4.4 now covers transfers and the required-by-law exception, with notice unless the law forbids it |
| No flow-down of obligations to sub-processors — Art. 28(4) requires them bound by contract to materially the same terms | §4.5 now states the flow-down and full responsibility |
| Deletion clause did not mention **copies**, which Art. 28(3)(g) requires | §4.4 now covers copies, with the legal-retention exception |

Also confirmed from KLARA's §"Datenlöschung": it deletes account data three
months after termination and enables a full data export on dissolution. Our
30-day windows plus the contacts export (`exportContacts`) are the stricter
position.

### Still for the lawyer

1. **Does activation-based acceptance suffice** for B2B contract formation under
   Swiss law, and does the stored record (version, timestamp, uid, email — **no
   IP**) meet the evidentiary bar? The market answer is settled — four of five
   comparators form on an act, and KLARA §3 makes registering carry the
   confirmation of capacity and authority — but market practice is not a legal
   opinion. IP was left out deliberately: personal data about the Customer, easy
   to add later and impossible to un-collect.
2. **Is §3.11's gross-negligence boundary worded to survive Art. 100 OR?** The
   shape is right and matches KLARA; the wording is what decides it.
3. **Does the DPA now satisfy Art. 28 in full**, after the three fixes above, for
   EU-established Customers under GDPR as well as the FADP? The structural gaps
   found by comparison are closed; whether the list is COMPLETE is a lawyer's
   call, not a diff.
4. **Should the mandatory-law reservation come back?** Offered and declined on
   2026-08-25 (see Decision 1's correction). KLARA keeps a narrow one; the
   removal rests on Linyup being B2B-only.
