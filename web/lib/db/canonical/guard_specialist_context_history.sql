CREATE OR REPLACE FUNCTION public.guard_specialist_context_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Retained working context revisions and request receipts are immutable'
    USING ERRCODE='23514',CONSTRAINT='specialist_context_history_immutable';
END $function$;
