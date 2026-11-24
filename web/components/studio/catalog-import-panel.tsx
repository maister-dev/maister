"use client";

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type {
  CatalogKind,
  CatalogPreview,
  CatalogReceipt,
  SearchResponse,
  SearchResult,
} from "@/lib/local-packages/catalog-contract";
import type { ReactElement } from "react";

import { Button, Input, ListBox, SearchField, Select } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
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
import { useOptionalFeedback } from "@/components/feedback/feedback-provider";

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

    if (failure?.code === "UNAUTHENTICATED")
      throw new CatalogRequestError("signIn");
    if (failure?.code === "UNAUTHORIZED")
      throw new CatalogRequestError("forbidden");
    if (failure?.code === "PASSWORD_CHANGE_REQUIRED")
      throw new CatalogRequestError("passwordChange");
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
          : "draftChanged",
      );
    if (failure?.code === "CONFIG")
      throw new CatalogRequestError("invalidImport");
    throw new CatalogRequestError("error");
  }

  return (await res.json()) as T;
}

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
  | "draftChanged"
  | "passwordChange";

class CatalogRequestError extends Error {
  constructor(readonly failure: CatalogFailure) {
    super(failure);
  }
}

function resultKey(result: SearchResult): string {
  return `${result.sourceId}/${result.resultId}`;
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
  const [choices, setChoices] = useState<Record<string, "draft" | "upstream">>(
    {},
  );
  const [name, setName] = useState("");
  const [applying, setApplying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef("");
  const alive = useRef(true);
  const searchEpoch = useRef(0);
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

  function clearPreview(): void {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreviewing(false);
    setPreview(null);
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
    const timeout = setTimeout(() => {
      void response<SearchResponse>(
        fetch(base + "/search?" + new URLSearchParams({ kind, q }), {
          signal: controller.signal,
        }),
      )
        .then((reply) => {
          if (!controller.signal.aborted && epoch === searchEpoch.current) {
            setData(reply);
            setSearching(false);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted && epoch === searchEpoch.current) {
            setError(t(e instanceof CatalogRequestError ? e.failure : "error"));
            setSearching(false);
          }
        });
    }, 250);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [base, kind, open, q, t]);
  function query(value: string): void {
    searchEpoch.current++;
    clearPreview();
    setQ(value);
    setData(null);
    setSelected(null);
    setError("");
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
      if (!controller.signal.aborted)
        setError(t(e instanceof CatalogRequestError ? e.failure : "error"));
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
          failure === "itemUnavailable"
        )
          clearPreview();
        setError(t(failure));
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
      {data && !data.results.length ? <p role="status">{t("empty")}</p> : null}
      {data?.sources
        .filter((s) => s.state !== "available")
        .map((s) => (
          <p key={s.sourceId} role="status">
            {s.sourceId}:{" "}
            {t(s.state === "rate_limited" ? "rateLimit" : "unavailable")}
          </p>
        ))}
      {q.trim() ? (
        <div aria-busy={searching || loadingMore} data-testid="catalog-results">
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

            if (!cursor || loadingMore) return;
            setLoadingMore(true);
            try {
              const next = await response<SearchResponse>(
                fetch(
                  base + "/search?" + new URLSearchParams({ kind, q, cursor }),
                ),
              );

              if (alive.current && epoch === searchEpoch.current)
                setData({
                  ...next,
                  results: [...data.results, ...next.results],
                });
            } catch (e) {
              if (alive.current && epoch === searchEpoch.current)
                setError(
                  t(e instanceof CatalogRequestError ? e.failure : "error"),
                );
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
      {error ? <p role="alert">{error}</p> : null}
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
            <details key={file.path}>
              <summary>
                {t(file.change)} · {file.path}
              </summary>
              {file.before !== null ? (
                <pre
                  aria-label={t("draft")}
                  className="max-h-64 overflow-auto whitespace-pre-wrap bg-ivory p-2"
                >
                  {file.before}
                </pre>
              ) : null}
              {file.after !== null ? (
                <pre
                  aria-label={t("upstream")}
                  className="max-h-64 overflow-auto whitespace-pre-wrap p-2"
                >
                  {file.after}
                </pre>
              ) : null}
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
