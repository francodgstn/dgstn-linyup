/** Types for docsMeta.mjs. The implementation stays plain ESM so the guard
 *  scripts run with no build step; TypeScript consumers (apps/docs's Astro
 *  config) need the shapes. */

export declare const AREAS: readonly string[]
export declare const STATUSES: readonly string[]

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
