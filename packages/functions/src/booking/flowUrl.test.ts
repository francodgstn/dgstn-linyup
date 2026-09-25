import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// WHO IS ALLOWED TO WRITE THE ADDRESS BAR IN A BOOKING FUNNEL.
//
// `hooks/useStepUrl.ts` owns the history mechanics: raw `pushState` so the
// loaded activities and coaches survive Back with no refetch, the marker that
// tells this app's entries from the locale redirect's, and the restore
// counter. On top of it sat a DECISION, written out twice, once per funnel:
// skip the restore's own re-render, rewrite a refinement, push a real step
// transition, rewrite a terminal screen.
//
// Two copies of that is how the funnels drift apart on Back, which is the one
// thing about a booking funnel nobody tests by hand twice. So the decision is
// `components/booking/flow/useBookingFlowUrl.ts` and it is the ONLY consumer
// of the mechanics: a funnel that wants its own rule has to reach past this
// file to get one, and that is what this pin refuses.
//
// Run with: pnpm --filter @linyup/functions test

const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

/** Every file that may touch the step-URL mechanics, and why. */
const MECHANICS = 'hooks/useStepUrl'
const OWNER = 'apps/web/src/components/booking/flow/useBookingFlowUrl.ts'
// ONE funnel, since the appointment route became a redirect: an appointment is
// a step inside this one rather than a second machine with its own URL writer.
// The list stays a list because the next offer type to arrive will be a step
// here too, and because a second funnel reappearing is exactly what this pin
// exists to notice.
const FUNNELS = ['apps/web/src/app/[locale]/(public)/public/[slug]/booking/BookingForm.tsx']

const importsMechanics = (src: string) =>
  new RegExp(`from '@/${MECHANICS}'|from '\\.\\./\\.\\./\\.\\./hooks/useStepUrl'`).test(src)

describe('one decision writes a booking funnel’s URL', () => {
  it('the shared hook is the one that holds the mechanics', () => {
    assert.ok(importsMechanics(read(OWNER)), `${OWNER} must import ${MECHANICS}`)
  })

  for (const funnel of FUNNELS) {
    const name = funnel.split('/').pop()
    it(`${name} takes the decision rather than rebuilding it`, () => {
      const src = read(funnel)
      assert.ok(
        /useBookingFlowUrl\(/.test(src),
        `${funnel} must drive its URL through useBookingFlowUrl`
      )
      assert.ok(
        !importsMechanics(src),
        `${funnel} reaches past useBookingFlowUrl to the raw step-URL mechanics`
      )
    })

    it(`${name} keeps no sync state of its own`, () => {
      // The three refs were the copied machinery. Their absence is what says
      // the copy is gone, not merely unused.
      const src = read(funnel)
      for (const ref of ['syncedQueryRef', 'prevStepRef', 'seenRestoreRef']) {
        assert.ok(!src.includes(ref), `${funnel} still carries ${ref}`)
      }
    })
  }

  it('the pin is capable of failing', () => {
    // A source-reading assertion is green on the day it is written whether or
    // not it works, so both patterns are run against the code as it WAS.
    const asItWas = `import { useStepUrl } from '@/hooks/useStepUrl'
      const stepUrl = useStepUrl({ disabled: disableStepUrl })
      const syncedQueryRef = useRef<string | null>(null)`
    assert.ok(importsMechanics(asItWas))
    assert.ok(asItWas.includes('syncedQueryRef'))
    assert.ok(!/useBookingFlowUrl\(/.test(asItWas))
  })
})

describe('a terminal screen rewrites its history entry', () => {
  // Back into a screen that already submitted lets the visitor book the same
  // thing twice. The class funnel has two such screens; the appointment funnel
  // has none, because its confirmation is a screen inside the `book` step
  // rather than a step. Both facts are stated where they are true, and this
  // checks the class one is still stated at all. A silently dropped
  // `terminalSteps` would push those entries again and nothing on screen would
  // say so until somebody pressed Back.
  it('the class funnel still names its endings', () => {
    const src = read(FUNNELS[0])
    assert.match(src, /const TERMINAL_STEPS = \[[^\]]*'confirmed'[^\]]*'waitlisted'[^\]]*\]/)
    assert.match(src, /terminalSteps: TERMINAL_STEPS/)
  })

  it('the hook rewrites rather than pushes on one', () => {
    const src = read(OWNER)
    assert.match(src, /isFirst \|\| !stepChanged \|\| isTerminal/)
  })
})
