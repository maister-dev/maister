import type { ExecutorAgent } from "./types";

export type AdapterBinarySource = "path" | "override" | "test_override";

export type AdapterRuntime = {
  readonly id: ExecutorAgent;
  readonly defaultBinary: string;
  readonly defaultArgs: readonly string[];
  readonly binaryOverrideEnv: string;
  readonly readOnlyCapable: boolean;
  readonly readOnlySessionSmoke: "required" | "not_required";
  // ADR-129: cached live evidence that capability_guard enforcement is safe at the
  // ACP seam (requestPermission fires per write + carries a stable tool identity).
  // Required for every adapter; the launch evidence gate refuses a strict
  // tools/mcps enforcement launch until this dimension is cached ok.
  readonly capabilityEnforcementSmoke: "required" | "not_required";
  readonly modelChannel: "settings_local" | "set_session_model" | "advisory";
  readonly resumeStrategy:
    | "session_resume"
    | "load_session_pending_smoke"
    | "session_resume_pending_smoke";
};

export type AdapterClientCapabilities = {
  readonly fs: {
    readonly readTextFile: false;
    readonly writeTextFile: false;
  };
};

export type AdapterBinaryResolution = {
  readonly binary: string;
  readonly source: AdapterBinarySource;
  readonly overrideEnv?: string;
};

export type AdapterAgentCapabilities = {
  readonly sessionCapabilities?: {
    readonly resume?: unknown;
    readonly load?: unknown;
  };
};

export type AdapterResumeAction =
  | { readonly kind: "resume_session" }
  | { readonly kind: "unsupported"; readonly reason: string };

const ADAPTER_RUNTIMES = [
  {
    id: "claude",
    defaultBinary: "claude-agent-acp",
    defaultArgs: [],
    binaryOverrideEnv: "MAISTER_ADAPTER_BINARY_CLAUDE",
    readOnlyCapable: true,
    readOnlySessionSmoke: "not_required",
    capabilityEnforcementSmoke: "required",
    modelChannel: "settings_local",
    resumeStrategy: "session_resume",
  },
  {
    id: "codex",
    defaultBinary: "codex-acp",
    defaultArgs: [],
    binaryOverrideEnv: "MAISTER_ADAPTER_BINARY_CODEX",
    readOnlyCapable: true,
    readOnlySessionSmoke: "not_required",
    capabilityEnforcementSmoke: "required",
    modelChannel: "set_session_model",
    resumeStrategy: "session_resume",
  },
  {
    id: "gemini",
    defaultBinary: "gemini",
    defaultArgs: ["--acp"],
    binaryOverrideEnv: "MAISTER_ADAPTER_BINARY_GEMINI",
    readOnlyCapable: true,
    readOnlySessionSmoke: "required",
    capabilityEnforcementSmoke: "required",
    modelChannel: "advisory",
    resumeStrategy: "load_session_pending_smoke",
  },
  {
    id: "opencode",
    defaultBinary: "opencode",
    defaultArgs: ["acp"],
    binaryOverrideEnv: "MAISTER_ADAPTER_BINARY_OPENCODE",
    readOnlyCapable: true,
    readOnlySessionSmoke: "required",
    capabilityEnforcementSmoke: "required",
    modelChannel: "advisory",
    resumeStrategy: "session_resume_pending_smoke",
  },
  {
    id: "mimo",
    defaultBinary: "mimo",
    defaultArgs: ["acp"],
    binaryOverrideEnv: "MAISTER_ADAPTER_BINARY_MIMO",
    readOnlyCapable: true,
    readOnlySessionSmoke: "required",
    capabilityEnforcementSmoke: "required",
    modelChannel: "set_session_model",
    resumeStrategy: "session_resume_pending_smoke",
  },
] as const satisfies readonly AdapterRuntime[];

export function listAdapterRuntimes(): readonly AdapterRuntime[] {
  return ADAPTER_RUNTIMES;
}

export function getAdapterRuntime(adapter: ExecutorAgent): AdapterRuntime {
  const runtime = ADAPTER_RUNTIMES.find((item) => item.id === adapter);

  if (!runtime) {
    throw new Error(`unsupported adapter runtime: ${adapter}`);
  }

  return runtime;
}

export function resolveAdapterBinary(args: {
  readonly adapter: ExecutorAgent;
  readonly testOverride?: string;
  readonly env?: NodeJS.ProcessEnv;
}): AdapterBinaryResolution {
  if (args.testOverride) {
    return { binary: args.testOverride, source: "test_override" };
  }

  const runtime = getAdapterRuntime(args.adapter);
  const env = args.env ?? process.env;
  const override = env[runtime.binaryOverrideEnv];

  if (override) {
    return {
      binary: override,
      source: "override",
      overrideEnv: runtime.binaryOverrideEnv,
    };
  }

  return { binary: runtime.defaultBinary, source: "path" };
}

export function clientCapabilitiesForAdapter(
  adapter: ExecutorAgent,
): AdapterClientCapabilities {
  getAdapterRuntime(adapter);

  return {
    fs: {
      readTextFile: false,
      writeTextFile: false,
    },
  };
}

export function resolveResumeAction(
  adapter: ExecutorAgent,
  capabilities: AdapterAgentCapabilities,
): AdapterResumeAction {
  const runtime = getAdapterRuntime(adapter);

  if (runtime.resumeStrategy === "load_session_pending_smoke") {
    return {
      kind: "unsupported",
      reason:
        "Gemini loadSession is not enabled until checkpoint invariant smoke passes",
    };
  }

  if (capabilities.sessionCapabilities?.resume) {
    return { kind: "resume_session" };
  }

  return {
    kind: "unsupported",
    reason: `${adapter} ACP session/resume is not advertised by the adapter`,
  };
}
