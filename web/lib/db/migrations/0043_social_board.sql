CREATE TABLE IF NOT EXISTS "inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"source_ref" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_items_recipient_type_check" CHECK ("inbox_items"."recipient_type" in ('user', 'agent')),
	CONSTRAINT "inbox_items_event_kind_check" CHECK ("inbox_items"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"project_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"event_kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_activity_event_kind_check" CHECK ("task_activity"."event_kind" in ('task_created', 'comment_added', 'task_mentioned', 'relation_added', 'relation_removed', 'run_launched')),
	CONSTRAINT "task_activity_actor_type_check" CHECK ("task_activity"."actor_type" in ('user', 'agent', 'system')),
	CONSTRAINT "task_activity_actor_pair_check" CHECK (("task_activity"."actor_type" = 'system') = ("task_activity"."actor_id" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"project_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_comments_actor_type_check" CHECK ("task_comments"."actor_type" in ('user', 'agent', 'system')),
	CONSTRAINT "task_comments_actor_pair_check" CHECK (("task_comments"."actor_type" = 'system') = ("task_comments"."actor_id" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"from_task_id" text NOT NULL,
	"kind" text NOT NULL,
	"to_task_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_relations_from_kind_to_uq" UNIQUE("from_task_id","kind","to_task_id"),
	CONSTRAINT "task_relations_kind_check" CHECK ("task_relations"."kind" in ('blocks', 'depends_on', 'parent_of')),
	CONSTRAINT "task_relations_no_self_check" CHECK ("task_relations"."from_task_id" <> "task_relations"."to_task_id"),
	CONSTRAINT "task_relations_actor_type_check" CHECK ("task_relations"."actor_type" in ('user', 'agent', 'system')),
	CONSTRAINT "task_relations_actor_pair_check" CHECK (("task_relations"."actor_type" = 'system') = ("task_relations"."actor_id" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_subscribers" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"subscriber_type" text NOT NULL,
	"subscriber_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_subscribers_task_pair_uq" UNIQUE("task_id","subscriber_type","subscriber_id"),
	CONSTRAINT "task_subscribers_type_check" CHECK ("task_subscribers"."subscriber_type" in ('user', 'agent')),
	CONSTRAINT "task_subscribers_reason_check" CHECK ("task_subscribers"."reason" in ('creator', 'commenter', 'mentioned', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "task_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "next_task_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer;--> statement-breakpoint
UPDATE "tasks" t SET "number" = sub.rn
FROM (
	SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
	FROM "tasks"
) sub
WHERE t.id = sub.id;--> statement-breakpoint
UPDATE "projects" p SET "next_task_number" = sub.max_n + 1
FROM (
	SELECT project_id, MAX(number) AS max_n
	FROM "tasks"
	GROUP BY project_id
) sub
WHERE p.id = sub.project_id;--> statement-breakpoint
DO $$
DECLARE
	proj RECORD;
	letters text;
	base text;
	candidate text;
	suffix integer;
BEGIN
	FOR proj IN SELECT id, name, slug FROM projects ORDER BY created_at, id LOOP
		letters := regexp_replace(proj.name, '[^A-Za-z]', '', 'g');
		IF length(letters) < 2 THEN
			letters := letters || regexp_replace(proj.slug, '[^A-Za-z]', '', 'g');
		END IF;
		IF length(letters) < 2 THEN
			letters := letters || 'XX';
		END IF;
		base := upper(substr(letters, 1, 3));
		candidate := base;
		IF EXISTS (SELECT 1 FROM projects WHERE task_key = candidate) THEN
			candidate := upper(substr(letters, 1, 4));
		END IF;
		suffix := 2;
		WHILE EXISTS (SELECT 1 FROM projects WHERE task_key = candidate) LOOP
			candidate := base || suffix::text;
			suffix := suffix + 1;
		END LOOP;
		UPDATE projects SET task_key = candidate WHERE id = proj.id;
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "task_key" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_from_task_id_tasks_id_fk" FOREIGN KEY ("from_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_to_task_id_tasks_id_fk" FOREIGN KEY ("to_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_subscribers" ADD CONSTRAINT "task_subscribers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_items_recipient_idx" ON "inbox_items" USING btree ("recipient_type","recipient_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_activity_task_created_idx" ON "task_activity" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_activity_project_created_idx" ON "task_activity" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_comments_task_created_idx" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_relations_to_task_idx" ON "task_relations" USING btree ("to_task_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_task_key_unique" UNIQUE("task_key");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_number_uq" UNIQUE("project_id","number");
