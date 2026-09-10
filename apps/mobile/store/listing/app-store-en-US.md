# App Store listing — en-US

The App Store copy, kept here so it is reviewable in a PR rather than typed into
a console and forgotten. Paste into App Store Connect → the version page
(**Promotional Text**, **Description**, **Keywords**) and App Information
(**Subtitle**).

English only for now (decided 2026-09-10). The app itself speaks four languages,
and per-locale listings are a real conversion lever in Switzerland — but they are
three more descriptions to keep in step, and `eas metadata` can version them here
if that changes.

Play's listing is **not** the same text: Apple has a 30-character subtitle and a
100-character keyword field that Play has no equivalent for, and Play has a
feature graphic that Apple does not. Where both stores say the same thing, say it
the same way; do not assume either file is a copy of the other.

---

## Subtitle — 30 char limit

```
Book classes, track progress
```

28 characters. Searchable, and it carries four indexable words the app name
cannot.

## Keywords — 100 char limit, comma-separated, no spaces

```
gym,studio,club,martial arts,dance,swim,pilates,yoga,class,booking,schedule,training,check-in
```

93 characters. Deliberately omits words already in the app name and the subtitle
— Apple indexes those separately, so repeating them spends the budget twice.
Leads with the business types a member would actually search.

**Keywords matter less here than for a consumer app.** Members arrive from a link
their studio sent them, not from search. Do not spend real time tuning this.

## Promotional Text — 170 char limit, editable WITHOUT a new version

```
Now in German, French and Italian. Book the next class, check in with a scan, and watch your streak build.
```

105 characters. This is the one field that can change without shipping a build,
so it is where a seasonal or "what's new" line belongs.

## Description — 4000 char limit

```
Linyup is the member app for studios, clubs and coaches who run on Linyup.

Your studio invites you — then everything you need is in one place.

• See what's on and book your spot
• Check in when you arrive by scanning your studio's QR code
• Track your training: attendance, streaks and points
• Rate yourself across five dimensions and watch your profile take shape
• See where you stand on your team's monthly leaderboard
• Book 1:1 sessions with your coach
• Keep your membership and details up to date

The app speaks English, German, French and Italian, and follows your phone's
language. It also takes on your studio's own colours, so it looks like the place
you train rather than like everyone else's app.

Used by martial arts schools, gyms, dance studios, swim schools and independent
coaches. The app shows your own record with your studio — your bookings, your
membership, your history.

You need an invitation from a studio that uses Linyup to sign in. There is no
password: enter your email address and we send you a code.

Are you a coach or studio owner? Manage your business at linyup.com.
```

### Two paragraphs that are doing work

**"You need an invitation…"** — do not cut this. An app that does nothing for a
person who downloads it cold is a minimum-functionality rejection on both stores.
Saying plainly that it is invite-only, plus the reviewer login in App Review
Information, is what stops a reviewer concluding it is broken.

**"There is no password"** — the sign-in is passwordless and the code arrives by
email. A reviewer who types the address and waits for a mail that never comes
(the review account's code is fixed and never sent) reports a broken app. The
Sign-In Information field must repeat this; the description sets the expectation.

---

## App Review Information

- **Sign-in required:** yes
- **Username:** `app.review@example.com`
- **Password field:** `123456`
- **Notes:** There is no password. Enter the email above; the app asks for a
  six-digit code — enter `123456`. It is a fixed code for this address and is
  never emailed. You land in "Linyup Demo Studio" with a demo membership.

The code's window is 60 days from the last provisioning run — re-run
`pnpm provision:demo --project linyup-prod` before submitting if it has lapsed,
or the reviewer cannot get in and the submission fails on the first screen.

## App Privacy

Every row: **Linked to you: Yes**, **Used for tracking: No**.

| Category | Types | Purpose |
|---|---|---|
| Contact Info | Name, Email Address, Phone Number, Physical Address, Other User Contact Info (date of birth) | App Functionality |
| Identifiers | User ID, Device ID (the push token) | App Functionality |
| Usage Data | Product Interaction (bookings, attendance) | App Functionality |

Everything else is **Data Not Collected**: no advertising identifier, no location,
no health data, no financial info (there is no checkout in the app), no contacts,
photos, messages or browsing history.

**"Used for Tracking" is No everywhere, and that answer is load-bearing** — a yes
anywhere obliges the App Tracking Transparency prompt. There is no ad ID, no
third-party analytics SDK and no cross-app tracking, so No is both true and the
cheaper answer.

The **Device ID** row is the push token (`contacts/{id}/push_tokens/{token}`).
Declared even though push is asleep, for the reason recorded in
`docs/mobile-store-setup.md`: the capability ships in the binary and switching it
on is an OTA, so a declaration that waits for the first notification goes stale
with no store build to hang the correction on.

## Assets

- **App icon 1024×1024** — `apps/mobile/assets/icon.png`, upload directly. NOT
  `store/icon-512.png`, which is Play-only.
- **Feature graphic** — Apple has no equivalent. Play-only.
- **Screenshots** — 6.7" iPhone, minimum 3. `ios.supportsTablet` is `false`, so
  iPhone is the only set required, which is the point of that decision. The
  Android captures cannot be reused: same screens, wrong pixel sizes. Take them
  from the TestFlight build and drop them in
  `store/screenshots/ios/`.
