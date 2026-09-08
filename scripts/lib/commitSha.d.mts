/** Types for the build-time commit resolver — see commitSha.mjs for the design. */
export type CommitShaSource = 'env' | 'git' | 'git-file'

export declare function resolveCommitSha(cwd?: string): {
  sha: string | null
  source: CommitShaSource | null
}

export declare function commitEnv(cwd?: string): {
  NEXT_PUBLIC_COMMIT_SHA?: string
  NEXT_PUBLIC_COMMIT_SOURCE?: CommitShaSource
}
