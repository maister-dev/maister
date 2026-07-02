-- Project Brain (ADR-122) brain lineage migration 0002 — adversarial-review fixes.
-- HAND-AUTHORED (no db:generate:brain). Runs AFTER 0001.
--
-- (F3) Idempotent re-embed: without a unique key on the embedding generation an
-- overlapping reindex sweep (multi-instance, or a lease that expires mid-run) can
-- write duplicate rows for the same (item, split, model, dimensions). The UNIQUE
-- index makes a concurrent/double insert a no-op via ON CONFLICT DO NOTHING in
-- retain + reindex.
CREATE UNIQUE INDEX "brain_embeddings_generation_uq" ON "brain_embeddings" USING btree ("item_id", "split_ordinal", "embedding_model", "embedding_dimensions");
--> statement-breakpoint
-- (F4) Harvest idempotency ledger: the at-least-once domain-event dispatcher can
-- redeliver an already-processed event (crash after retain, before the cursor
-- commits). brain_items.source_domain_event_id only records the INSERT path, so a
-- redelivered event that REINFORCED a near-duplicate would double-count
-- confidence/TTL. This ledger records EVERY harvested event id regardless of the
-- retain outcome (insert / reinforce / exact-dup), written in retain's own
-- transaction. No FK on domain_event_id — the marker must outlive domain_events
-- GC so a re-delivery after GC still short-circuits.
CREATE TABLE "brain_harvested_events" (
	"project_id" text NOT NULL,
	"domain_event_id" bigint NOT NULL,
	"harvested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_harvested_events_pk" PRIMARY KEY("project_id","domain_event_id")
);
--> statement-breakpoint
ALTER TABLE "brain_harvested_events" ADD CONSTRAINT "brain_harvested_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
