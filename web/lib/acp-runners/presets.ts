import "server-only";

import type {
  AdapterId,
  PermissionPolicy,
} from "@/lib/acp-runners/adapter-support";
import type { PlatformRunnerProvider } from "@/lib/db/schema";

export type PlatformRunnerPresetRow = {
  readonly id: string;
  readonly adapter: AdapterId;
  readonly capabilityAgent: AdapterId;
  readonly model: string;
  readonly provider: PlatformRunnerProvider;
  readonly permissionPolicy: PermissionPolicy;
  readonly sidecarId?: string | null;
  readonly readinessStatus: "Ready" | "NotReady";
  readonly readinessReasons: readonly string[];
  readonly enabled: boolean;
};

export type RouterSidecarPresetRow = {
  readonly id: string;
  readonly kind: "ccr";
  readonly lifecycle: "managed" | "external";
  readonly commandPreset?: "ccr_start";
  readonly configPath?: string | null;
  readonly baseUrl?: string | null;
  readonly healthcheckUrl?: string | null;
  readonly authTokenRef?: string | null;
  readonly readinessStatus: "Ready" | "NotReady";
  readonly readinessReasons: readonly string[];
  readonly enabled: boolean;
};

export const defaultPlatformRunnerId = "claude-code";

const notReadyCodexCompatibleReason =
  "Codex OpenAI-compatible provider materialization is not verified";
const notReadyGeminiSmokeReason =
  "Gemini ACP initialize/newSession and checkpoint smoke must be confirmed";
const notReadyOpencodeSmokeReason =
  "OpenCode ACP stdio and writable-state smoke must be confirmed";
const notReadyMimoSmokeReason =
  "MiMo Code ACP stdio and writable-state smoke must be confirmed";

export function routerSidecarPresetRows(): RouterSidecarPresetRow[] {
  return [
    {
      id: "ccr-default",
      kind: "ccr",
      lifecycle: "managed",
      commandPreset: "ccr_start",
      configPath: "~/.claude-code-router/config.json",
      baseUrl: "http://127.0.0.1:3456",
      healthcheckUrl: "http://127.0.0.1:3456/health",
      authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
      readinessStatus: "NotReady",
      readinessReasons: [
        "CCR sidecar health must be confirmed by supervisor diagnostics",
      ],
      enabled: true,
    },
  ];
}

export function platformRunnerPresetRows(): PlatformRunnerPresetRow[] {
  return [
    {
      id: "claude-code",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
      permissionPolicy: "default",
      readinessStatus: "Ready",
      readinessReasons: [],
      enabled: true,
    },
    {
      id: "claude-code-ccr",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "glm-5.1",
      provider: { kind: "anthropic_compatible" },
      permissionPolicy: "default",
      sidecarId: "ccr-default",
      readinessStatus: "NotReady",
      readinessReasons: [
        "CCR sidecar health must be confirmed by supervisor diagnostics",
      ],
      enabled: true,
    },
    {
      id: "claude-code-env-router",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "glm-5.1",
      provider: {
        kind: "anthropic_compatible",
        authToken: "env:ZAI_API_KEY",
        baseUrl: "https://api.z.ai/api/anthropic",
      },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
      readinessReasons: [
        "ZAI_API_KEY must be configured in supervisor environment",
      ],
      enabled: true,
    },
    {
      id: "claude-code-dangerous",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
      permissionPolicy: "dangerously_skip_permissions",
      readinessStatus: "Ready",
      readinessReasons: [],
      enabled: true,
    },
    {
      id: "codex-openai",
      adapter: "codex",
      capabilityAgent: "codex",
      model: "gpt-5-codex",
      provider: { kind: "openai" },
      permissionPolicy: "default",
      readinessStatus: "Ready",
      readinessReasons: [],
      enabled: true,
    },
    {
      id: "codex-zai-glm",
      adapter: "codex",
      capabilityAgent: "codex",
      model: "glm-5.1",
      provider: {
        kind: "openai_compatible",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiKey: "env:ZAI_API_KEY",
        wireApi: "responses",
      },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
      readinessReasons: [notReadyCodexCompatibleReason],
      enabled: true,
    },
    {
      id: "codex-qwen",
      adapter: "codex",
      capabilityAgent: "codex",
      model: "qwen-coder",
      provider: {
        kind: "openai_compatible",
        baseUrl:
          "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
        apiKey: "env:DASHSCOPE_API_KEY",
        wireApi: "responses",
      },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
      readinessReasons: [notReadyCodexCompatibleReason],
      enabled: true,
    },
    {
      id: "gemini-cli",
      adapter: "gemini",
      capabilityAgent: "gemini",
      model: "gemini-2.5-pro",
      // Keyless by default: the Gemini CLI's ambient login supplies credentials
      // and advertises its model list over ACP. A keyed google_gemini runner is
      // still creatable for headless/CI hosts without a CLI login.
      provider: { kind: "google_gemini" },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
      readinessReasons: [notReadyGeminiSmokeReason],
      enabled: true,
    },
    {
      id: "opencode-native",
      adapter: "opencode",
      capabilityAgent: "opencode",
      model: "opencode-native",
      provider: { kind: "agent_native" },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
      readinessReasons: [notReadyOpencodeSmokeReason],
      enabled: true,
    },
    {
      id: "mimo-code-native",
      adapter: "mimo",
      capabilityAgent: "mimo",
      model: "mimo-native",
      provider: { kind: "agent_native" },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
      readinessReasons: [notReadyMimoSmokeReason],
      enabled: true,
    },
  ];
}
