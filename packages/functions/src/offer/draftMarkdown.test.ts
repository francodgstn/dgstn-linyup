import assert from 'node:assert/strict'
import { markdownToPlainText, parseOfferingDraft } from '@linyup/shared'

// MARKDOWN IN AN OFFER DRAFT (2026-09-17). Descriptions are STORED in plain-text
// fields and shown as plain text on public pages, so the parser strips Markdown
// from them; the note is display-only and keeps its Markdown for the dialog to
// render. See `plainDescription` in shared/types/offeringDraft.ts.

describe('markdownToPlainText', () => {
  it('drops the marks and keeps the words', () => {
    assert.equal(
      markdownToPlainText('**Beginners** welcome, *no* experience needed. Try `Tuesday`.'),
      'Beginners welcome, no experience needed. Try Tuesday.'
    )
  })

  it('keeps list items on their own lines, as "- item"', () => {
    assert.equal(markdownToPlainText('What you get:\n* mats\n+ towels\n- water'), 'What you get:\n- mats\n- towels\n- water')
  })

  it('keeps a link and an image as their text', () => {
    assert.equal(markdownToPlainText('See [our site](https://x.example) ![logo](a.png)'), 'See our site logo')
  })

  it('drops heading and quote markers, fences and rules, but not the lines', () => {
    assert.equal(markdownToPlainText('## Yoga\n> calm\n---\n```\nbreathe\n```'), 'Yoga\ncalm\n\nbreathe')
  })

  it('leaves snake_case and lone symbols alone', () => {
    assert.equal(markdownToPlainText('file_name and 2 * 3 and a_b_c'), 'file_name and 2 * 3 and a_b_c')
  })
})

describe('parseOfferingDraft — descriptions are plain text, the note is not', () => {
  const draft = parseOfferingDraft({
    activities: [{ key: 'yoga', name: 'Yoga', description: '**Gentle** flow for *all* levels.\n- mats provided' }],
    plans: [{ key: 'ten', name: '10-class pass', description: '__Best value__ for regulars.' }],
    note: 'I assumed **CHF** and _no_ drop-in price.',
  }).draft!

  it('strips Markdown from activity and plan descriptions', () => {
    assert.equal(draft.activities[0].description, 'Gentle flow for all levels.\n- mats provided')
    assert.equal(draft.plans[0].description, 'Best value for regulars.')
  })

  it('keeps the note as Markdown, for the dialog to render', () => {
    assert.equal(draft.note, 'I assumed **CHF** and _no_ drop-in price.')
  })

  it('a description that is only marks is refused like an empty one', () => {
    const { draft: d, problems } = parseOfferingDraft({
      activities: [{ key: 'a', name: 'A', description: '**  **\n---' }],
    })
    assert.equal(d!.activities[0].description, undefined)
    assert.ok(problems.some((p) => p.path === 'activities[0].description'))
  })
})
