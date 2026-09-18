// ─── Markdown → plain text ───────────────────────────────────────────────────
//
// For model text that is about to be STORED in a plain-text field. A model asked
// for "a sentence or two" writes `**Beginners**` and `- bullet` anyway, and a
// field that is a plain textarea in its editor and plain text on every public
// page would then show the asterisks to members. Rendering the Markdown in a
// preview would be worse, not better: the preview would promise formatting the
// stored record never has.
//
// So the marks go and the words stay. Line structure is kept (a list item stays
// on its own line, as "- item"), links keep their text and lose their URL,
// images keep their alt text. It is deliberately a small, predictable set of
// rewrites rather than a parser: the input is a sentence-sized description, and
// anything it does not recognise passes through as the characters it is.

/** Strip Markdown marks from `text`, keeping words and line breaks. */
export function markdownToPlainText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // Code fences: keep what is inside, drop the fence lines.
      .replace(/^\s*```[^\n]*$/gm, '')
      // Horizontal rules.
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
      // Headings and blockquotes: the marker, not the line.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      // Bullets: one spelling, "- ".
      .replace(/^(\s*)[*+•]\s+/gm, '$1- ')
      // Images before links, so `![alt](src)` does not leave a stray "!".
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Emphasis. Underscore forms only between non-word characters, so
      // snake_case and file_names survive.
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(^|[^\w])__([^_\n]+)__(?=[^\w]|$)/g, '$1$2')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1$2')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      // Trailing spaces, then at most one blank line in a row.
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
