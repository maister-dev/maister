ALTER TABLE "platform_mcp_servers"
  ALTER COLUMN "supported_agents"
  SET DEFAULT '["claude","codex","gemini","opencode","mimo"]'::jsonb;

UPDATE "platform_mcp_servers"
SET
  "supported_agents" = '["claude","codex","gemini","opencode","mimo"]'::jsonb,
  "updated_at" = now()
WHERE "supported_agents" = '["claude","codex","gemini","opencode"]'::jsonb;
