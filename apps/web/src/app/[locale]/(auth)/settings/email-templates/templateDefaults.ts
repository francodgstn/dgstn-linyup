// Resolves the stock (default) content for a predefined outreach template from
// its `system_key`, so customized templates can show a "Customized" badge and
// be reset to default at any time.
//
// Two key shapes exist (see automationLibrary.ts):
//   - Library items:  '{library_key}:{lang}'  → AUTOMATION_LIBRARY translations
//   - Starter kit:    'sys_*'                 → SYSTEM_TEMPLATES (EN)
//
// Moved here from settings/emails/ (2026-08-27) alongside TemplateEditor.tsx —
// same depth under settings/, so the relative import below is unchanged.
import { AUTOMATION_LIBRARY, type SupportedLanguage } from '../../automations/automationLibrary'
import { SYSTEM_TEMPLATES } from '../../automations/systemDefaults'

export interface TemplateDefault {
  name: string
  subject: string
  body: string
}

export function templateDefault(
  systemKey: string | undefined,
  language: string
): TemplateDefault | null {
  if (!systemKey) return null

  if (systemKey.includes(':')) {
    const [libKey, keyLang] = systemKey.split(':')
    const item = AUTOMATION_LIBRARY.find((i) => i.library_key === libKey)
    if (item?.template) {
      const lang = (keyLang || language) as SupportedLanguage
      const tr = item.template.translations[lang] ?? item.template.translations.en
      return { name: item.template.name, subject: tr.subject, body: tr.body }
    }
    return null
  }

  const sys = SYSTEM_TEMPLATES.find((s) => s.system_key === systemKey)
  if (sys) return { name: sys.name, subject: sys.subject, body: sys.body }
  return null
}
