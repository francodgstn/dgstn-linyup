/** Types for docsMeta.mjs. The implementation stays plain ESM so the guard
 *  scripts run with no build step; TypeScript consumers (apps/docs's Astro
 *  config) need the shapes. */

/** Read a text file with CRLF normalised to LF — the only way to read input
 *  for the parsers below, which are line-based. */
export declare function readText(path: string): string

export declare const AREAS: readonly string[]
export declare const DOMAIN_AREAS: readonly string[]
export declare const AREA_TITLE: Record<string, string>
export declare const STATUSES: readonly string[]

export declare function byOrder(
  a: { order?: number | string; title: string },
  b: { order?: number | string; title: string },
): number

export interface ExternalDoc {
  path: string
  id: string
  title: string
  area: string
  order: number
}
export declare const EXTERNAL_DOCS: readonly ExternalDoc[]

export interface ClaudeSectionSpec {
  id?: string
  title?: string
  area?: string
  order?: number
  skip?: boolean
  whole?: boolean
}
export declare const CLAUDE_SECTIONS: Record<string, ClaudeSectionSpec>

export declare function claudeSections(src: string): {
  id: string
  title: string
  area: string
  order: number
  heading: string
  body: string
}[]

export interface DocFrontmatter {
  title?: string
  status?: string
  area?: string
  summary?: string
  'code-owner'?: string
  census?: string[]
  [key: string]: string | string[] | undefined
}

export declare function parseFrontmatter(src: string): {
  data: DocFrontmatter | null
  body: string
  bodyStartLine: number
  error: string | null
}

export interface DocHeading {
  level: number
  text: string
  line: number
  /** The section number the `§N` idiom resolves against, or null when the
   *  heading carries no leading number. */
  num: string | null
}

export declare function parseHeadings(src: string): DocHeading[]
export declare function hasNumberedHeading(headings: DocHeading[], n: string): boolean
export declare function hasHeadingContaining(headings: DocHeading[], needle: string): boolean
