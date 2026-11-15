CREATE OR REPLACE FUNCTION public.project_worktree_retry_source(source_id text)
 RETURNS jsonb
 LANGUAGE sql
AS $function$
  SELECT jsonb_build_object('workspaceId',workspace.id,'baseCommit',workspace.base_commit,
    'baseBranch',workspace.base_branch,'repositorySha256',task_launch_admission_digest(to_jsonb(workspace.parent_repo_path)))
  FROM workspaces workspace
  JOIN runs source ON source.id=workspace.run_id AND source.project_id=workspace.project_id
  JOIN projects project ON project.id=workspace.project_id AND project.repo_path=workspace.parent_repo_path
  WHERE workspace.run_id=source_id AND workspace.base_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
    AND char_length(workspace.base_branch) BETWEEN 1 AND 1024
    AND NOT EXISTS (SELECT 1 FROM workspaces other WHERE other.run_id=source_id AND other.id<>workspace.id)
  FOR SHARE OF workspace,project
$function$;
