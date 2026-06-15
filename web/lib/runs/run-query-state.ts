export const RUN_WORKBENCH_TABS = [
  "files",
  "diff",
  "evidence",
  "timeline",
] as const;

export const RUN_FILE_VIEWS = ["preview", "source"] as const;
export const RUN_DIFF_VIEWS = ["split", "unified"] as const;
export const RUN_DIFF_SCOPES = [
  "run",
  "since-last-review",
  "last-node",
  "uncommitted",
] as const;
export const RUN_INSPECTOR_STATES = ["open", "closed"] as const;
export const RUN_FLOW_STATES = ["fullscreen"] as const;

export type RunWorkbenchTab = (typeof RUN_WORKBENCH_TABS)[number];
export type RunFileView = (typeof RUN_FILE_VIEWS)[number];
export type RunDiffView = (typeof RUN_DIFF_VIEWS)[number];
export type RunDiffScope = (typeof RUN_DIFF_SCOPES)[number];
export type RunInspectorState = (typeof RUN_INSPECTOR_STATES)[number];
export type RunFlowState = (typeof RUN_FLOW_STATES)[number];

export interface RunQueryState {
  workbench: RunWorkbenchTab;
  file: string | null;
  fileView: RunFileView;
  diffFile: string | null;
  diffView: RunDiffView;
  scope: RunDiffScope;
  node: string | null;
  inspector: RunInspectorState | null;
  flow: RunFlowState | null;
}

export type RunSearchParamsInput =
  | string
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null; toString(): string }
  | null
  | undefined;

export interface RunQueryPatch {
  wb?: RunWorkbenchTab | null;
  file?: string | null;
  fileView?: RunFileView | null;
  diffFile?: string | null;
  diffview?: RunDiffView | null;
  scope?: RunDiffScope | null;
  node?: string | null;
  inspector?: RunInspectorState | null;
  flow?: RunFlowState | null;
}

function enumOrDefault<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

function enumOrNull<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | null {
  return allowed.includes(raw as T) ? (raw as T) : null;
}

export function toRunSearchParams(
  input: RunSearchParamsInput,
): URLSearchParams {
  if (!input) return new URLSearchParams();

  if (typeof input === "string") {
    return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  }

  if (input instanceof URLSearchParams) {
    return new URLSearchParams(input);
  }

  if ("get" in input && "toString" in input) {
    return new URLSearchParams(input.toString());
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }

  return params;
}

export function parseRunQueryState(input: RunSearchParamsInput): RunQueryState {
  const params = toRunSearchParams(input);

  return {
    workbench: enumOrDefault(params.get("wb"), RUN_WORKBENCH_TABS, "timeline"),
    file: params.get("file"),
    fileView: enumOrDefault(params.get("fileView"), RUN_FILE_VIEWS, "preview"),
    diffFile: params.get("diffFile"),
    diffView: enumOrDefault(params.get("diffview"), RUN_DIFF_VIEWS, "split"),
    scope: enumOrDefault(params.get("scope"), RUN_DIFF_SCOPES, "run"),
    node: params.get("node"),
    inspector: enumOrNull(params.get("inspector"), RUN_INSPECTOR_STATES),
    flow: enumOrNull(params.get("flow"), RUN_FLOW_STATES),
  };
}

function setOptionalParam(
  params: URLSearchParams,
  key: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null || value === "") {
    params.delete(key);

    return;
  }
  params.set(key, value);
}

export function buildRunSearchParams(
  input: RunSearchParamsInput,
  patch: RunQueryPatch,
): URLSearchParams {
  const params = toRunSearchParams(input);

  setOptionalParam(params, "wb", patch.wb);
  setOptionalParam(params, "file", patch.file);
  setOptionalParam(params, "fileView", patch.fileView);
  setOptionalParam(params, "diffFile", patch.diffFile);
  setOptionalParam(params, "diffview", patch.diffview);
  setOptionalParam(params, "scope", patch.scope);
  setOptionalParam(params, "node", patch.node);
  setOptionalParam(params, "inspector", patch.inspector);
  setOptionalParam(params, "flow", patch.flow);

  return params;
}

export function buildRunHref(
  pathname: string,
  input: RunSearchParamsInput,
  patch: RunQueryPatch,
): string {
  const params = buildRunSearchParams(input, patch);
  const query = params.toString();

  return query ? `${pathname}?${query}` : pathname;
}

export function buildRunFileHref(
  pathname: string,
  input: RunSearchParamsInput,
  file: string,
  fileView: RunFileView = "source",
): string {
  return buildRunHref(pathname, input, {
    wb: "files",
    file,
    fileView,
  });
}

export function buildRunDiffFileHref(
  pathname: string,
  input: RunSearchParamsInput,
  diffFile: string,
): string {
  return buildRunHref(pathname, input, {
    wb: "diff",
    diffFile,
  });
}
