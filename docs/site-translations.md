---
title: Site translations — public website + embed localization
status: living
area: content
---
# Site translations — public website + embed localization

A studio authors its public site **once, in its own language**, and the publish
pipeline machine-translates the site's text into the other three locales of
en/de/fr/it. The visitor-facing result is a public site that is genuinely
served — and therefore indexable — in all four languages, with `hreflang`
alternates, while the studio never sees a translation UI at all.

That sentence encodes the two decisions everything below follows from, both
recorded in `docs/fareharbor-analysis.md` §6.1 (resolved 2026-08-15):

> **No per-locale authoring, ever.** Owners will not maintain four versions of
> every page, and a half-filled translation reads as broken. The studio writes
> in ONE language (`Team.language` / `Organization.language`); the machine does
> the rest.
>
> **The driver is findability, not comprehension.** Browser translation happens
> after the page is served; Googlebot indexes the served HTML. Only stored,
> server-rendered translations put "Kampfsport Basel" in front of someone
> searching in German.

Two workstreams shipped together (2026-08-28) and they translate different
things — keep them apart when reasoning about a bug:

| | What it localizes | Mechanism |
|---|---|---|
| **Chrome** | The product's own UI on public surfaces (buttons, nav, the bio-link labels) | next-intl messages (`apps/web/messages/*`) — hand-written, all four locales, same as the rest of the app |
| **Tenant content** | What the studio *wrote into* its site (headlines, body copy, captions) | Machine translation at publish time, stored as hash-guarded unit maps |

Chrome was already 4-locale before this feature; what changed there is the
switcher and the cookie (see "The switcher and the cookie" below). The rest of
this document is about tenant content.

---

## What translates, and what deliberately doesn't

**ONE extractor + ONE resolver.** `extractSiteUnits`, `applySiteTranslations`
and `applySectionTranslations` in
`packages/shared/src/utils/siteTranslation.ts` are the single owner of the
mapping between a site and its flat translation-unit maps — which fields are
translatable, what key each one lives under, and when a stored translation may
substitute the base text. Same doctrine as `matchesFilter` and
`resolvePaymentOptions`: **never add a parallel implementation — extend the
field descriptors there.** The extractor and the resolver walk the SAME binding
structure, so they cannot drift apart; a field added to one is added to both.

**The key grammar is owned by that module's header** — the authoritative table
lives there and nowhere else. The families, so you can read a stored unit map:
`seo.*` (SEO title/description), `header.cta` and `surf.{surface}` (header CTA
and surface-link labels), `menu.{itemId}` (explicit menu labels), and
`s.{sectionId}.{field}` for section content — including `s.{id}.body` (rich
HTML, translated as HTML) and gallery captions as `s.{id}.cap.{index}`,
index-keyed within the section (an image reorder makes the hash guard fall back
to base until re-publish — accepted). Empty and whitespace-only strings are
never emitted as units.

**Excluded on principle**, each for a stated reason:

- **Brand names** — `SiteMeta.title` and the team/org name. A name is an
  identity, not prose; "Iron Circle Gym" must not become "Eisenkreis-Halle".
- **Data fields** — contact address, phone, email, `mapQuery`, place names,
  location extras, coach names, social links, URLs. Translating data corrupts
  it (a translated `mapQuery` stops finding the gym).
- **Live-mirror content** — activity / plan / session names that public pages
  pull from `public_profile` mirrors at render time. A site translation
  translates what the tenant wrote INTO the site, not what the site pulls in.
  Those mirrors render in the authoring language this phase; translating them
  is the unscheduled follow-on (see "What this phase does NOT cover").
- **Binding text** — waivers, cancellation policies, terms. Never
  machine-translated, per the rule recorded in `docs/fareharbor-analysis.md`
  §6.1: a mistranslated refund rule is a dispute you lose on time even where you
  would win on law — and nobody *searches* for a cancellation policy, so the
  findability value forfeited is zero. Binding text renders in the original.

**The source language** is resolved by ONE function:
`resolveSiteSourceLocale(tenant)` (same module) — the tenant's `language` when
it is a supported locale, else `'en'`. It accepts a `Team`, an `Organization`
or a `TeamPublicProfile`, so the server and the public reader resolve
identically. `TeamPublicProfile.language` mirrors `teams/{id}.language`
(written by `syncTeamPublicProfile`) so public surfaces know the base language
without touching the private team doc.

---

## Storage

### Team and org sites — the sidecar-id trick

Per-locale translations for published sites are **sidecar docs in the SAME
collection as the site they translate**:

```
site_published/{teamId}                      ← the site (base language)
site_published/{teamId}__i18n_{locale}       ← one sidecar per translated locale
org_site_published/{orgId}                   ← same pattern, org site
org_site_published/{orgId}__i18n_{locale}
```

Doc ids come from `siteI18nDocId(id, locale)` in `packages/shared/src/paths.ts`
(`SITE_I18N_SEPARATOR = '__i18n_'`). The shape is `SiteTranslationDoc`
(`packages/shared/src/types/website.ts`): `kind: 'site_i18n'`, the tenant id,
`locale` (never equals `srcLang`), `srcLang`, and the flat `units` map.

Why the same collection and not a subcollection: **the existing wildcard rules
already cover it.** `match /site_published/{teamId}` is `allow read; allow
write: if false` — a sidecar id matches the same wildcard, so sidecars are
world-readable and function-write-only **with no `firestore.rules` change**,
and there is no new collection for a rules review to miss.

Two invariants make the trick safe, both stated on the constant in `paths.ts`:

- **No real team/org id contains `__i18n_`**, so a sidecar id can never collide
  with a site doc.
- **A sidecar NEVER carries a `slug` field.** The public routes resolve tenants
  with slug queries against these collections; a sidecar with a `slug` could be
  returned *instead of the site*. The absence of the field makes that
  impossible by construction — preserve it in any future writer.

The base site doc carries a publisher-written manifest, `i18n: { srcLang,
locales }` (`SiteI18nManifest`), naming which sidecars actually exist — the
reader and the `hreflang` emitter consult the manifest, never a listing.

### Embed widgets — inline, because save IS publish

`embed_widgets/{teamId}` has no draft/publish split — a manager's save is
immediately live, and the doc is **client-written** (the manager authors the
public config directly). So there is no publish step to hang a sidecar write
on, and translations instead ride **inline on the one public doc**, under
`i18n: { srcLang, locales: { de: units, … } }` (`EmbedWidgetSet.i18n`).

They are written WHOLE by the `onEmbedWidgetsWritten` Firestore trigger, whose
loop guard is a **fixed-point check**: recompute the translations for the
stored doc; if what would be written equals what is stored, write nothing. No
marker field, no timestamp comparison — the trigger converges because a write
that changes nothing never fires a next iteration with different content.

The client save carries the stored `i18n` forward (a save that dropped it would
discard paid-for translations); if a client ever wipes it anyway, the trigger
self-heals at the next run — **at provider cost**, which is why carrying it
forward is the norm and self-heal is the backstop, not the mechanism.

---

## The hash-guard contract

Every stored unit is `{ text, srcHash, pinned? }` (`TranslatedUnit`). `srcHash`
is `translationSourceHash(sourceText)` — FNV-1a 64-bit over UTF-8, hex-encoded,
dependency-free and cheap enough for the render path. It is **not
cryptographic and must never be presented as such**: it answers "is this still
the text this translation was made from?", nothing adversarial.

The contract, on both sides:

- **The resolver substitutes a unit only when its `srcHash` equals the hash of
  the CURRENT base text at that key.** Anything else — missing unit, empty
  text, stale hash — leaves the base text standing. So **staleness degrades to
  the authoring language, never to wrong text**: a studio that edits a headline
  and republishes before translation catches up shows the new headline in
  German pages *in the authoring language*, not the old headline in German.
  This is the invariant that makes it safe for translation to lag, fail, or be
  skipped entirely.
- **The writer uses the same hash as a cache key.** A re-publish with unchanged
  text costs **zero provider calls**: units whose source hash already has a
  stored translation are reused, and a reverse index by `srcHash` lets
  duplicated text (the same CTA label on five sections) be translated once.
  This is also what makes the backfill idempotent.

Never bypass the guard "because the text obviously matches" — the guard IS the
staleness model, and every reader relies on it being applied uniformly.

### `pinned` — the Option-C reservation

`pinned?: boolean` on a unit is **reserved, not implemented**. The intended
feature (a manual per-unit override, "Option C" of the design discussion): a
future callable lets a studio hand-correct one translated string and marks it
`pinned`. The contract is already written into the writers and the resolver so
that adding the callable later needs **no migration**:

- **MT writers preserve a pinned unit while its `srcHash` still matches**, and
  clear the pin when the source text changes (a hand-corrected translation of
  text that no longer exists must not survive it).
- **The resolver never reads `pinned`** — a pinned unit substitutes under
  exactly the same hash guard as any other. Pinning changes who *writes* the
  text, never how it is *read*.

A future implementer adds: the callable (auth: manager+), the editing surface,
and nothing else. Do not add resolver-side meaning to the flag.

---

## The two write paths, and why they differ

### Publish path — team and org sites

`publishWebsite` / `publishOrgWebsite` (`packages/functions/src/website/`,
`packages/functions/src/orgWebsite/`) gain a translation step that runs
**synchronously inside the publish**: extract units from the draft being
published, translate what the hash cache doesn't already cover, write one
sidecar per target locale, and stamp the `i18n` manifest on the published doc.
Synchronous because publish is the ONE moment the content is known to be final
and the studio is already waiting on a spinner — a queue or cron would add
lag, a second failure domain, and a window where the manifest lies.

**Translation can never fail a publish.** The translation step is throw-free
end to end: a provider error, a missing key, a quota — each degrades to *fewer
translated locales* (down to zero), logs a warning, and the publish itself
succeeds with the manifest reflecting what actually exists. A studio must never
be unable to ship its site because DeepL had a bad day.

### Widget path — the trigger

Embed widgets have no publish moment (save = live, client-written), so the
translation writer is the `onEmbedWidgetsWritten` trigger described above —
same extractor, same hash cache, same never-fail posture, different mount. The
fixed-point loop guard replaces the "publish is the moment" property: the
trigger may fire on its own write, but a recompute that equals the stored
state writes nothing, so it terminates.

The two paths share everything except the mount. If you find translation logic
in one that the other lacks, that is a bug in the sharing, not a feature of the
path.

---

## Provider setup — DeepL or Google Cloud Translation

Translation goes through a provider-agnostic service in
`packages/functions/src/translate/` — call sites depend on the service
interface, never on vendor types. Two providers exist; **`provider.ts` is the
one place a vendor is chosen**, driven by the `TRANSLATION_PROVIDER` env
(deployed functions env / emulator `.env.local`):

| Value | Meaning |
|---|---|
| `deepl` | DeepL, via the `deepl-api-key` secret |
| `google` | Cloud Translation v3, via the runtime service account (no key) |
| `none` | machine translation explicitly off |
| unset / `auto` | DeepL when its key resolves; otherwise Google in deployed functions; off in the emulator (no surprise ADC attempts on dev machines) |

**DeepL** — best de/fr/it/en quality, first-class HTML handling. Secrets
(Secret Manager in prod; `packages/functions/.env.local` for the emulator —
same regime as the Brevo keys, see `packages/functions/src/mail/README.md`):

| Name | Secret Manager | Emulator env |
|---|---|---|
| DeepL API key | `deepl-api-key` | `DEEPL_API_KEY` |

The key can be set from the operator console (Settings → Translation) —
write-only, like the Brevo and Stripe secrets there — or with `gcloud secrets
versions add deepl-api-key --data-file=-`. Either way the secret CONTAINER and
its IAM come from Terraform first: `deepl-api-key` must be in the environment's
`secret_ids` **and** `admin_writable_secret_ids`
(`infra/environments/*/variables.tf`), or the console save fails with
`PERMISSION_DENIED: secretmanager.versions.add`.

The API Free tier (≈500k chars/month, keys end `:fx`) is routed to
`api-free.deepl.com` automatically; it is signed up for at deepl.com/pro-api
and is easy to miss next to the Pro subscriptions.

**Google Cloud Translation** — no vendor account and no secret: calls
authenticate as the functions runtime service account via ADC and bill to the
project (its own free allowance is also ≈500k chars/month). Setup is
project-side only: enable the `translate.googleapis.com` API and grant the
runtime service account `roles/cloudtranslate.user`. Credential or API-enable
problems surface as ordinary per-call errors and degrade like any provider
failure.

**No provider ⇒ one warning, publish succeeds untranslated.** A fresh clone, CI,
and any environment without the secret keep working; sites simply publish with
no sidecars (and the manifest says so). Never turn the missing-key path into an
error — that would violate "translation can never fail a publish".

Cost posture, recorded in `docs/fareharbor-analysis.md` §6.1 so it stops being
raised: the translatable surface is tens of thousands of characters per studio,
one-time plus edits — cents to low single-digit francs per tenant. The hash
cache bounds re-translation to what actually changed.

---

## Embed language pinning

A studio embedding a widget into its own website usually knows what language
that page is in — auto-detection inside the iframe would fight the host page.
So the embed snippet can pin a language: `WidgetTheme.locale` is `'auto'` (or
absent — the pre-feature behaviour, follow the visitor's Accept-Language) or
one of en/de/fr/it, baked into the snippet URL the builder generates.

The pin travels differently per locale, and the asymmetry is forced:

- **de/fr/it** use the ordinary path prefix: `/de/embed/{slug}/{widgetId}`.
- **en** uses a query param, `?hl=en`, handled in `apps/web/src/proxy.ts`.

Why English is special: with `localePrefix: 'as-needed'` English is the
UNPREFIXED locale, so an English pin cannot be expressed in the path — a bare
`/embed/...` URL is re-resolved from Accept-Language, and the normal fix (the
`NEXT_LOCALE` cookie, see below) is unavailable here because **a cross-origin
iframe cannot carry the locale cookie** (third-party cookie, blocked or
partitioned by the browser). `?hl=en` is the one channel that survives the
iframe boundary; the proxy reads it and pins the locale before next-intl
resolves. Do not "simplify" it into the cookie mechanism.

---

## The switcher and the cookie

Public-surface chrome was already fully translated (next-intl); what this
feature changed on the chrome side:

- **A `LocaleSwitcher` now mounts on the public site (via `WebsiteRenderer`),
  the org site, and the bio-link** — visitors can switch language, and because
  the tenant content is translated too, the switch changes the whole page, not
  just the buttons. `BioLinkHome`'s chrome strings were moved into messages as
  part of this (they had hardcoded English remnants).
- **Public surfaces now PERSIST the `NEXT_LOCALE` cookie on an explicit
  choice.** Previously nothing on a public surface ever called `persistLocale`
  (`apps/web/src/i18n/persistLocale.ts`), so a visitor's pick of English — the
  unprefixed locale — didn't stick: the next bare URL was re-resolved from
  Accept-Language and a German-preferring browser bounced straight back to
  `/de/...`. Writing the cookie puts the explicit choice ahead of the browser
  preference. **First-visit auto-detection is unchanged** — the cookie is
  written only on an explicit pick, never on arrival.
- **The prefixed-href regime for raw anchor tags still stands.** Links built
  through `@/i18n/navigation` get the locale automatically; any raw `<a
  href>` on a public surface must keep building its href through
  `publicLocalePrefix` / `localizedPublicUrl` (`packages/shared/src/publicRoutes.ts`)
  — the cookie is a resolver input, not a substitute for correct hrefs (and
  emailed links have no cookie at all).

---

## hreflang

The public site routes emit `alternates.languages` **only for the source
language plus the locales that are actually translated** (per the `i18n`
manifest), with **`x-default` pointing at the source-language URL**. Never emit
an alternate for a locale with no sidecar — advertising a URL that serves
fallback (authoring-language) content is worse for search than staying silent,
and the manifest exists precisely so the emitter doesn't have to guess.

---

## Backfill runbook

Already-published sites (HMD's included) predate the translation step and have
no sidecars until they are re-published — or backfilled:

```
pnpm backfill:site-translations              # translate every published site + widget set
pnpm backfill:site-translations --dry-run    # print unit/character counts, call nothing
```

(`scripts/backfill-site-translations.ts`.) Run it **after** a functions deploy
that includes the translation step, so a studio's next manual publish doesn't
race it. It is **idempotent via the hash cache** — a re-run translates only
text whose source hash has no stored translation, so running it twice costs one
provider pass, and running it against an already-backfilled environment costs
nothing. `--dry-run` first when pointing at a real project: the counts are the
cost estimate.

Needs a provider in the target environment: the DeepL key (env or
`packages/functions/.env.local` — emulator regime, `DEEPL_API_KEY`), or
`TRANSLATION_PROVIDER=google` to use Cloud Translation over the same ADC the
script's admin SDK is already running on, billed to `--project`. Without
either, the run degrades the same way a publish does — warns, writes nothing
new, reconciles manifests from cached units only.

---

## What this phase does NOT cover

- **Live-mirror content** — activity / plan / session names and descriptions in
  the `public_profile` mirrors, and everything the booking and shop surfaces
  render from them. Those stay in the authoring language. The shape for
  translating them at `sync*PublicProfile` time is recorded in
  `docs/fareharbor-analysis.md` §6.1 and remains unscheduled.
- **Manual overrides** — reserved via `pinned`, see Option C above.
- **Binding text** — permanently out, by decision, not by phase.

---

## Recorded decisions

- **2026-08-15** — No per-locale authoring, ever; machine-translate into the
  public read models for findability; never machine-translate binding text.
  (`docs/fareharbor-analysis.md` §6.1 — the revision note there
  is the reasoning.)
- **2026-08-28** — Shipped for the website + embed surfaces. The mirrors
  (booking/shop) remain unscheduled.
- **2026-08-28** — One extractor + one resolver in
  `shared/utils/siteTranslation.ts`; the key grammar is owned by its module
  header. Parallel implementations are forbidden on the `matchesFilter` /
  `resolvePaymentOptions` precedent.
- **2026-08-28** — Sidecar docs in the SAME collections, id
  `{id}__i18n_{locale}`, never carrying `slug` — chosen over a subcollection so
  the existing `write: if false` wildcards cover them with no rules change.
- **2026-08-28** — Hash-guarded substitution: staleness degrades to the
  authoring language, never to wrong text. FNV-1a, explicitly non-cryptographic.
- **2026-08-28** — Translation is synchronous at publish and can never fail a
  publish; no key ⇒ warn once, publish untranslated.
- **2026-08-28** — Embed widget translations ride inline, written whole by the
  `onEmbedWidgetsWritten` trigger with a fixed-point loop guard; the client
  save carries them forward, self-heal is the backstop.
- **2026-08-28** — Embed pinning: de/fr/it by path prefix, en by `?hl=en` in
  the proxy, because English is unprefixed and a cross-origin iframe cannot
  carry the locale cookie.
- **2026-08-28** — Public surfaces persist `NEXT_LOCALE` on explicit choice
  only; first-visit auto-detection unchanged.
- **2026-08-28** — `hreflang` alternates only for actually-translated locales;
  `x-default` is the source-language URL.
- **2026-08-28** — Gallery captions are index-keyed; a reorder falls back to
  the base language until re-publish. Accepted as the cost of not inventing
  per-image ids.
- **2026-08-28** — `pinned` reserved now (writers preserve-while-hash-matches,
  resolver never reads it) so the manual-override callable needs no migration.
