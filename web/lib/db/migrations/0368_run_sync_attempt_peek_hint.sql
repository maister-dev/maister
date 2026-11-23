CREATE TRIGGER run_sync_attempts_peek_hint
AFTER INSERT OR UPDATE OR DELETE ON run_sync_attempts
FOR EACH ROW EXECUTE FUNCTION public.maister_run_peek_hint(
  'summary',
  'run_id,phase,mode,target_ref,target_sha,head_sha_before,head_sha_after,session_name,runner_id,conflicted_files,pushed,error_code'
);
