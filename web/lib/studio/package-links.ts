export function withPackageInstall(
  path: string,
  installId: string | undefined,
  query: Record<string, string | string[] | undefined> = {},
): string {
  const params = new URLSearchParams();

  if (installId !== undefined) params.set("install", installId);
  for (const [key, value] of Object.entries(query)) {
    if (key !== "install" && typeof value === "string" && value)
      params.set(key, value);
  }

  return params.size ? `${path}?${params}` : path;
}

export function studioPackagePath(name: string, ...segments: string[]): string {
  return `/studio/packages/${[name, ...segments].map(encodeURIComponent).join("/")}`;
}
