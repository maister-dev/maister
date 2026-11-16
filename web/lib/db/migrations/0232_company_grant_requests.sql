SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
ALTER TABLE "company_grants" ADD COLUMN "creation_key" text;--> statement-breakpoint
ALTER TABLE "company_grants" ADD COLUMN "creation_digest" text;--> statement-breakpoint
ALTER TABLE "company_grants" ADD COLUMN "revocation_key" text;--> statement-breakpoint
ALTER TABLE "company_grants" ADD COLUMN "revocation_digest" text;--> statement-breakpoint
ALTER TABLE "company_grants" ADD COLUMN "revoked_by" text;--> statement-breakpoint
ALTER TABLE "company_grants" ADD COLUMN "revocation_reason" text;--> statement-breakpoint
ALTER TABLE "company_grants" ADD CONSTRAINT "company_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_grants_creation_request_action_unique" ON "company_grants" USING btree ("company_id","created_by","creation_key","action") WHERE "company_grants"."creation_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "company_grants" ADD CONSTRAINT "company_grants_creation_receipt_check" CHECK ((("company_grants"."creation_key" IS NULL AND "company_grants"."creation_digest" IS NULL) OR (length("company_grants"."creation_key") BETWEEN 8 AND 128 AND "company_grants"."creation_digest" ~ '^[a-f0-9]{64}$')) IS TRUE);--> statement-breakpoint
ALTER TABLE "company_grants" ADD CONSTRAINT "company_grants_revocation_receipt_check" CHECK (((("company_grants"."revocation_key" IS NULL AND "company_grants"."revocation_digest" IS NULL AND "company_grants"."revoked_by" IS NULL AND "company_grants"."revocation_reason" IS NULL) OR ("company_grants"."revoked_at" IS NOT NULL AND "company_grants"."revoked_by" IS NOT NULL AND length("company_grants"."revocation_key") BETWEEN 8 AND 128 AND "company_grants"."revocation_digest" ~ '^[a-f0-9]{64}$' AND length("company_grants"."revocation_reason") BETWEEN 1 AND 2000 AND "company_grants"."revision">1)) AND ("company_grants"."creation_key" IS NULL OR "company_grants"."revoked_at" IS NULL OR "company_grants"."revocation_key" IS NOT NULL)) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION guard_company_grant_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.creation_key IS NOT NULL OR OLD.revocation_key IS NOT NULL THEN
      RAISE EXCEPTION 'Company authority receipts are immutable; revoke the grant' USING ERRCODE='23514', CONSTRAINT='company_grants_history_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.company_id,NEW.principal_type,NEW.principal_id,NEW.action,NEW.confirmation_classes,NEW.created_by,NEW.created_at,NEW.creation_key,NEW.creation_digest)
    IS DISTINCT FROM ROW(OLD.company_id,OLD.principal_type,OLD.principal_id,OLD.action,OLD.confirmation_classes,OLD.created_by,OLD.created_at,OLD.creation_key,OLD.creation_digest) THEN
    RAISE EXCEPTION 'Company authority input is immutable; revoke and grant a new policy' USING ERRCODE='23514', CONSTRAINT='company_grants_history_immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Company authority revocation is immutable' USING ERRCODE='23514', CONSTRAINT='company_grants_history_immutable';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    IF NEW.creation_key IS NOT NULL OR NEW.revocation_key IS NOT NULL THEN
      IF NEW.revision <> OLD.revision+1 THEN
        RAISE EXCEPTION 'Company authority revocation requires the next exact revision' USING ERRCODE='23514', CONSTRAINT='company_grants_revocation_revision';
      END IF;
    ELSIF NEW.revision NOT IN (OLD.revision,OLD.revision+1) THEN
      RAISE EXCEPTION 'Legacy company authority revision is invalid' USING ERRCODE='23514', CONSTRAINT='company_grants_revocation_revision';
    END IF;
  ELSIF NEW.revision <> OLD.revision OR ROW(NEW.revocation_key,NEW.revocation_digest,NEW.revoked_by,NEW.revocation_reason) IS DISTINCT FROM ROW(OLD.revocation_key,OLD.revocation_digest,OLD.revoked_by,OLD.revocation_reason) THEN
    RAISE EXCEPTION 'Company authority may change only through revocation' USING ERRCODE='23514', CONSTRAINT='company_grants_history_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_grants_history_immutable BEFORE UPDATE OR DELETE ON company_grants FOR EACH ROW EXECUTE FUNCTION guard_company_grant_history();
