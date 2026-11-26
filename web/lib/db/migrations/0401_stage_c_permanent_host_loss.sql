CREATE TABLE "execution_host_losses" (
	"execution_host_id" text PRIMARY KEY NOT NULL,
	"host_key" text NOT NULL,
	"observed_boot_id" text NOT NULL,
	"operator_id" text NOT NULL,
	"isolation_evidence_ref" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_host_losses_evidence_ref_check" CHECK ("execution_host_losses"."isolation_evidence_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$')
);
--> statement-breakpoint
CREATE FUNCTION maister_guard_execution_host_loss() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'permanent execution host loss evidence is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_host_losses_immutable
BEFORE UPDATE OR DELETE ON execution_host_losses
FOR EACH ROW EXECUTE FUNCTION maister_guard_execution_host_loss();
--> statement-breakpoint
CREATE FUNCTION maister_guard_isolated_execution_host() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM execution_host_losses WHERE execution_host_id = OLD.id)
    AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.host_key IS DISTINCT FROM OLD.host_key
      OR NEW.last_boot_id IS DISTINCT FROM OLD.last_boot_id
      OR NEW.readiness IS DISTINCT FROM 'unavailable'
      OR NEW.readiness_reason IS DISTINCT FROM 'execution_host_permanently_lost')
  THEN
    RAISE EXCEPTION 'permanently isolated execution host cannot be reactivated' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER execution_hosts_permanent_loss_fence
BEFORE UPDATE ON execution_hosts
FOR EACH ROW EXECUTE FUNCTION maister_guard_isolated_execution_host();
--> statement-breakpoint
ALTER TABLE "execution_host_losses" ADD CONSTRAINT "execution_host_losses_execution_host_id_execution_hosts_id_fk" FOREIGN KEY ("execution_host_id") REFERENCES "public"."execution_hosts"("id") ON DELETE restrict ON UPDATE no action;
