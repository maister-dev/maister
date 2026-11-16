ALTER TABLE "specialist_owner_claims" ADD COLUMN "epoch_started_at" timestamp with time zone;
--> statement-breakpoint
CREATE FUNCTION set_specialist_epoch_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.epoch<>OLD.epoch THEN
    NEW.epoch_started_at:=NEW.renewed_at;
  ELSE
    NEW.epoch_started_at:=OLD.epoch_started_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_owner_epoch_start BEFORE INSERT OR UPDATE ON specialist_owner_claims
  FOR EACH ROW EXECUTE FUNCTION set_specialist_epoch_start();
--> statement-breakpoint
CREATE FUNCTION stamp_native_specialist_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM specialist_run_links link
    JOIN specialist_owner_claims owner ON owner.assignment_id=link.assignment_id
    WHERE link.run_id=COALESCE(NEW.company_run_id,NEW.bound_run_id)
      AND (link.work_witness IS NOT NULL OR (link.work_id IS NULL AND link.role IN ('specialist','coordinator','continuation')))
  ) THEN
    IF TG_OP='UPDATE' THEN
      IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Native specialist credential issue time is immutable'
          USING ERRCODE='23514',CONSTRAINT='specialist_native_credential_time_immutable';
      END IF;
    ELSE
      NEW.created_at:=clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER specialist_native_credential_time BEFORE INSERT OR UPDATE OF created_at ON project_tokens
  FOR EACH ROW WHEN (NEW.company_run_id IS NOT NULL OR NEW.bound_run_id IS NOT NULL)
  EXECUTE FUNCTION stamp_native_specialist_credential();
