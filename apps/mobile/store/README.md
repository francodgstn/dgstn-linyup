# Store listing assets

Everything a store listing needs that isn't code. Kept here so an Apple listing,
a re-render with different copy, or a second variant starts from what shipped
rather than from a screenshot somebody took once and lost.

| File | Size | Used by |
|---|---|---|
| `icon-512.png` | 512×512 | Play store icon (Play requires exactly this) |
| `feature-graphic-1024x500.png` | 1024×500 | Play feature graphic (**required** to publish) |
| `screenshots/android/*.png` | 1080×2410 | Play phone screenshots (2–8) |
| `screenshots/ios/*.png` | 1290×2796 | App Store iPhone screenshots (6.7", min 3) |

Four screens, in the order they tell a story: the dashboard (points, streak,
upcoming classes), the training calendar, the performance radar, the team
leaderboard.

## Regenerating the icon and feature graphic

```bash
node scripts/store-assets.mjs                       # both, from apps/mobile/assets/icon.png
node scripts/store-assets.mjs --tagline "Your text" # re-render the feature graphic
```

Both derive from `apps/mobile/assets/icon.png`, so the app icon stays the single
source of truth — change it there and re-run, rather than editing these by hand.

## The screenshots

Real captures from a physical device (Galaxy Z Fold cover display, 1080×2520),
taken over adb with the app signed in as the review contact. **Never screenshot a
real studio**: these show `linyup-demo` / Alex Reviewer, which is synthetic by
construction — every contact is `@example.com` and the tenant sends nothing. A
real member's bookings in a public listing is a privacy problem you can't undo
once it is indexed.

Recipe, with the two traps that cost time the first time:

```bash
adb exec-out screencap -p > shot.raw
```

1. **A Fold prepends a `[Warning] Multiple displays were found…` banner** to
   `screencap` output, so the file is not a valid PNG. Strip everything before
   the PNG signature (`89 50 4e 47`) — on the captures here it started at byte
   347.
2. **Crop the top 110 px** to remove the Android status bar. That is where the
   row-average brightness drops from ~48 to ~18 on this device (status bar to app
   background) — measure it again on a different phone rather than reusing 110.
   It also removes the clock, battery, carrier and VPN indicators, which have no
   business in a store listing.

Choose screens that show the app doing something. The demo tenant has to be
populated first — see `packages/functions/src/ops/demoTenant.ts`; it once
provisioned a tenant whose sessions never reached the app, and the screenshots
(and the store reviewer) got empty states.

## Release notes

`release-notes/<version>/<locale>.txt` — one file per Play locale (`en-US`,
`de-DE`, `fr-FR`, `it-IT`), plain text, under 500 characters each (Play's
limit). Written for a member, not a changelog: what they will notice, in the
language the app now speaks to them in.

`eas submit` uploads the bundle but not the notes: paste each file into Play
Console → the release → **Release notes** (add a language, paste, repeat).
Apple takes "What's New" per locale the same way, or via `store.config.json`.

Keep every version's notes — the production-access questionnaire asks what
changed during the test, and the answer is this directory.

## Apple, when you get there

Different requirements, same sources:

- **App icon** 1024×1024, no alpha, no rounded corners — use
  `apps/mobile/assets/icon.png` directly, not `icon-512.png`.
- **No feature graphic.** Apple has no equivalent; that file is Play-only.
- **Screenshots** are per device class and Apple is strict about exact pixel
  sizes. `ios.supportsTablet` is `false`, so **iPhone only** — that decision
  exists precisely to avoid maintaining an iPad set forever
  (`docs/mobile-store-setup.md`). The set here is 1290×2796 (6.7"), captured
  on a physical iPhone and moved over USB — anything that treats an image as a
  photo to be optimised (a messaging app, mail's "resize to medium") silently
  downscales them, and the first attempt arrived at 590×1280, which Apple
  rejects on sight. **Three screens, not four:** 01/02/04 keep the Android
  numbering so one screen has one number on both stores; 03, the performance
  radar, has no iOS capture yet.
- **The iOS three were hand-patched** to fill the top inset with `#121015`.
  Builds before the AppNavigator fix painted the notch area WHITE on iOS, so
  every capture carried a white band and the red screen-recording pill. That is
  fixed, and it shipped as an OTA — captures from 1.0.1 onward need no
  retouching and should match these pixel for pixel. If a fresh capture still
  shows the band, the device has not picked the update up: force-quit and
  reopen twice.
- Listing **text** belongs in `store.config.json` at `apps/mobile/`, pushed with
  `eas metadata:push` — Apple only; Play has no equivalent and stays manual.
