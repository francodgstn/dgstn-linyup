/**
 * Flattens the nested `schedule` object hmd-lineup's alert presets carry
 * into the two top-level fields Linyup reads — the exact same shape change
 * pass05 already applies to `contact_alerts` (see 05-contacts.ts's
 * transformSubcollectionDoc), because it is the same underlying schedule
 * concept written by the same era of hmd-lineup code.
 *
 * ── THE BUG THIS FLATTENS ───────────────────────────────────────────────────
 * hmd-lineup's AlertPresetsTab writes `{ name, description, schedule: { type,
 * value }, message, show_in_app }`
 * (hmd-lineup/src/routes/TeamSettings/components/AlertPresetsTab/
 * AlertPresetsTab.js:63-72, DEFAULT_PRESET). Linyup's `AlertPreset`
 * (apps/web/src/app/[locale]/(auth)/settings/team/page.tsx:127-135) is `{
 * name, description?, schedule_type, schedule_value?, message, show_in_app?
 * }` — flat, not nested. The one place a preset is actually USED —
 * `applyPreset` in apps/web/src/app/[locale]/(auth)/contacts/[id]/page.tsx:
 * 3909-3926 — reads `preset.schedule_type` / `preset.schedule_value`
 * directly and writes them straight into a new `contact_alerts` doc via the
 * CLIENT SDK's `addDoc`. A migrated preset has neither field (only the
 * nested `schedule` object), so `schedule_type` resolves to `undefined` —
 * which the web Firestore SDK also rejects on write (same default behavior
 * as the Admin SDK: no value, not an omission), throwing instead of
 * creating the alert. The preset list itself renders `AlertPresetRecord`
 * (contacts/[id]/page.tsx:753-760), which is the same flat shape.
 */

export function transformAlertPreset(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...src }
  const schedule = out.schedule as { type?: unknown; value?: unknown } | undefined

  if (schedule) {
    out.schedule_type = schedule.type
    out.schedule_value = schedule.value
    delete out.schedule
  }

  return out
}
