-- ADR-177: MCP configuration values become literal-or-reference MAPS.
--
-- `platform_mcp_servers` gains `env`/`headers` (Record<name, value>),
-- `bearer_token_env` and `description`; the two pre-ADR-177 name-list columns
-- are dropped after backfill. `capability_records.material` for kind='mcp' is
-- rewritten from its THREE legacy shapes (project rows, platform-from-YAML
-- rows, package requirement rows) to the SAME map shape, which also gives a
-- package TEMPLATE target the slots `resolveBindTarget` could not name before.
--
-- Two stored key spellings exist (`GITHUB_TOKEN` and `env:GITHUB_TOKEN`),
-- because the pre-ADR-177 key regex accepted both. Every derivation below
-- strips `^env:` on BOTH sides: a key that keeps the prefix becomes a map key
-- no server reads.
--
-- The backfill is fully SQL-derivable from the old columns, so there is no
-- abort guard: nothing is lost. `project_mcp_bindings.config_overlay` is NOT
-- rewritten — its keys never changed, and a stored
-- {GITHUB_TOKEN: "env:PROJ_A_GH"} now MEANS what the operator meant.
--
-- Every statement is self-contained: the drizzle migrator applies this file
-- inside one transaction while the replay helper applies it statement by
-- statement, and both paths must succeed.

ALTER TABLE "platform_mcp_servers"
  ADD COLUMN "env" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "headers" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "bearer_token_env" text,
  ADD COLUMN "description" text;
--> statement-breakpoint
UPDATE "platform_mcp_servers" p
SET
  "env" = COALESCE((
    SELECT jsonb_object_agg(
      regexp_replace(k, '^env:', ''),
      to_jsonb('env:' || regexp_replace(k, '^env:', ''))
    )
    FROM jsonb_array_elements_text(p."env_keys") AS k
  ), '{}'::jsonb),
  "headers" = COALESCE((
    SELECT jsonb_object_agg(
      regexp_replace(k, '^env:', ''),
      to_jsonb('env:' || regexp_replace(k, '^env:', ''))
    )
    FROM jsonb_array_elements_text(p."header_keys") AS k
  ), '{}'::jsonb);
--> statement-breakpoint
UPDATE "capability_records" c
SET "material" = (c."material" - 'envKeys' - 'headerKeys')
  || jsonb_build_object(
       'env',
       CASE
         WHEN c."material" ? 'envKeys' THEN COALESCE((
           SELECT jsonb_object_agg(
             regexp_replace(k, '^env:', ''),
             to_jsonb('env:' || regexp_replace(k, '^env:', ''))
           )
           FROM jsonb_array_elements_text(c."material" -> 'envKeys') AS k
         ), '{}'::jsonb)
         ELSE COALESCE(c."material" -> 'env', '{}'::jsonb)
       END,
       'headers',
       CASE
         WHEN c."material" ? 'headerKeys' THEN COALESCE((
           SELECT jsonb_object_agg(
             regexp_replace(k, '^env:', ''),
             to_jsonb('env:' || regexp_replace(k, '^env:', ''))
           )
           FROM jsonb_array_elements_text(c."material" -> 'headerKeys') AS k
         ), '{}'::jsonb)
         ELSE COALESCE(c."material" -> 'headers', '{}'::jsonb)
       END
     )
WHERE c."kind" = 'mcp'
  AND jsonb_typeof(c."material") = 'object';
--> statement-breakpoint
ALTER TABLE "platform_mcp_servers"
  DROP COLUMN "env_keys",
  DROP COLUMN "header_keys";
