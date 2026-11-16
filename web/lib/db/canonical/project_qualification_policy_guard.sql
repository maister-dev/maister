CREATE OR REPLACE FUNCTION public.project_qualification_policy_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.task_qualification_baseline IS DISTINCT FROM OLD.task_qualification_baseline THEN RAISE EXCEPTION 'project qualification creation baseline is immutable' USING ERRCODE='23514',CONSTRAINT='projects_qualification_baseline_immutable'; END IF;
  IF NEW.task_qualification_override IS DISTINCT FROM OLD.task_qualification_override THEN
    IF EXISTS(SELECT 1 FROM project_config_persist_operations WHERE project_id=OLD.id AND state IN ('preparing','prepared','publishing','recovery_required')) THEN RAISE EXCEPTION 'configuration publication requires completion before changing qualification policy' USING ERRCODE='55P03'; END IF;
    NEW.config_export_revision:=GREATEST(NEW.config_export_revision,OLD.config_export_revision+1);
  END IF;
  RETURN NEW;
END $function$;
