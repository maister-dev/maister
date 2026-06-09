CREATE TABLE "platform_mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"transport" text DEFAULT 'stdio' NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text,
	"header_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supported_agents" jsonb DEFAULT '["claude","codex"]'::jsonb NOT NULL,
	"trust_status" text DEFAULT 'untrusted' NOT NULL,
	"readiness_status" text DEFAULT 'Unknown' NOT NULL,
	"readiness_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_mcp_servers_transport_ck" CHECK ("transport" IN ('stdio','sse','http')),
	CONSTRAINT "platform_mcp_servers_trust_status_ck" CHECK ("trust_status" IN ('untrusted','trusted','trusted_by_policy')),
	CONSTRAINT "platform_mcp_servers_readiness_status_ck" CHECK ("readiness_status" IN ('Unknown','Ready','NotReady'))
);
--> statement-breakpoint
CREATE INDEX "platform_mcp_servers_transport_enabled_idx" ON "platform_mcp_servers" ("transport","enabled");
