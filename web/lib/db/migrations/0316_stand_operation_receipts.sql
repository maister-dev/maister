CREATE TABLE "stand_operation_receipts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"operation_id" text NOT NULL,
	"target_receipt_revision" integer NOT NULL,
	"target_sequence" bigint NOT NULL,
	"permit_id" text,
	"receipt" jsonb NOT NULL,
	"receipt_digest" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stand_operation_receipts_revision_unique" UNIQUE("operation_id","target_receipt_revision"),
	CONSTRAINT "stand_operation_receipts_sequence_unique" UNIQUE("operation_id","target_sequence"),
	CONSTRAINT "stand_operation_receipts_shape_check" CHECK ("stand_operation_receipts"."target_receipt_revision" BETWEEN 1 AND 3
      AND "stand_operation_receipts"."target_sequence" BETWEEN 1 AND 9007199254740991
      AND "stand_operation_receipts"."receipt_digest" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("stand_operation_receipts"."receipt")='object')
);
--> statement-breakpoint
ALTER TABLE "stand_operation_receipts" ADD CONSTRAINT "stand_operation_receipts_operation_id_stand_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."stand_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stand_operation_receipts" ADD CONSTRAINT "stand_operation_receipts_permit_id_stand_authorization_permits_id_fk" FOREIGN KEY ("permit_id") REFERENCES "public"."stand_authorization_permits"("id") ON DELETE restrict ON UPDATE no action;