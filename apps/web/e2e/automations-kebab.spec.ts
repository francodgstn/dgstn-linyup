import { test, expect } from './fixtures'

// This is a regression guard for a real, previously-confirmed limitation: this
// app's dropdown menus (base-ui, packages/functions unrelated) failed to open
// under the in-app Browser pane's synthetic input (ref-clicks, dispatched
// PointerEvents, keyboard) while remaining fully clickable under real
// Playwright input. That gap is what motivated adding this suite at all — if
// a future base-ui/Radix upgrade ever regresses REAL click handling too, this
// is the test that should catch it, not a person noticing a menu is dead.
//
// Scoped to `main` (excludes the sidebar studio-switcher, which uses the same
// `data-slot="dropdown-menu-trigger"` and sits earlier in the DOM — matching
// `.first()` unscoped grabs that one instead, as the spike that wrote this
// test discovered).
test('an automation card kebab menu opens and lists its actions', async ({ page }) => {
  await page.goto('/automations', { waitUntil: 'domcontentloaded' })

  const trigger = page.locator('main [data-slot="dropdown-menu-trigger"]').first()
  await trigger.waitFor({ state: 'visible' })
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  await trigger.click()

  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-slot="dropdown-menu-positioner"]')).toBeVisible()

  const items = page.locator('[data-slot="dropdown-menu-item"], [role="menuitem"]')
  await expect(items.first()).toBeVisible()
  expect(await items.count()).toBeGreaterThan(0)
})
