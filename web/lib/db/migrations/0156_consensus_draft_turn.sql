ALTER TABLE "agent_turns" DROP CONSTRAINT "agent_turns_source_check";--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_source_check" CHECK ("agent_turns"."ordinal" >= 0
      AND "agent_turns"."variant" IN ('initial', 'resume', 'rework', 'live_message', 'persistent_message', 'consensus_draft')
      AND length("agent_turns"."logical_key") BETWEEN 1 AND 256 AND length("agent_turns"."prompt") BETWEEN 1 AND 1000000);