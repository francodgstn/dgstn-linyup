/**
 * THREE ORG-TIER CLAIMS THAT ONLY THE SOURCE CAN SETTLE (UX-33 / UX-34 / UX-35).
 *
 * Each of the three is a property of the TEXT — which guard sits in front of a
 * callable, which callable the client actually calls, which field a sweep reads
 * — and two of them cross the functions/web boundary, which is where a
 * correction stops travelling. Same idiom, and for the same reason, as
 * `../saas-billing/billingRails.test.ts` and `../connect/commitSites.test.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')
const WEB = join(SRC, '..', '..', '..', 'apps', 'web', 'src')
const ROOT = join(SRC, '..', '..', '..')

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
}
function readWeb(rel: string): string {
  return readFileSync(join(WEB, rel), 'utf8').replace(/\r\n/g, '\n')
}
function readRoot(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}
/** Every .ts file under packages/functions/src, as a path relative to it — so a
 *  named call-site list below is checked against the TREE rather than trusted. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(relative(SRC, full).split('\\').join('/'))
  }
  return out
}
/** CODE only — the files under test explain the bug in prose, and the prose
 *  necessarily names the thing that must not appear in the code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** The org member rail, named — a member added here must be added below.
 *  It spans TWO files since decision 12: `orgs/members.ts` holds the direct
 *  grant and the role/removal callables, `orgs/memberInvitations.ts` the
 *  invitation lifecycle. Both are read together below, because the property
 *  under test ("the Members tab's callables exist and are org-authorized") is
 *  about the RAIL, not about a file. */
const MEMBER_CALLABLES = [
  'addOrgMember',
  'updateOrgMemberRole',
  'removeOrgMember',
  'inviteOrgMember',
  'revokeOrgMemberInvitation',
] as const

// ─────────────────────────────────────────────────────────────────────────────
// UX-34 — the org Members tab called three callables that did not exist
// ─────────────────────────────────────────────────────────────────────────────

describe('org member management (UX-34)', () => {
  const members = `${read('orgs/members.ts')}
${read('orgs/memberInvitations.ts')}`

  it('every callable the Members tab invokes actually exists', () => {
    const page = readWeb('app/[locale]/(auth)/org/[orgId]/members/page.tsx')
    const invoked = [...page.matchAll(/httpsCallable\(functions,\s*'([^']+)'/g)].map((m) => m[1])
    assert.ok(invoked.length > 0, 'the Members tab invokes no callable at all — did the file move?')
    for (const name of invoked) {
      assert.ok(
        members.includes(`export const ${name} = onCall(`),
        `the Members tab calls '${name}', which is not declared in orgs/members.ts`
      )
    }
  })

  it('is authorized through org_members, never team_members (UX-75s model)', () => {
    for (const name of MEMBER_CALLABLES) {
      const body = members.split(`export const ${name} = onCall(`)[1]
      assert.ok(body, `${name} is not declared in orgs/members.ts`)
      const decl = body.split('\n})')[0]
      assert.ok(
        decl.includes('await assertOrgAdmin('),
        `${name} does not go through assertOrgAdmin — an unguarded org callable`
      )
    }
    const src = code(members)
    assert.ok(
      !/hasTeamRole|assertOwner|assertManager/.test(src),
      'the org member rail must not reach for a team_members check — an org admin has no team_members document'
    )
  })

  it('is exported from the functions entrypoint, or it does not exist at runtime', () => {
    const entry = read('index.ts')
    for (const name of MEMBER_CALLABLES) {
      assert.ok(entry.includes(name), `${name} is not exported from src/index.ts`)
    }
  })

  it('an organisation can never be left with no admin', () => {
    // Both callables that can TAKE an admin away consult the guard, and the
    // guard runs inside the transaction that performs the write — otherwise two
    // admins removing each other concurrently both pass.
    for (const name of ['updateOrgMemberRole', 'removeOrgMember'] as const) {
      const decl = members.split(`export const ${name} = onCall(`)[1].split('\n})')[0]
      assert.ok(decl.includes('assertNotLastAdmin(tx'), `${name} does not guard the last admin`)
      assert.ok(
        decl.includes('runTransaction'),
        `${name}'s last-admin guard is outside a transaction`
      )
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UX-33 — a door nobody can pay through must not be offered
// ─────────────────────────────────────────────────────────────────────────────

describe('priced doors follow the ability to be paid (UX-33)', () => {
  it('the public profile mirrors BOTH halves of the server-side answer', () => {
    // `loadEnabledTeam` enforces the operator kill-switch and
    // `requireChargeableAccount` the account status; the mirror that public
    // surfaces read must not answer with only one of them.
    const sync = read('sync/syncTeamPublicProfile.ts')
    assert.ok(sync.includes('payments_enabled: paymentsEnabled'))
    const derivation = sync.split('const paymentsEnabled =')[1].split('\n')[0]
    assert.ok(derivation.includes('connectEnabled !== false'), 'the kill-switch half is missing')
    assert.ok(derivation.includes("connectStatus === 'enabled'"), 'the chargeable half is missing')
  })

  it('the shop surface is live only when there is a till', () => {
    const sync = read('sync/syncTeamPublicProfile.ts')
    assert.ok(
      /const shopActive = paymentsEnabled\b/.test(sync),
      'shopActive must derive from paymentsEnabled — a plugin install is not a payment method'
    )
  })

  // APPOINTMENTS ARE THE ONE EXCEPTION TO UX-33's HIDING, on purpose.
  //
  // This used to assert that `listAvailability` DROPS priced durations a studio
  // cannot charge for. That produced the wrong sentence at the worst moment: a
  // visitor who reached one anyway was told "This slot is no longer available",
  // which is false — the slot was fine, the studio simply had no Stripe account.
  //
  // Franco chose to let them book it and settle at the studio (2026-08-28), so
  // the length stays on the menu and the money moves in person. The rest of
  // UX-33 is untouched: the shop, the drop-in price and the priced trial still
  // fail closed, because each of those IS a purchase with nothing to hand over
  // at a door.
  it('an unchargeable studio still offers its priced lengths, marked for the door', () => {
    const window = read('appointments/window.ts')
    assert.ok(
      window.includes('const settleAtStudio = !paymentsAreChargeable('),
      'the listing must resolve settle-at-studio through the shared predicate'
    )
    assert.ok(
      !window.includes("resolveDurationSale(d).mode !== 'priced'"),
      'the listing drops priced durations again — an unchargeable studio loses the booking'
    )
    assert.ok(
      window.includes('return { coaches, settleAtStudio }'),
      'the client cannot label the door without the flag'
    )
  })

  it('the booking door is settled in person, in the state the desk already clears', () => {
    const window = read('appointments/window.ts')
    // The refusal must be conditional now — unconditional means the picker's
    // false dead end is back.
    assert.ok(
      window.includes("if (priceOption?.type === 'pay' && !settleAtStudio)"),
      'a payable caller at an unchargeable studio must not be refused'
    )
    // And it must land in the SAME shape the staff link rail leaves behind, so
    // markAppointmentPaid closes it with no new branch.
    assert.ok(
      window.includes("payment_status: 'required' as const") && window.includes('settle_at_studio: true'),
      'an owed booking must carry what is owed, in the state the desk already settles'
    )
  })

  it('the toggle reaches VISITORS, not just the settings screen', () => {
    // `bookingSettings.appointmentsEnabled` had exactly one web reader, imported
    // only by `(auth)` routes, so switching it off hid nothing public. It is
    // enforced at the callable rather than on the page because that is the one
    // door every client goes through — web, mobile, and anything added later.
    const window = read('appointments/window.ts')
    assert.ok(
      window.includes('if (!appointmentsEnabled) return { coaches: [], settleAtStudio }'),
      'listAvailability must refuse to list when the studio turned bookable hours off'
    )
    assert.ok(
      window.includes("?.appointmentsEnabled !== false"),
      'absent must mean ON, matching appointmentPickerLive — a studio that never ' +
        'touched the switch still has bookable hours'
    )
  })

  it('the content probe does not re-apply the filter listAvailability dropped', () => {
    // The probe mirrored "priced durations drop out without Connect". Now that
    // those are settled at the studio instead, keeping the filter here would
    // mark the surface dead over a picker that works.
    const sync = read('sync/syncTeamPublicProfile.ts')
    assert.ok(
      !sync.includes("resolveDurationSale(d).mode !== 'priced'"),
      'the appointment content probe filters priced durations again — a studio ' +
        'whose only lengths are priced would be reported as having no picker'
    )
  })

  it('ONE predicate answers "can this studio take money"', () => {
    // The listing decides what to offer and the booking decides which door the
    // offer opens; if they compute it separately they will eventually disagree,
    // and the visible form of that is a price nothing can take.
    const access = read('connect/access.ts')
    assert.ok(access.includes('export function paymentsAreChargeable('))
    const window = read('appointments/window.ts')
    assert.equal(
      (window.match(/paymentsAreChargeable\(/g) ?? []).length,
      2,
      'both the listing and the booking must go through the shared predicate'
    )
  })

  it('the booking form suppresses the drop-in and the PRICED trial, never the free one', () => {
    const form = readWeb('app/[locale]/(public)/public/[slug]/booking/BookingForm.tsx')
    const trialDoor = form.split('function trialDoorOpen(')[1].split('\n}')[0]
    assert.ok(
      trialDoor.includes("paymentsEnabled || typeof a.trialPriceAmount !== 'number'"),
      'a FREE trial must stay open when the studio cannot take money'
    )
    const dropIn = form.split('function dropInPriceOf(')[1].split('\n}')[0]
    assert.ok(dropIn.includes('if (!paymentsEnabled) return null'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UX-35 — org_id ⇒ the organisation plan
// ─────────────────────────────────────────────────────────────────────────────

describe('an org-affiliated team does not own its own billing (UX-35)', () => {
  it('the trial sweep never downgrades a team an organisation bills', () => {
    const billing = read('saas-billing/index.ts')
    const phase = billing
      .split('Phase 1 — lapsed trials')[1]
      .split('Phase 2 — lapsed ORGANISATION')[0]
    assert.ok(
      /if \(doc\.data\(\)\.org_id\)/.test(phase),
      'handleTrialLifecycle must skip org-affiliated teams — the org subscription governs them'
    )
  })

  it('a studio that still pays for itself is REFUSED, not enrolled and charged twice', () => {
    // Accepting puts the studio on the org plan and does not touch its own
    // Stripe subscription, so it went on invoicing while the federation paid
    // too. Cancelling that leftover — the correct move — then fired
    // `subscription.cancelled` into `downgradeTeamToFree` on a paid-up member.
    // Refusing at the door is the chosen answer; see the callable's comment.
    const orgs = read('orgs/index.ts')
    const accept = orgs.split('acceptOrgInvitation = onCall(')[1].split('\n})')[0]
    assert.ok(
      accept.includes("collection('saas_subscriptions').doc(data.teamId)"),
      'acceptOrgInvitation must look at the accepting studio’s OWN subscription'
    )
    assert.ok(
      accept.includes("reason: 'team_has_own_subscription'"),
      'the refusal carries a named reason — the accept page translates on it, not on the message'
    )
    assert.ok(
      /teamSubStatus === 'active' \|\| teamSubStatus === 'past_due'/.test(accept),
      'both statuses that can still take money must refuse'
    )
    // A TRIAL MUST STILL BE ABLE TO JOIN — the ordinary path. It is safe by
    // construction (no subscription doc exists for a trialing team), and the
    // guard must not start naming 'trial'.
    assert.ok(
      !/teamSubStatus === 'trial'/.test(accept),
      'a trialing studio joining a federation is the normal case and must not be refused'
    )
  })

  it('an org-billed studio’s own subscription events cannot speak for it', () => {
    // The gap the refusal cannot close: an event arriving LATE for a
    // subscription that ended before the studio joined. `subscription.updated`
    // carries the old tier (knocking the studio off `plan: 'organization'`),
    // `subscription.cancelled` reaches `downgradeTeamToFree`, and the add-on
    // reconcile DELETES installs whose item the payload does not carry.
    const billing = read('saas-billing/index.ts')
    assert.ok(
      billing.includes('const teamBilledByOrg = '),
      'the webhook must know whether the team it is about is billed by an organisation'
    )
    assert.ok(
      /if \(teamBilledByOrg\) \{/.test(billing),
      'the guard comes BEFORE the cancelled branch, so the teardown is unreachable for such a team'
    )
    assert.ok(
      /entityType === 'team' &&\s*!teamBilledByOrg/.test(billing),
      'the add-on reconcile is guarded too — it deletes installs the org is what grants'
    )
  })

  it('joining an organisation clears the team’s own trial deadline', () => {
    const orgs = read('orgs/index.ts')
    const accept = orgs.split('acceptOrgInvitation = onCall(')[1].split('\n})')[0]
    assert.ok(
      accept.includes('trial_ends_at: FieldValue.delete()'),
      'a stale trial_ends_at on a team whose status mirrors the org is what made the sweep fire'
    )
    assert.ok(
      accept.includes("plan: 'organization'"),
      'org_id and the plan are set together or not at all'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UX-9 — an org trial must END
// ─────────────────────────────────────────────────────────────────────────────

describe('an organisation trial ends (UX-9)', () => {
  const billing = read('saas-billing/index.ts')
  const orgs = read('orgs/index.ts')
  const lifecycle = read('orgs/lifecycle.ts')

  /** The org phase of the daily sweep, sliced out of handleTrialLifecycle. */
  const orgPhase = billing.split('Phase 2 — lapsed ORGANISATION')[1].split('Transitional sweep')[0]
  /** The team phase — everything before the org phase begins. */
  const teamPhase = billing.split('Phase 2 — lapsed ORGANISATION')[0]

  it('the daily sweep actually reads the organizations collection', () => {
    assert.ok(
      orgPhase.includes('.collection(ORGANIZATIONS_COLLECTION)'),
      'phase 2 must sweep organizations — phase 1 sweeps teams and is forbidden from touching an org’s ' +
        'studios (UX-35), so an org trial that no query selects is a trial that never ends'
    )
    assert.ok(orgPhase.includes("where('plan_status', '==', 'trial')"))
    assert.ok(
      orgPhase.includes("where('trial_ends_at', '<=', nowTs)"),
      'the deadline is READ from the document. Deriving it from `created` would make it un-extendable, ' +
        'and an operator-assisted onboarding is exactly the case that needs to move it'
    )
  })

  it('an org and a team share ONE exemption predicate, so they cannot disagree', () => {
    // Both phases used to spell the flag check out, and adding a third flag
    // (`comped`) meant finding both. The shared predicate is now the definition;
    // asserting the CALL rather than the flag names keeps this test true when a
    // fourth flag arrives, while still failing if either phase improvises.
    assert.ok(
      orgPhase.includes('tenantExemptFromTrialSweep(flags)'),
      'the org phase must ask the shared predicate, not re-derive the exemption',
    )
    assert.ok(
      teamPhase.includes('tenantExemptFromTrialSweep(flags)'),
      'the team phase must ask the same predicate as the org phase',
    )
    assert.ok(
      !/flags\?\.(internal|pilot|comped)\s*\|\|/.test(code(billing)),
      'no hand-rolled copy of the exemption may survive anywhere in saas-billing',
    )
  })

  it('the sweep hands off to the ONE org wind-down and never improvises one', () => {
    assert.ok(orgPhase.includes("lapseOrganization(orgId, { reason: 'trial_lapsed' })"))
    assert.ok(
      !/plan(_status)?:\s*'/.test(code(orgPhase)),
      'phase 2 must delegate the whole teardown — a second writer here is how the two tiers drift'
    )
  })

  it('the granted length is a named constant, not a number in a callable', () => {
    const create = orgs.split('createOrganization = onCall(')[1].split('\n})')[0]
    assert.ok(create.includes('ORG_TRIAL_DAYS'), 'createOrganization must grant ORG_TRIAL_DAYS')
    assert.ok(
      !/14 \* 24 \* 60 \* 60 \* 1000/.test(code(orgs)),
      'no 14-day trial is granted anywhere any more — a team’s own trial is TRIAL_DAYS (30) and an ' +
        'org’s is ORG_TRIAL_DAYS'
    )
  })

  it('an org trial is never SHORTER than a team’s', () => {
    const plan = readFileSync(join(SRC, '..', '..', 'shared', 'src', 'types', 'plan.ts'), 'utf8')
    const teamDays = Number(/export const TRIAL_DAYS = (\d+)/.exec(plan)![1])
    const orgDays = Number(/export const ORG_TRIAL_DAYS = (\d+)/.exec(plan)![1])
    assert.ok(
      orgDays >= teamDays,
      `ORG_TRIAL_DAYS (${orgDays}) must be at least TRIAL_DAYS (${teamDays})`
    )
  })

  it('a lapsed organisation cannot re-grant the tier by re-inviting its studios', () => {
    const accept = orgs.split('acceptOrgInvitation = onCall(')[1].split('\n})')[0]
    assert.ok(
      /orgPlanStatus !== 'trial' && orgPlanStatus !== 'active'/.test(accept),
      'accepting IS the grant, so it must refuse for an org whose subscription is not live — otherwise ' +
        'the sweep lapses the org, the admin re-invites, and nothing can lapse it again (the sweep ' +
        "selects 'trial' and the org now rests on 'expired')"
    )
    assert.ok(accept.includes("throw new HttpsError('failed-precondition'"))
  })

  it('the query the sweep runs has an index to run on', () => {
    const indexes = JSON.parse(readRoot('firestore.index.json')) as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>
    }
    const found = indexes.indexes.some(
      (i) =>
        i.collectionGroup === 'organizations' &&
        i.fields.length >= 2 &&
        i.fields[0].fieldPath === 'plan_status' &&
        i.fields[1].fieldPath === 'trial_ends_at'
    )
    assert.ok(
      found,
      'organizations(plan_status, trial_ends_at) is missing from firestore.index.json'
    )
  })

  it('the org wind-down is idempotent about a studio it already handled', () => {
    assert.ok(
      lifecycle.includes("teamSnap.data()?.plan !== 'free'"),
      'a daily sweep that resumes must not re-downgrade or re-email a studio already on Free'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UX-10 — a lapsed org stops mounting what it no longer pays for
// ─────────────────────────────────────────────────────────────────────────────

describe('a lapsed organisation is torn down like a team (UX-10)', () => {
  const billing = read('saas-billing/index.ts')
  const lifecycle = read('orgs/lifecycle.ts')

  it('ONE writer of the downgrade — the org path calls the team’s, never a copy', () => {
    assert.ok(lifecycle.includes("import { downgradeTeamToFree } from '../saas-billing/downgrade'"))
    assert.ok(
      /await downgradeTeamToFree\(teamId, \{ fromTrial[,)]/.test(lifecycle),
      'every member studio goes to Free through the SHARED path'
    )
    assert.ok(
      !/plan:\s*'free'/.test(code(lifecycle)),
      'orgs/lifecycle.ts must not write the Free plan itself — that is a second downgrade writer'
    )
  })

  it('the callers of the one downgrade are named, and nobody else calls it', () => {
    const callers = ['saas-billing/index.ts', 'orgs/lifecycle.ts']
    for (const f of callers) {
      assert.ok(
        read(f).includes('downgradeTeamToFree('),
        `${f} no longer calls downgradeTeamToFree`
      )
    }
    const exempt = new Set([...callers, 'saas-billing/downgrade.ts'])
    for (const f of sourceFiles()) {
      if (exempt.has(f) || f.endsWith('.test.ts')) continue
      assert.ok(
        !read(f).includes('downgradeTeamToFree('),
        `${f} calls downgradeTeamToFree and is not in the list above — add it there deliberately`
      )
    }
  })

  it('the org’s own paid surface comes down too', () => {
    assert.ok(lifecycle.includes("where('status', '==', 'active')"))
    assert.ok(
      lifecycle.includes('unpublishSiteForOrg(orgId)'),
      'the org site must be torn down EXPLICITLY. An org does now have an ' +
        'installed_plugins trigger (plugins/bundleTriggers.ts), but it owns bundle ' +
        'reconciliation only — this lapse path is documented as resumable-not-atomic, and ' +
        'moving a step of it into an eventually-consistent trigger would let a half-run lapse ' +
        'leave a public site up',
    )
  })

  it('dropping a studio to Free BREAKS the org link, deliberately', () => {
    // UX-35s invariant is `org_id ⇒ plan 'organization'`. A Free studio that
    // kept org_id would still merge the org's plugin installs — which an org
    // admin can write from the client — so the membership ends with the plan.
    assert.ok(lifecycle.includes('org_id: FieldValue.delete()'))
    assert.ok(lifecycle.includes("status: 'removed'"))
    assert.ok(lifecycle.includes("removed_reason: 'org_lapsed'"))
  })

  it('the teardown is not one click deep — publishing asks, unpublishing never does', () => {
    const site = read('orgWebsite/index.ts')
    const publish = site.split('publishOrgWebsite = onCall(')[1].split('\n})')[0]
    const unpublish = site.split('unpublishOrgWebsite = onCall(')[1].split('\n})')[0]
    assert.ok(
      publish.includes('await assertOrgSubscriptionLive(orgId)'),
      'the lapse unpublishes the org site but KEEPS the draft, so publishing must ask whether the ' +
        'organisation still pays for that surface'
    )
    assert.ok(
      !unpublish.includes('assertOrgSubscriptionLive'),
      'taking your own page down is always allowed'
    )
    // ONE definition of "is this org paying", read off the document both billing
    // rails write.
    const orgs = read('orgs/index.ts')
    assert.ok(orgs.includes('export async function assertOrgSubscriptionLive('))
  })

  it('a cancelled org subscription routes into the same wind-down', () => {
    assert.ok(billing.includes("lapseOrganization(entityId, { reason: 'subscription_cancelled' })"))
  })

  it('past_due tears NOTHING down — on either tier', () => {
    // Stripe dunning recovers; the teardown does not (course mirrors are
    // deleted and nothing rewrites them, UX-16). A past_due TEAM keeps its plan
    // and its installs and is refused by requirePlan, so a past_due ORG does the
    // same: status propagation and no more.
    // The closing `} else {` is matched WITHOUT pinning its indentation. It used
    // to be `'\n    } else {'`, which made this test a hostage to how deeply the
    // enclosing handler happened to be nested — wrapping handleStripeWebhook in
    // withErrorReporting shifted the body two spaces and the split silently ran
    // past the org branch, failing an assertion about behaviour nobody had
    // touched. The invariant here is "past_due winds nothing down", not "this
    // file is indented four spaces".
    const branch = billing
      .split("} else if (entityType === 'org') {")[1]
      .split(/\n\s*\} else \{/)[0]
    const pastDue = branch.split("update.status === 'past_due'")[1]
    assert.ok(
      !pastDue.includes('lapseOrganization('),
      'past_due must not wind an organisation down'
    )
    assert.ok(
      pastDue.includes('plan_status: update.status'),
      'past_due still propagates the status'
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UX-16 follow-up — an org lapse must not take away a course somebody BOUGHT
// ─────────────────────────────────────────────────────────────────────────────
//
// The `purchases/{contactId}` entitlement always survives a downgrade; the
// `courses/{id}/public_profile/{id}` mirror is what the Space resolves a course
// slug through, so deleting it is what actually takes the course away. Nothing
// rewrites a mirror on reinstall, so the deletion is one-way.
//
// The claim under test spans TWO files and is false unless both hold: sparing
// the mirrors in the downgrade is undone by `onInstalledPluginStatusChange` —
// which the downgrade itself triggers, by deactivating the install — unless that
// trigger reads the same instruction. Only the source can settle it.

describe('a lapsed organisation leaves bought courses watchable (UX-16 follow-up)', () => {
  const downgrade = read('saas-billing/downgrade.ts')
  const lifecycle = read('orgs/lifecycle.ts')
  const trigger = read('sync/onInstalledPluginStatusChange.ts')

  /** The options object of every `downgradeTeamToFree(...)` CALL in the tree. */
  function downgradeCalls(): Array<{ file: string; opts: string }> {
    const out: Array<{ file: string; opts: string }> = []
    for (const f of sourceFiles()) {
      if (f === 'saas-billing/downgrade.ts' || f.endsWith('.test.ts')) continue
      for (const m of code(read(f)).matchAll(/downgradeTeamToFree\([^,]+,\s*(\{[^}]*\})/g)) {
        out.push({ file: f, opts: m[1] })
      }
    }
    return out
  }

  it('every caller STATES its disposition, and only the org rail keeps the mirrors', () => {
    const calls = downgradeCalls()
    assert.ok(calls.length >= 2, 'found no downgrade calls to check — did the call shape change?')
    for (const { file, opts } of calls) {
      assert.match(
        opts,
        /courseMirrors: '(tear_down|keep_for_buyers)'/,
        `${file} calls downgradeTeamToFree without saying what happens to the course mirrors`
      )
      const keeps = opts.includes("courseMirrors: 'keep_for_buyers'")
      assert.equal(
        keeps,
        file === 'orgs/lifecycle.ts',
        keeps
          ? `${file} keeps course mirrors — only the ORG lapse may, because only there is the payer ` +
              'who stopped a third party'
          : `${file} tears course mirrors down and is not a team rail — was this meant to keep them?`
      )
    }
  })

  it('the TEAM lapse is untouched — it still tears its own mirrors down', () => {
    const billing = code(read('saas-billing/index.ts'))
    assert.ok(
      !billing.includes('keep_for_buyers'),
      'a team that stops paying loses its listings; that was not the decision under review'
    )
    assert.ok(
      /activePluginIds\.includes\('online-courses'\) && !keepCourseMirrors/.test(code(downgrade)),
      'the synchronous teardown must still run for every caller that did not ask to keep the mirrors'
    )
  })

  it('the disposition is REQUIRED — no default decides it for a new caller', () => {
    const sig = code(downgrade)
      .split('export async function downgradeTeamToFree(')[1]
      .split('):')[0]
    assert.ok(sig.includes('courseMirrors: CourseMirrorDisposition'), 'the option is missing')
    assert.ok(
      !/courseMirrors\?:/.test(sig) && !/courseMirrors[^,]*=/.test(sig),
      'an optional or defaulted disposition means a future caller silently inherits one of two ' +
        'opposite behaviours — make it choose'
    )
  })

  it('the trigger obeys it — otherwise the downgrade sparing the mirrors is undone a beat later', () => {
    // Deactivating the install IS a write to teams/{id}/installed_plugins/{id},
    // so onInstalledPluginStatusChange fires on every downgrade.
    const arm = trigger.split("pluginId === 'online-courses'")[1].split('\n    }')[0]
    const guardAt = arm.indexOf('KEEP_COURSE_MIRRORS_FIELD')
    const deleteAt = arm.indexOf('deleteAllCoursePublicProfiles')
    assert.ok(guardAt >= 0, 'the trigger deletes course mirrors without ever asking to keep them')
    assert.ok(
      deleteAt >= 0 && guardAt < deleteAt,
      'the keep check must come BEFORE the batch delete'
    )
  })

  it('writer and reader share ONE field name, from @linyup/shared', () => {
    for (const [name, src] of [
      ['saas-billing/downgrade.ts', downgrade],
      ['sync/onInstalledPluginStatusChange.ts', trigger],
    ] as const) {
      assert.ok(
        /KEEP_COURSE_MIRRORS_FIELD/.test(code(src)) && /from '@linyup\/shared'/.test(code(src)),
        `${name} must use the shared constant — a typo on either side of this pair silently ` +
          'deletes the mirrors a bought course lives behind'
      )
      assert.ok(
        !/'keep_course_mirrors'/.test(code(src)),
        `${name} hardcodes the field name instead of importing it`
      )
    }
  })

  it('the marker cannot go stale: ONE writer of an inactive team install', () => {
    // The marker is only ever honoured on an active → inactive transition, and
    // the write that performs that transition is the write that states it. That
    // holds only while `downgradeTeamToFree` is the sole producer of an inactive
    // install: every OTHER end-of-install path deletes the document, and a
    // deleted document carries no marker, so the teardown runs.
    for (const f of sourceFiles()) {
      if (f.endsWith('.test.ts')) continue
      const src = code(read(f))
      if (!/installed_plugins|INSTALLED_PLUGINS_SUBCOLLECTION|ORG_INSTALLED_PLUGINS/.test(src))
        continue
      if (!/status:\s*'inactive'/.test(src)) continue
      assert.ok(
        f === 'saas-billing/downgrade.ts' || f === 'orgs/lifecycle.ts',
        `${f} deactivates a plugin install without stating a course-mirror disposition — either ` +
          'route it through downgradeTeamToFree or stamp the field yourself'
      )
    }
    assert.ok(
      /status: 'inactive'/.test(code(lifecycle)),
      'expected the org-level install deactivation to still be here. It needs no course-mirror ' +
        'marker: the org trigger that now exists (plugins/bundleTriggers.ts) only reconciles ' +
        'bundles and never tears artefacts down — if that changes, re-check the list above',
    )
  })
})
