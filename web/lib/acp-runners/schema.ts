import "server-only";

import { z } from "zod";

import {
  getAdapterSupportById,
  PERMISSION_POLICIES,
  type AdapterId,
  type AdapterSupport,
  type PermissionPolicy,
} from "@/lib/acp-runners/adapter-support";

export {
  getAdapterSupport,
  type AdapterId,
  type AdapterSupport,
  type PermissionPolicy,
  type ProviderKind,
} from "@/lib/acp-runners/adapter-support";

export type PlatformAcpRunnerConfig = {
  readonly id: string;
  readonly adapter: AdapterId;
  readonly capabilityAgent: AdapterId;
  readonly model: string;
  readonly env?: Record<string, string>;
  readonly provider: ProviderConfig;
  readonly permissionPolicy: PermissionPolicy;
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
    }
  | {
      readonly kind: "google_gemini";
      readonly apiKey?: string;
    }
  | {
      readonly kind: "google_vertex";
      readonly projectId?: string;
      readonly location?: string;
      readonly apiKey?: string;
    }
  | {
      readonly kind: "google_gateway";
      readonly baseUrl?: string;
      readonly apiKey?: string;
    }
  | { readonly kind: "agent_native" };

export type PlatformRuntimeConfig = {
  readonly platform: { readonly defaultRunnerId: string };
  readonly acpRunners: readonly PlatformAcpRunnerConfig[];
};

const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const ENV_REF_PATTERN = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

const safeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SAFE_ID_PATTERN, "must be a safe id");

const secretRefSchema = z
  .string()
  .regex(ENV_REF_PATTERN, "must be an env:NAME secret reference");

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

const runnerEnvValueSchema = z
  .string()
  .refine((value) => !value.includes("\0"), "must not contain a null byte")
  .refine(
    (value) => !value.startsWith("env:") || ENV_REF_PATTERN.test(value),
    "env references must use env:NAME",
  );

const platformBlockSchema = z
  .object({
    default_runner: safeIdSchema,
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
  z
    .object({
      kind: z.literal("google_gemini"),
      api_key: secretRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("google_vertex"),
      project_id: z.string().min(1).optional(),
      location: z.string().min(1).optional(),
      api_key: secretRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("google_gateway"),
      base_url: z.string().url().optional(),
      api_key: secretRefSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("agent_native") }).strict(),
]);

const runnerInputSchema = z
  .object({
    id: safeIdSchema,
    adapter: safeIdSchema,
    model: z.string().min(1),
    env: z.record(envNameSchema, runnerEnvValueSchema).default({}),
    provider: providerSchema,
    permission_policy: z.enum(PERMISSION_POLICIES).default("default"),
    enabled: z.boolean().default(true),
  })
  .strict();

const platformRuntimeInputSchema = z
  .object({
    platform: platformBlockSchema,
    acp_runners: z.array(runnerInputSchema).min(1),
  })
  .strict();

type RunnerInput = z.infer<typeof runnerInputSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
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

  if (provider.kind === "google_gemini") {
    return {
      kind: provider.kind,
      apiKey: provider.api_key,
    };
  }

  if (provider.kind === "google_vertex") {
    return {
      kind: provider.kind,
      projectId: provider.project_id,
      location: provider.location,
      apiKey: provider.api_key,
    };
  }

  if (provider.kind === "google_gateway") {
    return {
      kind: provider.kind,
      apiKey: provider.api_key,
      baseUrl: provider.base_url,
    };
  }

  return { kind: provider.kind };
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
    env: input.env,
    provider: mapProvider(input.provider),
    permissionPolicy: input.permission_policy,
    enabled: input.enabled,
  };
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

  const runners = parsed.data.acp_runners.map((runner) => {
    const adapter = getAdapterSupportById(runner.adapter);

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
    acpRunners: runners,
  };
}
