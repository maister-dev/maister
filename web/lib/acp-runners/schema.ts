import "server-only";

import { z } from "zod";

type AdapterId = "claude" | "codex";

export type AdapterSupport = {
  readonly id: AdapterId;
  readonly capabilityAgent: AdapterId;
  readonly providerKinds: readonly ProviderKind[];
  readonly permissionPolicies: readonly PermissionPolicy[];
};

export type ProviderKind =
  | "anthropic"
  | "anthropic_compatible"
  | "openai"
  | "openai_compatible";

export type PermissionPolicy = "default" | "dangerously_skip_permissions";

export type RouterSidecarConfig = {
  readonly id: string;
  readonly kind: "ccr";
  readonly lifecycle: "managed" | "external";
  readonly commandPreset?: "ccr_start";
  readonly configPath?: string;
  readonly baseUrl?: string;
  readonly healthcheckUrl?: string;
  readonly authToken?: string;
};

export type PlatformAcpRunnerConfig = {
  readonly id: string;
  readonly adapter: AdapterId;
  readonly capabilityAgent: AdapterId;
  readonly model: string;
  readonly provider: ProviderConfig;
  readonly permissionPolicy: PermissionPolicy;
  readonly sidecarId?: string;
  readonly enabled: boolean;
};

export type ProviderConfig =
  | { readonly kind: "anthropic" }
  | {
      readonly kind: "anthropic_compatible";
      readonly baseUrl?: string;
      readonly authToken?: string;
    }
  | { readonly kind: "openai" }
  | {
      readonly kind: "openai_compatible";
      readonly baseUrl?: string;
      readonly apiKey?: string;
      readonly wireApi?: "responses";
    };

export type PlatformRuntimeConfig = {
  readonly platform: { readonly defaultRunnerId: string };
  readonly routerInstances: readonly RouterSidecarConfig[];
  readonly acpRunners: readonly PlatformAcpRunnerConfig[];
};

const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const ENV_REF_PATTERN = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

const ADAPTERS: readonly AdapterSupport[] = [
  {
    id: "claude",
    capabilityAgent: "claude",
    providerKinds: ["anthropic", "anthropic_compatible"],
    permissionPolicies: ["default", "dangerously_skip_permissions"],
  },
  {
    id: "codex",
    capabilityAgent: "codex",
    providerKinds: ["openai", "openai_compatible"],
    permissionPolicies: ["default"],
  },
];

const safeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SAFE_ID_PATTERN, "must be a safe id");

const secretRefSchema = z
  .string()
  .regex(ENV_REF_PATTERN, "must be an env:NAME secret reference");

const platformBlockSchema = z
  .object({
    default_runner: safeIdSchema,
  })
  .strict();

const routerSidecarInputSchema = z
  .object({
    id: safeIdSchema,
    kind: z.literal("ccr"),
    lifecycle: z.enum(["managed", "external"]),
    command_preset: z.literal("ccr_start").optional(),
    config_path: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    healthcheck_url: z.string().url().optional(),
    auth_token: secretRefSchema.optional(),
  })
  .strict();

const providerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anthropic") }).strict(),
  z
    .object({
      kind: z.literal("anthropic_compatible"),
      base_url: z.string().url().optional(),
      auth_token: secretRefSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("openai") }).strict(),
  z
    .object({
      kind: z.literal("openai_compatible"),
      base_url: z.string().url().optional(),
      api_key: secretRefSchema.optional(),
      wire_api: z.literal("responses").optional(),
    })
    .strict(),
]);

const runnerInputSchema = z
  .object({
    id: safeIdSchema,
    adapter: safeIdSchema,
    model: z.string().min(1),
    provider: providerSchema,
    permission_policy: z
      .enum(["default", "dangerously_skip_permissions"])
      .default("default"),
    router_instance: safeIdSchema.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

const platformRuntimeInputSchema = z
  .object({
    platform: platformBlockSchema,
    router_instances: z.array(routerSidecarInputSchema).default([]),
    acp_runners: z.array(runnerInputSchema).min(1),
  })
  .strict();

type RunnerInput = z.infer<typeof runnerInputSchema>;
type RouterInput = z.infer<typeof routerSidecarInputSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

function getAdapterById(adapterId: string): AdapterSupport | undefined {
  return ADAPTERS.find((adapter) => adapter.id === adapterId);
}

function mapProvider(provider: z.infer<typeof providerSchema>): ProviderConfig {
  if (provider.kind === "anthropic_compatible") {
    return {
      kind: provider.kind,
      authToken: provider.auth_token,
      baseUrl: provider.base_url,
    };
  }

  if (provider.kind === "openai_compatible") {
    return {
      kind: provider.kind,
      apiKey: provider.api_key,
      baseUrl: provider.base_url,
      wireApi: provider.wire_api,
    };
  }

  return { kind: provider.kind };
}

function mapSidecar(input: RouterInput): RouterSidecarConfig {
  return {
    id: input.id,
    kind: input.kind,
    lifecycle: input.lifecycle,
    commandPreset: input.command_preset,
    configPath: input.config_path,
    baseUrl: input.base_url,
    healthcheckUrl: input.healthcheck_url,
    authToken: input.auth_token,
  };
}

function mapRunner(
  input: RunnerInput,
  adapter: AdapterSupport,
): PlatformAcpRunnerConfig {
  return {
    id: input.id,
    adapter: adapter.id,
    capabilityAgent: adapter.capabilityAgent,
    model: input.model,
    provider: mapProvider(input.provider),
    permissionPolicy: input.permission_policy,
    sidecarId: input.router_instance,
    enabled: input.enabled,
  };
}

export function getAdapterSupport(): readonly AdapterSupport[] {
  return ADAPTERS;
}

export function parsePlatformRuntimeConfig(
  input: unknown,
): PlatformRuntimeConfig {
  const parsed = platformRuntimeInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new Error(
      `platform runtime config invalid: ${formatIssues(parsed.error)}`,
    );
  }

  const sidecarIds = new Set(
    parsed.data.router_instances.map((sidecar) => sidecar.id),
  );
  const runners = parsed.data.acp_runners.map((runner) => {
    const adapter = getAdapterById(runner.adapter);

    if (!adapter) {
      throw new Error(
        `platform runtime config invalid: adapter ${runner.adapter} is not supported`,
      );
    }

    if (!adapter.providerKinds.includes(runner.provider.kind)) {
      throw new Error(
        `platform runtime config invalid: adapter ${runner.adapter} does not support provider ${runner.provider.kind}`,
      );
    }

    if (!adapter.permissionPolicies.includes(runner.permission_policy)) {
      throw new Error(
        `platform runtime config invalid: adapter ${runner.adapter} does not support permission_policy ${runner.permission_policy}`,
      );
    }

    if (runner.router_instance && !sidecarIds.has(runner.router_instance)) {
      throw new Error(
        `platform runtime config invalid: router_instance ${runner.router_instance} for runner ${runner.id} is missing`,
      );
    }

    return mapRunner(runner, adapter);
  });
  const defaultRunner = runners.find(
    (runner) => runner.id === parsed.data.platform.default_runner,
  );

  if (!defaultRunner) {
    throw new Error(
      `platform runtime config invalid: default_runner ${parsed.data.platform.default_runner} is missing`,
    );
  }

  if (!defaultRunner.enabled) {
    throw new Error(
      `platform runtime config invalid: default_runner ${defaultRunner.id} is disabled`,
    );
  }

  return {
    platform: { defaultRunnerId: parsed.data.platform.default_runner },
    routerInstances: parsed.data.router_instances.map(mapSidecar),
    acpRunners: runners,
  };
}
