CREATE OR REPLACE FUNCTION public.guard_company_grant_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$;
