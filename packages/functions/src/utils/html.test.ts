import assert from 'node:assert/strict'
import { escapeHtml } from './html'

describe('escapeHtml', () => {
  it('neutralizes script tags', () => {
    assert.equal(
      escapeHtml('<script>alert(1)</script>'),
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
  })

  it('neutralizes anchor / attribute injection', () => {
    assert.equal(
      escapeHtml('"><a href="https://evil.example">click</a>'),
      '&quot;&gt;&lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt;',
    )
  })

  it('escapes all five significant characters', () => {
    assert.equal(escapeHtml(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;')
  })

  it('escapes ampersands before other entities (no double-encoding order bug)', () => {
    assert.equal(escapeHtml('a & <b>'), 'a &amp; &lt;b&gt;')
  })

  it('returns empty string for null/undefined', () => {
    assert.equal(escapeHtml(null), '')
    assert.equal(escapeHtml(undefined), '')
  })

  it('stringifies non-string input', () => {
    assert.equal(escapeHtml(42), '42')
  })

  it('leaves benign text untouched', () => {
    assert.equal(escapeHtml('Café Zürich 123'), 'Café Zürich 123')
  })
})
