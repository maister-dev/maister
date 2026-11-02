CREATE FUNCTION guard_task_launch_token_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin jsonb; token project_tokens%ROWTYPE; field text; bound_run_id text;
BEGIN
  IF NEW.principal_kind<>'project_token' THEN RETURN NEW; END IF;
  origin:=NEW.basis->'origin';
  IF NOT (jsonb_typeof(origin)='object' AND origin->'version'='1'::jsonb AND origin->>'kind'='token'
    AND origin ?& ARRAY['version','kind','tokenId','tokenKind','projectId','ownerUserId','agentId','boundRunId','librarianTurnId']
    AND origin-ARRAY['version','kind','tokenId','tokenKind','projectId','ownerUserId','agentId','boundRunId','librarianTurnId']='{}'::jsonb
    AND origin->>'tokenId'=NEW.principal_id AND origin->>'tokenKind' IN ('project','user','agent','librarian')
    AND octet_length(origin::text)<=8192 AND NEW.basis->>'kind' IN ('automatic','execution_child')) IS TRUE THEN
    RAISE EXCEPTION 'Bearer task launch requires its verified durable origin identity'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_token_origin_current';
  END IF;
  FOREACH field IN ARRAY ARRAY['tokenId','projectId','ownerUserId','agentId','boundRunId','librarianTurnId'] LOOP
    IF NOT (origin->field='null'::jsonb OR jsonb_typeof(origin->field)='string'
      AND length(origin->>field) BETWEEN 1 AND 256) IS TRUE THEN
      RAISE EXCEPTION 'Bearer task launch origin identifiers must be bounded'
        USING ERRCODE='23514',CONSTRAINT='task_launch_intents_token_origin_current';
    END IF;
  END LOOP;
  SELECT * INTO token FROM project_tokens WHERE id=NEW.principal_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bearer task launch token is unavailable'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_token_origin_current';
  END IF;
  bound_run_id:=substring(token.name from '^(?:orchestrator-run|agent-run):(.+)$');
  IF token.revoked_at IS NOT NULL OR token.expires_at<=clock_timestamp()
    OR NOT (token.scopes ? '*' OR NEW.basis->>'kind'='automatic' AND token.scopes ? 'runs:launch'
      OR NEW.basis->>'kind'='execution_child' AND token.scopes ? 'runs:delegate')
    OR origin->>'tokenKind' IS DISTINCT FROM token.token_kind
    OR origin->'projectId' IS DISTINCT FROM coalesce(to_jsonb(token.project_id),'null'::jsonb)
    OR origin->'ownerUserId' IS DISTINCT FROM coalesce(to_jsonb(token.owner_user_id),'null'::jsonb)
    OR origin->'agentId' IS DISTINCT FROM coalesce(to_jsonb(token.agent_id),'null'::jsonb)
    OR origin->'boundRunId' IS DISTINCT FROM coalesce(to_jsonb(bound_run_id),'null'::jsonb)
    OR origin->'librarianTurnId' IS DISTINCT FROM coalesce(to_jsonb(token.librarian_turn_id),'null'::jsonb)
    OR token.project_id IS NOT NULL AND token.project_id<>NEW.project_id
    OR NEW.actor_user_id IS DISTINCT FROM (CASE WHEN token.token_kind IN ('user','librarian') THEN token.owner_user_id ELSE NULL END)
    OR NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND archived_at IS NULL)
    OR token.token_kind IN ('user','librarian') AND NOT EXISTS(SELECT 1 FROM users u
      WHERE u.id=token.owner_user_id AND u.account_status='active' AND NOT u.must_change_password
        AND (u.role='admin' OR EXISTS(SELECT 1 FROM project_members membership
          WHERE membership.project_id=NEW.project_id AND membership.user_id=u.id AND membership.role IN ('owner','admin','member'))))
    OR token.token_kind='librarian' AND NOT EXISTS(SELECT 1 FROM librarian_turns turn
      JOIN librarian_conversations conversation ON conversation.id=turn.conversation_id
      WHERE turn.id=token.librarian_turn_id AND turn.status='running' AND conversation.user_id=token.owner_user_id)
    OR bound_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs parent WHERE parent.id=bound_run_id
      AND parent.project_id=token.project_id AND (token.agent_id IS NULL OR parent.agent_id=token.agent_id)
      AND parent.status IN ('Pending','Running','NeedsInput','NeedsInputIdle','HumanWorking','WaitingOnChildren')) THEN
    RAISE EXCEPTION 'Bearer task launch origin differs from its current scoped authority'
      USING ERRCODE='23514',CONSTRAINT='task_launch_intents_token_origin_current';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_launch_intents_token_origin_guard BEFORE INSERT ON task_launch_intents
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_token_origin();
