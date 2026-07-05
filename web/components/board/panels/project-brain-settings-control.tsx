"use client";

import type { Key, ReactElement } from "react";

import { Button, ListBox, Select } from "@heroui/react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";

type Props = {
  projectSlug: string;
  brainEnabled: boolean;
  indexingProfile: BrainIndexingProfile;
  homeResolution: BrainHomeResolution;
  projectionFlowId: string | null;
  autonomyDefaults: BrainAutonomyPolicy;
  flows: Array<{ id: string; ref: string }>;
  // Whether the platform embedding provider + distillation model are configured.
  // Enabling with this false returns CONFIG (the enable-gate) — surfaced inline.
  platformConfigured: boolean;
};

type AutonomyDecision = "manual" | "auto_draft";
type AutonomyPolicyKey = "rule.low" | "skill.low" | "flow.low";
type BrainAutonomyPolicy = Partial<Record<AutonomyPolicyKey, AutonomyDecision>>;
type BrainHomeKind = "decision" | "direction";
type BrainHomeValue = "owned" | "indexed";
type BrainHomeSelection = BrainHomeValue | "default";
type BrainHomeResolution = Partial<Record<BrainHomeKind, BrainHomeValue>>;
type BrainHomeState = Record<BrainHomeKind, BrainHomeSelection>;
type BrainIndexingProfile = "docs" | "docs_source" | "all";

const AUTONOMY_CONTROLS: Array<{ key: AutonomyPolicyKey; labelKey: string }> = [
  { key: "rule.low", labelKey: "brainAutonomyRuleLow" },
  { key: "skill.low", labelKey: "brainAutonomySkillLow" },
  { key: "flow.low", labelKey: "brainAutonomyFlowLow" },
];
const HOME_CONTROLS: Array<{ key: BrainHomeKind; labelKey: string }> = [
  { key: "decision", labelKey: "brainHomeDecision" },
  { key: "direction", labelKey: "brainHomeDirection" },
];
const NO_PROJECTION_FLOW = "__none__";

function normalizePolicy(policy: BrainAutonomyPolicy): BrainAutonomyPolicy {
  return AUTONOMY_CONTROLS.reduce<BrainAutonomyPolicy>((acc, control) => {
    acc[control.key] = policy[control.key] ?? "manual";

    return acc;
  }, {});
}

function policyKey(policy: BrainAutonomyPolicy): string {
  return AUTONOMY_CONTROLS.map((control) => {
    const decision = policy[control.key] ?? "manual";

    return `${control.key}:${decision}`;
  }).join("|");
}

function normalizeHomeState(
  homeResolution: BrainHomeResolution,
): BrainHomeState {
  return HOME_CONTROLS.reduce<BrainHomeState>(
    (acc, control) => {
      acc[control.key] = homeResolution[control.key] ?? "default";

      return acc;
    },
    { decision: "default", direction: "default" },
  );
}

function homeResolutionFromState(state: BrainHomeState): BrainHomeResolution {
  return HOME_CONTROLS.reduce<BrainHomeResolution>((acc, control) => {
    const value = state[control.key];

    if (value !== "default") acc[control.key] = value;

    return acc;
  }, {});
}

function homeKey(homeResolution: BrainHomeResolution): string {
  return HOME_CONTROLS.map((control) => {
    const value = homeResolution[control.key] ?? "default";

    return `${control.key}:${value}`;
  }).join("|");
}

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

// Per-project Project Brain toggle (ADR-122). Enabling is gated: the platform
// embedding provider AND distillation model must be configured; dedicated
// distillation provider fields are optional overrides. Otherwise the PATCH
// returns CONFIG (422) and nothing is persisted — the message renders inline.
export function ProjectBrainSettingsControl({
  projectSlug,
  brainEnabled,
  indexingProfile,
  homeResolution,
  projectionFlowId,
  autonomyDefaults,
  flows,
  platformConfigured,
}: Props): ReactElement {
  const t = useTranslations("settings");
  const labelId = useId();
  const profileId = useId();
  const homeId = useId();
  const projectionId = useId();
  const autonomyId = useId();
  const [enabled, setEnabled] = useState(brainEnabled);
  const [savedEnabled, setSavedEnabled] = useState(brainEnabled);
  const [profile, setProfile] = useState<BrainIndexingProfile>(indexingProfile);
  const [savedProfile, setSavedProfile] =
    useState<BrainIndexingProfile>(indexingProfile);
  const [home, setHome] = useState<BrainHomeState>(
    normalizeHomeState(homeResolution),
  );
  const [savedHomeKey, setSavedHomeKey] = useState(homeKey(homeResolution));
  const [projection, setProjection] = useState(
    projectionFlowId ?? NO_PROJECTION_FLOW,
  );
  const [savedProjection, setSavedProjection] = useState(
    projectionFlowId ?? NO_PROJECTION_FLOW,
  );
  const [policy, setPolicy] = useState<BrainAutonomyPolicy>(
    normalizePolicy(autonomyDefaults),
  );
  const [savedPolicyKey, setSavedPolicyKey] = useState(
    policyKey(normalizePolicy(autonomyDefaults)),
  );
  const [pending, setPending] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentHomeResolution = homeResolutionFromState(home);
  const currentHomeKey = homeKey(currentHomeResolution);
  const currentPolicyKey = policyKey(policy);
  const changed =
    enabled !== savedEnabled ||
    profile !== savedProfile ||
    currentHomeKey !== savedHomeKey ||
    projection !== savedProjection ||
    currentPolicyKey !== savedPolicyKey;
  const labelClass =
    "font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute";

  const options: Array<{ id: string; label: string }> = [
    { id: "on", label: t("brainEnabledOn") },
    { id: "off", label: t("brainEnabledOff") },
  ];
  const autonomyOptions: Array<{ id: AutonomyDecision; label: string }> = [
    { id: "manual", label: t("brainAutonomyManual") },
    { id: "auto_draft", label: t("brainAutonomyAutoDraft") },
  ];
  const homeOptions: Array<{ id: BrainHomeSelection; label: string }> = [
    { id: "default", label: t("brainHomeDefault") },
    { id: "owned", label: t("brainHomeOwned") },
    { id: "indexed", label: t("brainHomeIndexed") },
  ];
  const flowOptions: Array<{ id: string; label: string }> = [
    { id: NO_PROJECTION_FLOW, label: t("brainProjectionFlowNone") },
    ...flows.map((flow) => ({ id: flow.id, label: flow.ref })),
  ];
  const profileOptions: Array<{ id: BrainIndexingProfile; label: string }> = [
    { id: "docs", label: t("brainIndexingProfileDocs") },
    { id: "docs_source", label: t("brainIndexingProfileDocsSource") },
    { id: "all", label: t("brainIndexingProfileAll") },
  ];

  function setDecision(
    key: AutonomyPolicyKey,
    decision: AutonomyDecision,
  ): void {
    setShowSaved(false);
    setPolicy((prev) => ({ ...prev, [key]: decision }));
  }

  function setHomeResolution(
    key: BrainHomeKind,
    value: BrainHomeSelection,
  ): void {
    setShowSaved(false);
    setHome((prev) => ({ ...prev, [key]: value }));
  }

  async function save(): Promise<void> {
    setPending(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {};

      if (enabled !== savedEnabled) body.brainEnabled = enabled;
      if (profile !== savedProfile) body.brainIndexingProfile = profile;
      if (currentHomeKey !== savedHomeKey) {
        body.homeResolution = currentHomeResolution;
      }
      if (projection !== savedProjection) {
        body.projectionFlowId =
          projection === NO_PROJECTION_FLOW ? null : projection;
      }
      if (currentPolicyKey !== savedPolicyKey) {
        body.autonomyDefaults = normalizePolicy(policy);
      }

      await patchJson(
        `/api/projects/${encodeURIComponent(projectSlug)}/settings`,
        body,
      );
      setSavedEnabled(enabled);
      setSavedProfile(profile);
      setSavedHomeKey(currentHomeKey);
      setSavedProjection(projection);
      setSavedPolicyKey(currentPolicyKey);
      setShowSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="mb-4 scroll-mt-4 rounded-[8px] border border-line bg-paper px-[18px] py-[15px]"
      id="project-brain-settings"
    >
      <div className="mb-1 text-[13px] font-semibold tracking-[-0.005em] text-ink">
        {t("brainProjectTitle")}
      </div>
      <p className="m-0 mb-3 font-mono text-[10.5px] leading-[1.5] tracking-[0.02em] text-mute">
        {t("brainProjectHint")}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[200px] flex-col gap-1.5">
          <span className={labelClass}>{t("brainEnabledLabel")}</span>
          <span className="sr-only" id={labelId}>
            {t("brainEnabledLabel")}
          </span>
          <Select
            aria-labelledby={labelId}
            selectedKey={enabled ? "on" : "off"}
            variant="secondary"
            onSelectionChange={(key: Key | null) => {
              setShowSaved(false);
              setEnabled(key === null ? enabled : String(key) === "on");
            }}
          >
            <Select.Trigger className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
              <ListBox aria-label={t("brainEnabledLabel")}>
                {options.map((option) => (
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
        </label>
        <label className="flex min-w-[220px] flex-col gap-1.5">
          <span className={labelClass} id={profileId}>
            {t("brainIndexingProfile")}
          </span>
          <Select
            aria-labelledby={profileId}
            selectedKey={profile}
            variant="secondary"
            onSelectionChange={(key: Key | null) => {
              if (key === null) return;

              setShowSaved(false);
              setProfile(String(key) as BrainIndexingProfile);
            }}
          >
            <Select.Trigger className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
              <ListBox aria-label={t("brainIndexingProfile")}>
                {profileOptions.map((option) => (
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
        </label>
        {HOME_CONTROLS.map((control, index) => {
          const labelElementId = `${homeId}-${index}`;

          return (
            <label
              key={control.key}
              className="flex min-w-[190px] flex-col gap-1.5"
            >
              <span className={labelClass} id={labelElementId}>
                {t(control.labelKey)}
              </span>
              <Select
                aria-labelledby={labelElementId}
                selectedKey={home[control.key]}
                variant="secondary"
                onSelectionChange={(key: Key | null) => {
                  if (key === null) return;

                  setHomeResolution(
                    control.key,
                    String(key) as BrainHomeSelection,
                  );
                }}
              >
                <Select.Trigger className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
                  <ListBox aria-label={t(control.labelKey)}>
                    {homeOptions.map((option) => (
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
            </label>
          );
        })}
        <label className="flex min-w-[250px] flex-col gap-1.5">
          <span className={labelClass} id={projectionId}>
            {t("brainProjectionFlow")}
          </span>
          <Select
            aria-labelledby={projectionId}
            selectedKey={projection}
            variant="secondary"
            onSelectionChange={(key: Key | null) => {
              if (key === null) return;

              setShowSaved(false);
              setProjection(String(key));
            }}
          >
            <Select.Trigger className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
              <ListBox aria-label={t("brainProjectionFlow")}>
                {flowOptions.map((option) => (
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
        </label>
        {AUTONOMY_CONTROLS.map((control, index) => {
          const labelElementId = `${autonomyId}-${index}`;

          return (
            <label
              key={control.key}
              className="flex min-w-[190px] flex-col gap-1.5"
            >
              <span className={labelClass} id={labelElementId}>
                {t(control.labelKey)}
              </span>
              <Select
                aria-labelledby={labelElementId}
                selectedKey={policy[control.key] ?? "manual"}
                variant="secondary"
                onSelectionChange={(key: Key | null) => {
                  if (key === null) return;

                  setDecision(control.key, String(key) as AutonomyDecision);
                }}
              >
                <Select.Trigger className="h-10 rounded-[8px] border-line bg-canvas px-3 text-[13px] text-ink">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover className="rounded-md border border-line bg-paper p-1 shadow-lg">
                  <ListBox aria-label={t(control.labelKey)}>
                    {autonomyOptions.map((option) => (
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
            </label>
          );
        })}
        <Button
          className="border-line bg-ink text-[13px] font-semibold text-paper"
          isDisabled={pending || !changed}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void save()}
        >
          {pending ? t("saving") : t("save")}
        </Button>
        {showSaved && !changed ? (
          <span
            aria-label={t("brainProjectSaved")}
            className="flex items-center text-emerald-600"
            role="status"
            title={t("brainProjectSaved")}
          >
            <CheckIcon className="h-5 w-5" />
          </span>
        ) : null}
      </div>
      {!platformConfigured ? (
        <p className="m-0 mt-2 font-mono text-[10px] leading-[1.5] text-mute">
          {t("brainNotConfigured")}
        </p>
      ) : null}
      {error ? (
        <p
          className="m-0 mt-2 text-[12px] leading-[1.45] text-red-700"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
