// Client-safe DTOs for the admin Evaluations settings UI (T5.1). The server page
// maps DB rows / registry items into these plain shapes — no Date objects, no
// installed_path, no prompt/schema bodies, no secrets cross the RSC boundary.

export interface MethodologyRow {
  id: string;
  qualifiedId: string;
  packageName: string;
  versionLabel: string;
  activation: "enabled" | "disabled";
  health: "ready" | "degraded" | "incompatible";
  validationErrors: string[] | null;
  trustStatus: string;
}

export interface PanelRoleBinding {
  role: string;
  agentId: string;
  runnerId?: string | null;
}

export interface PanelPolicy {
  attempts: number;
  maxParallelAttempts: number;
  quorum: number;
  timeoutMs: number;
  maxRetries: number;
  blindLabels: boolean;
  randomizeOrder: boolean;
  allowedMcps: string[];
}

export interface JudgePanelRow {
  id: string;
  name: string;
  revision: number;
  roleBindings: PanelRoleBinding[];
  policy: PanelPolicy;
  enabled: boolean;
}

export interface ProfileRow {
  id: string;
  name: string;
  revision: number;
  methodRevisionId: string;
  panelId: string;
  enabled: boolean;
}
