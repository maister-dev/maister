CREATE OR REPLACE FUNCTION public.maister_execution_data_plane_imports_writer_gate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  declared text := coalesce(
    nullif(current_setting('maister.writer_capability', true), ''),
    'undeclared');
BEGIN
  IF declared <> 'execution-ab-1' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      CONSTRAINT = 'execution_data_plane_imports_writer_gate',
      MESSAGE = 'execution_data_plane_imports refuses writer_class=' || declared ||
        ' below schema floor execution-ab-1',
      DETAIL = 'Only a session that declares the execution-ab-1 writer capability may write a preservation lane record after the cut-over; an older writer cannot create or reopen a proof.',
      HINT = 'Deploy a binary that carries migration 0169; its web client, migrator and import CLI declare the capability on connect.';
  END IF;
  RETURN NEW;
END;
$function$;
