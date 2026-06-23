import type { LocalPackageEditorLabels } from "@/components/studio/local-package-editor";
import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { parse as parseYaml } from "yaml";

import { buildChangeReviewLabels } from "@/components/studio/change-review-dialog";
import { LocalPackageEditor } from "@/components/studio/local-package-editor";
import { requireSession } from "@/lib/authz";
import { flowYamlV1Schema } from "@/lib/config.schema";
import {
  buildFlowEditorTabsLabels,
  diffViewLabels,
  localPackageDiffLabels,
  packageFileKindLabels,
  packageFilesEditorLabels,
} from "@/lib/flows/editor/editor-labels";
import { readLockState } from "@/lib/local-packages/lock";
import {
  getLocalPackage,
  listFiles,
  readFileContent,
} from "@/lib/local-packages/service";
import { buildAuthoredFlowGraph } from "@/lib/queries/authored-flow-graph";
import { listPlatformMcpCatalog } from "@/lib/queries/platform-mcp-catalog";

type PageProps = {
  params: Promise<{ id: string; path?: string[] }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const pkg = await getLocalPackage(id);

  return { title: pkg?.name ?? id };
}

// A working-dir path the canvas can compile (a flow manifest). Root `flow.yaml`
// or a flow manifest under `flows/`.
function isFlowPath(path: string): boolean {
  return (
    path === "flow.yaml" ||
    (path.startsWith("flows/") && /\.ya?ml$/i.test(path))
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function declaredFlowPaths(files: AuthoredFlowPackageFile[]): string[] {
  const manifest = files.find((file) => file.path === "maister-package.yaml");

  if (!manifest) return [];

  const parsed = asRecord(parseYaml(manifest.content));
  const flows = Array.isArray(parsed.flows) ? parsed.flows : [];

  return flows
    .map((flow) => {
      const flowPath = asRecord(flow).path;

      if (typeof flowPath !== "string" || flowPath.length === 0) return null;

      return /\.ya?ml$/i.test(flowPath)
        ? flowPath
        : `${flowPath.replace(/\/+$/, "")}/flow.yaml`;
    })
    .filter((path): path is string =>
      Boolean(path && files.some((file) => file.path === path)),
    );
}

function defaultFlowPath(files: AuthoredFlowPackageFile[]): string | null {
  if (files.some((file) => file.path === "flow.yaml")) return "flow.yaml";

  return (
    declaredFlowPaths(files)[0] ??
    files.find((file) => isFlowPath(file.path))?.path ??
    null
  );
}

export default async function StudioEditPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { id, path: segments } = await params;

  await requireSession();
  const pkg = await getLocalPackage(id);

  if (!pkg || pkg.status !== "active") notFound();

  const t = await getTranslations("flows");
  const te = await getTranslations("flowEditor");
  const ts = await getTranslations("studio");
  const td = await getTranslations("workbench.diff");
  const tld = await getTranslations("studio.local.diff");

  const fileMetas = await listFiles(pkg);
  const files: AuthoredFlowPackageFile[] = await Promise.all(
    fileMetas.map(async (meta) => {
      const file = await readFileContent(pkg, meta.path);

      // `kind` here is presentational only; the editor re-derives it via
      // classifyPackageFilePath. Keep a safe default.
      return { kind: "asset" as const, path: file.path, content: file.content };
    }),
  );

  // The selected artifact path (optional `[[...path]]`). Decoded segment-wise.
  // A fork lands on `/studio/edit/:id`; pick the first declared flow manifest
  // instead of opening an empty YAML buffer.
  const selectedPath =
    segments && segments.length > 0
      ? segments.map(decodeURIComponent).join("/")
      : defaultFlowPath(files);
  const flowPath =
    selectedPath && isFlowPath(selectedPath) ? selectedPath : null;

  // Server-compile the selected flow file for the canvas (compile is
  // server-only). A file that does not parse/compile falls back to YAML-only.
  let canvasAvailable = false;
  let initialManifest: FlowYamlV1 | null = null;
  let topology: GraphTopology | null = null;
  let layout: FlowLayout | null = null;
  let initialYaml = "";

  if (flowPath) {
    const selected = files.find((f) => f.path === flowPath);

    initialYaml = selected?.content ?? "";
    try {
      const parsed = flowYamlV1Schema.safeParse(parseYaml(initialYaml));

      if (parsed.success) {
        const graph = buildAuthoredFlowGraph(parsed.data, 0);

        initialManifest = parsed.data;
        topology = graph.topology;
        layout = graph.layout;
        canvasAvailable = true;
      }
    } catch {
      canvasAvailable = false;
    }
  }

  const [mcpCatalog, lock] = await Promise.all([
    listPlatformMcpCatalog(),
    readLockState(id, ""),
  ]);

  const labels: LocalPackageEditorLabels = {
    editor: buildFlowEditorTabsLabels(te),
    readOnlyHeld: ts("local.readOnlyHeld"),
    readOnlyUnknownHolder: ts("local.readOnlyUnknownHolder"),
    lockLost: ts("local.lockLost"),
    reload: ts("local.reload"),
    saving: ts("local.saving"),
    saved: ts("local.saved"),
    saveFailed: ts("local.saveFailed"),
    tabProperties: ts("local.tabProperties"),
    tabAi: ts("local.tabAi"),
    aiWorking: ts("local.aiWorking"),
    ai: {
      intro: ts("local.ai.intro"),
      promptPlaceholder: ts("local.ai.promptPlaceholder"),
      launch: ts("local.ai.launch"),
      launching: ts("local.ai.launching"),
      lockRequired: ts("local.ai.lockRequired"),
    },
    diff: localPackageDiffLabels(tld),
    diffView: diffViewLabels(td),
    home: {
      orientation: ts("local.home.orientation"),
      flowsHeading: ts("local.home.flowsHeading"),
      noFlows: ts("local.home.noFlows"),
      save: ts("local.home.save"),
    },
    crumbStudio: ts("local.crumbStudio"),
    crumbLocal: ts("local.crumbLocal"),
    endEdit: ts("local.endEdit"),
    commitState: ts("local.commitState"),
    changeReview: buildChangeReviewLabels(ts),
  };

  return (
    <div className="flex h-[calc(100vh-160px)] min-h-[560px] w-full flex-col">
      <LocalPackageEditor
        canManage
        canvasAvailable={canvasAvailable}
        diff=""
        fileKindLabels={packageFileKindLabels(t)}
        files={files}
        filesLabels={packageFilesEditorLabels(t, te, true)}
        flowPath={flowPath}
        identity={{ project: pkg.name, slug: pkg.slug, kind: "package" }}
        initialLock={{
          held: lock.held,
          // Optimistic: a free lock means the opener (canManage) will acquire it
          // on mount — render editable to avoid a read-only flash. A lock held by
          // someone else stays read-only until the client acquire round-trips
          // (which takes over for the same user). ADR-105.
          heldByMe: !lock.held,
          holderLabel: lock.holderLabel,
        }}
        initialManifest={initialManifest}
        initialTitle={pkg.name}
        initialYaml={initialYaml}
        labels={labels}
        layout={layout}
        mcpCatalog={mcpCatalog}
        packageId={id}
        topology={topology}
      />
    </div>
  );
}
