import type { PluginManifest } from '@linyup/shared'

/**
 * MEMBER RECAP — a module of the `ai` container.
 *
 * A "Send to member" action on the contact briefing: the member-facing part of
 * the summary (where they stand, and one thing for their next session — never
 * the outlook), reviewed and editable in a dialog, then emailed as the studio.
 * Server: `sendContactRecapEmail` (`functions/src/contacts/aiRecapEmail.ts`).
 *
 * IT LIVES INSIDE THE BRIEFING. The recap is written in the same model call as
 * the summary, and its button sits on the summary block, so with
 * `ai-contact-summary` switched off there is nothing to send and nowhere to send
 * it from. That is a dependency of placement, not of installs, which is why it is
 * stated in the module's description rather than as a `PLUGIN_REQUIREMENTS`
 * entry: a requirement is written as a STANDALONE install, and a bundle member
 * installed that way would be a document the reconciler does not own.
 */
export const aiMemberRecapManifest: PluginManifest = {
  id: 'ai-member-recap',
  nameKey: 'aiMemberRecapName',
  descriptionKey: 'aiMemberRecapDescription',
  category: 'data',
  minPlan: 'studio',
  status: 'beta',
  iconName: 'Send',
  hasOwnerConfig: false,
}
