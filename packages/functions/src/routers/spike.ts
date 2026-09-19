// THROWAWAY — deleted once the pilot router has shipped.
//
// `rpcSpike` exists to prove, on a deployed project, what
// utils/callableRouter.ts claims from reading the SDK: that `request.auth`
// (staff and contact-session tokens), App Check enforcement, CORS from the web
// origin and `HttpsError` codes all survive being reached through a router, and
// that the path passes through on cloudfunctions.net and in the emulator. The
// checklist is docs/functions-consolidation-plan.md → "Phase 0".
//
// The members are read-only, and each stays exported standalone from
// src/index.ts under its own name: the mobile app calls them, so they are on
// the frozen list (utils/frozenFunctions.test.ts). Listing them here moves no
// traffic — no client routes a call until `callFunction` does.
//
// One module per router: later phases add their own file beside this one, and
// utils/routerCoverage.test.ts checks every table against CALLABLE_ROUTES in
// @linyup/shared.
//
// This module must NOT call `setGlobalOptions` — src/index.ts owns it, and the
// region reaches this function from there.

import { callableRouter } from '../utils/callableRouter'
import { listAvailability } from '../appointments/window'
import { getMyBookings } from '../booking/myBookings'

export const rpcSpike = callableRouter(
  'rpcSpike',
  {
    // `cpu` and `concurrency` are stated rather than inherited because a router
    // carries a whole domain, so its ceiling (concurrency × maxInstances) is a
    // sizing decision somebody should be able to read here. It is not a rescue
    // from a bad default: a plain callable already deploys at 1 cpu and
    // concurrency 80. Forty matches `api`.
    cpu: 1,
    concurrency: 40,
    // The ROUTER's memory and timeout govern; a member's own are ignored when
    // it is reached through here (utils/callableRouter.ts, header).
    memory: '512MiB',
    timeoutSeconds: 60,
  },
  { listAvailability, getMyBookings }
)
