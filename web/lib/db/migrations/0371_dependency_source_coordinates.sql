CREATE OR REPLACE FUNCTION project_dependency_safe_source(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  parts text[];
  host text;
  octets text[];
  item text;
  octet numeric;
  idx integer;
  pos integer;
  radix integer;
  digit integer;
  encoded bytea;
BEGIN
  IF length(value) NOT BETWEEN 1 AND 4096 OR value ~ U&'[\0001-\001F\007F-\009F]' THEN RETURN false; END IF;
  IF left(value,1)='/' THEN RETURN true; END IF;
  IF value ~ U&'[ ?#\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' OR position(chr(92) in value)>0 THEN RETURN false; END IF;

  parts := regexp_match(value, '^file://(?:localhost)?(/.*)$');
  IF parts IS NOT NULL THEN
    IF parts[1] ~* '%(2f|00)' OR regexp_replace(parts[1],'%[0-9a-fA-F]{2}','','g') LIKE '%\%%' THEN RETURN false; END IF;
    SELECT decode(string_agg(CASE WHEN left(piece[1],1)='%' THEN substr(piece[1],2) ELSE encode(convert_to(piece[1],'UTF8'),'hex') END,'' ORDER BY ordinal),'hex')
    INTO encoded FROM regexp_matches(parts[1],'%[0-9a-fA-F]{2}|[^%]+','g') WITH ORDINALITY AS segments(piece,ordinal);
    PERFORM convert_from(encoded,'UTF8');
    RETURN true;
  END IF;
  IF value ~ '^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*@[a-zA-Z0-9_.][a-zA-Z0-9_.-]*:.+$' AND position('::' in value)=0 THEN RETURN true; END IF;
  parts := regexp_match(value, '^(https?|ssh)://(?:([a-zA-Z0-9._-]+)@)?(\[[0-9a-fA-F:.]+\]|[^/@:\[\]%<>|^]+)(?::([0-9]+))?(?:/.*)?$');
  IF parts IS NULL OR (parts[2] IS NOT NULL AND parts[1]<>'ssh') OR parts[4]::numeric > 65535 THEN RETURN false; END IF;
  host := parts[3];
  IF left(host,1)='[' THEN RETURN family(substr(host,2,length(host)-2)::inet)=6; END IF;
  IF host ~ '^[0-9.]+$' AND position('.' in host)>0 THEN
    octets := string_to_array(regexp_replace(host,'\.$',''),'.');
    IF cardinality(octets) NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
    FOR idx IN 1..cardinality(octets) LOOP
      item := octets[idx];
      IF item !~ '^[0-9]+$' THEN RETURN false; END IF;
      radix := CASE WHEN length(item)>1 AND left(item,1)='0' THEN 8 ELSE 10 END;
      octet := 0;
      FOR pos IN 1..length(item) LOOP
        digit := substr(item,pos,1)::integer;
        IF digit >= radix THEN RETURN false; END IF;
        octet := octet*radix + digit;
        IF octet >= power(256::numeric,CASE WHEN idx=cardinality(octets) THEN 5-cardinality(octets) ELSE 1 END) THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR character_not_in_repertoire OR untranslatable_character THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE unsafe record;
BEGIN
  SELECT d.project_id,d.id,d.effective_attachment_id INTO unsafe
  FROM project_dependency_declarations d
  WHERE project_dependency_safe_source(d.desired->>'source') IS NOT TRUE
     OR EXISTS (SELECT 1 FROM project_dependency_attempts a WHERE a.declaration_id=d.id
                AND project_dependency_safe_source(a.desired->>'source') IS NOT TRUE)
  ORDER BY d.project_id,d.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Repair dependency coordinates in project %, declaration %, attachment %',
      unsafe.project_id,unsafe.id,unsafe.effective_attachment_id USING ERRCODE='23514';
  END IF;
END;
$$;
