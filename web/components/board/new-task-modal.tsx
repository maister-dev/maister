"use client";

import type { ProjectFlow } from "@/lib/queries/project";
import type { ReactElement } from "react";

import { PlusIcon } from "@heroicons/react/24/outline";
import { Button, Input, Modal } from "@heroui/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { readApiError } from "@/lib/api-error";

export interface NewTaskModalLabels {
  trigger: string;
  title: string;
  titleLabel: string;
  titlePlaceholder: string;
  promptLabel: string;
  promptPlaceholder: string;
  flowLabel: string;
  flowNone: string;
  noEnabledFlow: string;
  managePackages: string;
  create: string;
  cancel: string;
}

export interface NewTaskModalProps {
  slug: string;
  flows: ProjectFlow[];
  labels: NewTaskModalLabels;
  packagesHref: string;
}

export function NewTaskModal({
  slug,
  flows,
  labels,
  packagesHref,
}: NewTaskModalProps): ReactElement {
  const router = useRouter();
  const tApiErrors = useTranslations("apiErrors");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  // M34: flow is optional — "" creates a simple-intent task that the triager
  // (or a human via the card popover) configures later.
  const [flowId, setFlowId] = useState("");
  const launchableFlows = flows.filter((flow) => flow.launchable === true);

  function reset(): void {
    setTitle("");
    setPrompt("");
    setFlowId("");
    setError(null);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${slug}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          prompt,
          ...(flowId === "" ? {} : { flowId }),
        }),
      });

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      setOpen(false);
      reset();
      startTransition(() => router.refresh());
    } catch {
      setError(tApiErrors("requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  const disabled =
    busy || pending || title.trim() === "" || prompt.trim() === "";

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <Button
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber bg-amber px-3 py-[7px] font-mono text-[11px] font-semibold tracking-[0.02em] text-white shadow-[0_6px_18px_-8px_var(--amber)] hover:bg-amber-2"
        type="button"
      >
        <PlusIcon aria-hidden="true" className="size-3" />
        {labels.trigger}
      </Button>

      <Modal.Backdrop
        className="z-[200]"
        isDismissable={!busy}
        isKeyboardDismissDisabled={busy}
      >
        <Modal.Container placement="center" scroll="inside">
          <Modal.Dialog
            className="max-h-[calc(100dvh-2rem)] w-full max-w-[480px] overflow-hidden rounded-[14px] border border-line bg-paper"
            render={(props) => (
              <section {...props} aria-modal="true" role="dialog" />
            )}
          >
            <Modal.Header className="shrink-0 border-b border-line py-4 pl-5 pr-12">
              <Modal.Heading className="m-0 font-sans text-base font-bold text-ink">
                {labels.title}
              </Modal.Heading>
              <Modal.CloseTrigger
                aria-label={labels.cancel}
                isDisabled={busy}
              />
            </Modal.Header>
            <Modal.Body className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-5">
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                  {labels.titleLabel}
                </span>
                <Input
                  // eslint-disable-next-line jsx-a11y-x/no-autofocus -- Focus enters the opened modal at its first field.
                  autoFocus
                  className="rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-amber"
                  placeholder={labels.titlePlaceholder}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                  {labels.promptLabel}
                </span>
                <textarea
                  className="min-h-[90px] resize-y rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] leading-[1.5] text-ink outline-none focus:border-amber"
                  placeholder={labels.promptPlaceholder}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>

              <div className="grid grid-cols-1 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                    {labels.flowLabel}
                  </span>
                  <select
                    className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
                    value={flowId}
                    onChange={(e) => setFlowId(e.target.value)}
                  >
                    <option value="">{labels.flowNone}</option>
                    {launchableFlows.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.ref}
                      </option>
                    ))}
                  </select>
                </label>
                {launchableFlows.length === 0 ? (
                  <p className="m-0 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 text-[12px] text-amber">
                    {labels.noEnabledFlow}{" "}
                    <Link
                      className="font-semibold underline underline-offset-2"
                      href={packagesHref}
                    >
                      {labels.managePackages}
                    </Link>
                  </p>
                ) : null}
              </div>

              {error ? (
                <div
                  className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}
            </Modal.Body>

            <Modal.Footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-4">
              <Button
                className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
                isDisabled={busy}
                size="sm"
                type="button"
                variant="outline"
                onPress={() => setOpen(false)}
              >
                {labels.cancel}
              </Button>
              <Button
                className="rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2"
                isDisabled={disabled}
                size="sm"
                type="button"
                onPress={() => void submit()}
              >
                {labels.create}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
