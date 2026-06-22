INSERT INTO "capability_records" (
  "id",
  "project_id",
  "capability_ref_id",
  "kind",
  "label",
  "source",
  "version",
  "revision",
  "agents",
  "enforceability",
  "selected_by_default",
  "selectable",
  "material",
  "disabled_at",
  "created_at",
  "updated_at"
)
SELECT
  'pkg-skill-' || md5("attachments"."id" || ':' || "skills"."value") AS "id",
  "attachments"."project_id",
  "skills"."value",
  'skill',
  "skills"."value",
  'flow-package',
  "installs"."version_label",
  "installs"."resolved_revision",
  '["claude","codex","gemini","opencode","mimo"]'::jsonb,
  'instructed',
  true,
  true,
  jsonb_build_object(
    'origin', 'package-attachment',
    'packageInstallId', "installs"."id",
    'hasContent', true
  ),
  NULL,
  now(),
  now()
FROM "project_package_attachments" AS "attachments"
JOIN "package_installs" AS "installs"
  ON "installs"."id" = "attachments"."package_install_id"
CROSS JOIN LATERAL jsonb_array_elements_text(
  coalesce("installs"."manifest" #> '{inventory,skills}', '[]'::jsonb)
) AS "skills"("value")
ON CONFLICT ("project_id", "source", "kind", "capability_ref_id") DO NOTHING;
