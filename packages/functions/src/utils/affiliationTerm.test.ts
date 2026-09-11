import * as assert from 'node:assert'
import { resolveAffiliationTerm, DEFAULT_AFFILIATION_TERM } from '@linyup/shared'

// ONE fallback chain for the org's affiliation noun — the web and the member
// app used to disagree on the third step, and on whether '' counts.

describe('resolveAffiliationTerm', () => {
  const term = { en: 'Membership', de: 'Mitgliedschaft', fr: 'Adhésion' }

  it("the reader's language, matched on its two-letter tag", () => {
    assert.strictEqual(resolveAffiliationTerm(term, 'de'), 'Mitgliedschaft')
    assert.strictEqual(resolveAffiliationTerm(term, 'de-CH'), 'Mitgliedschaft')
    assert.strictEqual(resolveAffiliationTerm(term, 'fr-FR'), 'Adhésion')
  })

  it('then English', () => {
    assert.strictEqual(resolveAffiliationTerm(term, 'it'), 'Membership')
  })

  it('then ANY filled translation — a studio that entered only German gets it everywhere', () => {
    assert.strictEqual(resolveAffiliationTerm({ de: 'Lizenz' }, 'it'), 'Lizenz')
    assert.strictEqual(resolveAffiliationTerm({ de: 'Lizenz' }, 'en'), 'Lizenz')
  })

  it('then the default, when nothing is configured', () => {
    assert.strictEqual(resolveAffiliationTerm(null, 'de'), DEFAULT_AFFILIATION_TERM)
    assert.strictEqual(resolveAffiliationTerm(undefined, 'de'), DEFAULT_AFFILIATION_TERM)
    assert.strictEqual(resolveAffiliationTerm({}, 'de'), DEFAULT_AFFILIATION_TERM)
  })

  it('a blank string is not a translation at any step', () => {
    assert.strictEqual(resolveAffiliationTerm({ de: '  ', en: 'Membership' }, 'de'), 'Membership')
    assert.strictEqual(resolveAffiliationTerm({ de: '', en: '' , fr: 'Adhésion' }, 'de'), 'Adhésion')
    assert.strictEqual(resolveAffiliationTerm({ de: '', en: '' }, 'de'), DEFAULT_AFFILIATION_TERM)
  })
})
