/**
 * Determines whether a checkin is confirmed based on event type and the data
 * collected during the checkin flow.
 *
 * This runs on both client (UI indicators) and server (Cloud Function validation)
 * so the logic must not import any browser or Node-only APIs.
 *
 * Confirmation rules per built-in event type:
 *   exam:    requires at least one ranking-system entry in checkin_data.disciplines
 *            (an entry whose level is 0 IS a result — see the arm below)
 *   camp:    requires checkin_data.join_as
 *   others:  a plugin rule from PLUGIN_CHECKIN_COMPLETION if the event type has
 *            one (fighting_cup requires a non-empty categories array);
 *            auto-confirmed otherwise
 */
import { PLUGIN_CHECKIN_COMPLETION } from '../types/plugin-checkins'

export function isCheckinCompleted(
  eventType: string,
  checkinData?: Record<string, unknown>,
): boolean {
  switch (eventType) {
    case 'exam': {
      // "Not examined" is the ABSENCE OF THE KEY, never the value zero. Every
      // ranking preset's first level is `value: 0` — BJJ White, the Swiss
      // "Krebs", HMD "No belt" — so the earlier `> 0` test made awarding the
      // entry grade unrecordable: the form wrote the 0 and the check-in stayed
      // pending forever.
      //
      // An empty or absent map still means nobody was examined, which the
      // "admit now, finalize later" door depends on: it asks this with
      // `checkinData = {}` to decide whether there is a second step at all.
      const disciplines = checkinData?.disciplines as Record<string, unknown> | undefined
      if (!disciplines) return false
      return Object.values(disciplines).some(
        (v) => typeof v === 'number' && Number.isFinite(v),
      )
    }
    case 'camp':
      return typeof checkinData?.join_as === 'string' && checkinData.join_as.length > 0
    default: {
      // A PLUGIN'S RULE, FROM THE PLUGIN'S OWN LIST — not from here.
      //
      // This branch used to read `Array.isArray(checkinData.categories)`, which
      // is the `hmd-fighting-cup` payload shape: core knew one tenant-specific
      // plugin's data model, and a second plugin needing completion logic had
      // nowhere to put it but this same `if`, beside a rule that was not its
      // own. The rules live in `PLUGIN_CHECKIN_COMPLETION` now.
      //
      // It also narrowed a real over-reach: the old test applied the cup's rule
      // to ANY event type that happened to carry a `categories` array. Keyed
      // lookup asks the question the switch is already asking — what KIND of
      // event is this.
      const rule = PLUGIN_CHECKIN_COMPLETION[eventType]
      if (rule) return rule(checkinData)
      // competition, seminar, workshop, and any other type: auto-confirm
      return true
    }
  }
}
