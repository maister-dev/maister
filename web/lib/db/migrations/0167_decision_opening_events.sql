-- M51 (ADR-169 amendment): two decision-OPENING domain event kinds.
--
-- `domain_events` is the shared trigger bus, and it had no kind for either of
-- the two commonest ways a decision opens. `run.needs_input` is a run blocked on
-- a human answer. `run.review_opened` is the COMPLEMENT of `run.review`: ADR-100
-- deliberately scoped that kind to runs WITH a parent because its consumer is
-- the orchestrator resume, so a top-level run reaching Review emitted nothing.
-- Together the two now cover every entry into Review, and neither redefines an
-- existing kind — no shipped consumer sees a widened population.
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_kind_check";--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_kind_check" CHECK ("domain_events"."kind" in ('task.created', 'task.comment_added', 'task.triage_requeued', 'task.clarification_answered', 'run.done', 'run.failed', 'run.crashed', 'run.abandoned', 'run.review', 'run.review_opened', 'run.needs_input', 'run.escalated', 'run.rework_claimed', 'run.rework_returned', 'gate.failed'));
