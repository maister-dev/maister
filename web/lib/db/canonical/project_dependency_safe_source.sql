CREATE OR REPLACE FUNCTION public.project_dependency_safe_source(value text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  SELECT length(value) BETWEEN 1 AND 4096 AND value !~ '[[:cntrl:]]'
    AND (left(value,1)='/' OR (
      value !~ '[?#]' AND value !~ '[[:space:]]' AND position(chr(92) in value)=0 AND (
        value ~ '^https?://[^/@:]+(:[0-9]+)?(/|$)' OR
        value ~ '^https?://\[[0-9a-fA-F:]+\](:[0-9]+)?(/|$)' OR
        value ~ '^file://(localhost)?/' OR
        value ~ '^ssh://([a-zA-Z0-9._-]+@)?([^/@:]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?(/|$)' OR
        (value ~ '^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*@[a-zA-Z0-9_.][a-zA-Z0-9_.-]*:.+$' AND position('::' in value)=0)
      )
    ));
$function$;
