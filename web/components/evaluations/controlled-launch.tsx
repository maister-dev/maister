"use client";

import type { ExecutionPreset } from "@/lib/runs/execution-policy";
import type { ReactElement } from "react";

import { PlayIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

import { evalErrorKey, evalRequest } from "@/components/evaluations/api-error";
import {
  PreflightVerdict,
  type PreflightVerdictView,
} from "@/components/evaluations/controlled-preview";
import { EVALUATION_RECIPE_HOLD_SOURCE } from "@/lib/evaluations/recipe-schema";

// ── Client-facing props (server maps `loadControlledLaunchContext` → these) ────
// Types are re-declared here rather than imported from the server-only
// `lab-queries` module so this client bundle never reaches a `server-only`
// import; the shapes are structurally identical (D3, ADR-150 T1.4).

export interface ControlledFlowScaffold {
  flowRefId: string;
  flowRevisionId: string;
  inputContractDigest: string;
  artifactContractDigest: string;
  taskSnapshotRef: string;
  slotKeys: string[];
  requiredSlotKeys: string[];
}

export interface ControlledRunnerOption {
  id: string;
  capabilityAgent: string;
  model: string;
  ready: boolean;
}

export interface ControlledRecipeOption {
  id: string;
  key: string;
  label: string;
}

export interface ControlledOverlayCatalog {
  rules: string[];
  skills: string[];
  mcps: string[];
  subagents: string[];
}

export interface ControlledLaunchContext {
  enabled: boolean;
  launchable: boolean;
  taskId: string | null;
  scaffold: ControlledFlowScaffold | null;
  runnerOptions: ControlledRunnerOption[];
  overlayCatalog: ControlledOverlayCatalog;
  existingRecipes: ControlledRecipeOption[];
}

interface PinOption {
  packageInstallId: string;
  packageName: string;
  versionLabel: string;
  kind: "local_cut" | "upstream";
}

interface LaunchBatchItem {
  id: string;
  recipeId: string;
  replicateOrdinal: number;
  status: string;
  runId: string | null;
  attempt: number;
  errorReason: string | null;
}

interface LaunchBatch {
  id: string;
  status: string;
  items: LaunchBatchItem[];
}

const OVERLAY_CLASSES = ["rules", "skills", "mcps", "subagents"] as const;

type OverlayClass = (typeof OVERLAY_CLASSES)[number];

type OverlayDraft = Record<OverlayClass, { add: string; remove: string }>;

// A single inline variant the operator is composing before launch.
export interface VariantDraft {
  id: string;
  label: string;
  // slotKey -> runnerId ("" = unbound, resolves via the default runner chain).
  slotRunners: Record<string, string>;
  packageInstallId: string;
  policyPreset: ExecutionPreset;
  overlay: OverlayDraft;
  replicateCount: number;
}

const EXECUTION_PRESETS: readonly ExecutionPreset[] = [
  "supervised",
  "assisted",
  "unattended",
];

const NON_TERMINAL_ITEM = new Set(["queued", "launching"]);

function emptyOverlay(): OverlayDraft {
  return {
    rules: { add: "", remove: "" },
    skills: { add: "", remove: "" },
    mcps: { add: "", remove: "" },
    subagents: { add: "", remove: "" },
  };
}

// A deterministic client key for a fresh variant. `index` disambiguates variants
// created in the same tick (Math.random is unavailable in some sandboxes and
// re-keying on every render breaks controlled inputs, so we derive from a
// monotonic seed the caller supplies).
export function makeVariant(seed: number, label: string): VariantDraft {
  return {
    id: `v${seed}`,
    label,
    slotRunners: {},
    packageInstallId: "",
    policyPreset: "supervised",
    overlay: emptyOverlay(),
    replicateCount: 1,
  };
}

// Split a comma-separated capability-ref input into a deduped, trimmed list.
// Mirrors the legacy `csv()` normalizer but also dedupes (the recipe overlay
// schema rejects duplicate add/remove refs → CONFIG), so the UI never emits a
// definition the strict parse would refuse for a within-list duplicate.
export function csvRefs(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of value.split(",")) {
    const ref = raw.trim();

    if (ref.length > 0 && !seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }

  return out;
}

function overlayDelta(cell: {
  add: string;
  remove: string;
}): { add?: string[]; remove?: string[] } | undefined {
  const add = csvRefs(cell.add);
  const remove = csvRefs(cell.remove);

  if (add.length === 0 && remove.length === 0) return undefined;

  return {
    ...(add.length > 0 ? { add } : {}),
    ...(remove.length > 0 ? { remove } : {}),
  };
}

// The count of overlay changes across all four classes (for the dialog summary).
export function overlayChangeCount(overlay: OverlayDraft): number {
  return OVERLAY_CLASSES.reduce((total, cls) => {
    const delta = overlayDelta(overlay[cls]);

    return total + (delta?.add?.length ?? 0) + (delta?.remove?.length ?? 0);
  }, 0);
}

// Assemble the strict controlled-recipe definition from the SERVER scaffold plus
// the operator's parity-axis choices. The flow revision + contract digests come
// only from the scaffold — the client never fabricates a digest — so a launched
// participant is reproducible and preflight can catch a stale revision. Sparse:
// empty optional fields are omitted so zod defaults apply (D16).
export function buildRecipeDefinition(
  scaffold: ControlledFlowScaffold,
  variant: VariantDraft,
): Record<string, unknown> {
  const slotBindings: Record<string, { mode: "runner"; runnerId: string }> = {};

  for (const [slotKey, runnerId] of Object.entries(variant.slotRunners)) {
    if (runnerId) slotBindings[slotKey] = { mode: "runner", runnerId };
  }

  const overlay: Record<string, { add?: string[]; remove?: string[] }> = {};

  for (const cls of OVERLAY_CLASSES) {
    const delta = overlayDelta(variant.overlay[cls]);

    if (delta) overlay[cls] = delta;
  }

  return {
    schemaVersion: 1,
    flow: {
      flowRefId: scaffold.flowRefId,
      flowRevisionId: scaffold.flowRevisionId,
      inputContractDigest: scaffold.inputContractDigest,
      artifactContractDigest: scaffold.artifactContractDigest,
      ...(variant.packageInstallId
        ? { packageInstallId: variant.packageInstallId }
        : {}),
    },
    inputs: { taskSnapshotRef: scaffold.taskSnapshotRef, formValues: {} },
    ...(Object.keys(slotBindings).length > 0 ? { slotBindings } : {}),
    executionPolicy: { preset: variant.policyPreset },
    ...(Object.keys(overlay).length > 0 ? { capabilityOverlay: overlay } : {}),
    ...(variant.packageInstallId
      ? {
          materializationIntent: {
            packagePins: [{ packageInstallId: variant.packageInstallId }],
            capabilityRequirements: [],
            allowedProjectOverlays: [],
          },
        }
      : {}),
    promotionHold: { source: EVALUATION_RECIPE_HOLD_SOURCE },
  };
}

// Map the pure preflight result (typed refusal/warning objects) to the code-only
// view the shared PreflightVerdict block renders — a raw message never reaches
// the UI, only its stable localized code.
export function toVerdictView(result: {
  ok: boolean;
  refusals: Array<{ code: string }>;
  warnings: Array<{ code: string }>;
}): PreflightVerdictView {
  return {
    ok: result.ok,
    refusalCodes: result.refusals.map((r) => r.code),
    warningCodes: result.warnings.map((w) => w.code),
  };
}

// ── Presentational sub-components (renderToStaticMarkup-testable) ─────────────

export function LaunchDisabledReason({
  reasonKey,
}: {
  reasonKey: string;
}): ReactElement {
  const t = useTranslations("evaluationsControlled");

  return (
    <p className="text-[12px] text-mute" role="note">
      {t(reasonKey)}
    </p>
  );
}

function OverlayInputs({
  variant,
  overlayCatalog,
  onChange,
}: {
  variant: VariantDraft;
  overlayCatalog: ControlledOverlayCatalog;
  onChange: (next: OverlayDraft) => void;
}): ReactElement {
  const t = useTranslations("evaluationsControlled");
  const listId = useId();

  return (
    <div className="grid grid-cols-2 gap-2">
      {OVERLAY_CLASSES.map((cls) => (
        <fieldset
          key={cls}
          className="col-span-2 grid grid-cols-2 gap-2 border-0 p-0"
        >
          {(["add", "remove"] as const).map((dir) => (
            <label key={dir} className="flex flex-col gap-1">
              <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mute">
                {t(`launch.overlay.${cls}.${dir}`)}
              </span>
              <input
                className="rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[11px] text-ink"
                list={`${listId}-${cls}`}
                value={variant.overlay[cls][dir]}
                onChange={(e) =>
                  onChange({
                    ...variant.overlay,
                    [cls]: { ...variant.overlay[cls], [dir]: e.target.value },
                  })
                }
              />
            </label>
          ))}
          <datalist id={`${listId}-${cls}`}>
            {overlayCatalog[cls].map((ref) => (
              <option key={ref} value={ref} />
            ))}
          </datalist>
        </fieldset>
      ))}
    </div>
  );
}

export function VariantEditorFields({
  variant,
  scaffold,
  runnerOptions,
  pinOptions,
  overlayCatalog,
  canRemove,
  onChange,
  onRemove,
}: {
  variant: VariantDraft;
  scaffold: ControlledFlowScaffold;
  runnerOptions: ControlledRunnerOption[];
  pinOptions: PinOption[];
  overlayCatalog: ControlledOverlayCatalog;
  canRemove: boolean;
  onChange: (next: VariantDraft) => void;
  onRemove: () => void;
}): ReactElement {
  const t = useTranslations("evaluationsControlled");

  return (
    <fieldset className="rounded-[10px] border border-line bg-ivory p-3">
      <legend className="flex items-center gap-2 px-1">
        <input
          aria-label={t("launch.variantLabel")}
          className="rounded-md border border-line bg-paper px-2 py-1 text-[12px] font-semibold text-ink"
          value={variant.label}
          onChange={(e) => onChange({ ...variant, label: e.target.value })}
        />
        {canRemove ? (
          <button
            aria-label={t("launch.removeVariant")}
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-line bg-paper text-mute hover:text-danger"
            type="button"
            onClick={onRemove}
          >
            <XMarkIcon aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </legend>

      <div className="grid grid-cols-1 gap-2">
        {scaffold.slotKeys.length === 0 ? (
          <p className="text-[11px] text-mute">{t("launch.noSlots")}</p>
        ) : (
          scaffold.slotKeys.map((slotKey) => (
            <label key={slotKey} className="flex flex-col gap-1">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                {t("launch.runnerFor", { slot: slotKey })}
              </span>
              <select
                className="rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                value={variant.slotRunners[slotKey] ?? ""}
                onChange={(e) =>
                  onChange({
                    ...variant,
                    slotRunners: {
                      ...variant.slotRunners,
                      [slotKey]: e.target.value,
                    },
                  })
                }
              >
                <option value="">{t("launch.runnerDefault")}</option>
                {runnerOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.model} · {r.capabilityAgent}
                    {r.ready ? "" : ` (${t("launch.runnerNotReady")})`}
                  </option>
                ))}
              </select>
            </label>
          ))
        )}

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("launch.packagePin")}
          </span>
          <select
            className="rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink disabled:opacity-50"
            disabled={pinOptions.length === 0}
            value={variant.packageInstallId}
            onChange={(e) =>
              onChange({ ...variant, packageInstallId: e.target.value })
            }
          >
            <option value="">{t("launch.packagePinNone")}</option>
            {pinOptions.map((option) => (
              <option
                key={option.packageInstallId}
                value={option.packageInstallId}
              >
                {option.packageName} · {option.versionLabel} (
                {option.kind === "local_cut"
                  ? t("launch.pinLocalCut")
                  : t("launch.pinUpstream")}
                )
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
              {t("launch.policy")}
            </span>
            <select
              className="rounded-md border border-line bg-paper px-2 py-1.5 text-[12px] text-ink"
              value={variant.policyPreset}
              onChange={(e) =>
                onChange({
                  ...variant,
                  policyPreset: e.target.value as ExecutionPreset,
                })
              }
            >
              {EXECUTION_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {t(`policy.${preset}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
              {t("launch.replicates")}
            </span>
            <input
              className="rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
              max={32}
              min={1}
              type="number"
              value={variant.replicateCount}
              onChange={(e) =>
                onChange({
                  ...variant,
                  replicateCount: Math.max(
                    1,
                    Math.min(32, Number(e.target.value) || 1),
                  ),
                })
              }
            />
          </label>
        </div>

        <OverlayInputs
          overlayCatalog={overlayCatalog}
          variant={variant}
          onChange={(next) => onChange({ ...variant, overlay: next })}
        />
      </div>
    </fieldset>
  );
}

export function PreflightPreviewList({
  verdicts,
  labels,
}: {
  verdicts: PreflightVerdictView[];
  labels: string[];
}): ReactElement {
  const t = useTranslations("evaluationsControlled");

  return (
    <div className="flex flex-col gap-2">
      <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
        {t("launch.previewHeading")}
      </h4>
      {verdicts.map((verdict, index) => (
        <div key={index} className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink">
            {labels[index] ?? `#${index + 1}`}
          </span>
          <PreflightVerdict verdict={verdict} />
        </div>
      ))}
    </div>
  );
}

export function BatchStatusStrip({
  batch,
  retrying,
  onRetry,
}: {
  batch: LaunchBatch;
  retrying: boolean;
  onRetry: () => void;
}): ReactElement {
  const t = useTranslations("evaluationsControlled");
  const hasFailed = batch.items.some((i) => i.status === "failed");

  return (
    <section
      aria-live="polite"
      className="mt-3 rounded-[10px] border border-line bg-paper p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
          {t("launch.batchHeading")}
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-2">
          {t(`launch.batch.${batch.status}`)}
        </span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {batch.items.map((item) => (
          <li
            key={item.id}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10.5px] ${
              item.status === "launched"
                ? "border-good text-good"
                : item.status === "failed"
                  ? "border-danger text-danger"
                  : "border-line text-ink-2"
            }`}
            title={item.errorReason ?? undefined}
          >
            <span>{t(`launch.item.${item.status}`)}</span>
            {item.runId ? <span>· {item.runId.slice(0, 8)}</span> : null}
            {item.attempt > 1 ? <span>· ×{item.attempt}</span> : null}
          </li>
        ))}
      </ul>
      {hasFailed ? (
        <button
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
          disabled={retrying}
          type="button"
          onClick={onRetry}
        >
          {retrying ? t("launch.retrying") : t("launch.retry")}
        </button>
      ) : null}
    </section>
  );
}

// ── Modal shell (portal to body, focus trap/restore, Escape, scroll-lock) ─────

function LaunchModal({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";
    // Initial focus on the panel so the focus trap has an anchor.
    panelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();

        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      );

      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus();
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-hidden="true"
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative flex max-h-[85vh] w-full max-w-[880px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ── Stateful shell ────────────────────────────────────────────────────────────

export function ControlledLaunch({
  slug,
  studyId,
  context,
}: {
  slug: string;
  studyId: string;
  context: ControlledLaunchContext;
}): ReactElement {
  const t = useTranslations("evaluationsControlled");
  const tErr = useTranslations("evaluationsErrors");
  const titleId = useId();
  const { scaffold, enabled, launchable } = context;

  const [open, setOpen] = useState(false);
  const [variants, setVariants] = useState<VariantDraft[]>(() => [
    makeVariant(1, "Control"),
    makeVariant(2, "Candidate"),
  ]);
  const seedRef = useRef(3);
  const [selectedRecipes, setSelectedRecipes] = useState<Set<string>>(
    new Set(),
  );
  const [pinOptions, setPinOptions] = useState<PinOption[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [verdicts, setVerdicts] = useState<PreflightVerdictView[] | null>(null);
  const [busy, setBusy] = useState<"preview" | "launch" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [batch, setBatch] = useState<LaunchBatch | null>(null);
  const [retrying, setRetrying] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const launchDisabled = !enabled || !launchable || !scaffold;
  const disabledReasonKey = !enabled
    ? "launch.disabledKillSwitch"
    : !launchable
      ? "launch.disabledStatus"
      : "launch.disabledNoFlow";

  const loadPinOptions = useCallback(async (): Promise<void> => {
    if (!context.taskId) {
      setPinOptions([]);

      return;
    }
    try {
      const res = await fetch(
        `/api/projects/${slug}/evaluations/pin-options?taskId=${encodeURIComponent(context.taskId)}`,
      );

      if (!res.ok) {
        setPinOptions([]);

        return;
      }
      const body = (await res.json()) as { options?: PinOption[] };

      setPinOptions(body.options ?? []);
    } catch {
      setPinOptions([]);
    }
  }, [slug, context.taskId]);

  function openDialog(): void {
    setVariants([makeVariant(1, "Control"), makeVariant(2, "Candidate")]);
    seedRef.current = 3;
    setSelectedRecipes(new Set());
    setVerdicts(null);
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
    setOpen(true);
    void loadPinOptions();
  }

  const stopPolling = useCallback((): void => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const pollBatch = useCallback(
    async (batchId: string): Promise<void> => {
      try {
        const res = await evalRequest(
          `/api/projects/${slug}/evaluations/studies/${studyId}/launch-batches/${batchId}`,
        );
        const dto = (await res.json()) as LaunchBatch;

        setBatch(dto);
        if (dto.items.some((i) => NON_TERMINAL_ITEM.has(i.status))) {
          pollTimer.current = setTimeout(() => void pollBatch(batchId), 2000);
        }
      } catch {
        // Stop polling on a transient read failure; the last snapshot stays.
      }
    },
    [slug, studyId],
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  const inlineDefinitions = useCallback((): Record<string, unknown>[] => {
    if (!scaffold) return [];

    return variants.map((v) => buildRecipeDefinition(scaffold, v));
  }, [scaffold, variants]);

  async function preview(): Promise<void> {
    if (!scaffold) return;
    setBusy("preview");
    setError(null);
    try {
      const res = await evalRequest(
        `/api/projects/${slug}/evaluations/studies/${studyId}/launch-preflight`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipes: inlineDefinitions() }),
        },
      );
      const body = (await res.json()) as {
        results: Array<{
          ok: boolean;
          refusals: Array<{ code: string }>;
          warnings: Array<{ code: string }>;
        }>;
      };

      setVerdicts(body.results.map(toVerdictView));
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setBusy(null);
    }
  }

  async function launch(): Promise<void> {
    if (!scaffold) return;
    const items: Array<Record<string, unknown>> = [
      ...variants.map((v) => ({
        definition: buildRecipeDefinition(scaffold, v),
        replicateCount: v.replicateCount,
      })),
      ...[...selectedRecipes].map((recipeId) => ({ recipeId })),
    ];

    if (items.length === 0) {
      setError(t("launch.emptyRefusal"));

      return;
    }

    setBusy("launch");
    setError(null);
    try {
      const res = await evalRequest(
        `/api/projects/${slug}/evaluations/studies/${studyId}/launch-batches`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey, items }),
        },
      );
      const body = (await res.json()) as { batchId: string };

      setOpen(false);
      stopPolling();
      void pollBatch(body.batchId);
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setBusy(null);
    }
  }

  async function retry(): Promise<void> {
    if (!batch) return;
    setRetrying(true);
    try {
      await evalRequest(
        `/api/projects/${slug}/evaluations/studies/${studyId}/launch-batches/${batch.id}/retry`,
        { method: "POST" },
      );
      stopPolling();
      void pollBatch(batch.id);
    } catch {
      // Retry refuses softly server-side; keep the last snapshot.
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("launch.section")}
        </h2>
        <button
          className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-paper px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
          disabled={launchDisabled}
          title={launchDisabled ? t(disabledReasonKey) : undefined}
          type="button"
          onClick={openDialog}
        >
          <PlayIcon aria-hidden="true" className="h-4 w-4" />
          {t("launch.trigger")}
        </button>
      </div>

      {launchDisabled ? (
        <LaunchDisabledReason reasonKey={disabledReasonKey} />
      ) : null}

      {batch ? (
        <BatchStatusStrip
          batch={batch}
          retrying={retrying}
          onRetry={() => void retry()}
        />
      ) : null}

      {open && scaffold ? (
        <LaunchModal titleId={titleId} onClose={() => setOpen(false)}>
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 className="m-0 text-base font-bold text-ink" id={titleId}>
              {t("launch.title")}
            </h2>
            <button
              aria-label={t("launch.close")}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-mute hover:text-ink"
              type="button"
              onClick={() => setOpen(false)}
            >
              <XMarkIcon aria-hidden="true" className="h-4 w-4" />
            </button>
          </header>

          <div className="flex-1 space-y-4 overflow-auto px-5 py-5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                {t("launch.variants")} ({variants.length})
              </h3>
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line bg-paper px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                disabled={variants.length >= 12}
                type="button"
                onClick={() => {
                  const seed = seedRef.current;

                  seedRef.current += 1;
                  setVariants((cur) => [
                    ...cur,
                    makeVariant(seed, `Variant ${cur.length + 1}`),
                  ]);
                }}
              >
                <PlusIcon aria-hidden="true" className="h-4 w-4" />
                {t("launch.addVariant")}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {variants.map((variant) => (
                <VariantEditorFields
                  key={variant.id}
                  canRemove={variants.length > 1}
                  overlayCatalog={context.overlayCatalog}
                  pinOptions={pinOptions}
                  runnerOptions={context.runnerOptions}
                  scaffold={scaffold}
                  variant={variant}
                  onChange={(next) =>
                    setVariants((cur) =>
                      cur.map((v) => (v.id === variant.id ? next : v)),
                    )
                  }
                  onRemove={() =>
                    setVariants((cur) => cur.filter((v) => v.id !== variant.id))
                  }
                />
              ))}
            </div>

            {context.existingRecipes.length > 0 ? (
              <details className="rounded-[10px] border border-line bg-ivory p-3">
                <summary className="cursor-pointer font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                  {t("launch.reuse")}
                </summary>
                <ul className="mt-2 grid list-none gap-1 p-0">
                  {context.existingRecipes.map((recipe) => (
                    <li key={recipe.id}>
                      <label className="flex items-center gap-2 text-[12px] text-ink">
                        <input
                          checked={selectedRecipes.has(recipe.id)}
                          type="checkbox"
                          onChange={(e) =>
                            setSelectedRecipes((prev) => {
                              const next = new Set(prev);

                              if (e.target.checked) next.add(recipe.id);
                              else next.delete(recipe.id);

                              return next;
                            })
                          }
                        />
                        <span className="font-semibold">{recipe.label}</span>
                        <span className="font-mono text-[11px] text-mute">
                          {recipe.key}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {verdicts ? (
              <PreflightPreviewList
                labels={variants.map((v) => v.label)}
                verdicts={verdicts}
              />
            ) : null}

            {error ? (
              <p className="text-[12px] text-danger" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
            <button
              className="inline-flex h-9 items-center rounded-[8px] border border-line bg-paper px-3 text-[12px] font-semibold text-mute hover:text-ink"
              type="button"
              onClick={() => setOpen(false)}
            >
              {t("launch.cancel")}
            </button>
            <button
              className="inline-flex h-9 items-center rounded-[8px] border border-line bg-paper px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
              disabled={busy !== null}
              type="button"
              onClick={() => void preview()}
            >
              {busy === "preview"
                ? t("launch.previewing")
                : t("launch.preview")}
            </button>
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-ink px-4 text-[12px] font-semibold text-paper disabled:opacity-50"
              disabled={busy !== null}
              type="button"
              onClick={() => void launch()}
            >
              <PlayIcon aria-hidden="true" className="h-4 w-4" />
              {busy === "launch" ? t("launch.launching") : t("launch.confirm")}
            </button>
          </footer>
        </LaunchModal>
      ) : null}
    </section>
  );
}
