// ─── What a model is told before it reads anything ──────────────────────────
//
// The grounding every front end of the read tools gives its model: which studio,
// what day it is THERE, how money is written, the people vocabulary the numbers
// use, and — the line that keeps an answer honest — what this principal cannot
// see. Written once so the remote MCP server and the in-app assistant cannot
// disagree about what "external" means or which zone a date is in.

import type { ApiScope } from '@linyup/shared'
import type { ApiPrincipal } from '../auth/principal'
import type { TeamReadContext } from '../context'
import { describeScopes } from '../rest'
import { zonedYmd } from '../time'

/**
 * `connection` — an external client that connected with a key or an OAuth grant.
 * `assistant` — the in-app assistant, speaking for the signed-in member.
 */
export type ToolAudience = 'connection' | 'assistant'

const WATCHED: readonly ApiScope[] = [
  'contacts:read',
  'contacts:read:pii',
  'schedule:read',
  'offerings:read',
  'subscriptions:read',
  'reports:read',
  'finance:read',
]

export function studioInstructions(
  principal: ApiPrincipal,
  team: TeamReadContext,
  nowMs: number,
  audience: ToolAudience
): string {
  const { usable } = describeScopes(principal)
  const missing = WATCHED.filter((s) => !usable.includes(s))
  return [
    audience === 'connection'
      ? `You are connected, read-only, to the Linyup studio "${team.name}".`
      : `You can read the Linyup studio "${team.name}" through your tools, read-only, as the member asking — you see what their role lets them see and nothing more.`,
    `Today is ${zonedYmd(nowMs, team.timeZone)} in ${team.timeZone}; give times in that zone. Money is in minor units (divide by 100); the studio's currency is ${team.currency}.`,
    'People: "roster" means members and leads the studio looks after; "external" means people who train here without being on the roster (partner-app drop-ins, former members) and are not churn. Leads are not yet confirmed.',
    'Engagement bands (active, low, at_risk, inactive) are measured from the last attended session.',
    missing.length
      ? `This connection cannot see: ${missing.join(', ')}. Say so rather than guessing.`
      : 'This connection can see everything the API offers, contact details included.',
  ].join('\n')
}
