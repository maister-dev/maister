const refusalKeys: Readonly<Record<string, string>> = {
  retry_launch_upgrade_required: "refusal.launchRequired",
  launch_manual_authority_required: "permissionChanged",
  launch_input_changed: "refusal.taskChanged",
  launch_settings_changed: "refusal.contextChanged",
  reconciliation_required: "refusal.reconciliation",
  retry_task_changed: "refusal.taskChanged",
  retry_runner_unavailable: "refusal.runner",
  retry_source_not_failed: "refusal.notFailed",
  retry_source_unsupported: "refusal.unsupported",
  retry_trigger_unsupported: "refusal.unsupported",
  retry_source_unavailable: "refusal.sourceUnavailable",
  retry_agent_unknown: "refusal.agentUnavailable",
  retry_agent_unavailable: "refusal.agentUnavailable",
  retry_configuration_invalid: "refusal.configuration",
  retry_context_changed: "refusal.contextChanged",
  retry_preview_stale: "refusal.previewStale",
  retry_authority_revoked: "permissionChanged",
  retry_successor_already_owned: "refusal.alreadyOwned",
  retry_duplicate_task: "refusal.duplicateTask",
  retry_qualification_active: "refusal.assessmentActive",
  retry_task_busy: "refusal.taskBusy",
  retry_qualification_current: "refusal.assessmentReady",
  qualification_already_active: "refusal.assessmentActive",
  retry_qualification_ready: "refusal.assessmentReady",
  retry_task_already_qualified: "refusal.assessmentReady",
  retry_strategy_changed: "refusal.previewStale",
  qualification_policy_required: "refusal.qualificationPolicy",
  qualification_not_required: "refusal.qualificationRequired",
  retry_request_key_reused: "refusal.previewStale",
  retry_owner_stale: "refusal.contextChanged",
  retry_intent_unavailable: "refusal.sourceUnavailable",
};

export function retryRefusalKey(reason: string | null): string {
  return reason === null
    ? "retryRefused"
    : (refusalKeys[reason] ?? "retryRefused");
}

export async function retryResponseErrorKey(
  response: Response,
): Promise<string> {
  if (response.status === 401 || response.status === 403)
    return "permissionChanged";
  const body: unknown = await response.json().catch(() => null);

  if (
    body !== null &&
    typeof body === "object" &&
    "reason" in body &&
    typeof body.reason === "string"
  ) {
    return retryRefusalKey(body.reason);
  }

  return response.status === 409 ? "retryConflict" : "retryError";
}
