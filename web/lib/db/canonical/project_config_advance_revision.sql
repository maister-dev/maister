CREATE OR REPLACE FUNCTION public.project_config_advance_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW.name, NEW.main_branch, NEW.branch_prefix, NEW.public_branch_template,
         NEW.default_runner_id, NEW.promotion_mode)
     IS DISTINCT FROM
     ROW(OLD.name, OLD.main_branch, OLD.branch_prefix, OLD.public_branch_template,
         OLD.default_runner_id, OLD.promotion_mode) THEN
    NEW.config_export_revision := OLD.config_export_revision + 1;
  ELSIF NEW.config_export_revision < OLD.config_export_revision THEN
    RAISE EXCEPTION 'project config export revision cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
