CREATE TABLE IF NOT EXISTS "flow_graph_layouts" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_graph_layouts_flow_node_uq" UNIQUE("flow_id","node_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_graph_layouts" ADD CONSTRAINT "flow_graph_layouts_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flow_graph_layouts" ADD CONSTRAINT "flow_graph_layouts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
