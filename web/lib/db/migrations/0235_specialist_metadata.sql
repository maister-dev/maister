ALTER TABLE "agents" ADD COLUMN "specialist" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_specialist_check" CHECK ("agents"."specialist" IS NULL OR (CASE WHEN jsonb_typeof("agents"."specialist")='object' AND jsonb_typeof("agents"."specialist"->'responsibilities')='array' AND jsonb_typeof("agents"."specialist"->'targetClasses')='array' THEN
        "agents"."specialist" ?& ARRAY['responsibilities','targetClasses']
        AND "agents"."specialist"-ARRAY['responsibilities','targetClasses']='{}'::jsonb
        AND jsonb_array_length("agents"."specialist"->'responsibilities') BETWEEN 1 AND 32
        AND jsonb_array_length("agents"."specialist"->'targetClasses') BETWEEN 1 AND 32
        AND NOT jsonb_path_exists("agents"."specialist", '$.*[*] ? (@.type() != "string" || !(@ like_regex "^.{1,255}.?$" flag "s") || !(@ like_regex "[^[:space:]]"))')
        ELSE false END) IS TRUE);