CREATE OR REPLACE FUNCTION public.project_readonly_retry_source(source_id text)
 RETURNS jsonb
 LANGUAGE sql
AS $function$
  SELECT jsonb_build_object('commit',source.operational_integrity_baseline->>'head',
    'repositorySha256',task_launch_admission_digest(to_jsonb(project.repo_path)))
  FROM runs source JOIN projects project ON project.id=source.project_id
  WHERE source.id=source_id AND source.agent_workspace='repo_read'
    AND source.operational_integrity_baseline->>'resourceKind' IN ('shared_repository','ephemeral_checkout')
    AND source.operational_integrity_baseline->>'head' ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
    AND source.operational_integrity_baseline->'owner'->>'repoPath'=project.repo_path
    AND source.operational_integrity_baseline->'owner'->>'projectSlug'=project.slug
  FOR SHARE OF project
$function$;
