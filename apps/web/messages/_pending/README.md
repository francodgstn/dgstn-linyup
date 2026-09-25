# Message fragments — how parallel lanes add copy

`apps/web/messages/{en,de,fr,it}.json` is the busiest contention point in the
repo, and until 2026-08-17 it was the reason UI work ran **one agent at a
time**. The race is at **file** level, not key level: an agent reads the whole
file, edits it, writes it back — so two agents adding keys to entirely
different namespaces still lose one another's work, with no conflict marker and
no failing build. Partitioning namespaces would not have helped.

## The contract

**A lane never opens a locale file.** It writes one fragment here instead:

```
apps/web/messages/_pending/<lane>.json
```

```json
{
  "PublicBooking": {
    "signedUpOnlyLine": {
      "en": "Members only — signing up is free",
      "de": "Nur für Mitglieder — die Registrierung ist kostenlos",
      "fr": "Réservé aux membres — l'inscription est gratuite",
      "it": "Solo per membri — la registrazione è gratuita"
    }
  }
}
```

Namespaces may nest to any depth. A **leaf** is recognized by its shape — an
object whose keys are locale codes — so no depth needs declaring.

**The four translations of one key live together, deliberately.** A translation
is one unit of work; splitting a key across four fragment files is how locales
drift, which is the failure this scheme exists to prevent.

Then, once the lanes have landed:

```bash
pnpm i18n:merge
```

## What the merge refuses to guess

It exits non-zero and writes **nothing** when:

- a leaf is missing a locale, or one is blank;
- a translation drops or invents a `{placeholder}` — a next-intl **runtime
  error**, and only in the locale nobody clicks through;
- two lanes claim the same key with different copy — neither can be preferred
  without knowing which shipped last, and silently picking one is how a lane's
  copy vanishes with no diff to notice;
- a key already exists with different text — either a lane stomping shipped
  copy or a stale fragment. `--force` if you mean it.

Identical text is a no-op, so re-running is safe. `--dry-run` previews;
`--keep` leaves the fragments in place instead of consuming them.

## Why an unmerged fragment fails CI

`pnpm i18n:check` (in the Lint job) fails if any fragment is left here. There is
no `IntlMessages` type augmentation in this repo, so **message keys are untyped
strings** — a component referencing a key that was never merged compiles,
lints, and renders the raw key id to every visitor. Nothing else catches it.

The same check enforces parity across every key, including the arrays that
hold real copy (plan feature lists, for one). Before this existed,
`apps/web` had no test runner and parity was held by discipline alone.

## Fragments are not committed

`*.json` here is gitignored. A fragment is a transient hand-off between a lane
and the merge, and committing one would mean shipping copy that is in the
fragment but not in the app.
