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
// or any `flows/*.y(a)ml`.
function isFlowPath(path: string): boolean {
  return (
    path === "flow.yaml" ||
    (path.startsWith("flows/") && /\.ya?ml$/i.test(path))
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
  const selectedPath =
    segments && segments.length > 0
      ? segments.map(decodeURIComponent).join("/")
      : null;
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
    diff: localPackageDiffLabels(tld),
    diffView: diffViewLabels(td),
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
          heldByMe: false,
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
