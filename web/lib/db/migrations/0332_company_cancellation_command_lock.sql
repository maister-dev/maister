CREATE OR REPLACE FUNCTION check_company_cancellation_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cancellation jsonb;
BEGIN
  IF NEW.kind IN ('session.create','session.prompt','session.input','session.steer') THEN
    -- Cancellation changes a non-key field. Keep the exclusion and allow result FK witnesses.
    SELECT company_cancellation_intent INTO cancellation FROM runs WHERE id=NEW.run_id FOR NO KEY UPDATE;
    IF cancellation IS NOT NULL THEN
      RAISE EXCEPTION 'Company cancellation refuses new execution commands' USING ERRCODE='23514', CONSTRAINT='execution_commands_company_cancellation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
