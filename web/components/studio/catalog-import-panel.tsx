"use client";

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type {
  CatalogFailureDetails,
  CatalogKind,
  CatalogPreview,
  CatalogReceipt,
  ReviewFile,
  SearchResponse,
  SearchResult,
} from "@/lib/local-packages/catalog-contract";
import type { ReactElement } from "react";

import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { Button, Input, ListBox, SearchField, Select } from "@heroui/react";
import { createTwoFilesPatch } from "diff";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import {
  parsePackageManifest,
  PACKAGE_MANIFEST_FILENAME,
} from "@/lib/local-packages/manifest";
import {
  inlineSelectHref,
  skillScreenHref,
} from "@/lib/local-packages/composition";
import { readApiErrorBody } from "@/lib/api-error";
import { catalogFailureDetails } from "@/lib/local-packages/catalog-contract";
import { useOptionalFeedback } from "@/components/feedback/feedback-provider";
import { useTheme } from "@/lib/theme";

import "@git-diff-view/react/styles/diff-view.css";

type Origin = {
  sourceId: string;
  selector: string;
  destination: string;
  importId: string;
  kind: CatalogKind;
  pin: string;
};
function readOrigins(
  files: AuthoredFlowPackageFile[],
  kind: CatalogKind,
): Origin[] {
  return files.flatMap((file) => {
    if (!/^catalog-origins\/[a-f0-9]{64}\.json$/.test(file.path)) return [];
    try {
      const record = JSON.parse(file.content) as Partial<Origin>;

      return record.kind === kind &&
        ["sourceId", "selector", "destination", "importId", "pin"].every(
          (key) => typeof record[key as keyof Origin] === "string",
        )
        ? [record as Origin]
        : [];
    } catch {
      return [];
    }
  });
}
async function response<T>(req: Promise<Response>): Promise<T> {
  const res = await req;

  if (!res.ok) {
    const failure = await readApiErrorBody(res);
    const details = catalogFailureDetails.safeParse(failure?.details);

    if (failure?.code === "UNAUTHENTICATED")
      throw new CatalogRequestError("signIn");
    if (failure?.code === "UNAUTHORIZED")
      throw new CatalogRequestError("forbidden");
    if (failure?.code === "PASSWORD_CHANGE_REQUIRED")
      throw new CatalogRequestError("passwordChange");
    if (details.success)
      throw new CatalogRequestError(
        catalogFailureLabels[details.data.reason],
        details.data,
      );
    switch (res.status) {
      case 404:
        throw new CatalogRequestError("itemUnavailable");
      case 410:
        throw new CatalogRequestError("previewExpired");
      case 429:
        throw new CatalogRequestError("rateLimit");
      case 503:
        throw new CatalogRequestError("unavailable");
    }
    if (failure?.code === "CONFLICT")
      throw new CatalogRequestError(
        failure.details?.reason === "operation_in_progress" ||
          failure.details?.reason === "operation_busy"
          ? "operationBusy"
          : "operationConflict",
      );
    if (failure?.code === "CONFIG")
      throw new CatalogRequestError("invalidImport");
    throw new CatalogRequestError("error");
  }

  return (await res.json()) as T;
}

const catalogFailureLabels = {
  approval_revoked: "approvalRevoked",
  catalog_identity_unavailable: "catalogIdentityUnavailable",
  upstream_access_denied: "upstreamAccessDenied",
  preview_limit_reached: "previewLimitReached",
  remote_requirements_unsupported: "remoteRequirementsUnsupported",
  distribution_requirements_unsupported: "distributionRequirementsUnsupported",
  origin_changed: "originChanged",
  already_imported: "alreadyImported",
  skill_id_exists: "skillIdExists",
  mcp_ref_exists: "mcpRefExists",
  mcp_descriptor_diverged: "mcpDescriptorDiverged",
  destination_occupied: "destinationOccupied",
  request_key_reused: "requestKeyReused",
  draft_changed: "draftChanged",
  resolutions_required: "resolutionsRequired",
} as const satisfies Record<CatalogFailureDetails["reason"], string>;

type CatalogFailure =
  | "error"
  | "signIn"
  | "forbidden"
  | "itemUnavailable"
  | "previewExpired"
  | "rateLimit"
  | "unavailable"
  | "invalidImport"
  | "operationBusy"
  | "operationConflict"
  | "passwordChange"
  | (typeof catalogFailureLabels)[keyof typeof catalogFailureLabels];

class CatalogRequestError extends Error {
  constructor(
    readonly failure: CatalogFailure,
    readonly details?: CatalogFailureDetails,
  ) {
    super(failure);
  }
}

function failureText(
  error: unknown,
  t: ReturnType<typeof useTranslations<"studio.catalog">>,
): string {
  if (!(error instanceof CatalogRequestError)) return t("error");
  const { details } = error;
  const message = t(error.failure);

  if (!details) return message;
  const groups = ["headers", "urlVariables", "environmentVariables"] as const;

  return [
    message,
    ...groups.flatMap((group) => {
      const requirements = details[group];

      return requirements?.names.length
        ? [
            t(group, {
              names: requirements.names.join(", "),
              more: requirements.more ? "yes" : "no",
            }),
          ]
        : [];
    }),
  ].join(" ");
}

function resultKey(result: SearchResult): string {
  return `${result.sourceId}/${result.resultId}`;
}

const SKILL_SEARCH_SCOPES = ["skills.sh", "repositories"] as const;

function mergeSearchResults(
  previous: SearchResponse | null,
  reply: SearchResponse,
): SearchResponse {
  const seen = new Set<string>();
  const indexedSkills = new Map<string, boolean>();
  const results = [...(previous?.results ?? []), ...reply.results].filter(
    (result) => {
      const key = resultKey(result);

      if (seen.has(key)) return false;
      if (result.canonicalSkillId) {
        const fromIndex = result.sourceId === "skills.sh";
        const firstSource = indexedSkills.get(result.canonicalSkillId);

        // Keep the first visible option stable when its other source arrives.
        if (firstSource !== undefined && firstSource !== fromIndex)
          return false;
        indexedSkills.set(result.canonicalSkillId, fromIndex);
      }
      seen.add(key);

      return true;
    },
  );

  return {
    results,
    sources: [...(previous?.sources ?? []), ...reply.sources],
    nextCursor: reply.nextCursor,
  };
}

function CatalogFileDiff({ file }: { file: ReviewFile }): ReactElement {
  const t = useTranslations("studio.catalog");
  const { resolvedTheme } = useTheme();
  const { before, after, path } = file;
  const data = useMemo(() => {
    const oldFileName = before === null ? "/dev/null" : `a/${path}`;
    const newFileName = after === null ? "/dev/null" : `b/${path}`;
    const patch = createTwoFilesPatch(
      oldFileName,
      newFileName,
      before ?? "",
      after ?? "",
      undefined,
      undefined,
      {
        timeout: 100,
      },
    );

    return patch
      ? {
          oldFile: { fileName: oldFileName, content: before },
          newFile: { fileName: newFileName, content: after },
          hunks: [patch],
        }
      : null;
  }, [before, after, path]);

  return data ? (
    <div className="max-h-96 overflow-auto" data-testid="catalog-file-diff">
      <DiffView
        data={data}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme={resolvedTheme}
      />
    </div>
  ) : (
    <p role="status">{t("diffUnavailable")}</p>
  );
}

function CatalogSelect({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <Select
      aria-label={label}
      className="min-w-32"
      isDisabled={disabled}
      placeholder={label}
      selectedKey={value || null}
      variant="secondary"
      onSelectionChange={(key) => {
        if (typeof key === "string") onChange(key);
      }}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value}>
              {option.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function CatalogImportPanel({
  packageId,
  sessionId,
  kind,
  files,
  dirty,
  onApplied,
}: {
  packageId: string;
  sessionId: string;
  kind: CatalogKind;
  files: AuthoredFlowPackageFile[];
  dirty: boolean;
  onApplied: () => void;
}): ReactElement {
  const t = useTranslations("studio.catalog");
  const router = useRouter();
  const feedback = useOptionalFeedback();
  const base =
    "/api/studio/local-packages/" + encodeURIComponent(packageId) + "/catalog";
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, true>>({});
  const [choices, setChoices] = useState<Record<string, "draft" | "upstream">>(
    {},
  );
  const [name, setName] = useState("");
  const [applying, setApplying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchFailure, setSearchFailure] =
    useState<CatalogRequestError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef("");
  const alive = useRef(true);
  const searchEpoch = useRef(0);
  const searchRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const manifest = parsePackageManifest(
    files.find((f) => f.path === PACKAGE_MANIFEST_FILENAME)?.content ?? "",
  );
  const roots = manifest.ok
    ? manifest.model.capabilities.map((c) => c.path)
    : [];
  const [root, setRoot] = useState(
    roots.length === 1 ? roots[0] : roots.length > 1 ? "" : "capability",
  );
  const origins = readOrigins(files, kind);
  const resultItems = data?.results ?? [];
  const unavailable =
    data?.sources.filter((source) => source.state !== "available") ?? [];
  const visibleError =
    error || (searchFailure && failureText(searchFailure, t));

  function clearPreview(): void {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreviewing(false);
    setPreview(null);
    setOpenFiles({});
    setChoices({});
  }

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
      previewRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!open || !q.trim()) return;
    const controller = new AbortController();
    const epoch = searchEpoch.current;
    const scopes = kind === "skill" ? SKILL_SEARCH_SCOPES : [undefined];
    let pending = scopes.length;
    const current = () =>
      !controller.signal.aborted && epoch === searchEpoch.current;

    searchRequest.current = controller;
    const timeout = setTimeout(() => {
      for (const scope of scopes) {
        const params = new URLSearchParams({ kind, q });

        if (scope) params.set("scope", scope);
        void response<SearchResponse>(
          fetch(base + "/search?" + params, { signal: controller.signal }),
        )
          .then((reply) => {
            if (current())
              setData((previous) => mergeSearchResults(previous, reply));
          })
          .catch((failure: unknown) => {
            if (current())
              setSearchFailure(
                failure instanceof CatalogRequestError
                  ? failure
                  : new CatalogRequestError("error"),
              );
          })
          .finally(() => {
            if (--pending === 0 && current()) setSearching(false);
          });
      }
    }, 250);

    return () => {
      clearTimeout(timeout);
      controller.abort();
      if (searchRequest.current === controller) searchRequest.current = null;
    };
  }, [base, kind, open, q]);
  function query(value: string): void {
    if (value === q && value.trim()) return;
    searchEpoch.current++;
    searchRequest.current?.abort();
    clearPreview();
    setQ(value);
    setData(null);
    setSelected(null);
    setError("");
    setSearchFailure(null);
    setSearching(Boolean(value.trim()));
    setLoadingMore(false);
  }
  function choose(item: SearchResult): void {
    setSelected(item);
    clearPreview();
    setError("");
    const slug = item.name
      .split("/")
      .at(-1)!
      .replace(/[^a-zA-Z0-9._-]+/g, "-");

    setName(slug);
    if (!dirty && slug && (kind === "mcp" || root)) {
      void review({
        sourceId: item.sourceId,
        selector: item.resultId,
        destination:
          kind === "skill"
            ? root + "/skills/" + slug
            : "mcps/" + slug + ".yaml",
      });
    }
  }
  async function review(item: {
    sourceId: string;
    selector: string;
    destination: string;
    importId?: string;
  }): Promise<void> {
    clearPreview();
    const controller = new AbortController();

    previewRequest.current = controller;
    setPreviewing(true);
    setError("");
    try {
      const refreshed = await response<CatalogPreview>(
        fetch(base + "/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, sessionId, ...item }),
          signal: controller.signal,
        }),
      );

      if (!controller.signal.aborted) {
        setPreview(refreshed);
        requestKey.current = crypto.randomUUID();
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(failureText(e, t));
    } finally {
      if (previewRequest.current === controller) {
        previewRequest.current = null;
        setPreviewing(false);
      }
    }
  }
  async function apply(): Promise<void> {
    if (!preview || dirty) return;
    setApplying(true);
    setError("");
    try {
      const payload = {
        previewId: preview.previewId,
        expectedDraftBase: preview.expectedDraftBase,
        sessionId,
        requestKey: requestKey.current,
        resolutions: Object.entries(choices).map(([path, use]) => ({
          path,
          use,
        })),
      };
      let receipt = await response<CatalogReceipt>(
        fetch(base + "/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );

      if (receipt.state === "pending")
        receipt = await response<CatalogReceipt>(
          fetch(base + "/operations/" + receipt.operationId),
        );
      if (!alive.current) return;
      if (receipt.state === "aborted") {
        clearPreview();
        setError(
          t(
            receipt.reason === "approval_revoked"
              ? "approvalRevoked"
              : "draftChanged",
          ),
        );

        return;
      }
      if (receipt.state !== "applied") {
        setError(t("pending"));

        return;
      }
      if (alive.current) {
        const stem = preview.destination.split("/").at(-1)!;

        feedback?.success({
          mutationId: receipt.operationId,
          message: t("applied"),
        });
        setOpen(false);
        onApplied();
        router.push(
          kind === "skill"
            ? skillScreenHref(packageId, stem)
            : inlineSelectHref(packageId, "mcps", stem.replace(/\.yaml$/, "")),
        );
      }
    } catch (e) {
      if (alive.current) {
        const failure = e instanceof CatalogRequestError ? e.failure : "error";

        if (
          failure === "previewExpired" ||
          failure === "draftChanged" ||
          failure === "approvalRevoked" ||
          failure === "requestKeyReused" ||
          failure === "itemUnavailable"
        )
          clearPreview();
        setError(failureText(e, t));
      }
    } finally {
      if (alive.current) setApplying(false);
    }
  }
  if (!open)
    return (
      <Button
        data-testid="catalog-open"
        size="sm"
        variant="secondary"
        onPress={() => {
          setOpen(true);
          query("");
        }}
      >
        {t("open")}
      </Button>
    );

  return (
    <section
      aria-label={t("open")}
      className="flex w-full flex-col gap-2 rounded-lg border border-line bg-paper p-3"
      data-testid="catalog-panel"
    >
      <div className="flex gap-2">
        <SearchField
          aria-label={t("search")}
          className="min-w-0 grow"
          isDisabled={applying}
          value={q}
          onChange={query}
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("search")} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <Button
          isDisabled={applying}
          size="sm"
          variant="ghost"
          onPress={() => {
            query("");
            setOpen(false);
          }}
        >
          {t("close")}
        </Button>
      </div>
      {dirty ? <p role="status">{t("dirty")}</p> : null}
      {searching ? <p role="status">{t("searching")}</p> : null}
      {!searching &&
      !searchFailure &&
      data &&
      !resultItems.length &&
      (!unavailable.length ||
        data.sources.some((source) => source.state === "available")) ? (
        <p role="status">{t(unavailable.length ? "partialEmpty" : "empty")}</p>
      ) : null}
      {unavailable.map((source) => (
        <p key={source.sourceId} role="status">
          {source.sourceId}:{" "}
          {t(
            source.state === "rate_limited"
              ? "rateLimit"
              : source.reason === "catalog_identity_unavailable"
                ? "catalogIdentityUnavailable"
                : "unavailable",
          )}
        </p>
      ))}
      {q.trim() ? (
        <div
          aria-busy={(searching && !resultItems.length) || loadingMore}
          data-testid="catalog-results"
        >
          <ListBox
            disallowEmptySelection
            aria-label={t("results")}
            className="max-h-44 overflow-y-auto"
            disabledKeys={applying ? resultItems.map(resultKey) : undefined}
            items={resultItems}
            selectedKeys={selected ? [resultKey(selected)] : []}
            selectionMode="single"
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const [key] = keys;
              const item = resultItems.find(
                (result) => resultKey(result) === key,
              );

              if (item) choose(item);
            }}
          >
            {(r) => (
              <ListBox.Item
                id={resultKey(r)}
                textValue={`${r.name} · ${r.publisher}`}
              >
                {r.name} · {r.publisher}
              </ListBox.Item>
            )}
          </ListBox>
        </div>
      ) : null}
      {data?.nextCursor ? (
        <Button
          isDisabled={applying}
          isPending={loadingMore}
          size="sm"
          variant="secondary"
          onPress={async () => {
            const cursor = data.nextCursor;
            const epoch = searchEpoch.current;
            const controller = searchRequest.current;

            if (!cursor || loadingMore || !controller) return;
            setLoadingMore(true);
            try {
              const next = await response<SearchResponse>(
                fetch(
                  base + "/search?" + new URLSearchParams({ kind, q, cursor }),
                  { signal: controller.signal },
                ),
              );

              if (alive.current && epoch === searchEpoch.current)
                setData({
                  ...next,
                  results: [...data.results, ...next.results],
                });
            } catch (e) {
              if (alive.current && epoch === searchEpoch.current)
                setError(failureText(e, t));
            } finally {
              if (alive.current && epoch === searchEpoch.current)
                setLoadingMore(false);
            }
          }}
        >
          {t("more")}
        </Button>
      ) : null}
      {selected ? (
        <div className="flex flex-wrap gap-2">
          {kind === "skill" && roots.length > 1 ? (
            <CatalogSelect
              disabled={applying}
              label={t("root")}
              options={roots.map((value) => ({ value, label: value }))}
              value={root}
              onChange={(value) => {
                setRoot(value);
                clearPreview();
              }}
            />
          ) : null}
          <label>
            {t("localName")}{" "}
            <Input
              disabled={applying}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearPreview();
              }}
            />
          </label>
          <Button
            isDisabled={
              applying || dirty || !name || (!root && kind === "skill")
            }
            isPending={previewing}
            size="sm"
            variant="secondary"
            onPress={() =>
              void review({
                sourceId: selected.sourceId,
                selector: selected.resultId,
                destination:
                  kind === "skill"
                    ? root + "/skills/" + name
                    : "mcps/" + name + ".yaml",
              })
            }
          >
            {t("preview")}
          </Button>
        </div>
      ) : null}
      {origins.map((origin) => (
        <Button
          key={origin.importId}
          isDisabled={applying || dirty}
          size="sm"
          variant="secondary"
          onPress={() =>
            void review({
              sourceId: origin.sourceId,
              selector: origin.selector,
              destination: origin.destination,
              importId: origin.importId,
            })
          }
        >
          {t("update")} · {origin.destination}
        </Button>
      ))}
      {previewing ? <p role="status">{t("previewing")}</p> : null}
      {visibleError ? <p role="alert">{visibleError}</p> : null}
      {preview ? (
        <div className="space-y-2" data-testid="catalog-preview">
          <p>
            {preview.publisher} ·{" "}
            <a
              className="underline"
              href={preview.sourceUrl}
              rel="noreferrer"
              target="_blank"
            >
              {preview.pin}
            </a>{" "}
            → {preview.destination}
          </p>
          <p className="break-all font-mono text-xs">
            SHA-256 {preview.digest}
          </p>
          {preview.artifactDigest ? (
            <div data-testid="catalog-artifact-digest">
              <p className="font-medium">{t("artifactDigest")}</p>
              <code className="break-all text-xs">
                {preview.artifactDigest}
              </code>
              <p className="text-ink-2">{t("artifactDigestNote")}</p>
            </div>
          ) : null}
          {preview.notices.length ? (
            <p>
              {t("notices")}: {preview.notices.join(", ")}
            </p>
          ) : null}
          {preview.configuration.length ? (
            <p>{preview.configuration.join(" · ")}</p>
          ) : null}
          {preview.migratesLegacyManifest ? (
            <p>{t("legacyManifestUpdate")}</p>
          ) : null}
          {preview.runnerCompatibility ? (
            <div>
              <p className="font-medium">{t("compatibleAdapters")}</p>
              <p>
                {preview.runnerCompatibility.compatibleAdapters.length
                  ? preview.runnerCompatibility.compatibleAdapters.join(", ")
                  : t("noCompatibleAdapters")}
              </p>
              <p className="text-ink-2">{t("runnerCompatibilityNote")}</p>
            </div>
          ) : null}
          {preview.affectedRefs?.length ? (
            <p>
              {t("affectedRefs")}: {preview.affectedRefs.join(", ")}
            </p>
          ) : null}
          {preview.files.map((file) => (
            <details
              key={`${preview.previewId}/${file.path}`}
              onToggle={(event) => {
                if (event.currentTarget.open)
                  setOpenFiles((opened) =>
                    opened[file.path]
                      ? opened
                      : { ...opened, [file.path]: true },
                  );
              }}
            >
              <summary>
                {t(file.change)} · {file.path}
              </summary>
              {openFiles[file.path] ? <CatalogFileDiff file={file} /> : null}
              {file.change === "conflict" ? (
                <CatalogSelect
                  disabled={applying}
                  label={t("resolve") + " " + file.path}
                  options={[
                    { value: "upstream", label: t("upstream") },
                    { value: "draft", label: t("draft") },
                  ]}
                  value={choices[file.path] ?? ""}
                  onChange={(value) => {
                    if (value === "upstream" || value === "draft")
                      setChoices((c) => ({ ...c, [file.path]: value }));
                  }}
                />
              ) : null}
            </details>
          ))}
          <Button
            data-testid="catalog-apply"
            isDisabled={
              dirty ||
              preview.files.some(
                (f) => f.change === "conflict" && !choices[f.path],
              )
            }
            isPending={applying}
            size="sm"
            onPress={() => void apply()}
          >
            {t("apply")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
