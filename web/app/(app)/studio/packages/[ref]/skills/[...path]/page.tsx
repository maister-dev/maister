import type {
  PackageFileReadState,
  PackageFileViewLabels,
} from "@/components/flows/package-viewer";
import type { SkillBundleFile } from "@/components/studio/skill-bundle-view";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Link from "next/link";

import {
  CodeEditor,
  type CodeEditorKind,
} from "@/components/flows/code-editor";
import { SkillBundleView } from "@/components/studio/skill-bundle-view";
import { requireSession } from "@/lib/authz";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";
import {
  imageMimeForPath,
  listInstalledPackageFiles,
  readInstalledPackageFile,
  readInstalledPackageImage,
} from "@/lib/flows/package-content";
import { getStudioPackageInstalledPath } from "@/lib/studio/package-path";
import { resolveStudioPackageByRef } from "@/lib/studio/load";

type PageProps = {
  params: Promise<{ ref: string; path: string[] }>;
  searchParams: Promise<{ file?: string | string[] }>;
};

function firstParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value && value.length > 0 ? value : null;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { path } = await params;

  return { title: path.map(decodeURIComponent).join("/") };
}

function frontmatterStrings(
  fm: Record<string, unknown> | undefined,
): { name?: string; description?: string } | null {
  if (!fm) return null;

  const name = typeof fm.name === "string" ? fm.name : undefined;
  const description =
    typeof fm.description === "string" ? fm.description : undefined;

  return name || description ? { name, description } : null;
}

export default async function StudioSkillDetailPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { ref, path: rawPath } = await params;
  const { file: rawFile } = await searchParams;
  const decodedRef = decodeURIComponent(ref);
  const skillId = rawPath.map(decodeURIComponent).join("/");

  const user = await requireSession();
  const resolution = await resolveStudioPackageByRef(
    user.id,
    user.role,
    decodedRef,
  );

  if (resolution.status !== "ok") notFound();

  const installedPath = await getStudioPackageInstalledPath(
    resolution.installId,
  );

  if (!installedPath) notFound();

  const t = await getTranslations("studio");
  const tViewer = await getTranslations("studio.viewer");
  // Generic file-state strings are shared with the per-project viewer.
  const tFile = await getTranslations("packages.viewer");
  const packageHref = `/studio/packages/${encodeURIComponent(decodedRef)}`;
  const skillBase = `${packageHref}/skills/${skillId
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  const fileLabels: PackageFileViewLabels = {
    binary: tFile("fileBinary"),
    tooLarge: tFile("fileTooLarge"),
    notFound: tFile("fileNotFound"),
    bundleMissing: tViewer("skillBundleMissing"),
    emptyPrompt: tFile("fileEmptyPrompt"),
    imageAlt: tViewer("fileImageAlt"),
  };

  // All disk reads server-side, off the resolved installedPath (never the DTO).
  const listing = await listInstalledPackageFiles({ installedPath });
  const bundleMissing = listing.bundleMissing;

  const prefix = `skills/${skillId}/`;
  const files: SkillBundleFile[] = bundleMissing
    ? []
    : listing.files
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => ({ relPath: f.path.slice(prefix.length), kind: f.kind }));

  // SKILL.md frontmatter header (best-effort; absent/unreadable → no header).
  let frontmatter: { name?: string; description?: string } | null = null;

  if (!bundleMissing) {
    const skillMd = await readInstalledPackageFile(
      { installedPath },
      `${prefix}SKILL.md`,
    );

    if (skillMd.state === "text" && skillMd.content) {
      const split = splitFrontmatter(skillMd.content);

      if (split.ok) frontmatter = frontmatterStrings(split.frontmatter);
    }
  }

  // Selected file (deep-linkable `?file=`), confined under the skill subtree. The
  // bundle-relative value is prefixed with the package-relative skill path before
  // the confined read enforces traversal/symlink boundaries.
  const selectedRelPath = bundleMissing ? null : firstParam(rawFile);
  let selectedFile: PackageFileReadState | null = null;

  if (selectedRelPath) {
    const packageRel = `${prefix}${selectedRelPath}`;

    if (imageMimeForPath(selectedRelPath)) {
      const img = await readInstalledPackageImage(
        { installedPath },
        packageRel,
      );

      selectedFile =
        img.state === "image"
          ? { state: "image", dataUri: img.dataUri }
          : { state: img.state };
    } else {
      const read = await readInstalledPackageFile(
        { installedPath },
        packageRel,
      );

      selectedFile =
        read.state === "text"
          ? {
              state: "text",
              content: read.content ?? "",
              kind: read.kind ?? "asset",
            }
          : { state: read.state };
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1120px]">
      <Link
        className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
        href={packageHref}
      >
        {tViewer("backToPackage")}
      </Link>

      <header className="mb-6">
        <div className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {decodedRef} · {tViewer("skillDetailTitle")}
        </div>
        <h1 className="m-0 font-mono text-[24px] font-bold tracking-[-0.01em] text-ink">
          {skillId}
        </h1>
      </header>

      <SkillBundleView
        bundleMissing={bundleMissing}
        editor={
          selectedFile?.state === "text" ? (
            <CodeEditor
              readOnly
              ariaLabel={selectedRelPath ?? undefined}
              kind={selectedFile.kind as CodeEditorKind}
              value={selectedFile.content}
            />
          ) : undefined
        }
        files={files}
        frontmatter={frontmatter}
        hrefFor={(relPath) =>
          `${skillBase}?file=${encodeURIComponent(relPath)}`
        }
        labels={{
          filesTitle: tViewer("skillFilesTitle"),
          frontmatterTitle: tViewer("skillFrontmatterTitle"),
          noFrontmatter: tViewer("skillNoFrontmatter"),
          bundleMissing: tViewer("skillBundleMissing"),
          empty: tViewer("skillEmpty"),
          file: fileLabels,
        }}
        selectedFile={selectedFile}
        selectedRelPath={selectedRelPath}
        skillId={skillId}
      />

      <p className="sr-only">{t("viewer.readOnlyNotice")}</p>
    </div>
  );
}
