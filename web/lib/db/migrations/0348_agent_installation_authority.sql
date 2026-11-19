CREATE TABLE "agent_installation_run_authorities" (
	"run_id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"binding_revision" integer NOT NULL,
	"binding_digest" text NOT NULL,
	"grant_snapshot" jsonb NOT NULL,
	"principal" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_installation_authority_shape_check" CHECK (
      "agent_installation_run_authorities"."binding_digest" ~ '^[a-f0-9]{64}$' AND "agent_installation_run_authorities"."binding_revision">0 AND
      jsonb_typeof("agent_installation_run_authorities"."grant_snapshot")='object' AND "agent_installation_run_authorities"."grant_snapshot"->>'reach'='active_projects' AND
      jsonb_typeof("agent_installation_run_authorities"."principal")='object' AND
      (("agent_installation_run_authorities"."principal"->>'kind'='manual' AND char_length("agent_installation_run_authorities"."principal"->>'userId') BETWEEN 1 AND 192)
       OR ("agent_installation_run_authorities"."principal"->>'kind'='unattended' AND "agent_installation_run_authorities"."principal"->>'trigger' IN ('cron','domain_event'))) IS TRUE
    )
);
--> statement-breakpoint
CREATE TABLE "agent_installation_run_sources" (
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_installation_run_sources_run_id_project_id_pk" PRIMARY KEY("run_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "agent_installation_run_authorities" ADD CONSTRAINT "agent_installation_authority_revision_fk" FOREIGN KEY ("binding_id","binding_revision") REFERENCES "public"."company_specialist_binding_revisions"("binding_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_installation_run_sources" ADD CONSTRAINT "agent_installation_run_sources_run_id_agent_installation_run_authorities_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_installation_run_authorities"("run_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION reject_installation_witness_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Installation authority and source witnesses are immutable' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_installation_authority_immutable
  BEFORE UPDATE OR DELETE ON agent_installation_run_authorities
  FOR EACH ROW EXECUTE FUNCTION reject_installation_witness_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_installation_source_immutable
  BEFORE UPDATE OR DELETE ON agent_installation_run_sources
  FOR EACH ROW EXECUTE FUNCTION reject_installation_witness_mutation();
