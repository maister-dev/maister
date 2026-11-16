CREATE OR REPLACE FUNCTION public.stamp_native_specialist_credential()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM specialist_run_links link
    JOIN specialist_owner_claims owner ON owner.assignment_id=link.assignment_id
    WHERE link.run_id=COALESCE(NEW.company_run_id,NEW.bound_run_id)
      AND (link.work_witness IS NOT NULL OR (link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation')))
  ) THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Native specialist credential issue time is immutable'
          USING ERRCODE='23514',CONSTRAINT='specialist_native_credential_time_immutable';
      END IF;
    ELSE
      NEW.created_at:=clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END $function$;
