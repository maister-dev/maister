export type PackageMemberCounts = {
  flows: number;
  skills: number;
  platformAgents: number;
  subagents: number;
  mcps: number;
  rules: number;
};

export type PackageInstallLike = {
  id: string;
  name: string;
  sourceUrl: string;
  versionLabel: string;
  trustStatus: string;
  counts: PackageMemberCounts;
};

export type AttachmentLike = {
  packageInstallId: string | null;
  projectId: string;
};

export type PackageVersion = {
  installId: string;
  versionLabel: string;
  trustStatus: string;
};

export type PackageGroup = {
  key: string;
  name: string;
  sourceUrl: string;
  isLocal: boolean;
  needsTrust: boolean;
  versions: PackageVersion[];
  counts: PackageMemberCounts;
  attachedProjectCount: number;
};

const isLocalSource = (url: string) =>
  url.startsWith("file:") || /(^|\/)local-/.test(url);

// Groups a flat install list (one row per installed package version) into one
// entry per `(sourceUrl, name)` package, newest version first. Pure — the
// loader supplies pre-computed member counts and project ids so this stays
// jsdom-free and trivially testable.
export function groupPackages(input: {
  installs: PackageInstallLike[];
  attachments: AttachmentLike[];
}): PackageGroup[] {
  const byKey = new Map<string, PackageInstallLike[]>();

  for (const install of input.installs) {
    const key = `${install.sourceUrl}::${install.name}`;
    const bucket = byKey.get(key) ?? [];

    bucket.push(install);
    byKey.set(key, bucket);
  }

  const projectsByInstall = new Map<string, Set<string>>();

  for (const attachment of input.attachments) {
    if (!attachment.packageInstallId) continue;
    const set = projectsByInstall.get(attachment.packageInstallId) ?? new Set();

    set.add(attachment.projectId);
    projectsByInstall.set(attachment.packageInstallId, set);
  }

  return [...byKey.entries()].map(([key, installs]) => {
    const versions = [...installs].sort((a, b) =>
      a.versionLabel < b.versionLabel ? 1 : -1,
    );
    const newest = versions[0];
    const attachedProjects = new Set<string>();

    for (const install of installs) {
      for (const projectId of projectsByInstall.get(install.id) ?? []) {
        attachedProjects.add(projectId);
      }
    }

    return {
      key,
      name: newest.name,
      sourceUrl: newest.sourceUrl,
      isLocal: isLocalSource(newest.sourceUrl),
      needsTrust: installs.some(
        (install) => install.trustStatus === "untrusted",
      ),
      versions: versions.map((version) => ({
        installId: version.id,
        versionLabel: version.versionLabel,
        trustStatus: version.trustStatus,
      })),
      counts: newest.counts,
      attachedProjectCount: attachedProjects.size,
    };
  });
}
