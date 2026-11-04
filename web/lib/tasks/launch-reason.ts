const REASON_KEYS: Readonly<Record<string, string>> = {
  launch_input_changed: "inputChanged",
  launch_parent_capacity_wait: "parentCapacity",
  launch_capacity_wait: "capacity",
  launch_runner_unavailable: "runner",
  flow_runner_unresolved: "runner",
  launch_flow_assets_changed: "assetsChanged",
  launch_capabilities_changed: "assetsChanged",
  launch_settings_changed: "settingsChanged",
  launch_authority_revoked: "authorityRevoked",
  launch_already_reserved: "alreadyReserved",
  launch_flagged: "held",
  launch_task_held: "held",
  launch_dispatch_committed: "executionStarted",
  launch_state_changed: "statusChanged",
  queue_paused: "paused",
  qualification_required: "qualification",
  qualification_stale: "qualification",
  qualification_evidence_stale: "qualification",
  qualification_parent_unavailable: "parentUnavailable",
  qualification_child_stale: "childChanged",
  launch_status_unavailable: "statusUnavailable",
  launch_storage_unavailable: "storageUnavailable",
  launch_request_invalid: "requestInvalid",
};

/** Public reasons are translated by category; backend messages and enum codes stay in diagnostics. */
export function taskLaunchReasonKey(reason: string): string {
  return `admission.reason.${REASON_KEYS[reason] ?? "technical"}`;
}
