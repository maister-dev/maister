CREATE OR REPLACE FUNCTION public.maister_execution_data_plane_imports_complete_is_final()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.state = 'complete' AND
    ROW(NEW.state, NEW.source_fingerprint, NEW.last_source_position, NEW.imported_count)
    IS DISTINCT FROM
    ROW(OLD.state, OLD.source_fingerprint, OLD.last_source_position, OLD.imported_count)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'execution_data_plane_imports_complete_is_final',
      MESSAGE = 'a proven preservation lane record is final',
      DETAIL = 'run ' || OLD.run_id || ' lane ' || OLD.source_kind ||
        ' is complete; its state, fingerprint, position and count cannot change.';
  END IF;
  RETURN NEW;
END;
$function$;
