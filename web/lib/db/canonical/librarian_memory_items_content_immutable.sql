CREATE OR REPLACE FUNCTION public.librarian_memory_items_content_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'librarian_memory_items_content_immutable',
      MESSAGE = 'memory content is immutable; insert a revision instead';
  END IF;
  RETURN NEW;
END;
$function$;
