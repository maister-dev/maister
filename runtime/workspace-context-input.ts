/** The named, sealed input carries refs and identities. It never carries OS paths. */
export const WORKSPACE_CONTEXT_INPUT = "context-repositories.json";

export type WorkspaceContextInput = Readonly<{
  stepId: string;
  repositoryId: string;
  slug: string;
  ref: string;
  declaredRef: string | null;
  commit: string;
}>;
