ALTER TABLE "agent_memory_proposals" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "agent_memory_proposals" ADD CONSTRAINT "agent_memory_proposal_decision_reason_check" CHECK ("agent_memory_proposals"."decision_reason" IS NULL OR (
        "agent_memory_proposals"."state" IN ('accepted','rejected')
        AND char_length("agent_memory_proposals"."decision_reason") BETWEEN 1 AND 2000
        AND "agent_memory_proposals"."decision_reason" !~ '^[[:space:]]|[[:space:]]$'
      ));