"use client";

import type { CreateFlowInput } from "@/lib/local-packages/create-flow-contract";
import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  createFlowInputSchema,
  localPackageNameSchema,
} from "@/lib/local-packages/create-flow-contract";

type CreateFlowDialogMode = "new-package" | "add-flow";

type CreateFlowDialogSubmit =
  | { mode: "new-package"; name: string; flow: CreateFlowInput }
  | { mode: "add-flow"; flow: CreateFlowInput };

function parseOptionalArray(value: string): unknown[] | undefined {
  const trimmed = value.trim();

  if (trimmed === "") return undefined;
  const parsed: unknown = JSON.parse(trimmed);

  if (!Array.isArray(parsed)) {
    throw new Error("Expected a JSON array");
  }

  return parsed;
}

// Shared canonical wizard for both package creation and the existing package
// composition screen. It deliberately maps form labels to `metadata` in
// flow.yaml; it never calls that metadata Markdown frontmatter.
export function CreateFlowDialog({
  mode,
  busy,
  requestError,
  onClose,
  onSubmit,
}: {
  mode: CreateFlowDialogMode;
  busy: boolean;
  requestError: string | null;
  onClose: () => void;
  onSubmit: (value: CreateFlowDialogSubmit) => Promise<void>;
}): ReactElement {
  const t = useTranslations("studio.local.createFlow");
  const tLocal = useTranslations("studio.local");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [routeWhen, setRouteWhen] = useState("");
  const [labels, setLabels] = useState("");
  const [links, setLinks] = useState("");
  const [sources, setSources] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    let parsedLinks: unknown[] | undefined;
    let parsedSources: unknown[] | undefined;

    try {
      parsedLinks = parseOptionalArray(links);
      parsedSources = parseOptionalArray(sources);
    } catch {
      setValidationError(t("invalidJson"));
      return;
    }

    const flow = createFlowInputSchema.safeParse({
      id,
      metadata: {
        title,
        summary,
        route_when: routeWhen,
        ...(labels.trim()
          ? {
              labels: labels
                .split(",")
                .map((label) => label.trim())
                .filter((label) => label.length > 0),
            }
          : {}),
        ...(parsedLinks ? { links: parsedLinks } : {}),
        ...(parsedSources ? { sources: parsedSources } : {}),
      },
    });

    if (!flow.success) {
      setValidationError(t("invalidFields"));
      return;
    }

    if (mode === "new-package") {
      const packageName = localPackageNameSchema.safeParse(name);

      if (!packageName.success) {
        setValidationError(t("invalidPackageName"));
        return;
      }

      setValidationError(null);
      await onSubmit({ mode, name: packageName.data, flow: flow.data });
      return;
    }

    setValidationError(null);
    await onSubmit({ mode, flow: flow.data });
  }

  return (
    <section
      aria-label={mode === "new-package" ? t("newTitle") : t("addTitle")}
      className="w-full rounded-[14px] border border-amber-line bg-amber-soft p-4"
      data-testid="create-flow-dialog"
      role="dialog"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="m-0 text-[15px] font-semibold text-ink">
          {mode === "new-package" ? t("newTitle") : t("addTitle")}
        </h2>
        <button
          className="rounded-md border border-line bg-paper px-2 py-1 font-mono text-[10px] text-mute hover:text-ink"
          disabled={busy}
          type="button"
          onClick={onClose}
        >
          {tLocal("cancel")}
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {mode === "new-package" ? (
          <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
            {t("packageName")}
            <input
              className="rounded-[8px] border border-line bg-paper px-2.5 py-2 text-[13px] text-ink"
              data-testid="create-flow-package-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
          {t("flowId")}
          <input
            className="rounded-[8px] border border-line bg-paper px-2.5 py-2 text-[13px] text-ink"
            data-testid="create-flow-id"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
          {t("displayTitle")}
          <input
            className="rounded-[8px] border border-line bg-paper px-2.5 py-2 text-[13px] text-ink"
            data-testid="create-flow-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
          {t("summary")}
          <textarea
            className="min-h-[72px] rounded-[8px] border border-line bg-paper px-2.5 py-2 text-[13px] text-ink"
            data-testid="create-flow-summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-ink-2">
          {t("routeWhen")}
          <textarea
            className="min-h-[72px] rounded-[8px] border border-line bg-paper px-2.5 py-2 text-[13px] text-ink"
            data-testid="create-flow-route-when"
            value={routeWhen}
            onChange={(event) => setRouteWhen(event.target.value)}
          />
        </label>
      </div>
      <details className="mt-3 rounded-[8px] border border-line bg-paper p-3">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-2">
          {t("optionalMetadata")}
        </summary>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-[11px] text-ink-2">
            {t("labels")}
            <input
              className="rounded-[8px] border border-line bg-paper px-2 py-1.5 text-[12px] text-ink"
              placeholder={t("labelsHint")}
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-2">
            {t("links")}
            <textarea
              className="min-h-[88px] rounded-[8px] border border-line bg-paper px-2 py-1.5 font-mono text-[11px] text-ink"
              placeholder={t.raw("linksHint")}
              value={links}
              onChange={(event) => setLinks(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-2">
            {t("sources")}
            <textarea
              className="min-h-[88px] rounded-[8px] border border-line bg-paper px-2 py-1.5 font-mono text-[11px] text-ink"
              placeholder={t.raw("sourcesHint")}
              value={sources}
              onChange={(event) => setSources(event.target.value)}
            />
          </label>
        </div>
      </details>
      {validationError || requestError ? (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {validationError ?? requestError}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end">
        <button
          className="rounded-[10px] border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
          data-testid="create-flow-submit"
          disabled={busy}
          type="button"
          onClick={() => void submit()}
        >
          {busy
            ? t("creating")
            : mode === "new-package"
              ? t("createPackage")
              : t("createFlow")}
        </button>
      </div>
    </section>
  );
}
