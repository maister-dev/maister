"use client";

import type { Key, ReactElement } from "react";

import { Button, Input, ListBox, Select } from "@heroui/react";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";

type DeliveryPolicyStrategy =
  | "merge"
  | "rebase_merge"
  | "pull_request"
  | "ai_rebase_merge";
type DeliveryPolicyPush = "never" | "on_success";
type DeliveryPolicyTrigger = "manual" | "auto_on_ready";

type StoredDeliveryPolicy = {
  strategy: DeliveryPolicyStrategy;
  push: DeliveryPolicyPush;
  trigger: DeliveryPolicyTrigger;
  targetBranch: string | null;
};

type Props = {
  projectSlug: string;
  projectMainBranch: string;
  defaultPolicy: StoredDeliveryPolicy | null;
};

type SelectOption<T extends string> = {
  id: T;
  label: string;
};

async function patchJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;

    throw new Error(payload?.message ?? `request failed: ${response.status}`);
  }
}

function selectedValue<T extends string>(key: Key | null, fallback: T): T {
  if (key === null) return fallback;

  return String(key) as T;
}

function PolicySelect<T extends string>(props: {
  label: string;
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
}): ReactElement {
  const labelId = useId();

  return (
    <>
      <span className="sr-only" id={labelId}>
        {props.label}
      </span>
      <Select
        aria-labelledby={labelId}
        selectedKey={props.value}
        variant="secondary"
        onSelectionChange={(key) =>
          props.onChange(selectedValue(key, props.value))
        }
      >
        <Select.Trigger className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
          <ListBox aria-label={props.label}>
            {props.options.map((option) => (
              <ListBox.Item
                key={option.id}
                id={option.id}
                textValue={option.label}
              >
                {option.label}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </>
  );
}

export function DeliveryPolicySettingsControl({
  projectSlug,
  projectMainBranch,
  defaultPolicy,
}: Props): ReactElement {
  const t = useTranslations("settings");
  const [strategy, setStrategy] = useState<DeliveryPolicyStrategy>(
    defaultPolicy?.strategy ?? "merge",
  );
  const [push, setPush] = useState<DeliveryPolicyPush>(
    defaultPolicy?.push ?? "never",
  );
  const [trigger, setTrigger] = useState<DeliveryPolicyTrigger>(
    defaultPolicy?.trigger ?? "manual",
  );
  const [targetBranch, setTargetBranch] = useState(
    defaultPolicy?.targetBranch ?? "",
  );
  const [savedPolicy, setSavedPolicy] = useState(defaultPolicy);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextPolicy = {
    strategy,
    push,
    trigger,
    targetBranch: targetBranch.trim().length > 0 ? targetBranch.trim() : null,
  };
  const saved = JSON.stringify(savedPolicy ?? null);
  const current = JSON.stringify(nextPolicy);
  const changed = current !== saved;
  const labelClass =
    "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";
  const strategyOptions: Array<SelectOption<DeliveryPolicyStrategy>> = [
    { id: "merge", label: t("deliveryStrategyMerge") },
    { id: "rebase_merge", label: t("deliveryStrategyRebaseMerge") },
    { id: "pull_request", label: t("deliveryStrategyPullRequest") },
    { id: "ai_rebase_merge", label: t("deliveryStrategyAiRebaseMerge") },
  ];
  const pushOptions: Array<SelectOption<DeliveryPolicyPush>> = [
    { id: "never", label: t("deliveryPushNever") },
    { id: "on_success", label: t("deliveryPushOnSuccess") },
  ];
  const triggerOptions: Array<SelectOption<DeliveryPolicyTrigger>> = [
    { id: "manual", label: t("deliveryTriggerManual") },
    { id: "auto_on_ready", label: t("deliveryTriggerAutoOnReady") },
  ];

  async function save(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      await patchJson(
        `/api/projects/${encodeURIComponent(projectSlug)}/settings`,
        {
          deliveryPolicyDefault: nextPolicy,
        },
      );
      setSavedPolicy(nextPolicy);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  async function clear(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      await patchJson(
        `/api/projects/${encodeURIComponent(projectSlug)}/settings`,
        {
          deliveryPolicyDefault: null,
        },
      );
      setSavedPolicy(null);
      setStrategy("merge");
      setPush("never");
      setTrigger("manual");
      setTargetBranch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mb-4 rounded-[8px] border border-line bg-paper px-[18px] py-[15px]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="m-0 text-[13px] font-semibold tracking-[-0.005em] text-ink">
            {t("deliveryPolicyTitle")}
          </h3>
          <p className="m-0 mt-1 font-mono text-[10.5px] text-mute">
            {t("deliveryPolicyHint", { branch: projectMainBranch })}
          </p>
        </div>
        <span className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold tracking-[0.04em] text-mute">
          {savedPolicy ? t("projectOverride") : t("inheritPlatformDefault")}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("deliveryStrategy")}</span>
          <PolicySelect
            label={t("deliveryStrategy")}
            options={strategyOptions}
            value={strategy}
            onChange={setStrategy}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("deliveryPush")}</span>
          <PolicySelect
            label={t("deliveryPush")}
            options={pushOptions}
            value={push}
            onChange={setPush}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("deliveryTrigger")}</span>
          <PolicySelect
            label={t("deliveryTrigger")}
            options={triggerOptions}
            value={trigger}
            onChange={setTrigger}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("deliveryTarget")}</span>
          <Input
            aria-label={t("deliveryTarget")}
            className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink"
            placeholder={projectMainBranch}
            value={targetBranch}
            onChange={(event) => setTargetBranch(event.target.value)}
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          className="border-line bg-ivory text-[12px] font-semibold text-ink"
          isDisabled={pending || savedPolicy === null}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void clear()}
        >
          {t("clearDefault")}
        </Button>
        <Button
          className="border-line bg-ink text-[12px] font-semibold text-paper"
          isDisabled={pending || !changed}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void save()}
        >
          {pending ? t("saving") : t("save")}
        </Button>
      </div>
      {error ? (
        <p className="m-0 mt-2 text-[12px] leading-[1.45] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
