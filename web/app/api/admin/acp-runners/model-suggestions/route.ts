import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  resolveModelSuggestions,
  type SupervisorModelCatalog,
  type SupervisorModelCatalogDraft,
} from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { platformRouterSidecars } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-admin-acp-runner-model-suggestions",
  level: process.env.LOG_LEVEL ?? "info",
});

const ENV_REF_PATTERN = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

const providerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anthropic") }).strict(),
  z
    .object({
      kind: z.literal("anthropic_compatible"),
      baseUrl: z.string().url().optional(),
      authToken: z.string().regex(ENV_REF_PATTERN).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("openai") }).strict(),
  z
    .object({
      kind: z.literal("openai_compatible"),
      baseUrl: z.string().url().optional(),
      apiKey: z.string().regex(ENV_REF_PATTERN).optional(),
      wireApi: z.literal("responses").optional(),
    })
    .strict(),
]);

const requestSchema = z
  .object({
    adapter: z.enum(["claude", "codex"]),
    provider: providerSchema,
    router: z.literal("ccr").optional(),
    sidecarId: z.string().min(1).nullable().optional(),
    force: z.boolean().optional(),
  })
  .strict();

type DraftProvider = z.infer<typeof providerSchema>;

const GROUP_LABELS: Record<string, string> = {
  acp_probe: "Agent",
  provider_api: "Provider",
  curated: "Curated",
  ccr: "CCR",
  agent_observed: "Observed",
};

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "CONFLICT":
      return 409;
    // A stray supervisor PRECONDITION (malformed draft we already validate
    // for) is an upstream config fault, not a client 4xx here — surface it
    // as EXECUTOR_UNAVAILABLE.
    case "PRECONDITION":
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "model-suggestions API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function parseJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function envRefName(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  if (!ref.startsWith("env:")) return undefined;

  return ref.slice("env:".length);
}

function toSupervisorProvider(
  provider: DraftProvider,
): SupervisorModelCatalogDraft["provider"] {
  if (provider.kind === "anthropic_compatible") {
    return {
      kind: provider.kind,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.authToken
        ? { authTokenEnv: envRefName(provider.authToken) }
        : {}),
    };
  }
  if (provider.kind === "openai_compatible") {
    return {
      kind: provider.kind,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.apiKey ? { apiKeyEnv: envRefName(provider.apiKey) } : {}),
      ...(provider.wireApi ? { wireApi: provider.wireApi } : {}),
    };
  }

  return { kind: provider.kind };
}

async function assertSidecarExists(sidecarId: string): Promise<void> {
  // FIXME(any): dual drizzle-orm peer-dep variants.
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(platformRouterSidecars)
    .where(eq(platformRouterSidecars.id, sidecarId));

  if (rows.length === 0) {
    throw new MaisterError("CONFIG", `unknown sidecarId: ${sidecarId}`);
  }
}

function toGroupedResponse(catalog: SupervisorModelCatalog): {
  groups: Array<{
    source: string;
    label: string;
    status: string;
    reason?: string;
    models: Array<{ id: string; displayName?: string }>;
  }>;
  resolvedAt: string;
  ttlSeconds: number;
} {
  const groups = catalog.sources.map((source) => ({
    source: source.kind,
    label: GROUP_LABELS[source.kind] ?? source.kind,
    status: source.status,
    ...(source.reason !== undefined ? { reason: source.reason } : {}),
    models: catalog.models
      .filter((model) => model.origins[0] === source.kind)
      .map((model) => ({
        id: model.id,
        ...(model.displayName !== undefined
          ? { displayName: model.displayName }
          : {}),
      })),
  }));

  return {
    groups,
    resolvedAt: catalog.resolvedAt,
    ttlSeconds: catalog.ttlSeconds,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const parsed = requestSchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    if (parsed.data.router === "ccr") {
      if (!parsed.data.sidecarId) {
        throw new MaisterError("CONFIG", "router 'ccr' requires a sidecarId");
      }
      await assertSidecarExists(parsed.data.sidecarId);
    }

    const draft: SupervisorModelCatalogDraft = {
      adapter: parsed.data.adapter,
      provider: toSupervisorProvider(parsed.data.provider),
      ...(parsed.data.router ? { router: parsed.data.router } : {}),
      ...(parsed.data.router === "ccr" && parsed.data.sidecarId
        ? { sidecarId: parsed.data.sidecarId }
        : {}),
    };

    const computed = await resolveModelSuggestions(draft, {
      force: parsed.data.force ?? false,
    });

    return NextResponse.json(toGroupedResponse(computed));
  } catch (err) {
    return errorResponse(err);
  }
}
