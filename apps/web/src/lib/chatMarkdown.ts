import { Marked, type Tokens } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

/**
 * MARKDOWN FROM A MODEL → HTML SAFE TO RENDER in a chat bubble.
 *
 * The in-app assistant answers in whatever shape the model chooses, and a model
 * asked for a list or a comparison writes Markdown — `**bold**`, `- items`, a
 * table. Shown as plain text that arrives as asterisks and pipes, which reads as
 * broken. So a reply is parsed as GitHub-flavoured Markdown and then SANITIZED:
 * the text is model output that quotes studio data (activity names, notes a tool
 * returned), so it is attacker-influenceable and never trusted as HTML.
 *
 * Also the offer draft dialog's model NOTE (`components/offer/AiDraftDialog.tsx`)
 * — display-only text, like a reply. Model text that is STORED in a plain-text
 * field goes the other way, through `markdownToPlainText` in @linyup/shared.
 *
 * Three decisions, each deliberate:
 *
 *  - **A private `Marked` instance.** `marked.use()` on the shared default would
 *    change how the email-template preview renders too.
 *  - **Raw HTML in the reply is shown as text, not dropped.** A model that writes
 *    `<b>` has written characters; rendering them as literal text is honest,
 *    silently deleting them is not. DOMPurify below is still the security
 *    boundary — this only decides what an unsafe-looking reply LOOKS like.
 *  - **A tag allow-list, not DOMPurify's defaults.** Its defaults admit images,
 *    forms and styles. A chat answer needs text structure and links, nothing that
 *    loads a resource or takes input.
 *
 * Links: an absolute `http(s)` link opens in a new tab with `noopener`; a path
 * starting with `/` stays an in-app link, which the panel routes through the
 * locale-aware router (see AssistantPanel). Line breaks inside a paragraph are
 * kept (`breaks: true`), because a model's single newlines are meant as newlines.
 */

const md = new Marked({ gfm: true, breaks: true, async: false })

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

md.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens)
      const external = /^https?:\/\//i.test(href)
      const attrs = [
        `href="${escapeHtml(href)}"`,
        title ? `title="${escapeHtml(title)}"` : '',
        external ? 'target="_blank" rel="noopener noreferrer"' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `<a ${attrs}>${label}</a>`
    },
  },
})

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]
// `align` is how marked writes a table column's alignment; `start` is an ordered
// list that does not begin at 1. No `input`: a GFM task list keeps its text and
// loses its checkbox, which is a fair price for a reply carrying no form control.
const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'align', 'start']

/** A model reply as sanitized HTML. Empty in, empty out. */
export function renderChatMarkdown(text: string | null | undefined): string {
  if (!text) return ''
  const html = md.parse(text) as string
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })
}
