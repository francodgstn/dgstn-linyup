import type { PluginManifest } from '@linyup/shared'

export const whatsappManifest: PluginManifest = {
  id: 'whatsapp',
  nameKey: 'whatsappName',
  descriptionKey: 'whatsappDescription',
  category: 'web',
  minPlan: 'studio',
  status: 'beta',
  iconName: 'MessageCircle',
  // Phase 1 (docs/whatsapp-outbound.md): connect + the send rail + booking
  // reminders + consent. NO automation trigger and NO automation action ship
  // yet — both are Phase 2, once a template picker exists for the action and
  // an inbound-message trigger actually fires something. The two ids that used
  // to sit here (`plugin:whatsapp:message_received`,
  // `plugin:whatsapp:send_message`) were never wired to a real trigger/handler:
  // a studio could pick either from the automations builder and nothing would
  // ever happen (UX-87 — no error, no log, nothing to notice). Re-add them in
  // the SAME commit that ships the server-side fire/handler, never ahead of
  // it. `referrals` is the worked example for a trigger —
  // packages/functions/src/referrals/events.ts.
  hasOwnerConfig: true,
}
