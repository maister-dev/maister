import "server-only";

import type {
  SupervisorMcpProbeRequest,
  SupervisorMcpProbeResult,
} from "@/lib/execution-host";
import type { BindingTargetKind } from "@/lib/mcp/binding-service";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { executionHosts } from "@/lib/execution-host";

// ADR-129 (W-F): resolve a probe target's NAMES-only config + enforce the D4
// web-side PLATFORM trust gate (an untrusted-source platform stdio probe is
// refused with a typed reason — NO override in v1), then proxy to the supervisor
// and cache the result. A project/package stdio probe has no platform
// trust_status axis — it is an explicit admin "test connection" spawn (the route
// is admin-gated). A secret VALUE never crosses: only env/header NAMES reach the
// supervisor, and only a status/reason is cached.

const log = pino({
  name: "mcp-probe",
  level: process.env.LOG_LEVEL ?? "info",
});

type ProbeDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

function db(injected?: ProbeDb): ProbeDb {
  return injected ?? (getDb() as unknown as ProbeDb);
}

function rowsOf<T>(result: { rows?: unknown[] }): T[] {
  return (result.rows ?? []) as T[];
}

function bare(k: string): string {
  return k.startsWith("env:") ? k.slice(4) : k;
}

export type ProbeTargetInput =
  | { refId: string }
  | { targetKind: BindingTargetKind; targetId: string };

type ProbeCacheTarget =
  | { kind: "platform"; id: string }
  | { kind: "capability"; id: string };

export type ResolvedProbeTarget = {
  request: SupervisorMcpProbeRequest;
  cache: ProbeCacheTarget;
};

async function resolveTargetRef(
  database: ProbeDb,
  projectId: string,
  input: ProbeTargetInput,
): Promise<{ targetKind: BindingTargetKind; targetId: string }> {
  if ("targetKind" in input) {
    return { targetKind: input.targetKind, targetId: input.targetId };
  }

  const binding = rowsOf<{ target_kind: BindingTargetKind; target_id: string }>(
    await database.execute(sql`
      SELECT target_kind, target_id FROM project_mcp_bindings
      WHERE project_id = ${projectId} AND ref_id = ${input.refId} AND enabled = true
      LIMIT 1
    `),
  )[0];

  if (!binding) {
    throw new MaisterError(
      "PRECONDITION",
      `no enabled binding to probe for ref "${input.refId}"`,
    );
  }

  return { targetKind: binding.target_kind, targetId: binding.target_id };
}

export async function resolveProbeTarget(
  projectId: string,
  input: ProbeTargetInput,
  injected?: ProbeDb,
): Promise<ResolvedProbeTarget> {
  const database = db(injected);
  const { targetKind, targetId } = await resolveTargetRef(
    database,
    projectId,
    input,
  );

  if (targetKind === "platform") {
    const row = rowsOf<{
      transport: "stdio" | "sse" | "http";
      command: string | null;
      args: string[] | null;
      env_keys: string[] | null;
      url: string | null;
      header_keys: string[] | null;
      trust_status: string;
    }>(
      await database.execute(sql`
        SELECT transport, command, args, env_keys, url, header_keys, trust_status
        FROM platform_mcp_servers WHERE id = ${targetId} LIMIT 1
      `),
    )[0];

    if (!row) {
      throw new MaisterError(
        "PRECONDITION",
        `platform MCP server not found: ${targetId}`,
      );
    }

    const trusted =
      row.trust_status === "trusted" ||
      row.trust_status === "trusted_by_policy";

    // D4 (owner lock): trust → execute, never execute-then-trust.
    if (row.transport === "stdio" && !trusted) {
      throw new MaisterError(
        "CONFIG",
        `probing an untrusted-source stdio MCP is refused (trust the server first — no override in v1)`,
      );
    }

    return {
      request: {
        transport: row.transport,
        command: row.command ?? undefined,
        args: row.args ?? [],
        envKeys: (row.env_keys ?? []).map(bare),
        url: row.url ?? undefined,
        headerKeys: (row.header_keys ?? []).map(bare),
      },
      cache: { kind: "platform", id: targetId },
    };
  }

  const source = targetKind === "project" ? "project" : "flow-package";
  const row = rowsOf<{
    material: {
      transport?: "stdio" | "sse" | "http";
      command?: string | null;
      args?: string[];
      envKeys?: string[];
      env?: Record<string, string>;
      url?: string | null;
      headerKeys?: string[];
      requirement?: boolean;
    } | null;
  }>(
    await database.execute(sql`
      SELECT material FROM capability_records
      WHERE id = ${targetId} AND project_id = ${projectId}
        AND kind = 'mcp' AND source = ${source}
      LIMIT 1
    `),
  )[0];

  if (!row?.material) {
    throw new MaisterError(
      "PRECONDITION",
      `${targetKind} MCP not found: ${targetId}`,
    );
  }

  const m = row.material;

  if (m.requirement || !m.transport) {
    throw new MaisterError(
      "PRECONDITION",
      `ref "${targetId}" is a requirement, not a probable MCP implementation`,
    );
  }

  const envKeys = (m.envKeys ?? Object.keys(m.env ?? {})).map(bare);

  return {
    request: {
      transport: m.transport,
      command: m.command ?? undefined,
      args: m.args ?? [],
      envKeys,
      url: m.url ?? undefined,
      headerKeys: (m.headerKeys ?? []).map(bare),
    },
    cache: { kind: "capability", id: targetId },
  };
}

async function writeProbeCache(
  database: ProbeDb,
  cache: ProbeCacheTarget,
  result: SupervisorMcpProbeResult,
): Promise<void> {
  const status = result.ok ? "Ok" : "Failed";
  const reason = result.reason ?? null;

  if (cache.kind === "platform") {
    await database.execute(sql`
      UPDATE platform_mcp_servers
      SET last_probe_status = ${status}, last_probe_at = now(),
          last_probe_reason = ${reason}
      WHERE id = ${cache.id}
    `);

    return;
  }

  // project/package: cache under material.lastProbe (never a secret value).
  const cached = JSON.stringify({
    status,
    at: new Date().toISOString(),
    reason,
  });

  await database.execute(sql`
    UPDATE capability_records
    SET material = jsonb_set(coalesce(material, '{}'::jsonb), '{lastProbe}', ${cached}::jsonb),
        updated_at = now()
    WHERE id = ${cache.id}
  `);
}

export async function probeAndCache(
  projectId: string,
  input: ProbeTargetInput,
  injected?: ProbeDb,
  supervisorProbe: (
    req: SupervisorMcpProbeRequest,
  ) => Promise<SupervisorMcpProbeResult> = (req) =>
    executionHosts.local().probeMcp(req),
): Promise<SupervisorMcpProbeResult> {
  const database = db(injected);
  const { request, cache } = await resolveProbeTarget(
    projectId,
    input,
    database,
  );

  log.info(
    { projectId, transport: request.transport, cacheKind: cache.kind },
    "[mcp.probe] proxying to supervisor",
  );
  const result = await supervisorProbe(request);

  await writeProbeCache(database, cache, result);
  log.info(
    { projectId, ok: result.ok, latencyMs: result.latencyMs },
    "[mcp.probe] result cached (no secret value)",
  );

  return result;
}
