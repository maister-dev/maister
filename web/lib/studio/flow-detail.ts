import "server-only";

import type { PackageInstallManifest } from "@/lib/packages/attach";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";

import { join, posix } from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { loadFlowManifest } from "@/lib/config";
import { compileManifest } from "@/lib/flows/graph/compile";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { readInstalledPackageFile } from "@/lib/flows/package-content";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "studio/flow-detail",
  level: process.env.LOG_LEVEL ?? "info",
});

type NodeDef = NonNullable<FlowYamlV1["nodes"]>[number];

// Everything the read-only flow detail needs, all rendered server-side. The
// absolute `installedPath` NEVER appears here — only the raw flow.yaml text, the
// compiled topology/layout, and the manifest node defs cross to the client. A
// compile/parse failure degrades to `compiled: null` + the raw yaml (never throws
// → the page renders the YAML fallback, never a 500). `flowYaml === null` means
// the flow id is unknown or its bundle is gone.
export type StudioFlowDetail = {
  flowId: string;
  flowPath: string | null;
  flowYaml: string | null;
  compiled: {
    topology: GraphTopology;
    layout: FlowLayout;
    nodes: NodeDef[];
  } | null;
};

export async function getStudioFlowDetail(
  installId: string,
  flowId: string,
): Promise<StudioFlowDetail | null> {
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installId));
  const install = rows[0];

  if (!install) return null;

  const manifest = install.manifest as PackageInstallManifest | undefined;
  const flow = manifest?.spec.flows.find((f) => f.id === flowId);

  if (!flow) return { flowId, flowPath: null, flowYaml: null, compiled: null };

  const installedPath = install.installedPath as string;
  const flowPath = posix.join(flow.path, "flow.yaml");

  // Raw flow.yaml for the fallback view — read through the confined reader off
  // the validated package-relative path (no user input reaches the fs sink).
  const yamlRead = await readInstalledPackageFile(
    { installedPath },
    join(flow.path, "flow.yaml"),
  );
  const flowYaml =
    yamlRead.state === "text" ? (yamlRead.content ?? null) : null;

  try {
    const parsed = await loadFlowManifest(
      join(installedPath, flow.path, "flow.yaml"),
    );

    return {
      flowId,
      flowPath,
      flowYaml,
      compiled: {
        topology: buildGraphTopology(compileManifest(parsed)),
        layout: presentationLayout(parsed),
        nodes: parsed.nodes ?? [],
      },
    };
  } catch {
    // A malformed/legacy/uncompilable manifest → yaml-only fallback, never throw.
    log.warn({ installId, flowId }, "studio flow detail compile degrade");

    return { flowId, flowPath, flowYaml, compiled: null };
  }
}
