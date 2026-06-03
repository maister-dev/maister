// The external_check readiness helpers are defined in `readiness-core.ts` (the
// pure SSOT classifier, carrying no `server-only` marker). This module re-exports
// them so existing callers that import from `external-gate-readiness` keep
// working. Single source of truth for the external_check allow-list + collapse is
// `readiness-core`. (M15, ADR-048)
export {
  EXTERNAL_GATE_READY_STATUSES,
  isExternalGateReady,
  collapseLatestExternalPerGate,
} from "@/lib/flows/graph/readiness-core";
