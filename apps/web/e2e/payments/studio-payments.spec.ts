/**
 * The studio's side of the money, signed in as the seeded owner:
 *
 *   payment link   → Payments → "Create payment link" → a new person pays it on
 *                    Stripe → a contact, a member_subscriptions row, the plan
 *   refund         → that payment's row → "Refund" → Stripe refunds it and the
 *                    member_payments row says so
 *   manual payment → a contact's Payments tab → "Record payment" (cash) → a
 *                    payment_events row and the plan → "Void" → both taken back
 *   Tarif 595      → that payment's row → "Tarif 595 receipt" → issued with its
 *                    files, downloaded by the studio AND by the member in Space
 *   QR-bill        → install the plugin → invoice a contact → PDF → mark paid
 *                    (which records the payment on the manual rail)
 *   gift card      → Payments → Gift cards → "Issue gift card" (paid in cash)
 *   appointment    → Schedule → New appointment → "Send payment link" → the
 *                    client pays the link → the booking confirmed
 *
 * Runs in order in one staff context.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  ACCT,
  BASE_URL,
  STUDIO,
  captureCallable,
  clearCodesFor,
  clearRateLimits,
  contactSignIn,
  db,
  deleteContactsByEmail,
  findContactsByEmail,
  payOnStripeCheckout,
  staffContext,
  stripe,
  waitFor,
  watchErrors,
} from './lib'

const LINK_EMAIL = 'e2e-payment-link@example.com'

test.describe.configure({ mode: 'serial' })

let context: BrowserContext
let page: Page
let errors: string[]
let linkPaymentIntent = ''

test.beforeAll(async ({ browser }) => {
  await deleteContactsByEmail(STUDIO.teamId, LINK_EMAIL)
  context = await staffContext(browser)
  page = await context.newPage()
  errors = watchErrors(page, [
    // The refund test's deliberate partial refusal (a 400 by design).
    /refundMemberPayment/,
    /status of 400/,
    // Dev-server artefacts, not the product: under `next dev --webpack` the staff
    // layout's server render trips over jsdom's bundled stylesheet path (the
    // client then renders normally), and next-themes' inline script warns.
    // docs/launch/payments-e2e-2026-09.md, "Dev-only noise".
    /status of 500/,
    /Encountered a script tag/,
  ])
})

test.afterAll(async () => {
  await context?.close()
})

test('payment link: the studio sends a Premium link and a new person pays it', async ({ browser }) => {
  await page.goto('/payments', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Create payment link' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').nth(0).click()
  await page.getByRole('option', { name: 'Premium' }).click()
  await dialog.getByRole('combobox').nth(1).click()
  await page.getByRole('option', { name: /139/ }).first().click()
  await dialog.getByPlaceholder('member@example.com').fill(LINK_EMAIL)
  const box = await captureCallable(page, 'createMembershipPayment')
  await dialog.getByRole('button', { name: 'Generate link' }).click()
  const url = await waitFor('the generated link', async () => box.body?.result?.url as string | undefined, 120_000)
  expect(url).toContain('checkout.stripe.com')
  await expect(dialog.locator('input[readonly]')).toHaveValue(url)

  // The member opens the link somewhere else entirely.
  const member = await browser.newContext()
  const m = await member.newPage()
  await m.goto(url)
  await payOnStripeCheckout(m, { email: LINK_EMAIL, name: 'Lina Link' })
  await m.waitForURL(/\/pay\/result|localhost/, { timeout: 120_000 })
  await member.close()

  const sessionId = url.match(/cs_test_[A-Za-z0-9]+/)![0]
  const cs = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['invoice'] }, { stripeAccount: ACCT[STUDIO.teamId] })
  expect(cs.status).toBe('complete')
  expect(cs.amount_total).toBe(13900)
  const subId = typeof cs.subscription === 'string' ? cs.subscription : cs.subscription!.id

  const contact = await waitFor('the contact created by the payment', async () => (await findContactsByEmail(STUDIO.teamId, LINK_EMAIL))[0])
  const sub = await waitFor('member_subscriptions row', async () => {
    const d = await db.doc(`teams/${STUDIO.teamId}/member_subscriptions/${subId}`).get()
    return d.exists ? d.data()! : null
  })
  expect(sub.contactId ?? sub.contact_id).toBe(contact.id)

  // The first invoice's charge is the member payment the studio can refund. Two
  // webhook events write this row and either may land first: wait for the one
  // that dates it, or the list (ordered by created_at) cannot show it yet.
  const pay = await waitFor('the member payment of the first invoice', async () => {
    const q = await db
      .collection(`teams/${STUDIO.teamId}/member_payments`)
      .where('contactId', '==', contact.id)
      .get()
    return q.docs.find((d) => d.data().created_at && d.data().amount === 13900) ?? null
  })
  linkPaymentIntent = pay.id
})

test('refund: a partial refund of a membership is explained, then the full amount goes back', async () => {
  test.skip(!linkPaymentIntent, 'needs the payment from the previous test')
  await page.goto('/payments', { waitUntil: 'domcontentloaded' })
  const row = page.getByRole('row', { name: /Lina Link/ }).first()
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Refund' }).click()
  const dialog = page.locator('[role=dialog], [role=alertdialog]').last()

  // A subscription may be a class pack (divisible) or a plan (not); the client
  // cannot tell, so it offers the partial and renders the server's refusal
  // inline, next to the way out (RefundPaymentDialog.tsx header).
  await dialog.getByText('Refund a different amount').click()
  await dialog.getByRole('spinbutton').fill('39')
  const partial = await captureCallable(page, 'refundMemberPayment')
  await dialog.getByRole('button', { name: /^Refund CHF\s?39/ }).click()
  await expect.poll(() => partial.status, { timeout: 120_000 }).toBe(400)
  await expect(dialog.getByText(/can only be refunded in full/)).toBeVisible()
  await page.unroute('**/refundMemberPayment')

  await dialog.getByText('Refund the full amount instead').click()
  const full = await captureCallable(page, 'refundMemberPayment')
  await dialog.getByRole('button', { name: /^Refund CHF\s?139/ }).click()
  await expect.poll(() => full.status, { timeout: 120_000 }).toBe(200)
  expect(full.body?.result?.reversal?.state).not.toBe('failed')
  await expect(page.getByText('Refunded.').first()).toBeVisible()

  const refunds = await stripe.refunds.list({ payment_intent: linkPaymentIntent }, { stripeAccount: ACCT[STUDIO.teamId] })
  expect(refunds.data.reduce((sum, r) => sum + r.amount, 0)).toBe(13900)
  await waitFor('member_payments shows the refund', async () => {
    const d = (await db.doc(`teams/${STUDIO.teamId}/member_payments/${linkPaymentIntent}`).get()).data()
    return d?.amount_refunded === 13900 ? true : null
  })
})

// OPEN DECISION (docs/launch/payments-e2e-2026-09.md, "Refunding a Stripe-billed
// membership"). The dialog says a refund "takes back what the payment gave: the
// membership it set up", but reversePaymentEffects only clears a plan a ONE-OFF
// payment set (`subscription_source_ref`): a Stripe-billed subscription records
// `skipped_not_owner`, stays active, and bills again next month. Whether the
// refund should cancel it or only say so is the studio-facing call this waits on.
test.fixme('refund: a full refund of a membership\'s only payment ends the membership', async () => {
  const [contact] = await findContactsByEmail(STUDIO.teamId, LINK_EMAIL)
  const c = (await contact.ref.get()).data()!
  const held = (c.held_plans ?? []) as Array<{ subscription_type_id?: string }>
  expect(held.map((h) => h.subscription_type_id)).not.toContain('seed-team-studio-sub-premium')
})

/** Emma Schneider: seeded, joined, no plan. */
const EMMA = 'seed-team-studio-contact-005'
const EMMA_EMAIL = 'emma.schneid.seed-team-studio@email.com'
let manualRef = ''

test('manual payment: cash for a Starter month gives Emma the plan', async () => {
  // A rerun's leftovers: previous manual records for Emma and the plan they set.
  const old = await db.collection(`teams/${STUDIO.teamId}/payment_events`).where('contact_id', '==', EMMA).get()
  for (const d of old.docs) await d.ref.delete()
  // …and the plan grants those records made, keyed `manual:{ref}`, which the
  // held_plans mirror would otherwise keep answering "Starter" from.
  const grants = await db.collection(`contacts/${EMMA}/plan_grants`).get()
  for (const g of grants.docs) if (g.id.startsWith('manual:')) await g.ref.delete()
  await waitFor('Emma back to no plan', async () => {
    const c = (await db.doc(`contacts/${EMMA}`).get()).data()!
    return JSON.stringify(c.held_plans ?? []).includes('seed-team-studio-sub-starter') ? null : true
  })

  await page.goto(`/contacts/${EMMA}?tab=payments&seg=payments`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Record payment' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input').first().fill('89')
  // comboboxes in order: method, what-was-paid kind, plan, price
  await dialog.getByRole('combobox').nth(1).click()
  await page.getByRole('option', { name: 'Subscription', exact: true }).click()
  await dialog.getByRole('combobox').nth(2).click()
  await page.getByRole('option', { name: 'Starter' }).click()
  await dialog.getByRole('combobox').nth(3).click()
  await page.getByRole('option').first().click()
  const box = await captureCallable(page, 'recordManualPayment')
  await dialog.getByRole('button', { name: 'Record payment' }).click()
  await expect.poll(() => box.status, { timeout: 120_000 }).toBe(200)

  const ev = await waitFor('the manual payment_events row', async () => {
    const q = await db.collection(`teams/${STUDIO.teamId}/payment_events`).where('contact_id', '==', EMMA).get()
    return q.docs[0] ?? null
  })
  manualRef = ev.id
  const e = ev.data()
  expect(e.gateway ?? e.source).toMatch(/manual/)
  expect(e.amount ?? e.amount_minor).toBeTruthy()
  await waitFor('Starter on Emma', async () => {
    const c = (await db.doc(`contacts/${EMMA}`).get()).data()!
    return JSON.stringify(c.held_plans ?? []).includes('seed-team-studio-sub-starter') ? true : null
  })
  await expect(page.locator('tr', { hasText: 'CHF 89.00' }).first()).toBeVisible()
})

test('Tarif 595: a receipt is issued from that payment, downloaded by both sides, and voided', async ({ browser }) => {
  test.skip(!manualRef, 'needs the record from the previous test')
  // Emma is one of the seeded contacts with insurer data, and the seed maps
  // every offering (to 9999), so the only thing left to do is issue.
  const oldReceipts = await db.collection(`teams/${STUDIO.teamId}/tarif595_receipts`).where('contact_id', '==', EMMA).get()
  for (const d of oldReceipts.docs) await d.ref.delete()

  await page.goto(`/contacts/${EMMA}?tab=payments&seg=payments`, { waitUntil: 'domcontentloaded' })
  const row = page.locator('tr', { hasText: 'CHF 89.00' }).first()
  await row.getByRole('button', { name: 'More actions' }).click()
  // The dialog previews on its own as soon as it has a source and a period.
  const preview = await captureCallable(page, 'previewTarif595Receipt')
  await page.getByRole('menuitem', { name: 'Tarif 595 receipt' }).click()
  const dialog = page.getByRole('dialog')
  // The period is the month this payment paid for, not the plan row's span
  // (which, for a plan started today, is today alone).
  const paidOn = new Date().toISOString().slice(0, 10)
  const [y, m, d] = paidOn.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const monthEnd = new Date(Date.UTC(y, m, Math.min(d, lastDay) - 1)).toISOString().slice(0, 10)
  await expect(dialog.locator('#t595-fp-from')).toHaveValue(paidOn)
  await expect(dialog.locator('#t595-fp-to')).toHaveValue(monthEnd)
  await expect.poll(() => preview.status, { timeout: 120_000 }).toBe(200)
  await expect(dialog.getByText('Total: CHF 89.00')).toBeVisible()
  // The dialog must fit its content: the footer's button inside the dialog box.
  const box = await dialog.boundingBox()
  const btn = await dialog.getByRole('button', { name: 'Issue receipt' }).boundingBox()
  expect(btn!.x + btn!.width).toBeLessThanOrEqual(box!.x + box!.width + 1)
  const issue = await captureCallable(page, 'issueTarif595Receipt')
  await dialog.getByRole('button', { name: 'Issue receipt' }).click()
  await expect.poll(() => issue.status, { timeout: 120_000 }).toBe(200)

  const receipt = await waitFor('the issued receipt with its files', async () => {
    const q = await db.collection(`teams/${STUDIO.teamId}/tarif595_receipts`).where('contact_id', '==', EMMA).get()
    const d = q.docs.find((x) => x.data().status === 'issued' && x.data().files?.pdf)
    return d ?? null
  })
  const r = receipt.data()
  expect(r.number).toMatch(/^RB-\d{4}-\d{5}$/)
  expect(r.totals).toBeTruthy()

  // The plugin page lists it; the PDF downloads through the verified callable.
  await page.goto('/plugins/tarif-595', { waitUntil: 'domcontentloaded' })
  const rrow = page.getByRole('listitem').filter({ hasText: r.number }).first()
  await expect(rrow).toBeVisible({ timeout: 60_000 })
  const download = page.waitForEvent('download', { timeout: 120_000 })
  await rrow.getByRole('button', { name: 'Actions' }).click()
  await page.getByRole('menuitem', { name: 'Download PDF' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/\.pdf$/)

  // The member's own copy: Emma signs into her Space and downloads it there,
  // through the contact door of the same download callable.
  const member = await browser.newContext({ baseURL: BASE_URL })
  const mp = await member.newPage()
  await clearCodesFor(EMMA_EMAIL)
  await clearRateLimits()
  await mp.goto(`/public/${STUDIO.slug}/space/receipts`, { waitUntil: 'domcontentloaded' })
  // The wall's button does nothing until the page has hydrated: retry until
  // the dialog is up rather than racing the first render.
  await expect(async () => {
    await mp.getByRole('button', { name: /^Sign in/ }).last().click()
    await expect(mp.getByPlaceholder('your@email.com')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
  await contactSignIn(mp, EMMA_EMAIL)
  const mine = mp.getByRole('listitem').filter({ hasText: r.number }).or(mp.locator('tr', { hasText: r.number })).first()
  await expect(mine).toBeVisible({ timeout: 60_000 })
  const memberDownload = mp.waitForEvent('download', { timeout: 120_000 })
  await mine.getByRole('button', { name: 'PDF' }).click()
  expect((await memberDownload).suggestedFilename()).toMatch(/\.pdf$/)
  await member.close()

  await rrow.getByRole('button', { name: 'Actions' }).click()
  await page.getByRole('menuitem', { name: 'Void' }).click()
  const confirm = page.locator('[role=dialog], [role=alertdialog]').last()
  const voided = await captureCallable(page, 'voidTarif595Receipt')
  await confirm.getByRole('button', { name: /void/i }).last().click()
  await expect.poll(() => voided.status, { timeout: 120_000 }).toBe(200)
  await waitFor('the receipt voided', async () => ((await receipt.ref.get()).data()!.status === 'voided' ? true : null))
})

test('void: the manual record is voided and takes the plan back', async () => {
  test.skip(!manualRef, 'needs the record from the previous test')
  await page.goto(`/contacts/${EMMA}?tab=payments&seg=payments`, { waitUntil: 'domcontentloaded' })
  const row = page.locator('tr', { hasText: 'CHF 89.00' }).first()
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Void' }).click()
  const dialog = page.locator('[role=dialog], [role=alertdialog]').last()
  await expect(dialog.getByText(/takes back what the record gave/)).toBeVisible()
  const box = await captureCallable(page, 'voidManualPayment')
  await dialog.getByRole('button', { name: 'Void payment' }).click()
  await expect.poll(() => box.status, { timeout: 120_000 }).toBe(200)
  await expect(page.getByText('Payment voided.').first()).toBeVisible()

  await waitFor('the record voided', async () => {
    const d = (await db.doc(`teams/${STUDIO.teamId}/payment_events/${manualRef}`).get()).data()
    return d && (d.status === 'voided' || d.voided_at) ? true : null
  })
  await waitFor('Starter taken back from Emma', async () => {
    const c = (await db.doc(`contacts/${EMMA}`).get()).data()!
    return JSON.stringify(c.held_plans ?? []).includes('seed-team-studio-sub-starter') ? null : true
  })
})

test('QR-bill invoices: install, invoice Emma, download, mark paid', async () => {
  // Not installed by the seed: install it the way a studio would.
  const installed = await db.doc(`teams/${STUDIO.teamId}/installed_plugins/qr-invoices`).get()
  if (!installed.exists || installed.data()?.status !== 'active') {
    await page.goto('/plugins', { waitUntil: 'domcontentloaded' })
    // The card is itself role=button with its buttons nested inside, so the
    // accessibility tree flattens them away: reach Install through the DOM.
    const card = page.locator('[role=button]').filter({ hasText: 'QR-bill invoices' }).first()
    await card.locator('button', { hasText: 'Install' }).click()
    const confirm = page.locator('[role=dialog], [role=alertdialog]')
    if (await confirm.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await confirm.last().getByRole('button', { name: /install/i }).last().click()
    }
    await waitFor('the plugin installed', async () => {
      const d = await db.doc(`teams/${STUDIO.teamId}/installed_plugins/qr-invoices`).get()
      return d.exists && d.data()?.status === 'active' ? true : null
    }, 180_000)
  }

  await page.goto(`/contacts/${EMMA}?tab=payments&seg=payments`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Create QR-bill invoice' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: 'Other', exact: true }).click()
  await dialog.getByLabel('Amount (CHF)').fill('120')
  await dialog.getByLabel('Description').fill('Private lessons, October')
  const created = await captureCallable(page, 'createInvoice')
  await dialog.getByRole('button', { name: 'Create QR-bill invoice' }).click()
  await expect.poll(() => created.status, { timeout: 120_000 }).toBe(200)

  const invoice = await waitFor('the invoice with its PDF', async () => {
    const q = await db.collection(`teams/${STUDIO.teamId}/invoices`).where('contact_id', '==', EMMA).get()
    return q.docs.find((d) => d.data().status === 'open' && d.data().files?.pdf) ?? null
  })
  const inv = invoice.data()
  expect(inv.amount_minor).toBe(12000)
  expect(inv.reference?.type).toMatch(/QRR|SCOR/)

  await page.goto('/plugins/qr-invoices', { waitUntil: 'domcontentloaded' })
  const row = page.getByRole('listitem').filter({ hasText: inv.number }).or(page.locator('tr', { hasText: inv.number })).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  const download = page.waitForEvent('download', { timeout: 120_000 })
  await row.getByRole('button', { name: 'Invoice actions' }).click()
  await page.getByRole('menuitem', { name: 'Download PDF' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/)

  await row.getByRole('button', { name: 'Invoice actions' }).click()
  await page.getByRole('menuitem', { name: 'Mark as paid' }).click()
  const confirm = page.locator('[role=dialog], [role=alertdialog]').last()
  const paid = await captureCallable(page, 'markInvoicePaid')
  await confirm.getByRole('button', { name: 'Mark as paid' }).click()
  await expect.poll(() => paid.status, { timeout: 120_000 }).toBe(200)

  // "Mark as paid" records the payment through the manual rail: one
  // payment_events row, and the invoice points at it.
  const after = await waitFor('the invoice paid', async () => {
    const d = (await invoice.ref.get()).data()!
    return d.status === 'paid' && d.paid?.payment_event_id ? d : null
  })
  const ev = (await db.doc(`teams/${STUDIO.teamId}/payment_events/${after.paid.payment_event_id}`).get()).data()
  expect(ev?.contact_id).toBe(EMMA)
})

test('gift card at the desk: a CHF 40 card sold for cash is minted and recorded', async () => {
  await page.goto('/payments?tab=giftCards', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Issue gift card' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[type=number], input[inputmode=decimal]').first().fill('40')
  await dialog.getByText('Paid (cash / bank / TWINT)').click()
  const issued = await captureCallable(page, 'issueGiftCard')
  await dialog.getByRole('button', { name: /^Issue/ }).last().click()
  await expect.poll(() => issued.status, { timeout: 120_000 }).toBe(200)
  const code: string = issued.body?.result?.code
  expect(code).toMatch(/^GC-/)
  await expect(page.getByText(`Gift card ${code} issued.`)).toBeVisible()

  const card = (await db.doc(`teams/${STUDIO.teamId}/gift_cards/${code}`).get()).data()!
  expect(card.balance).toBe(40)
  expect(card.issue_kind).toBe('admin_paid')
  // A paid card is money in: a manual payment row records it.
  await waitFor('the manual payment for the card', async () => {
    const q = await db.collection(`teams/${STUDIO.teamId}/payment_events`).where('gift_card_code', '==', code).get()
    if (!q.empty) return true
    const all = await db.collection(`teams/${STUDIO.teamId}/payment_events`).orderBy('created_at', 'desc').limit(5).get()
    return all.docs.some((d) => JSON.stringify(d.data()).includes(code)) ? true : null
  })
})

const APPT_LINK_EMAIL = 'e2e-appointment-link@example.com'

test('appointment payment link: staff books a new client and the emailed link is paid', async ({ browser }) => {
  await deleteContactsByEmail(STUDIO.teamId, APPT_LINK_EMAIL)
  await page.goto('/schedule', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New appointment' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('New appointment').first()).toBeVisible()
  // Coach and today's next free hour come prefilled; the activity may still be
  // loading, so it is chosen explicitly, and with it the priced 1h length.
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: '1-on-1 Coaching' }).click()
  await dialog.getByRole('button', { name: /^1h\s*CHF 85/ }).click()
  await dialog.getByRole('button', { name: 'New', exact: true }).click()
  await dialog.getByPlaceholder('First name').fill('Paula')
  await dialog.getByPlaceholder('Last name').fill('Paylink')
  await dialog.getByPlaceholder('Email').fill(APPT_LINK_EMAIL)
  await dialog.getByRole('combobox').filter({ hasText: 'Paid (offline)' }).click()
  await page.getByRole('option', { name: 'Send payment link' }).click()
  const box = await captureCallable(page, 'createStaffAppointment')
  await dialog.getByRole('button', { name: 'Book appointment' }).click()
  await expect
    .poll(async () => (box.status ? box.status : (await dialog.innerText().catch(() => '')).replace(/\n+/g, ' | ')), {
      timeout: 120_000,
    })
    .toBe(200)
  const { sessionId, paymentUrl } = box.body!.result as { sessionId: string; paymentUrl: string }
  expect(paymentUrl).toContain('checkout.stripe.com')
  // Unpaid until the webhook says otherwise.
  expect((await db.doc(`sessions/${sessionId}`).get()).data()?.status).not.toBe('full')

  // The client opens the emailed link on their own device and pays.
  const client = await browser.newContext()
  const c = await client.newPage()
  await c.goto(paymentUrl)
  await payOnStripeCheckout(c, { email: APPT_LINK_EMAIL, name: 'Paula Paylink' })
  await c.waitForURL(/\/pay\/result/, { timeout: 120_000 })
  expect(c.url()).toContain('status=success')
  await client.close()

  const cs = await stripe.checkout.sessions.retrieve(paymentUrl.match(/cs_test_[A-Za-z0-9]+/)![0], undefined, {
    stripeAccount: ACCT[STUDIO.teamId],
  })
  expect(cs.amount_total).toBe(8500)
  await waitFor('the appointment paid and confirmed', async () => {
    const s = (await db.doc(`sessions/${sessionId}`).get()).data()
    const [contact] = await findContactsByEmail(STUDIO.teamId, APPT_LINK_EMAIL)
    if (!s || !contact) return null
    const b = (await db.doc(`sessions/${sessionId}/bookings/${contact.id}`).get()).data()
    return b && b.status === 'confirmed' && b.payment_status !== 'required' ? true : null
  })
})

test('no console errors on the staff pages', async () => {
  expect(errors, errors.join('\n')).toEqual([])
})
