// Statically imported so Metro bundles all four — the app has no network at
// first paint and a member's language must not wait on one. Four short
// catalogs are a rounding error next to the JS bundle.
import en from '../../messages/en.json'
import de from '../../messages/de.json'
import fr from '../../messages/fr.json'
import it from '../../messages/it.json'

export type Locale = 'en' | 'de' | 'fr' | 'it'

export const messages: Record<Locale, unknown> = { en, de, fr, it }
