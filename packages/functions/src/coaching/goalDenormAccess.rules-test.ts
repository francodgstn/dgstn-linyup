import fs from 'node:fs'
import path from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'

// Security-rules coverage for the coaching denormalized fields.
//
// `latest_score` / `last_evaluated_at` / `overdue_at` (on a goal) and
// `coaching_open_count` / `coaching_overdue_count` / `last_checkin_at` /
// `alerts_count` (on the contact) are written ONLY by Cloud Functions
// (trackGoals, trackGoalEvaluations, trackPerformanceCheckins,
// trackContactAlerts, all Admin-SDK — which bypasses these rules entirely).
// No client write — not even a team owner's — may forge them.
//
// This file also pins the true (and asymmetric) behaviour around evaluating a
// COACH-created goal: the evaluation CREATE is allowed, but the client cannot
// then cascade the parent goal's own `status` field, because that update
// branch is gated on `resource.data.created_by == 'student'`.
//
//   pnpm --filter @linyup/functions test:rules

function findRules(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'firestore.rules')
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    dir = path.dirname(dir)
  }
  throw new Error('firestore.rules not found above ' + process.cwd())
}

const RULES = findRules()
const TEAM = 'teamG'
const CONTACT = 'contactG'
const OWNER = 'ownerG'

let testEnv: RulesTestEnvironment

const contactSession = () =>
  testEnv
    .authenticatedContext('contact:' + CONTACT, {
      contactId: CONTACT,
      teamId: TEAM,
      sessionExpires: Date.now() + 3_600_000,
    })
    .firestore()

const ownerSession = () => testEnv.authenticatedContext(OWNER).firestore()

describe('firestore.rules — coaching denormalized fields', function () {
  this.timeout(30_000)

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-linyup-goal-denorm',
      firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
    })
  })
  after(async () => {
    await testEnv?.cleanup()
  })

  beforeEach(async () => {
    await testEnv.clearFirestore()
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      await setDoc(doc(db, 'contacts', CONTACT), {
        teamId: TEAM,
        firstname: 'Nadia',
        coaching_open_count: 0,
        coaching_overdue_count: 0,
        alerts_count: 0,
      })
      await setDoc(doc(db, 'contacts', CONTACT, 'goals', 'studentGoal'), {
        type: 'goal',
        title: 'Run 10k',
        status: 'open',
        categories: [],
        created_by: 'student',
        created_at: new Date(),
      })
      await setDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachGoal'), {
        type: 'goal',
        title: 'Improve endurance',
        status: 'open',
        categories: [],
        created_by: 'coach',
        created_at: new Date(),
      })
      await setDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachTask'), {
        type: 'task',
        title: 'Stretch 10 minutes',
        status: 'open',
        categories: [],
        created_by: 'coach',
        parent_goal_id: 'coachGoal',
        created_at: new Date(),
      })
      await setDoc(doc(db, 'teams', TEAM, 'team_members', OWNER), { role: 'owner' })
      await setDoc(doc(db, 'users', OWNER), { currentTeam: TEAM })
    })
  })

  // ── Goal-doc denorm fields ──────────────────────────────────────────────

  it('a team owner CANNOT forge latest_score on a goal via a direct update', async () => {
    const db = ownerSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachGoal'), { latest_score: 5 }),
    )
  })

  it('a team owner CANNOT forge overdue_at on a goal via a direct update', async () => {
    const db = ownerSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachGoal'), { overdue_at: new Date() }),
    )
  })

  it('a team owner CAN still update ordinary goal fields', async () => {
    const db = ownerSession()
    await assertSucceeds(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachGoal'), { title: 'Improve endurance further' }),
    )
  })

  it('a self-contact CANNOT create a goal that already carries overdue_at', async () => {
    const db = contactSession()
    await assertFails(
      setDoc(doc(db, 'contacts', CONTACT, 'goals', 'forged'), {
        type: 'goal',
        title: 'Forged',
        status: 'open',
        categories: [],
        created_by: 'student',
        created_at: new Date(),
        overdue_at: new Date(),
      }),
    )
  })

  it('a self-contact CAN still fully update their OWN goal, except the denorm fields', async () => {
    const db = contactSession()
    // The whole document may change (title, status, …) — confirms the comment
    // fix: this is NOT a status-only grant.
    await assertSucceeds(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'studentGoal'), {
        title: 'Run a half marathon',
        status: 'in_progress',
      }),
    )
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'studentGoal'), { last_evaluated_at: new Date() }),
    )
  })

  // ── Contact-doc denorm counters ──────────────────────────────────────────

  it('a team owner CANNOT forge coaching_overdue_count on the contact', async () => {
    const db = ownerSession()
    await assertFails(updateDoc(doc(db, 'contacts', CONTACT), { coaching_overdue_count: 99 }))
  })

  it('a team owner CANNOT forge alerts_count on the contact', async () => {
    const db = ownerSession()
    await assertFails(updateDoc(doc(db, 'contacts', CONTACT), { alerts_count: 99 }))
  })

  // Not a counter but the same guard: `ai_summary` is written by the
  // generateContactSummary callable only, so what the page labels "written by
  // AI" was. A client that could set it would be labelling its own prose.
  it('a team owner CANNOT forge ai_summary on the contact', async () => {
    const db = ownerSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT), {
        ai_summary: { text: 'A model wrote this', generated_by: OWNER, model: 'x', language: 'en' },
      })
    )
  })

  it('a team owner CAN still update ordinary contact fields', async () => {
    const db = ownerSession()
    await assertSucceeds(updateDoc(doc(db, 'contacts', CONTACT), { firstname: 'Nadège' }))
  })

  // ── Evaluating a COACH-created goal: create allowed, status cascade denied ──

  it('a self-contact CAN create an evaluation against a COACH-created goal', async () => {
    const db = contactSession()
    await assertSucceeds(
      setDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachGoal', 'evaluations', 'e1'), {
        evaluated_at: new Date(),
        evaluated_by: 'student',
        score: 4,
        status_after: 'in_progress',
      }),
    )
  })

  it('a self-contact CANNOT then cascade that evaluation onto the coach-created goal\'s own status', async () => {
    const db = contactSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachGoal'), { status: 'in_progress' }),
    )
  })

  it('sanity: a self-contact CAN update status on their OWN (student-created) goal', async () => {
    const db = contactSession()
    await assertSucceeds(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'studentGoal'), { status: 'in_progress' }),
    )
  })

  // ── The narrow coach-assigned TASK arm ───────────────────────────────────

  it('a self-contact CAN tick a coach-assigned TASK done (status + completed_at only)', async () => {
    const db = contactSession()
    await assertSucceeds(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachTask'), {
        status: 'achieved',
        completed_at: new Date(),
      }),
    )
  })

  it('a self-contact CAN undo a coach-assigned TASK back to open', async () => {
    const db = contactSession()
    await assertSucceeds(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachTask'), {
        status: 'open',
        completed_at: null,
      }),
    )
  })

  it('a self-contact CANNOT abandon a coach-assigned TASK', async () => {
    const db = contactSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachTask'), { status: 'abandoned' }),
    )
  })

  it('a self-contact CANNOT edit a coach-assigned TASK\'s title', async () => {
    const db = contactSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachTask'), { title: 'Rewritten' }),
    )
  })

  it('a self-contact CANNOT forge latest_score on a coach-assigned TASK via the task arm', async () => {
    const db = contactSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachTask'), {
        status: 'achieved',
        latest_score: 5,
      }),
    )
  })

  it('a self-contact CANNOT forge overdue_at on a coach-assigned TASK via the task arm', async () => {
    const db = contactSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachTask'), {
        status: 'achieved',
        overdue_at: null,
      }),
    )
  })

  it('the task arm does NOT extend to a coach-created GOAL (type: goal stays denied)', async () => {
    const db = contactSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachGoal'), { status: 'achieved' }),
    )
  })

  // ── Create still works for a member's own task, parent_goal_id included ──

  it('a self-contact CAN create their OWN task, with parent_goal_id, for mobile\'s create flow', async () => {
    const db = contactSession()
    await assertSucceeds(
      setDoc(doc(db, 'contacts', CONTACT, 'goals', 'studentTask'), {
        type: 'task',
        title: 'Foam-roll before bed',
        status: 'open',
        categories: [],
        created_by: 'student',
        parent_goal_id: 'studentGoal',
        created_at: new Date(),
      }),
    )
  })

  // ── `created_by` is immutable ─────────────────────────────────────────────
  //
  // Authorship is a historical fact, and it is load-bearing: the member's
  // own-goal arm and the coach-task arm both key on it. A member flipping their
  // own goal to 'coach' would render a "set by your coach" chip on something
  // they wrote themselves.

  it('a self-contact CANNOT flip their OWN goal to created_by: coach', async () => {
    const db = contactSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'studentGoal'), { created_by: 'coach' }),
    )
  })

  it('a self-contact CANNOT flip a coach-assigned TASK to created_by: student', async () => {
    const db = contactSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'coachTask'), { created_by: 'student' }),
    )
  })

  it('even a team owner CANNOT rewrite created_by — it is history, not a setting', async () => {
    const db = ownerSession()
    await assertFails(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'studentGoal'), { created_by: 'coach' }),
    )
  })

  it('sanity: echoing created_by back UNCHANGED is not blocked (affectedKeys is a diff)', async () => {
    const db = contactSession()
    await assertSucceeds(
      updateDoc(doc(db, 'contacts', CONTACT, 'goals', 'studentGoal'), {
        created_by: 'student',
        status: 'in_progress',
      }),
    )
  })
})
