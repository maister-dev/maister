DO $$
DECLARE
  open_unowned bigint;
  retained_unowned bigint;
BEGIN
  SELECT count(*) INTO open_unowned FROM execution_commands
  WHERE kind = 'session.prompt' AND owner_kind IS NULL
    AND state IN ('queued', 'delivering', 'accepted');

  IF open_unowned > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '55006',
      MESSAGE = 'mandatory prompt owner activation refused: ' || open_unowned ||
        ' pre-v2 prompt command(s) are still open',
      DETAIL = 'An open prompt with no owner cannot be proven or reconstructed. Drain these runs on the previous release, then re-run this migration.',
      HINT = 'select id, run_id, state from execution_commands where kind = ''session.prompt'' and owner_kind is null and state in (''queued'', ''delivering'', ''accepted'')';
  END IF;

  SELECT count(*) INTO retained_unowned FROM execution_commands
  WHERE kind = 'session.prompt' AND owner_kind IS NULL;

  RAISE NOTICE 'prompt-owner activation v2: % pre-v2 prompt row(s) preserved unreconstructed', retained_unowned;
END $$;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_prompt_owner_required" CHECK ("execution_commands"."kind" <> 'session.prompt' OR "execution_commands"."owner_kind" IS NOT NULL) NOT VALID;
