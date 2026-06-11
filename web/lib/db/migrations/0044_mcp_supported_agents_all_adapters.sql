ALTER TABLE "platform_mcp_servers"
  ALTER COLUMN "supported_agents"
  SET DEFAULT '["claude","codex","gemini","opencode"]'::jsonb;
