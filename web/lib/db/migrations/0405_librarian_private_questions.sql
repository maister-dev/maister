ALTER TABLE "librarian_cards" DROP CONSTRAINT "librarian_cards_kind_check";--> statement-breakpoint
ALTER TABLE "librarian_turns" DROP CONSTRAINT "librarian_turns_status_check";--> statement-breakpoint
DROP INDEX "librarian_turns_one_active_uq";--> statement-breakpoint
ALTER TABLE "librarian_cards" ADD COLUMN "question_turn_id" text;--> statement-breakpoint
ALTER TABLE "librarian_cards" ADD COLUMN "question_key" text;--> statement-breakpoint
ALTER TABLE "librarian_cards" ADD COLUMN "question_checkpoint_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "librarian_cards" ADD COLUMN "question_answer" jsonb;--> statement-breakpoint
ALTER TABLE "librarian_cards" ADD COLUMN "question_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "librarian_cards" ADD CONSTRAINT "librarian_cards_question_owner_fk" FOREIGN KEY ("question_turn_id","conversation_id","segment_id") REFERENCES "public"."librarian_turns"("id","conversation_id","segment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "librarian_cards_question_key_uq" ON "librarian_cards" USING btree ("question_turn_id","question_key") WHERE "librarian_cards"."kind" = 'question';--> statement-breakpoint
CREATE UNIQUE INDEX "librarian_cards_pending_question_uq" ON "librarian_cards" USING btree ("question_turn_id") WHERE "librarian_cards"."kind" = 'question' AND "librarian_cards"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "librarian_turns_one_active_uq" ON "librarian_turns" USING btree ("conversation_id") WHERE "librarian_turns"."status" IN ('admitted', 'running', 'awaiting_answer');--> statement-breakpoint
ALTER TABLE "librarian_turns" ADD CONSTRAINT "librarian_turns_owner_uq" UNIQUE("id","conversation_id","segment_id");--> statement-breakpoint
ALTER TABLE "librarian_cards" ADD CONSTRAINT "librarian_cards_question_shape_check" CHECK ((
      ("librarian_cards"."kind" <> 'question' AND "librarian_cards"."question_turn_id" IS NULL AND "librarian_cards"."question_key" IS NULL
        AND "librarian_cards"."question_checkpoint_at" IS NULL AND "librarian_cards"."question_answer" IS NULL AND "librarian_cards"."question_delivered_at" IS NULL)
      OR ("librarian_cards"."kind" = 'question' AND "librarian_cards"."question_turn_id" IS NOT NULL
        AND length("librarian_cards"."question_key") BETWEEN 1 AND 128 AND "librarian_cards"."requires_owner"
        AND ("librarian_cards"."status" <> 'pending' OR ("librarian_cards"."question_answer" IS NULL AND "librarian_cards"."decided_at" IS NULL))
        AND ("librarian_cards"."status" <> 'accepted' OR ("librarian_cards"."question_checkpoint_at" IS NOT NULL
          AND jsonb_typeof("librarian_cards"."question_answer") = 'object' AND "librarian_cards"."decided_at" IS NOT NULL))
        AND ("librarian_cards"."question_delivered_at" IS NULL OR "librarian_cards"."status" = 'accepted'))
    ) IS TRUE);--> statement-breakpoint
ALTER TABLE "librarian_cards" ADD CONSTRAINT "librarian_cards_kind_check" CHECK ("librarian_cards"."kind" IN ('statement_proposal', 'confirmation', 'memory_suggestion', 'knowledge_proposal', 'brain_proposal', 'vault_edit', 'question'));--> statement-breakpoint
ALTER TABLE "librarian_turns" ADD CONSTRAINT "librarian_turns_status_check" CHECK ("librarian_turns"."status" IN ('queued', 'admitted', 'running', 'awaiting_answer', 'completed', 'stopped', 'failed', 'withdrawn'));