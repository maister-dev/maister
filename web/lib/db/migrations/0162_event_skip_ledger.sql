CREATE TABLE IF NOT EXISTS "execution_event_skips" (
	"id" text PRIMARY KEY NOT NULL,
	"event_stream_id" text NOT NULL,
	"execution_host_id" text NOT NULL,
	"host_sequence" bigint NOT NULL,
	"event_id" text NOT NULL,
	"run_id" text NOT NULL,
	"event_type" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_event_skips_stream_sequence_unique" UNIQUE("event_stream_id","host_sequence"),
	CONSTRAINT "execution_event_skips_event_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "execution_event_skips" ADD CONSTRAINT "execution_event_skips_event_stream_id_execution_event_streams_id_fk" FOREIGN KEY ("event_stream_id") REFERENCES "public"."execution_event_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_event_skips" ADD CONSTRAINT "execution_event_skips_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_event_skips_stream_scan_idx" ON "execution_event_skips" USING btree ("event_stream_id","host_sequence");
